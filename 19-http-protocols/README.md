# 19 — HTTP Protocols: HTTP/1.1 vs HTTP/2 vs HTTP/3

> **Protokol transport yang bikin API kamu cepat atau lambat.** Tiga generasi HTTP — dari text-based serial ke binary multiplexed ke UDP-based QUIC.

## Apa itu HTTP Protocol?

HTTP protocol = **aturan bagaimana data dikirim antara client dan server**. URL, method, status code sama — tapi cara data di-pack di wire beda.

```
HTTP/1.1 (1997)     HTTP/2 (2015)        HTTP/3 (2022)
Text-based          Binary framing       QUIC (UDP)
Serial              Multiplexed          Multiplexed + no HOL
TCP                 TCP                  UDP
TLS optional        TLS required*        TLS required (built-in)
```

## Perbandingan

| | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---|---|---|---|
| **Transport** | TCP | TCP | UDP (QUIC) |
| **Format** | Text (human-readable) | Binary (framed) | Binary (framed) |
| **Multiplexing** | ❌ serial | ✅ concurrent streams | ✅ concurrent streams |
| **Head-of-line blocking** | ✅ per connection | ✅ per TCP packet | ❌ per stream only |
| **Header compression** | ❌ text utuh | ✅ HPACK | ✅ QPACK |
| **Server Push** | ❌ | ✅ (deprecated) | ✅ (deprecated) |
| **Connection setup** | TCP (1 RTT) | TCP + TLS (2-3 RTT) | QUIC (1 RTT, 0-RTT resume) |
| **IP migration** | ❌ reconnect | ❌ reconnect | ✅ connection survives |
| **TLS** | Optional | Required (browser) | Required (built-in) |
| **Node.js support** | ✅ native | ✅ `http2` module | ❌ not supported |
| **Bun support** | ✅ `Bun.serve` | ✅ `Bun.serve` | ✅ `Bun.serve({ http3: true })` |

## HTTP/1.1 — Text-based Serial

### Cara kerja

```
Client → Server:
  GET /tasks HTTP/1.1\r\n      ← request line (text)
  Host: localhost:3011\r\n     ← header (text, dikirim utuh)
  User-Agent: curl/8.7\r\n
  Accept: */*\r\n
  \r\n                          ← header end

Server → Client:
  HTTP/1.1 200 OK\r\n           ← status line (text)
  Content-Type: application/json\r\n
  Content-Length: 42\r\n
  \r\n
  {"tasks":[...]}\r\n           ← body
```

### Head-of-line blocking

```
Connection 1 (HTTP/1.1 keep-alive):
  Request 1: GET /tasks   (2000ms — DB query lambat)
  Request 2: GET /fast    (1ms — harusnya instant)
  
  Timeline:
  ├──── /tasks (2000ms) ────┤── /fast (1ms) ──┤
  ^                         ^
  /fast nunggu /tasks selesai dulu
  
  Total: 2001ms untuk /fast (harusnya 1ms)
```

Di HTTP/1.1, satu connection = satu request pada satu waktu. Keep-alive reuse connection, tapi request masih **serial**. Browser workaround: 6 parallel connections per domain.

### Kelebihan

- **Sederhana** — text-based, debugging mudah (telnet, curl -v)
- **Universal** — semua server/proxy/CDN support
- **No TLS required** — bisa plain HTTP

### Kekurangan

- **Head-of-line blocking** — request lambat block request berikutnya
- **Header overhead** — header dikirim utuh setiap request, tidak di-compress
- **6 connection limit** — browser batasi 6 connection per domain

## HTTP/2 — Binary Multiplexed

### Cara kerja

```
Client → Server (HTTP/2):
  [Binary frame: STREAM 1, GET /tasks]     ← stream 1
  [Binary frame: STREAM 3, GET /fast]      ← stream 3 (concurrent!)
  [Binary frame: STREAM 1, GET /headers]   ← stream 1 (setelah /tasks)

  Multiplexing: multiple stream di 1 TCP connection
  Stream 1: ├──── /tasks (2000ms) ────────────┤
  Stream 3: ├─ /fast (1ms) ─┤                   ← langsung selesai!
  
  /fast tidak nunggu /tasks — stream independen
```

### Binary framing

HTTP/2 tidak kirim text. Data di-pack dalam **binary frames**:

