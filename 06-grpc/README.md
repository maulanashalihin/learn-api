# 06 — gRPC

## Apa itu gRPC?

**gRPC** adalah RPC (Remote Procedure Call) framework dari Google. Client call method di server seolah-olah local function call, tapi sebenarnya dikirim via network. gRPC pakai **Protocol Buffers** (protobuf) untuk serialization dan **HTTP/2** untuk transport.

### Perbedaan dengan REST/GraphQL

| Aspek | REST | GraphQL | gRPC |
|-------|------|---------|------|
| Serialization | JSON (text) | JSON (text) | **Protobuf (binary)** |
| Transport | HTTP/1.1 | HTTP/1.1 | **HTTP/2** |
| Schema | Optional (OpenAPI) | GraphQL Schema | **.proto file** |
| Client codegen | Optional | Optional | **Built-in** |
| Streaming | No | Subscriptions | **Yes (4 types)** |
| Performance | Medium | Medium | **High** |
| Browser support | ✅ | ✅ | ❌ (butuh gRPC-Web) |

## Protocol Buffers (protobuf)

Protobuf = format serialization binary dari Google. Lebih kecil dan lebih cepat dari JSON.

### Contoh: data yang sama

**JSON** (56 bytes):

```json
{"id":"123","title":"Belajar gRPC","done":false,"createdAt":"2026-01-01"}
```

**Protobuf** (~25 bytes):

```
08 03 12 0d 42 65 6c 61 6a 61 72 20 67 52 50 43 18 00
```

Protobuf gak kirim field names — cuma field numbers. Lebih compact, tapi gak human-readable.

### .proto file = Schema

```protobuf
syntax = "proto3";

message Task {
  string id = 1;        // field number 1
  string title = 2;     // field number 2
  bool done = 3;        // field number 3
  string created_at = 4;
}

service TaskService {
  rpc CreateTask(CreateTaskRequest) returns (Task);
  rpc ListTasks(ListTasksRequest) returns (stream Task);
}
```

**Aturan penting**:

- Field numbers jangan diubah setelah dipakai (backward compatibility)
- Tambah field baru = aman (old code ignore unknown fields)
- Hapus field = aman kalau number gak dipakai ulang
- `repeated` = array/list
- `stream` = streaming response/request

## 4 Jenis RPC di gRPC

```
1. Unary          2. Server Streaming    3. Client Streaming    4. Bi-directional

  ──→ ──→           ──→ ──→               ──→ ──→               ──→ ──→
  ←── ←──           ←── ←──               ←── ←──               ←── ←──
                    ←── ←──               ──→ ──→               ──→ ──→
                    ←── ←──               ──→ ──→               ←── ←──
                                                                ──→ ──→
                                                                ←── ←──

  1 request         1 request             N requests            N requests
  1 response        N responses           1 response            N responses
```

| Jenis | Use Case |
|-------|----------|
| **Unary** | CRUD operations (seperti REST) |
| **Server streaming** | Large dataset, real-time updates, log tailing |
| **Client streaming** | Upload, batch processing, telemetry |
| **Bi-directional** | Chat, sync, collaborative editing |

> Di code ini, `ListTasks` pakai **server streaming** — server kirim setiap Task satu per satu.

## Cara Kerja

```
    ┌────────┐                              ┌────────┐
    │ Client │ ── .proto (shared) ───────── │ Server  │
    │        │                              │         │
    │  stub  │ ── HTTP/2 + protobuf ──────→ │ service │
    │        │ ←── HTTP/2 + protobuf ─────── │ impl    │
    │        │                              │         │
    └────────┘                              └────────┘

    1. Client & server share .proto file
    2. Client call stub.CreateTask({title: "..."})
    3. Stub serialize request → protobuf binary
    4. HTTP/2 POST to /taskapi.TaskService/CreateTask
    5. Server deserialize, call handler, serialize response
    6. Client stub deserialize response → return to caller
```

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Performance**: protobuf binary 3-10x lebih kecil & cepat dari JSON
- **Type-safe**: .proto = contract, codegen generate typed client/server untuk 10+ bahasa
- **Streaming**: native support untuk 4 jenis streaming
- **HTTP/2**: multiplexing, header compression, binary framing
- **Polyglot**: client Go, server Java, dll — .proto language-agnostic
- **Deadline/timeout**: built-in timeout propagation
- **Interceptors**: middleware untuk auth, logging, metrics

### ❌ Kekurangan

- **No browser support**: gRPC butuh HTTP/2, browser gak bisa raw HTTP/2 → butuh gRPC-Web proxy
- **Hard to debug**: binary protobuf gak human-readable (butuh tools seperti grpcurl)
- **Schema coupling**: client & server harus share .proto file
- **Learning curve**: protobuf, HTTP/2, streaming concepts
- **No CDN caching**: HTTP/2 POST, gak cacheable seperti REST GET
- **Load balancing**: butuh HTTP/2 aware load balancer (envoy, nginx)

## gRPC vs REST — kapan pakai yang mana?

| Kriteria | REST | gRPC |
|----------|------|------|
| Browser client | ✅ | ❌ (butuh gRPC-Web) |
| Public API (3rd party) | ✅ | ❌ |
| Microservice → microservice | ❌ | ✅ |
| High performance | ❌ | ✅ |
| Streaming | ❌ | ✅ |
| Polyglot (multi-language) | Tergantung | ✅ |
| Human-readable debug | ✅ | ❌ |
| Simple CRUD | ✅ | Overkill |

> **Pattern umum**: gRPC untuk service-to-service (internal), REST/gRPC-Web untuk client-facing API.

## Cara Coba

```bash
# Terminal 1: Start gRPC server
npm run grpc:server

# Terminal 2: Run client demo (calls all methods)
npm run grpc:client
```

Output client:

```
┌─────────────────────────────────────────────┐
│     gRPC Client Demo — TaskService          │
└─────────────────────────────────────────────┘

📋 ListTasks (streaming):
   ⬜ [a1b2c3d4] Belajar gRPC
   ⬜ [e5f6g7h8] Belajar tRPC
   ⬜ [i9j0k1l2] Belajar API Gateway

➕ CreateTask:
   ✅ Created: [m3n4o5p6] Belajar gRPC streaming

🔍 GetTask:
   Found: [m3n4o5p6] Belajar gRPC streaming (done: false)

📝 UpdateTask:
   Updated: [m3n4o5p6] done=true

🗑️  DeleteTask:
   Deleted: success=true

❌ Error handling (GetTask non-existent):
   Error: Task not found
```

## Struktur File

```
06-grpc/
  task.proto     → Protocol Buffers schema (service + message definitions)
  server.ts      → gRPC server implementing TaskService
  client.ts      → gRPC client calling all RPC methods
  README.md      → Penjelasan ini
```
