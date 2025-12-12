# Documento de Prueba de Concepto: Arquitectura SaaS Multi tenant con Arrow Flight sobre WebSocket

---

## 1. Propósito y Objetivos

### 1.1 Propósito General
Esta prueba de concepto (PoC) valida la viabilidad técnica de una arquitectura SaaS multi tenant donde los datos residen en infraestructura on-premise restringida (IPs dinámicas, sin puertos inbound disponibles). Se demuestra que es posible transferir datasets analíticos desde entornos corporativos cerrados hasta el navegador del usuario sin requerir configuraciones de firewall complejas.

### 1.2 Objetivos Específicos
- Validar el patrón **Reverse WebSocket** para conectar Data Connectors en redes restringidas con el Gateway SaaS.
- Medir la latencia end-to-end de transferencia de datasets (1M filas) usando WebSocket como transporte primario.
- Probar el comportamiento del sistema bajo carga concurrente de hasta 1000 solicitudes simultáneas.
- Evaluar el overhead de adaptar Arrow Flight a través de WebSocket vs. gRPC nativo.
- Verificar el aislamiento de tenants cuando todos comparten un mismo túnel de salida.

---

## 2. Alcance de la Prueba de Concepto

### 2.1 Qué se incluye
- Simulación de tres capas: Cliente de Carga, Gateway SaaS y Data Connector.
- **Conexión persistente WebSocket** iniciada desde el Data Connector hacia el Gateway (patrón reverse).
- Serialización/deserialización de datos Arrow IPC sobre frames binarios de WebSocket.
- Generación de métricas de latencia comparando WebSocket vs. arquitectura tradicional.
- Escenario de carga concurrente controlada con múltiples tenants.

### 2.2 Qué NO se incluye
- Implementación de TLS/mTLS en el túnel WebSocket (usa WSS en puerto 443).
- Reconexión automática y manejo de desconexiones abruptas.
- Autenticación avanzada (solo tokens estáticos).
- Compresión de datos en el túnel WebSocket.
- Persistencia de conexiones en el Gateway (stateless a efectos de esta PoC).
- Integración real con DuckDB WASM (se simula con cliente Python).

---

## 3. Arquitectura General

### 3.1 Diagrama de Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CAPA CLIENTE                                │
│  Aplicación de Carga (Python)                                       │
│  - Genera 1000 solicitudes concurrentes                            │
│  - Mide latencia por request y componente                          │
│  - Simula múltiples tenants                                        │
└─────────────────────────────────────────────────────────────────────┘
                                 ↓
                     Protocolo: gRPC/Arrow Flight
                     Transporte: HTTP/2 sobre TCP
                                 ↓
┌─────────────────────────────────────────────────────────────────────┐
│                       CAPA GATEWAY SAAS                            │
│  Servidor Node.js                                                   │
│  - Puerto 8080: Health check REST                                 │
│  - Puerto 8815: Servidor Arrow Flight (gRPC)                      │
│  - Puerto 443: Servidor WebSocket (WSS)                           │
│  - Funciones: Routing, Auth, Adaptación gRPC ↔ WebSocket          │
└─────────────────────────────────────────────────────────────────────┘
                                 ↑
                     Protocolo: WebSocket (WSS)
                     Transporte: TCP sobre TLS 1.3
                                 ↑
┌─────────────────────────────────────────────────────────────────────┐
│                     CAPA DATA CONNECTOR                            │
│  Servidor Python (Simulación)                                       │
│  - Conexión saliente: WebSocket a wss://gateway:443               │
│  - Carga dataset estático desde archivo Parquet                   │
│  - Simula latencia de extracción de base de datos                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Principios de Diseño
- **Reverse Connection**: El Connector siempre inicia la conexión, eliminando necesidad de IP pública o puertos inbound.
- **Transporte Dual**: El Gateway usa gRPC nativo hacia el cliente y WebSocket hacia el Connector, actuando como puente.
- **State Recovery**: El Gateway mantiene un mapeo de tenant_id a socket WebSocket activo.
- **Zero-copy Adaptation**: Los datos Arrow IPC se encapsulan en frames binarios de WebSocket sin re-serialización.
- **Multi tenant Isolation**: Cada tenant tiene su propio WebSocket, pero comparten el mismo puerto 443 de salida.

