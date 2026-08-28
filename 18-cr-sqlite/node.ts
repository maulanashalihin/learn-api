/**
 * node.ts — cr-sqlite node (in-app, bukan sidecar).
 *
 * Ini adalah cara pakai cr-sqlite di production:
 * 1. openDB() — load extension, mark CRR tables
 * 2. startSync() — background changeset exchange + /sync endpoint
 * 3. db.query() — write/read NORMAL, tidak lewat HTTP
 *
 * /write endpoint di sini HANYA untuk demo (supaya demo.ts bisa
 * trigger write via curl). Production app tidak butuh /write —
 * write langsung pakai db.query().
 *
 * Usage:
 *   bun run 18-cr-sqlite/node.ts <node-id> <port> <db-path> <extension> <peer-url>
 */

import { openDB } from "./db.ts";
import { startSync } from "./sync.ts";

const [nodeIdStr, portStr, dbPath, extensionPath, ...peers] = process.argv.slice(2);
const nodeId = parseInt(nodeIdStr ?? "1");
const port = parseInt(portStr ?? "3001");

console.log(`[Node ${nodeId}] Starting on :${port}, db: ${dbPath}`);
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

// 2. Start sync — background loop + /sync endpoint
const stopSync = startSync(db, { nodeId, port, peers });

// 3. Demo endpoint — HANYA untuk demo.ts
// Production app: write pakai db.query() langsung, tidak butuh /write
const server = Bun.serve({
  port: port + 10000,  // demo endpoint di port terpisah (misal 13001)
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/write" && req.method === "POST") {
      const body = await req.json();
      // INI cara write cr-sqlite: db.query() biasa, CRDT metadata auto-tracked
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

console.log(`[Node ${nodeId}] Demo /write on http://0.0.0.0:${port + 10000}`);

// Graceful shutdown
function shutdown() {
  stopSync();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
