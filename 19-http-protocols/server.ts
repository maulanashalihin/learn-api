/**
 * 19-http-protocols/server.ts
 *
 * Demonstrate HTTP/1.1 vs HTTP/2 side-by-side di satu process.
 *
 * HTTP/1.1 server (port 3011):
 *   - Head-of-line blocking: request lambat block request berikutnya
 *   - Text-based protocol: header human-readable
 *   - One request per connection (keep-alive helps, tapi masih serial)
 *
 * HTTP/2 server (port 3012):
 *   - Multiplexing: multiple request concurrent di satu connection
 *   - Binary framing: tidak human-readable, tapi efisien
 *   - HPACK header compression: header di-compress, tidak dikirim ulang
 *   - Server Push: server kirim resource sebelum client minta
 *
 * HTTP/3 (QUIC):
 *   - Tidak didukung native Node.js (butuh QUIC/UDP)
 *   - Bun 1.4+ support: Bun.serve({ http3: true, tls: {...} })
 *   - Lihat 18-cr-sqlite/ untuk demo HTTP/3 cross-server
 */

import http from "node:http";
import http2 from "node:http2";
import { generateId, type Task } from "../shared/types.js";

// ─── Self-signed cert untuk HTTP/2 (butuh TLS) ─────────────────
import { generateSelfSignedCert } from "./cert.js";
const cert = generateSelfSignedCert();

// ─── Shared state ──────────────────────────────────────────────
const tasks = new Map<string, Task>();
const now = () => new Date().toISOString();

tasks.set(generateId(), { id: generateId(), title: "Belajar HTTP/1.1", done: false, createdAt: now() });
tasks.set(generateId(), { id: generateId(), title: "Belajar HTTP/2", done: false, createdAt: now() });
tasks.set(generateId(), { id: generateId(), title: "Belajar HTTP/3", done: false, createdAt: now() });

function jsonBody(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function slowOperation(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── HTTP/1.1 Server (port 3011) ───────────────────────────────
const HTTP1_PORT = 3011;

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${HTTP1_PORT}`);

  if (url.pathname === "/tasks" && req.method === "GET") {
    // Slow endpoint — simulate DB query 2000ms
    // Di HTTP/1.1, request ini BLOCK request berikutnya di same connection
    await slowOperation(2000);
    jsonBody(res, { protocol: "HTTP/1.1", count: tasks.size, tasks: [...tasks.values()] });
    return;
  }

  if (url.pathname === "/fast" && req.method === "GET") {
    // Fast endpoint — harusnya instant, tapi kalau ada request /tasks
    // yang lagi jalan di connection yang sama, ini harus nunggu
    jsonBody(res, { protocol: "HTTP/1.1", message: "fast response", timestamp: Date.now() });
    return;
  }

  if (url.pathname === "/headers" && req.method === "GET") {
    // Show raw HTTP/1.1 headers — text-based, dikirim utuh setiap request
    const headers = { ...req.headers };
    jsonBody(res, {
      protocol: "HTTP/1.1",
      message: "Header dikirim sebagai text utuh setiap request — tidak ada compression",
      headers,
      headerSize: JSON.stringify(headers).length,
    });
    return;
  }

  jsonBody(res, { error: "Not found" }, 404);
}).listen(HTTP1_PORT, () => {
  console.log(`┌─ HTTP/1.1 server ─────────────────────────────┐`);
  console.log(`│  http://localhost:${HTTP1_PORT}                     │`);
  console.log(`│  GET /tasks   (slow: 2000ms — HOL blocking)  │`);
  console.log(`│  GET /fast    (instant — tapi nunggu /tasks) │`);
  console.log(`│  GET /headers (show raw text headers)        │`);
  console.log(`└────────────────────────────────────────────────┘`);
});

// ─── HTTP/2 Server (port 3012) ─────────────────────────────────
const HTTP2_PORT = 3012;