---

## 4. Descripción de Componentes

### 4.1 Componente 1: Cliente de Carga (Load Tester)
**Tecnología**: Python asyncio con pyarrow-flight  
**Ubicación**: Máquina de pruebas externa  

**Responsabilidades**:
- Generar carga concurrente controlada mediante semáforos (hasta 100 workers simultáneos).
- Medir latencia con precisión de microsegundos en tres fases: conexión, metadatos y transferencia.
- Distribuir requests entre múltiples tenant_ids (5 identidades simuladas).
- Ejecutar operaciones Arrow Flight nativas: `GetFlightInfo` y `DoGet`.
- Persistir resultados en JSON con métricas por tenant.

**Configuración de Prueba**:
- Total requests: 1000
- Concurrencia máxima: 100 workers
- Tenants: 5 identidades con distribución round-robin
- Dataset objetivo: 1 millón de filas (~50MB en Arrow IPC)

### 4.2 Componente 2: SaaS Gateway
**Tecnología**: Node.js con soporte dual gRPC y WebSocket  
**Puertos**: 8080 (REST), 8815 (gRPC), 443 (WSS)  

**Responsabilidades**:
- **WebSocket Server**: Acepta conexiones entrantes en `wss://gateway:443/connect`.
- **Handshake de Registro**: Cuando un Connector se conecta, envía su `tenant_id` y recibe un `session_id`.
- **Mapeo de Sockets**: Mantiene en memoria un diccionario `tenant_id → WebSocket`.
- **Adaptación de Protocolo**: Recibe peticiones gRPC del Cliente, las traduce a mensajes WebSocket, y reenvía al Connector correspondiente.
- **Streaming Bidireccional**: Pipe de datos del Connector WebSocket al Cliente gRPC sin buffering.
- **Health Monitoring**: Endpoint REST en `:8080` retorna estado de conexiones activas.

**Comportamiento**:
- **Timeouts**: Si un Connector no envía heartbeat en 120s, se marca como offline.
- **Backpressure**: Si el Cliente gRPC lee lento, el Gateway pausa el stream WebSocket.
- **TLS Termination**: El Gateway maneja certificados wildcard para `*.saas-gateway.com`.

### 4.3 Componente 3: Data Connector Simulado
**Tecnología**: Python con cliente WebSocket y pyarrow  
**Conexión**: Saliente WSS al puerto 443 del Gateway  

**Responsabilidades**:
- **Conexión Persistente**: Inicia WebSocket al Gateway y mantiene heartbeat cada 60s.
- **Registro Automático**: Al conectar, envía `tenant_id` y metadata del dataset disponible.
- **Carga de Dataset**: Lee archivo Parquet estático al iniciar y mantiene tabla en memoria.
- **Simulación de Latencia**: Aplica delay artificial de 200-250ms antes de iniciar transferencia.
- **Recepción de Comandos**: Escucha mensajes WebSocket con estructura `{action: "do_get", query: "...", request_id: "..."}`.
- **Envío de Datos**: Serializa tabla Arrow en batches y envía como frames binarios por WebSocket.

**Dataset de Prueba**:
- **Estructura**: 4 columnas (id, valor string, amount float, timestamp)
- **Tamaño**: 1,000,000 filas (~50MB en Arrow IPC)
- **Formato**: Parquet local, convertido a Arrow IPC en stream de memoria

---

## 5. Flujo de Datos y Protocolos

### 5.1 Secuencia de Comunicación

**Fase 0: Registro del Connector (Al inicio)**
1. Connector inicia WebSocket desde su red local: `wss://saas-gateway.com:443/connect`.
2. Gateway acepta conexión y espera mensaje de registro.
3. Connector envía: `{tenant_id: "tenant_001", action: "register", version: "1.0"}`.
4. Gateway responde: `{status: "ok", session_id: "sess_abc123"}`.
5. Gateway almacena: `connections.set("tenant_001", socket)`.

