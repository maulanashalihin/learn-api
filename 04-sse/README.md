# 04 — Server-Sent Events (SSE)

## Apa itu SSE?

**SSE** adalah mekanisme di mana server push data ke client via HTTP connection yang tetap terbuka. One-way: server → client saja.

### Analogi

- **REST**: Client tanya → Server jawab. (Request-Response)
- **Webhook**: Server push ke server lain via HTTP POST. (Server-to-Server)
- **SSE**: Server push ke client via HTTP stream. (Server-to-Client, one-way)
- **WebSocket**: Two-way, client dan server saling push. (Bi-directional)

## Cara Kerja

```
    ┌────────┐    GET /events (HTTP, keep-alive)    ┌────────┐
    │ Client │ ←─────────────────────────────────── │ Server  │
    │        │    data: {"event":"task.created"}     │         │
    │        │ ←─────────────────────────────────── │         │
    │        │    data: {"event":"task.completed"}   │         │
    │        │ ←─────────────────────────────────── │         │
    └────────┘    Connection stays open              └────────┘
```

1. Client buka HTTP GET ke `/events`
2. Server respond dengan `Content-Type: text/event-stream`
3. Server **keep connection open** dan kirim events secara terus-menerus
4. Client parse stream real-time
5. Kalau connection putus, **auto-reconnect** (browser EventSource built-in)

## SSE Wire Format

SSE pakai format text sederhana, dipisah oleh double newline (`\n\n`):

```
event: task.created
data: {"id":"123","title":"Belajar SSE","done":false}

event: task.completed
data: {"id":"123","done":true}

: heartbeat comment (ignored by client)

```

| Field | Fungsi | Wajib? |
|-------|--------|--------|
| `event:` | Named event type (client bisa listen ke event spesifik) | Optional |
| `data:` | Payload data (bisa multi-line) | Ya (untuk event dengan data) |
| `id:` | Event ID — client kirim `Last-Event-ID` header saat reconnect | Optional |
| `retry:` | Reconnect interval dalam ms | Optional |
| `:` | Comment — ignore, dipakai untuk heartbeat | Optional |

## Browser vs Node.js Client

### Browser (EventSource API — built-in)

```javascript
const es = new EventSource("http://localhost:3004/events");

// Listen ke specific event
es.addEventListener("task.created", (e) => {
  const task = JSON.parse(e.data);
  console.log("New task:", task);
});

es.addEventListener("task.completed", (e) => {
  console.log("Task completed:", JSON.parse(e.data));
});

// Auto-reconnect: browser handle automatically
// es.close() untuk disconnect
```

### Node.js (raw HTTP — seperti di client.ts)

Node.js (sebelum v22) gak punya EventSource built-in. Kita pakai `http.request` dan parse stream manual. Ini bagus untuk belajar — kita lihat exactly format SSE di wire level.

## SSE vs WebSocket vs Polling

| Aspek | Polling | SSE | WebSocket |
|-------|---------|-----|-----------|
| Direction | Client → Server | Server → Client | Bi-directional |
| Protocol | HTTP | HTTP | WS (upgrade dari HTTP) |
| Connection | New per request | Persistent (1 connection) | Persistent (1 connection) |
| Auto-reconnect | N/A (client polls) | ✅ Built-in | ❌ Manual |
| Binary data | ✅ | ❌ (text only) | ✅ |
| Max connections | Unlimited | 6 per domain (HTTP/1.1) | Unlimited |
| Complexity | Simple | Simple | Complex |
| Best for | Low-frequency updates | Server push (notifications, feeds) | Chat, gaming, bi-directional |

> **HTTP/1.1 limit**: browser max 6 SSE connections per domain. HTTP/2 = no limit. Penting kalau buka multiple tabs.

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Simple**: cuma HTTP, no protocol upgrade, no special library di browser
- **Auto-reconnect**: EventSource handle reconnect + resume via `Last-Event-ID`
- **HTTP infrastructure**: works dengan proxy, CDN, load balancer (HTTP compatible)
- **Lightweight**: no framing overhead seperti WebSocket
- **Named events**: client bisa subscribe ke event type spesifik

### ❌ Kekurangan

- **One-way only**: client gak bisa kirim data balik (perlu REST endpoint terpisah)
- **Text only**: gak support binary data (WebSocket support)
- **Connection limit**: 6 per domain di HTTP/1.1
- **No built-in ack**: server gak tahu client sudah process event (WebSocket punya)
- **Proxy issues**: some proxy buffer SSE stream (butuh `X-Accel-Buffering: no` di nginx)

## Use Case SSE

| Use Case | Kenapa SSE? |
|----------|-------------|
| Live notifications | Push-only, simple, auto-reconnect |
| Stock/crypto prices | Server push data, client gak perlu kirim balik |
| Dashboard real-time | Update metrics, server push saja |
| Chat (receive only) | Pesan masuk push ke client, kirim via REST |
| Progress bar (long task) | Server push progress updates |
| AI streaming response | LLM token streaming (seperti ChatGPT) |

> ChatGPT dan Claude pakai SSE untuk streaming response! LLM generate token per token, push ke client via SSE.

## Cara Coba

Butuh **2 terminal** — server dan client.

```bash
# Terminal 1: Start SSE server
npm run sse

# Terminal 2: Start SSE client
npm run sse:client

# Terminal 3: Trigger events
# Create task → client akan terima "task.created" event
curl -X POST http://localhost:3004/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Belajar SSE"}'

# Complete task → client terima "task.completed"
curl -X PATCH http://localhost:3004/tasks/<UUID> \
  -H 'Content-Type: application/json' \
  -d '{"done":true}'

# Delete task → client terima "task.deleted"
curl -X DELETE http://localhost:3004/tasks/<UUID>
```

Atau pakai `curl` sebagai SSE client (raw stream):

```bash
# curl akan terima stream terus-menerus
curl -N http://localhost:3004/events
# -N = --no-buffer, supaya curl flush output langsung
```

## Struktur File

```
04-sse/
  server.ts     → Express + SSE endpoint, broadcast ke clients
  client.ts     → Node.js SSE client (raw HTTP, parse manual)
  README.md     → Penjelasan ini
```