http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: true })
  .on("stream", async (stream, headers) => {
    const path = headers[":path"] ?? "/";
    const method = headers[":method"] ?? "GET";

    if (path === "/tasks" && method === "GET") {
      // Slow endpoint — tapi di HTTP/2, ini TIDAK block request lain
      // Multiple streams concurrent di satu connection (multiplexing)
      await slowOperation(2000);
      const body = JSON.stringify({ protocol: "HTTP/2", count: tasks.size, tasks: [...tasks.values()] });
      stream.respond({ "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      stream.end(body);
      return;
    }

    if (path === "/fast" && method === "GET") {
      // Di HTTP/2, /fast langsung return bahkan kalau /tasks lagi jalan
      // karena multiplexing — setiap stream independen
      const body = JSON.stringify({ protocol: "HTTP/2", message: "fast response (multiplexed!)", timestamp: Date.now() });
      stream.respond({ "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      stream.end(body);
      return;
    }

    if (path === "/push" && method === "GET") {
      // HTTP/2 Server Push — server kirim resource sebelum client minta
      // Client request /push → server response + push /tasks otomatis
      // Note: curl disable push by default. Browser support: Chrome 103+ removed it.
      // Server Push sudah deprecated di praktik — tapi konsep penting dipahami.
      const body = JSON.stringify({
        protocol: "HTTP/2",
        message: "main response. Server Push attempted (may be rejected by client).",
        pushNote: "curl disable push streams. Browser: Chrome removed push in v103. Concept still important.",
      });

      try {
        stream.pushStream({ ":path": "/tasks" }, (err, pushStream) => {
          if (err) return;
          const pushBody = JSON.stringify({ protocol: "HTTP/2 (pushed)", tasks: [...tasks.values()] });
          pushStream.respond({ "content-type": "application/json", "content-length": Buffer.byteLength(pushBody) });
          pushStream.end(pushBody);
        });
      } catch {
        // Client disabled push streams (curl, some browsers) — graceful fallback
      }

      stream.respond({ "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      stream.end(body);
      return;
    }

    if (path === "/headers" && method === "GET") {
      // HTTP/2 pakai HPACK — header di-compress dengan dictionary
      // Header yang sama (User-Agent, Accept) tidak dikirim ulang
      const reqHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!k.startsWith(":")) reqHeaders[k] = String(v);
      }
      const body = JSON.stringify({
        protocol: "HTTP/2",
        message: "Header di-compress via HPACK — dictionary + Huffman encoding",
        headers: reqHeaders,
        headerSize: JSON.stringify(reqHeaders).length,
        note: "Ukuran sebenarnya lebih kecil karena HPACK compression",
      });
      stream.respond({ "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      stream.end(body);
      return;
    }

    const body = JSON.stringify({ error: "Not found" });
    stream.respond({ "content-type": "application/json", "content-length": Buffer.byteLength(body), ":status": 404 });
    stream.end(body);
  })
  .listen(HTTP2_PORT, () => {
    console.log(`┌─ HTTP/2 server ───────────────────────────────┐`);
    console.log(`│  https://localhost:${HTTP2_PORT}                    │`);
    console.log(`│  GET /tasks   (slow: 2000ms — NOT blocking)  │`);
    console.log(`│  GET /fast    (instant — multiplexed!)       │`);
    console.log(`│  GET /push    (server push demo)             │`);
    console.log(`│  GET /headers (HPACK compressed headers)     │`);
    console.log(`└────────────────────────────────────────────────┘`);
    console.log("");
    console.log(`💡 Test HTTP/1.1 head-of-line blocking:`);
    console.log(`   curl http://localhost:${HTTP1_PORT}/tasks & curl http://localhost:${HTTP1_PORT}/fast`);
    console.log("");
    console.log(`💡 Test HTTP/2 multiplexing (no blocking):`);
    console.log(`   curl -k https://localhost:${HTTP2_PORT}/tasks & curl -k https://localhost:${HTTP2_PORT}/fast`);
  });
