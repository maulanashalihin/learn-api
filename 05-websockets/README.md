# 05 — WebSockets

## Apa itu WebSocket?

**WebSocket** adalah protokol komunikasi bi-directional di atas satu TCP connection. Dimulai dengan HTTP upgrade handshake, lalu protocol switch ke WebSocket frame protocol. Setelah itu, client dan server saling kirim pesan kapan saja — tidak perlu request-response cycle.

### Perbedaan dengan yang sudah kita pelajari

| Aspek | REST | SSE | WebSocket |
|-------|------|-----|-----------|
| Direction | Request → Response | Server → Client | **Bi-directional** |
| Connection | New per request | Persistent (1 conn) | Persistent (1 conn) |
| Protocol | HTTP | HTTP | **WS** (upgrade dari HTTP) |
| Client kirim data | Ya (request) | Tidak (hanya connect) | **Ya, kapan saja** |
| Binary data | Ya | Tidak | **Ya** |
| Use case | CRUD API | Notifications, feeds | **Chat, games, collab** |

## Cara Kerja

```
    ┌────────┐                              ┌────────┐
    │ Client │ ── HTTP GET (Upgrade: websocket) ──→ │ Server  │
    │        │ ←── HTTP 101 Switching Protocols ─── │         │
    │        │                                    │         │
    │        │ ←──── WebSocket frames ──────────── │         │
    │        │ ──── WebSocket frames ────────────→ │         │
    │        │ ←──── WebSocket frames ──────────── │         │
    │        │ ──── WebSocket frames ────────────→ │         │
    │        │         (persistent connection)     │         │
    └────────┘                              └────────┘
```

### 1. Handshake (HTTP Upgrade)

Client kirim HTTP request dengan header `Upgrade: websocket`:

```
GET / HTTP/1.1
Host: localhost:3005
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

Server respond dengan `101 Switching Protocols`:

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

Setelah ini, HTTP selesai. Connection sekarang pakai WebSocket frame protocol.

### 2. WebSocket Frames

Setelah handshake, data dikirim dalam frame format (bukan HTTP lagi):

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
|N|V|V|V|       |S|             |   (if payload len==126/127)   |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
|     Extended payload length continued, if payload len == 127  |
+ - - - - - - - - - - - - - - - +-------------------------------+
|                               |Masking-key, if MASK set to 1  |
+-------------------------------+-------------------------------+
| Masking-key (continued)       |          Payload Data         |
+-------------------------------- - - - - - - - - - - - - - - - +
:                     Payload Data continued ...                :
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
|                     Payload Data continued ...                |
+---------------------------------------------------------------+
```

- **FIN (1 bit)**: 1 = frame lengkap, 0 = fragment
- **Opcode (4 bits)**: 0x1=text, 0x2=binary, 0x8=close, 0x9=ping, 0xA=pong
- **MASK (1 bit)**: 1 = client data di-mask (wajib untuk client→server)
- **Payload length**: 7 bit, atau 16 bit (jika 126), atau 64 bit (jika 127)

> Library `ws` handle semua frame parsing untuk kita. Ini cuma untuk paham apa yang terjadi di wire level.

## WebSocket Events

| Event | Kapan | Browser API | Node.js (`ws`) |
|-------|-------|-------------|----------------|
| `open` | Connection established | `ws.onopen` | `ws.on("open")` |
| `message` | Data diterima | `ws.onmessage` | `ws.on("message")` |
| `close` | Connection closed | `ws.onclose` | `ws.on("close")` |
| `error` | Error terjadi | `ws.onerror` | `ws.on("error")` |
| `ping`/`pong` | Heartbeat | N/A (auto) | `ws.on("ping")` |

## Browser vs Node.js

### Browser (built-in WebSocket API)

```javascript
const ws = new WebSocket("ws://localhost:3005");

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "join", username: "alice" }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg);
};

ws.send(JSON.stringify({ type: "chat", text: "Hello!" }));
```

### Node.js (`ws` library)

```typescript
import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:3005");

ws.on("open", () => { /* ... */ });
ws.on("message", (data) => { /* ... */ });
ws.send(JSON.stringify({ /* ... */ }));
```

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Bi-directional**: client dan server saling push kapan saja
- **Low latency**: 1 TCP connection, no HTTP overhead per message
- **Binary support**: kirim binary data (images, audio, video frames)
- **Lightweight frames**: protocol overhead kecil (2-14 bytes vs HTTP headers)
- **Real-time**: ideal untuk chat, games, collaborative editing

### ❌ Kekurangan

- **No HTTP infrastructure**: proxy, CDN, load balancer butuh config khusus
- **Stateful**: server harus track connection state → harder to scale
- **No auto-reconnect**: client harus implement reconnect logic manual
- **Connection management**: handle ping/pong, timeout, cleanup manually
- **Security**: butuh origin validation, authentication per connection
- **Scaling**: butuh sticky sessions atau pub/sub (Redis) untuk multi-server

## WebSocket vs SSE — kapan pakai yang mana?

| Kriteria | Pilih SSE | Pilih WebSocket |
|----------|-----------|-----------------|
| Server push only | ✅ | Overkill |
| Client juga kirim data | ❌ | ✅ |
| Binary data | ❌ | ✅ |
| Auto-reconnect important | ✅ (built-in) | Manual |
| HTTP infrastructure (CDN, proxy) | ✅ | Butuh config |
| Chat / gaming | ❌ | ✅ |
| Notifications / feeds | ✅ | Overkill |

> **Rule of thumb**: Kalau cuma butuh server→client push, pakai SSE (simpler). Kalau butuh two-way, pakai WebSocket.

## Cara Coba

Butuh **2+ terminal** — server + client(s).

```bash
# Terminal 1: Start WebSocket server
npm run ws

# Terminal 2: Client 1
npm run ws:client alice

# Terminal 3: Client 2
npm run ws:client bob

# Type messages di client, akan broadcast ke semua client
# /quit untuk keluar
```

## Struktur File

```
05-websockets/
  server.ts     → WebSocket chat server (ws library)
  client.ts     → Interactive chat client (readline + ws)
  README.md     → Penjelasan ini
```