```
Frame structure (9 byte header + payload):
  ┌──────────┬──────────┬──────────┐
  │ Length    │ Type     │ Flags    │
  │ (3 byte)  │ (1 byte) │ (1 byte) │
  ├──────────┼──────────┼──────────┤
  │ Stream ID (4 byte)  │ Reserved │
  ├──────────┴──────────┴──────────┤
  │ Payload (variable)              │
  └─────────────────────────────────┘

Frame types: DATA, HEADERS, PRIORITY, RST_STREAM, SETTINGS, PUSH_PROMISE, PING, GOAWAY, WINDOW_UPDATE, CONTINUATION
```

### HPACK header compression

```
Request 1: GET /tasks
  Header: :method GET, :path /tasks, user-agent curl/8.7, accept */*
  HPACK: encode dengan dictionary + Huffman → ~20 bytes

Request 2: GET /fast
  Header: :method GET, :path /fast, user-agent curl/8.7, accept */*
  HPACK: user-agent + accept sudah di dictionary → cuma kirim :path baru → ~5 bytes
```

Header yang sama (`user-agent`, `accept`) tidak dikirim ulang. HPACK pakai **static dictionary** (61 common headers) + **dynamic dictionary** (header yang sudah dikirim di connection ini).

### Server Push (deprecated)

```
Client: GET /push
Server: 
  → Response: {"message": "main response"}
  → Push: /tasks (sebelum client minta)
  
  Server kirim resource yang client "pasti butuh" tanpa nunggu request.
  Masalah: server tidak tahu client butuh apa → sering push yang tidak dipakai.
  Chrome removed push di v103 (2022). HTTP/3 masih support tapi deprecated.
```

### Kelebihan

- **Multiplexing** — no head-of-line blocking (di application layer)
- **HPACK** — header di-compress, hemat bandwidth
- **1 connection** — tidak butuh 6 connection per domain
- **Server Push** — (deprecated tapi konsep penting)

### Kekurangan

- **TCP head-of-line blocking** — kalau 1 TCP packet loss, semua stream nunggu retransmit
- **TLS required** — browser hanya support h2 over TLS
- **Binary** — tidak human-readable, debugging butuh tools (nghttp, curl --http2)

## HTTP/3 — QUIC (UDP)

### Cara kerja

```
HTTP/3 tidak pakai TCP. Pakai QUIC — UDP-based protocol dengan TLS 1.3 built-in.

Client → Server (HTTP/3 over QUIC):
  UDP packet:
    [QUIC header + TLS 1.3 + HTTP/3 frame]
    
  Connection setup: 1 RTT (vs HTTP/2: 2-3 RTT)
  0-RTT resume: client yang sudah pernah connect bisa kirim data langsung

  Stream 1: ├──── /tasks (2000ms) ────────────┤
  Stream 3: ├─ /fast (1ms) ─┤                   ← multiplexed seperti HTTP/2
  
  Kalau packet stream 1 loss:
  Stream 3 TIDAK nunggu — hanya stream 1 yang retransmit
  (HTTP/2: semua stream nunggu TCP retransmit)
```

### QUIC = HTTP/2 + UDP + TLS 1.3

```
HTTP/2 layer stack:
  HTTP/2 frames
  TLS 1.2/1.3
  TCP           ← head-of-line blocking di sini
  IP

HTTP/3 layer stack:
  HTTP/3 frames (QPACK instead of HPACK)
  QUIC           ← multiplexing + retransmit per-stream
  UDP            ← no head-of-line blocking
  IP
```

### Connection migration

```
HTTP/2 (TCP):
  Client WiFi: 192.168.1.5 → Server
  Client switch ke 4G: 10.0.0.5 → Server
  TCP connection: BROKEN (IP changed)
  → Reconnect: 2-3 RTT

HTTP/3 (QUIC):
  Client WiFi: 192.168.1.5 → Server (Connection ID: abc123)
  Client switch ke 4G: 10.0.0.5 → Server (Connection ID: abc123)
  QUIC: Connection ID tetap sama → connection survives!
  → No reconnect needed
```

### Kelebihan

- **No head-of-line blocking** — packet loss di 1 stream tidak block stream lain
- **1 RTT connection setup** — vs 2-3 RTT HTTP/2
- **0-RTT resume** — client yang pernah connect langsung kirim data
- **Connection migration** — IP change (WiFi → 4G) tidak kill connection
- **Built-in TLS** — TLS 1.3 mandatory, tidak ada plain HTTP/3

### Kekurangan

