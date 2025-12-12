/**
 * WebSocket Server - Endpoint para Data Connectors
 * Equivalente a websocket_endpoint en main.py de Python
 */
import { WebSocketServer } from 'ws';
import { manager } from './connection-manager.js';

export function startWebSocketServer(port = 8080) {
    const wss = new WebSocketServer({ 
        port,
        maxPayload: 200 * 1024 * 1024, // 200MB max message
        path: '/ws/connect'
    });

    console.log(`[WebSocket] Server started on port ${port}`);

    wss.on('connection', (ws) => {
        console.log('[WebSocket] New connection');
        let registered = false;
        let registrationTimeout;

        // Timeout para registro inicial
        registrationTimeout = setTimeout(() => {
            if (!registered) {
                console.warn('[WebSocket] Registration timeout');
                ws.close(1002, 'Registration timeout');
            }
        }, 30000);

        ws.on('message', (message, isBinary) => {
            if (!registered) {
                // Primer mensaje debe ser registro
                try {
                    const data = JSON.parse(message.toString());
                    
                    if (data.action !== 'register') {
                        ws.send(JSON.stringify({
                            status: 'error',
                            error: 'First message must be a register action'
                        }));
                        ws.close(1002);
                        return;
                    }

                    clearTimeout(registrationTimeout);
                    
                    const response = manager.register(ws, data.tenant_id);
                    ws.send(JSON.stringify(response));
                    registered = true;

                } catch (e) {
                    console.error('[WebSocket] Error parsing registration:', e);
                    ws.close(1003, 'Invalid JSON');
                }
            } else {
                // Mensaje normal: delegar al manager
                manager.handleMessage(ws, message, isBinary);
            }
        });

        ws.on('close', () => {
            clearTimeout(registrationTimeout);
            if (registered) {
                manager.unregister(ws);
            }
            console.log('[WebSocket] Connection closed');
        });

        ws.on('error', (err) => {
            console.error('[WebSocket] Error:', err);
        });
    });

    return wss;
}