**Fase 1: Request del Cliente (Operación normal)**
1. Cliente Python conecta gRPC al Gateway: `grpc://gateway:8815`.
2. Cliente envía `GetFlightInfo` con descriptor `["dataset", "sales"]` y metadata `tenant-id: tenant_001`.
3. Gateway busca en su mapa el WebSocket activo para `tenant_001`.
4. Gateway traduce a mensaje WebSocket: `{action: "get_flight_info", request_id: "req_456", descriptor: {...}}`.
5. Gateway envía mensaje por WebSocket y espera respuesta.

**Fase 2: Respuesta del Connector**
1. Connector recibe mensaje WebSocket y parsea.
2. Connector ejecuta lógica local: carga dataset, aplica delay.
3. Connector envía respuesta: `{request_id: "req_456", flight_info: {schema: ..., ticket: ...}}`.
4. Gateway recibe y traduce a formato `FlightInfo` gRPC.
5. Gateway responde al Cliente gRPC.

**Fase 3: Transferencia de Datos**
1. Cliente envía `DoGet(ticket)` al Gateway.
2. Gateway envía mensaje WebSocket: `{action: "do_get", ticket: "..."}`.
3. Connector inicia stream: lee batches de Arrow y envía frames binarios.
4. Gateway recibe frames binarios y los **reemite directamente** al stream gRPC del Cliente.
5. Cliente lee batches hasta `StopIteration`.

### 5.2 Formato de Datos en WebSocket

**Mensajes de Control** (JSON sobre texto):
```json
{
  "action": "get_flight_info|do_get|heartbeat",
  "tenant_id": "tenant_001",
  "request_id": "uuid-123",
  "descriptor": {"type": "PATH", "path": ["dataset"]},
  "ticket": "base64-encoded"
}
```

**Mensajes de Datos** (Binario puro):
- Frame 1: `0x01` (tipo: metadata) + bytes del esquema Arrow
- Frame 2+: `0x02` (tipo: data) + bytes del record batch
- Frame Final: `0x03` (tipo: end)

El Gateway **no parsea** los frames de datos, solo hace pipe.

---

## 6. Escenario de Prueba

### 6.1 Configuración del Experimento

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| **Carga Total** | 1000 requests | Número total de operaciones completas |
| **Concurrencia** | 100 workers | Máximas solicitudes simultáneas |
| **Tenants** | 5 identidades | Distribución round-robin |
| **Dataset** | 1M filas | ~50MB transferidos por request |
| **Delay Simulado** | 250ms | Latencia artificial en el Connector |
| **Duración Estimada** | 20-30 segundos | Mayor que PoC gRPC por overhead de WebSocket |

### 6.2 Distribución de Carga

Cada worker ejecuta:
- **Conexión gRPC al Gateway**: ~5-10ms
- **GetFlightInfo vía WebSocket**: ~15-25ms (2 hops + traducción)
- **DoGet vía WebSocket**: ~270-850ms (delay + transferencia + overhead)

**Overhead Esperado de WebSocket**: +10-20% vs gRPC directo.

### 6.3 Métricas Capturadas

Para cada request se registra:
- `request_id`, `tenant_id`, `timestamp`
- `metadata_ms`: Latencia de GetFlightInfo
- `data_transfer_ms`: Latencia de DoGet
- `websocket_overhead_ms`: Diferencia vs baseline gRPC
- `status`: "success", "error", "timeout"
- `rows_transfered`: Total de filas recibidas

---

## 7. Métricas de Éxito y Resultados Esperados

### 7.1 Métricas de Rendimiento (WebSocket)

| Métrica | Objetivo | Umbral de Éxito | Nota |
|---------|----------|-----------------|------|
| **Latencia P50** | < 600ms | < 900ms | Overhead WebSocket aceptable |
| **Latencia P95** | < 1200ms | < 1800ms | Colas en traducción |
| **Latencia P99** | < 2000ms | < 2500ms | Peor caso |
| **Tasa de Error** | < 2% | < 5% | Timeouts por desconexión WebSocket |
| **Throughput** | > 40 req/s | > 30 req/s | Menor que gRPC nativo |
| **Uso CPU Gateway** | < 80% | < 90% | Traducción consume CPU extra |