- **UDP** — beberapa firewall/network block UDP → fallback ke TCP
- **CPU intensive** — QUIC di userspace (TCP di kernel, lebih optimized)
- **New** — adoption masih growing (CDN support: Cloudflare, Google, Fastly)
- **Node.js** — tidak support native (butuh QUIC module atau Bun)

## Cara Coba

### Start server

```bash
npm run http-protocols
```

### HTTP/1.1 — head-of-line blocking demo

```bash
# Request /tasks (slow: 2000ms) dan /fast (instant) di background
# Di HTTP/1.1, /fast nunggu /tasks selesai
curl http://localhost:3011/tasks &
curl http://localhost:3011/fast
# /fast return setelah ~2000ms (nunggu /tasks)

# Lihat raw text headers
curl http://localhost:3011/headers
```

### HTTP/2 — multiplexing demo

```bash
# Request /tasks (slow) dan /fast di background
# Di HTTP/2, /fast langsung return (multiplexed, tidak nunggu)
curl -k https://localhost:3012/tasks &
curl -k https://localhost:3012/fast
# /fast return instantly (~1ms), /tasks tetap 2000ms

# Server Push (curl disable push, tapi konsepnya ada)
curl -k https://localhost:3012/push

# HPACK compressed headers
curl -k https://localhost:3012/headers
```

### HTTP/3 — lihat module 18

HTTP/3 tidak didukung Node.js. Demo HTTP/3 ada di [18-cr-sqlite](../18-cr-sqlite/) menggunakan Bun 1.4:

```bash
# Bun.serve dengan HTTP/3
Bun.serve({
  port: 3001,
  tls: { cert: Bun.file("cert.pem"), key: Bun.file("key.pem") },
  http3: true,  // listen UDP + TCP di port yang sama
  fetch(req) { return new Response("hi over HTTP/3!"); },
});

// Client
fetch("https://server:3001/", { protocol: "http3" });
```

## Kapan pakai apa?

| Scenario | Protocol | Kenapa |
|---|---|---|
| **Internal API** | HTTP/1.1 | Simple, no TLS needed, low overhead |
| **Public API** | HTTP/2 | Multiplexing, HPACK, CDN support |
| **Mobile app** | HTTP/3 | Connection migration (WiFi → 4G), 0-RTT |
| **High packet loss** | HTTP/3 | No TCP head-of-line blocking |
| **Real-time sync** | HTTP/3 | QUIC streams, low latency |
| **Legacy infra** | HTTP/1.1 | Universal support, no proxy config |

**Praktik nyata:** mayoritas API masih HTTP/1.1 atau HTTP/2. HTTP/3 growing tapi belum mainstream. CDN (Cloudflare, Vercel) auto-negotiate: client yang support HTTP/3 pakai HTTP/3, sisanya fallback.

## Evolusi HTTP

```
HTTP/0.9 (1991)  → GET /, response = raw text, no headers
HTTP/1.0 (1996)  → headers, status codes, Content-Type
HTTP/1.1 (1997)  → keep-alive, chunked transfer, Host header
HTTP/2   (2015)  → multiplexing, HPACK, binary, server push
HTTP/3   (2022)  → QUIC/UDP, 0-RTT, connection migration, QPACK
```

Setiap generasi solve masalah generasi sebelumnya:

- 1.0 → 1.1: connection reuse (keep-alive)
- 1.1 → 2: multiplexing (no HOL blocking) + header compression
- 2 → 3: TCP → UDP (no TCP HOL blocking) + connection migration

## Struktur File

```
19-http-protocols/
  server.ts     → HTTP/1.1 (port 3011) + HTTP/2 (port 3012) side-by-side
  cert.ts       → Self-signed cert generator untuk HTTP/2 TLS
  README.md     → Penjelasan ini
```

## Further Reading

- [HTTP/2 spec (RFC 7540)](https://httpwg.org/specs/rfc7540.html) — binary framing, HPACK
- [HTTP/3 spec (RFC 9114)](https://httpwg.org/specs/rfc9114.html) — QUIC, QPACK
- [QUIC (RFC 9000)](https://www.rfc-editor.org/rfc/rfc9000.html) — UDP transport, 0-RTT
- [Bun HTTP/3 docs](https://bun.com/docs/runtime/http/server#http3) — `Bun.serve({ http3: true })`
- [18-cr-sqlite](../18-cr-sqlite/) — HTTP/3 cross-server demo dengan Bun 1.4
