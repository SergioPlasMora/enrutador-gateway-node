/**
 * Connection Manager - Gestiona conexiones WebSocket de Data Connectors
 * Equivalente a websocket_manager.py de Python
 */
import { v4 as uuidv4 } from 'uuid';

class ConnectionManager {
    constructor() {
        // tenant_id -> [WebSocket connections]
        this._connections = new Map();
        // tenant_id -> round-robin index
        this._rrIndex = new Map();
        // request_id -> { ws, resolve, reject, chunks: [] }
        this._pendingRequests = new Map();
        // ws -> active stream count (semaphore)
        this._activeStreams = new Map();
        // Max concurrent streams per websocket
        this._maxConcurrentStreams = 3;
        // Queue for pending stream requests
        this._streamQueue = [];
    }

    /**
     * Registra un nuevo Data Connector
     */
    register(ws, tenantId) {
        const sessionId = uuidv4();
        
        if (!this._connections.has(tenantId)) {
            this._connections.set(tenantId, []);
            this._rrIndex.set(tenantId, 0);
        }
        
        this._connections.get(tenantId).push(ws);
        ws.tenantId = tenantId;
        ws.sessionId = sessionId;
        
        console.log(`[ConnectionManager] Registered tenant: ${tenantId} (${this._connections.get(tenantId).length} connections)`);
        
        return { status: 'ok', session_id: sessionId };
    }

    /**
     * Desregistra una conexión
     */
    unregister(ws) {
        const tenantId = ws.tenantId;
        if (!tenantId) return;
        
        const connections = this._connections.get(tenantId) || [];
        const idx = connections.indexOf(ws);
        if (idx !== -1) {
            connections.splice(idx, 1);
        }
        
        if (connections.length === 0) {
            this._connections.delete(tenantId);
            this._rrIndex.delete(tenantId);
        }
        
        console.log(`[ConnectionManager] Unregistered tenant: ${tenantId}`);
    }

    /**
     * Verifica si un tenant está conectado
     */
    isConnected(tenantId) {
        const conns = this._connections.get(tenantId);
        return conns && conns.length > 0;
    }

    /**
     * Obtiene la siguiente conexión usando Round-Robin
     */
    getNextConnection(tenantId) {
        const connections = this._connections.get(tenantId);
        if (!connections || connections.length === 0) {
            throw new Error(`Tenant ${tenantId} not connected`);
        }
        
        const idx = this._rrIndex.get(tenantId) % connections.length;
        this._rrIndex.set(tenantId, idx + 1);
        return connections[idx];
    }

    /**
     * Envía request y espera respuesta JSON (para GetFlightInfo)
     */
    sendRequest(tenantId, action, data = {}, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const requestId = uuidv4();
            const ws = this.getNextConnection(tenantId);
            
            const timer = setTimeout(() => {
                this._pendingRequests.delete(requestId);
                reject(new Error('Request timeout'));
            }, timeout);
            
            this._pendingRequests.set(requestId, {
                ws,
                resolve: (response) => {
                    clearTimeout(timer);
                    this._pendingRequests.delete(requestId);
                    resolve(response);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    this._pendingRequests.delete(requestId);
                    reject(err);
                },
                chunks: [],
                isStreaming: false
            });
            
            const message = {
                action,
                tenant_id: tenantId,
                request_id: requestId,
                ...data
            };
            
            ws.send(JSON.stringify(message));
        });
    }

    /**
     * Envía request y devuelve un async generator de chunks binarios (para DoGet)
     * IMPORTANTE: Serializa streams por WebSocket para evitar confusión de chunks
     */
    async *sendStreamRequest(tenantId, action, data = {}) {
        const requestId = uuidv4();
        const ws = this.getNextConnection(tenantId);
        
        // Esperar si ya hay un stream activo en este WebSocket
        while (this._activeStreams.get(ws)) {
            await new Promise(r => setTimeout(r, 10));
        }
        
        // Marcar como activo
        this._activeStreams.set(ws, requestId);
        
        console.log(`[ConnectionManager] sendStreamRequest: tenantId=${tenantId}, action=${action}, requestId=${requestId}`);
        
        // Cola de chunks con control de flujo
        const chunkQueue = [];
        let resolveWait = null;
        let streamEnded = false;
        let streamError = null;
        
        this._pendingRequests.set(requestId, {
            ws,
            isStreaming: true,
            onChunk: (chunk) => {
                chunkQueue.push(chunk);
                if (resolveWait) {
                    resolveWait();
                    resolveWait = null;
                }
            },
            onEnd: () => {
                streamEnded = true;
                if (resolveWait) {
                    resolveWait();
                    resolveWait = null;
                }
            },
            onError: (err) => {
                console.error(`[ConnectionManager] Stream error for ${requestId}:`, err);
                streamError = err;
                if (resolveWait) {
                    resolveWait();
                    resolveWait = null;
                }
            }
        });
        
        const message = {
            action,
            tenant_id: tenantId,
            request_id: requestId,
            ...data
        };
        
        ws.send(JSON.stringify(message));
        
        // Yield chunks mientras llegan
        try {
            while (true) {
                if (chunkQueue.length > 0) {
                    yield chunkQueue.shift();
                } else if (streamEnded) {
                    break;
                } else if (streamError) {
                    throw streamError;
                } else {
                    // Esperar nuevo chunk
                    await new Promise(r => { resolveWait = r; });
                }
            }
        } finally {
            this._pendingRequests.delete(requestId);
            this._activeStreams.delete(ws);
        }
    }

    /**
     * Maneja mensaje entrante del Connector (llamado por WebSocket server)
     */
    handleMessage(ws, message, isBinary) {
        if (isBinary) {
            // Mensaje binario: buscar request activo para este websocket
            for (const [reqId, ctx] of this._pendingRequests) {
                if (ctx.ws === ws && ctx.isStreaming) {
                    ctx.onChunk(message);
                    return;
                }
            }
            console.warn('[ConnectionManager] Binary message received but no pending stream request');
        } else {
            // Mensaje JSON
            try {
                const data = JSON.parse(message.toString());
                const requestId = data.request_id;
                
                if (!requestId) {
                    console.debug('[ConnectionManager] Control message:', data);
                    return;
                }
                
                const ctx = this._pendingRequests.get(requestId);
                if (!ctx) {
                    console.warn(`[ConnectionManager] No pending request for ${requestId}`);
                    return;
                }
                
                if (ctx.isStreaming) {
                    // Streaming: manejar mensajes de control
                    if (data.type === 'stream_end') {
                        ctx.onEnd();
                    } else if (data.status === 'error') {
                        ctx.onError(new Error(data.error || 'Unknown error'));
                    }
                    // stream_start se ignora
                } else {
                    // Request normal: resolver promesa
                    if (data.status === 'error') {
                        ctx.reject(new Error(data.error || 'Unknown error'));
                    } else {
                        ctx.resolve(data);
                    }
                }
            } catch (e) {
                console.error('[ConnectionManager] Error parsing message:', e);
            }
        }
    }

    /**
     * Getters de estado
     */
    get activeConnections() {
        let count = 0;
        for (const conns of this._connections.values()) {
            count += conns.length;
        }
        return count;
    }

    get connectedTenants() {
        return Array.from(this._connections.keys());
    }
}

// Singleton
export const manager = new ConnectionManager();
