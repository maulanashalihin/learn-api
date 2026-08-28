/**
 * cr-sqlite multi-writer replication app.
 *
 * Setiap node jalan HTTP server dengan:
 * - /health  — status check
 * - /write   — insert/update user (trigger CRDT metadata)
 * - /users   — list all users
 * - /sync    — receive changesets from peer (INSERT INTO crsql_changes)
 *
 * Background loop: export local crsql_changes → POST /sync ke semua peer.
 *
 * Prerequisite:
 *   1. Download crsqlite extension:
 *      # Linux x86_64
 *      wget https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-linux-x86_64.zip
 *      unzip crsqlite-linux-x86_64.zip
 *      # macOS arm64
 *      wget https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-darwin-arm64.zip
 *      unzip crsqlite-darwin-arm64.zip
 *
 *   2. Run:
 *      bun run 18-cr-sqlite/replicate.ts --node-id 1 --port 3001 \
 *        --db /tmp/crsql-node1.db --extension ./crsqlite.so \
 *        --peer http://localhost:3002 --table users
 */

import { Database } from "bun:sqlite";

// --- CLI args ---
const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const NODE_ID = parseInt(arg("node-id", "1"));
const PORT = parseInt(arg("port", "3001"));
const DB_PATH = arg("db", `/tmp/crsql-node${NODE_ID}.db`);
const EXTENSION = arg("extension", process.platform === "darwin" ? "./crsqlite.dylib" : "./crsqlite.so");
const PEERS = args
  .filter((_, i, a) => a[i - 1] === "--peer")
  .map((v) => (v.startsWith("http") ? v : `http://${v}`));
const TABLES = args
  .filter((_, i, a) => a[i - 1] === "--table");

console.log(`[Node ${NODE_ID}] Starting on :${PORT}, db: ${DB_PATH}`);
console.log(`[Node ${NODE_ID}] Peers: ${PEERS.length ? PEERS.join(", ") : "none (standalone)"}`);
console.log(`[Node ${NODE_ID}] CRR tables: ${TABLES.join(", ") || "none"}`);

// --- Database setup ---
const db = new Database(DB_PATH);
db.loadExtension(EXTENSION);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY NOT NULL,
    name TEXT,
    city TEXT
  )
`);

// Mark as CRR (conflict-free replicated relation)
db.exec('SELECT crsql_as_crr("users")');

// --- Binary blob handling ---
// crsql_changes has pk (Uint8Array) and site_id (Uint8Array).
// JSON.stringify turns Uint8Array into {"0":1} — broken on receive.
// Convert to number[] for transport, reconstruct as Uint8Array on apply.
function encodeChanges(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...r,
    pk: r.pk instanceof Uint8Array ? Array.from(r.pk as Uint8Array) : r.pk,
    site_id:
      r.site_id instanceof Uint8Array
        ? Array.from(r.site_id as Uint8Array)
        : r.site_id,
  }));
}

function decodeChange(ch: Record<string, unknown>): unknown[] {
  return [
    ch.table,
    ch.pk instanceof Uint8Array ? ch.pk : new Uint8Array(ch.pk as number[]),
    ch.cid,
    ch.val,
    ch.col_version,
    ch.db_version,
    ch.site_id instanceof Uint8Array
      ? ch.site_id
      : new Uint8Array(ch.site_id as number[]),
    ch.cl,
    ch.seq,
  ];
}

// --- HTTP server ---
let lastSentVersion = 0;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const count = db.query("SELECT count(*) as c FROM users").get() as { c: number };
      return Response.json({ node: NODE_ID, users: count.c, peers: PEERS });
    }

    if (url.pathname === "/write" && req.method === "POST") {
      const body = await req.json();
      db.query("INSERT OR REPLACE INTO users(id, name, city) VALUES (?, ?, ?)").run(
        body.id,
        body.name,
        body.city,
      );
      console.log(`[Node ${NODE_ID}] Wrote user ${body.id}: ${body.name} (${body.city})`);
      return Response.json({ ok: true, node: NODE_ID });
    }

    if (url.pathname === "/sync" && req.method === "POST") {
      const changes = (await req.json()) as Record<string, unknown>[];
      if (changes.length === 0) return Response.json({ ok: true, applied: 0 });

      const stmt = db.prepare(
        "INSERT INTO crsql_changes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let applied = 0;
      for (const ch of changes) {
        try {
          stmt.run(...decodeChange(ch));
          applied++;
        } catch {
          // Duplicate or conflict — cr-sqlite handles via LWW
        }
      }
      if (applied > 0) {
        const count = db.query("SELECT count(*) as c FROM users").get() as { c: number };
        console.log(`[Node ${NODE_ID}] Received ${applied} changesets, now ${count.c} users`);
      }
      return Response.json({ ok: true, applied });
    }

    if (url.pathname === "/users") {
      const rows = db.query("SELECT * FROM users ORDER BY id").all();
      return Response.json({ node: NODE_ID, users: rows });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[Node ${NODE_ID}] HTTP server on http://0.0.0.0:${PORT}`);

// --- Background sync loop ---
let syncTimer: ReturnType<typeof setInterval> | null = null;

if (PEERS.length > 0) {
  syncTimer = setInterval(async () => {
    try {
      const changes = db
        .query("SELECT * FROM crsql_changes WHERE db_version > ?")
        .all(lastSentVersion) as Record<string, unknown>[];

      if (changes.length === 0) return;

      lastSentVersion = Math.max(
        ...changes.map((c) => c.db_version as number),
      );

      const payload = JSON.stringify(encodeChanges(changes));

      for (const peer of PEERS) {
        try {
          const res = await fetch(`${peer}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          });
          const result = (await res.json()) as { applied: number };
          if (result.applied > 0) {
            console.log(
              `[Node ${NODE_ID}] Pushed ${changes.length} changesets to ${peer}, applied ${result.applied}`,
            );
          }
        } catch {
          // Peer unreachable — retry next interval
        }
      }
    } catch {
      // Query error — skip this tick
    }
  }, 2000);
}

// --- Graceful shutdown ---
function shutdown() {
  if (syncTimer) clearInterval(syncTimer);
  console.log(`[Node ${NODE_ID}] Shutting down...`);
  db.exec("SELECT crsql_finalize()");
  db.close();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
