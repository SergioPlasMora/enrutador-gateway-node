/**
 * Enrutador Gateway - Node.js Implementation
 * Entry point that starts both WebSocket and Arrow Flight servers
 */
import { startWebSocketServer } from './websocket-server.js';
import { startFlightServer } from './flight-server.js';
import { manager } from './connection-manager.js';
import http from 'http';

const WS_PORT = 8080;
const FLIGHT_PORT = 8815;
const HEALTH_PORT = 8081;

console.log('========================================');
console.log('  Enrutador Gateway - Node.js v1.0.0');
console.log('========================================');

// Start WebSocket Server for Data Connectors
const wss = startWebSocketServer(WS_PORT);

// Start Arrow Flight gRPC Server for Clients
const flightServer = startFlightServer(FLIGHT_PORT);

// Simple HTTP health check endpoint
const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            active_connections: manager.activeConnections,
            connected_tenants: manager.connectedTenants
        }));
    } else if (req.url === '/tenants') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tenants: manager.connectedTenants,
            count: manager.activeConnections
        }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

healthServer.listen(HEALTH_PORT, () => {
    console.log(`[Health] HTTP server started on port ${HEALTH_PORT}`);
});

console.log('');
console.log('Endpoints:');
console.log(`  WebSocket:    ws://localhost:${WS_PORT}/ws/connect`);
console.log(`  Arrow Flight: grpc://localhost:${FLIGHT_PORT}`);
console.log(`  Health Check: http://localhost:${HEALTH_PORT}/health`);
console.log('');

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    wss.close();
    flightServer.tryShutdown(() => {
        healthServer.close(() => {
            console.log('Goodbye!');
            process.exit(0);
        });
    });
});
