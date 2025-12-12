/**
 * Arrow Flight gRPC Server
 * Implementa el protocolo Arrow Flight usando gRPC genérico
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { manager } from './connection-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cargar proto de Arrow Flight
const PROTO_PATH = join(__dirname, '../proto/Flight.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});

const flightProto = grpc.loadPackageDefinition(packageDefinition).arrow.flight.protocol;

/**
 * Implementación de GetFlightInfo
 * Obtiene metadata del dataset del Connector via WebSocket
 */
async function getFlightInfo(call, callback) {
    try {
        const descriptor = call.request;
        
        // Extraer tenant_id y dataset del path
        // Path format: [tenant_id, dataset_name, rows?]
        const path = descriptor.path || [];
        if (path.length < 2) {
            return callback({
                code: grpc.status.INVALID_ARGUMENT,
                message: 'Invalid descriptor path'
            });
        }
        
        const tenantId = Buffer.isBuffer(path[0]) ? path[0].toString() : path[0];
        const datasetName = Buffer.isBuffer(path[1]) ? path[1].toString() : path[1];
        let rows = null;
        if (path[2]) {
            rows = parseInt(Buffer.isBuffer(path[2]) ? path[2].toString() : path[2]);
        }

        if (!manager.isConnected(tenantId)) {
            return callback({
                code: grpc.status.UNAVAILABLE,
                message: `Tenant ${tenantId} not connected`
            });
        }

        // Enviar request al Connector
        const reqDescriptor = { type: 'PATH', path: [datasetName] };
        if (rows) reqDescriptor.rows = rows;

        const response = await manager.sendRequest(tenantId, 'get_flight_info', {
            descriptor: reqDescriptor
        });

        if (response.status !== 'ok') {
            return callback({
                code: grpc.status.INTERNAL,
                message: response.error || 'Unknown error'
            });
        }

        // Construir ticket con info completa
        const ticketData = { tenant_id: tenantId, dataset: datasetName };
        if (rows) ticketData.rows = rows;

        // Construir FlightInfo response
        const flightInfo = {
            schema: Buffer.from(response.data.schema || '', 'base64'),
            flight_descriptor: descriptor,
            endpoint: [{
                ticket: { ticket: Buffer.from(JSON.stringify(ticketData)) },
                location: [{ uri: 'grpc://localhost:8815' }]
            }],
            total_records: response.data.total_records || -1,
            total_bytes: response.data.total_bytes || -1
        };

        callback(null, flightInfo);

    } catch (err) {
        console.error('[FlightServer] GetFlightInfo error:', err);
        callback({
            code: grpc.status.UNAVAILABLE,
            message: err.message
        });
    }
}

/**
 * Implementación de DoGet
 * Obtiene datos del Connector y los streamea al cliente
 * 
 * IMPORTANTE: Los datos vienen del Connector como Arrow IPC streams.
 * Cada chunk es un stream IPC completo (schema + batches).
 * Los enviamos directamente como data_body en FlightData.
 */
async function doGet(call) {
    try {
        const ticket = call.request.ticket;
        const ticketData = JSON.parse(ticket.toString());
        const tenantId = ticketData.tenant_id;

        if (!manager.isConnected(tenantId)) {
            call.emit('error', {
                code: grpc.status.UNAVAILABLE,
                message: `Tenant ${tenantId} not connected`
            });
            return;
        }

        console.log(`[FlightServer] DoGet for tenant ${tenantId}`);

        // Obtener stream del Connector
        const ticketB64 = Buffer.from(JSON.stringify(ticketData)).toString('base64');
        
        let chunkCount = 0;
        for await (const chunk of manager.sendStreamRequest(tenantId, 'do_get', { ticket: ticketB64 })) {
            // El chunk es un Arrow IPC stream completo (bytes crudos)
            // Arrow Flight protocol requiere data_header (puede estar vacío) y data_body
            const flightData = {
                data_header: Buffer.alloc(0),  // Metadata vacía pero presente
                data_body: chunk  // Los datos Arrow IPC
            };
            call.write(flightData);
            chunkCount++;
            console.log(`[FlightServer] Sent FlightData chunk ${chunkCount}, size=${chunk.length}`);
        }

        console.log(`[FlightServer] DoGet complete, sent ${chunkCount} chunks`);
        call.end();

    } catch (err) {
        console.error('[FlightServer] DoGet error:', err);
        call.emit('error', {
            code: grpc.status.UNAVAILABLE,
            message: err.message
        });
    }
}

/**
 * Implementación de ListFlights
 */
function listFlights(call) {
    const tenants = manager.connectedTenants;
    
    for (const tenantId of tenants) {
        call.write({
            flight_descriptor: {
                type: 'PATH',
                path: [Buffer.from(tenantId), Buffer.from('default')]
            },
            schema: Buffer.alloc(0),
            endpoint: [],
            total_records: -1,
            total_bytes: -1
        });
    }
    
    call.end();
}

/**
 * Implementación de Handshake (requerido por Arrow Flight)
 */
function handshake(call) {
    call.on('data', (request) => {
        call.write({
            protocol_version: 0,
            payload: Buffer.alloc(0)
        });
    });
    call.on('end', () => call.end());
}

/**
 * Inicia el servidor Arrow Flight gRPC
 */
export function startFlightServer(port = 8815) {
    const server = new grpc.Server({
        'grpc.max_receive_message_length': 200 * 1024 * 1024,
        'grpc.max_send_message_length': 200 * 1024 * 1024
    });

    server.addService(flightProto.FlightService.service, {
        Handshake: handshake,
        ListFlights: listFlights,
        GetFlightInfo: getFlightInfo,
        DoGet: doGet,
        // Métodos no usados pero requeridos por el proto
        GetSchema: (call, cb) => cb({ code: grpc.status.UNIMPLEMENTED }),
        DoPut: (call) => call.emit('error', { code: grpc.status.UNIMPLEMENTED }),
        DoExchange: (call) => call.emit('error', { code: grpc.status.UNIMPLEMENTED }),
        DoAction: (call, cb) => cb({ code: grpc.status.UNIMPLEMENTED }),
        ListActions: (call) => { call.end(); }
    });

    server.bindAsync(
        `0.0.0.0:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
            if (err) {
                console.error('[FlightServer] Failed to bind:', err);
                return;
            }
            console.log(`[FlightServer] Arrow Flight gRPC server started on port ${boundPort}`);
        }
    );

    return server;
}
