/**
 * node.ts — cr-sqlite node (in-app, SATU server, SATU proses).
 *
 * Ini cara pakai cr-sqlite di production:
 * 1. openDB() — load extension, create schema, mark CRR
 * 2. startPushLoop() — background changeset push ke peers
 * 3. Bun.serve() — SATU server: route app + route sync
 * 4. db.query() — write/read normal
 *
 * /write endpoint HANYA untuk demo. Production app: write pakai
 * db.query() langsung di route manapun.
 *
 * Usage:
 *   bun run 18-cr-sqlite/node.ts <node-id> <port> <db-path> <extension> <cert-path> <key-path> [peer-url...]
 */

import { openDB } from "./db.ts";
import { syncRoutes, startPushLoop } from "./sync.ts";

const [nodeIdStr, portStr, dbPath, extensionPath, certPath, keyPath, ...peers] = process.argv.slice(2);
const nodeId = parseInt(nodeIdStr ?? "1");
const port = parseInt(portStr ?? "3001");
const intervalMs = parseInt(process.env.SYNC_INTERVAL ?? "2000");

console.log(`[Node ${nodeId}] Starting on :${port}, db: ${dbPath}, interval: ${intervalMs}ms`);
console.log(`[Node ${nodeId}] Peers: ${peers.length ? peers.join(", ") : "none (standalone)"}`);

// 1. Open DB with crsqlite extension — IN-APP
const { db, close } = openDB({
  dbPath,
  extensionPath,
  tables: ["users"],
  schema: `
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT,
      city TEXT
    )
  `,
});

// 2. Start background push loop — proses yang sama, bukan sidecar
const stopPush = startPushLoop(db, { nodeId, peers, intervalMs });

// 3. SATU HTTP server — route app + route sync di tempat yang sama
const server = Bun.serve({
  port,
  // HTTP/3 over QUIC — multiple streams, no head-of-line blocking
  // Requires TLS (QUIC mandates encryption)
  tls: certPath && certPath !== "-" && keyPath && keyPath !== "-" ? {
    cert: Bun.file(certPath),
    key: Bun.file(keyPath),
  } : undefined,
  http3: certPath && certPath !== "-",  // enable HTTP/3 only if TLS is configured
  async fetch(req) {
    // Sync routes: /sync, /health, /users
    const syncRes = await syncRoutes(db, nodeId, req);
    if (syncRes) return syncRes;

    const url = new URL(req.url);

    // Demo endpoint — HANYA untuk demo.ts
    // Production: write pakai db.query() di route manapun
    if (url.pathname === "/write" && req.method === "POST") {
      const body = await req.json();
      db.query("INSERT OR REPLACE INTO users(id, name, city) VALUES (?, ?, ?)").run(
        body.id,
        body.name,
        body.city,
      );
      console.log(`[Node ${nodeId}] Wrote user ${body.id}: ${body.name} (${body.city})`);
      return Response.json({ ok: true, node: nodeId });
    }

    return new Response("Not found", { status: 404 });
  },
});

const hasTls = certPath && certPath !== "-";
console.log(`[Node ${nodeId}] HTTP${hasTls ? "/3" : "/1.1"} server on ${hasTls ? "https" : "http"}://0.0.0.0:${port}`);

// Graceful shutdown
function shutdown() {
  stopPush();
  console.log(`[Node ${nodeId}] Shutting down...`);
  close();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