### 7.2 Comparativa vs Baseline gRPC

Se espera que WebSocket añada:
- **+15-25ms** por operación de traducción Gateway
- **+5-10%** en uso de CPU del Gateway
- **+2-5%** en tiempo de transferencia (menos eficiente que HTTP/2)

El trade-off es **aceptable** dada la eliminación de requisitos de red.

---

## 8. Consideraciones Técnicas y Limitaciones

### 8.1 Limitaciones Específicas de WebSocket

- **Overhead de Handshake**: TLS + HTTP upgrade añade 2-3 RTT iniciales.
- **No Multiplexación Nativa**: No hay streams como en HTTP/2; se deben implementar "canales lógicos" por request_id.
- **Backpressure Manual**: Hay que pausar/resumir el socket cuando el Cliente gRPC no lee.
- **Reconexión**: Si el WebSocket se cae, el Connector debe reconectar y el Gateway debe invalidar conexiones antiguas.
- **Escalado**: El Gateway puede mantener miles de sockets, pero cada socket es un file descriptor que consume memoria.

### 8.2 Requisitos de Infraestructura

**Gateway SaaS (Nube)**:
- **Puertos Inbound**: 443 (WSS), 8815 (gRPC), 8080 (REST)
- **RAM**: 2GB para buffer de sockets (~2MB por WebSocket activo)
- **CPU**: 2-4 cores para traducción y pipe

**Data Connector (On-Premise)**:
- **Puertos Outbound**: 443 (WSS) al dominio del Gateway
- **RAM**: 500MB para dataset en memoria
- **CPU**: 1-2 cores
- **No requiere**: IP pública, inbound ports, DMZ

**Cliente de Carga**:
- **RAM**: 4GB para manejar 100 streams gRPC concurrentes
- **Network**: Ancho de banda de al menos 500Mbps para evitar ser cuello de botelo

### 8.3 Seguridad y Aislamiento en WebSocket

- **Auth en Handshake**: El Connector envía token en el primer mensaje.
- **Rate Limiting**: Gateway limita mensajes por WebSocket (ej: 1 request/s).
- **Cifrado**: WSS en 443 asegura que pase por proxies corporativos.
- **Tenant Isolation**: El Gateway valida que cada socket solo envía datos de su tenant.

---

## 9. Próximos Pasos Post-PoC

### 9.1 Validaciones Adicionales
1. **Prueba en red corporativa real**: Desplegar Connector en una red con firewall saliente restringido.
2. **Reconexión automática**: Simular caída del WebSocket y medir tiempo de recuperación.
3. **Escalado de Gateway**: Probar con 5000+ WebSockets concurrentes usando clustering de Node.js.
4. **Integración DuckDB WASM**: Implementar cliente JavaScript que consuma el stream gRPC y lo cargue en WASM.

### 9.2 Roadmap de Producción
1. **Implementar gRPC Reverse Nativo**: Reemplazar WebSocket por gRPC persistente (más eficiente).
2. **Session Management**: Persistencia de sesiones en Redis con TTL.
3. **Health Checks**: Backend que monitoree conectividad de cada tenant.
4. **Metrics**: Integrar Prometheus para métricas de WebSocket (connected_clients, messages_per_second, etc.).
5. **Autoscaling**: Gateway debe escalar horizontalmente cuando el número de tenants crezca.

---

## 10. Resumen Ejecutivo

Esta PoC demuestra que **es viable conectar Data Connectors desde redes restringidas (sin IP fija ni puertos abiertos) usando WebSocket como túnel de salida**. Aunque hay un overhead del 10-20% vs gRPC directo, el beneficio de eliminar requisitos de infraestructura es **masivo** para el modelo SaaS.

Los resultados cuantificarán el costo de esta adaptación y permitirán decidir si se acepta el trade-off para la fase de producción, o si se invierte en gRPC reverse nativo.

---

**Fecha de Documento**: 2025-12-10  
**Versión**: 2.0 (Adaptado para WebSocket)  
**Estado**: Preparado para Ejecución