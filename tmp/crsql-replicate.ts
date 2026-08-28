/**
 * cr-sqlite multi-writer replication test with Bun.
 *
 * Usage:
 *   bun run replicate.ts <node-id> <port> <peer-url>
 *
 * Example Node 1:
 *   bun run replicate.ts 1 3001 http://185.111.159.99:3002
 * Example Node 2:
 *   bun run replicate.ts 2 3002 http://51.79.159.231:3001
 *
 * Then write to either node via HTTP:
 *   curl -X POST http://localhost:3001/write -H 'Content-Type: application/json' \
 *     -d '{"id":1,"name":"Alice","city":"Singapore"}'
 */

import { Database } from "bun:sqlite";

const NODE_ID = parseInt(process.argv[2] ?? "1");
const PORT = parseInt(process.argv[3] ?? "3001");
const PEER_URL = process.argv[4] ?? "";
const DB_PATH = `/tmp/crsql-test/node${NODE_ID}.db`;

console.log(`[Node ${NODE_ID}] Starting on :${PORT}, peer: ${PEER_URL || "none"}`);

const db = new Database(DB_PATH);
db.loadExtension("./crsqlite.so");
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
db.exec('SELECT crsql_as_crr("users")');

// Track last synced db_version to avoid re-sending
let lastSentVersion = 0;

// --- Binary blob handling for JSON transport ---
// crsql_changes has pk (Uint8Array) and site_id (Uint8Array) columns.
// JSON.stringify turns Uint8Array into {"0":1,"1":9} — broken on receive.
// Convert to number[] for transport, reconstruct as Uint8Array on apply.
function encodeChanges(rows: any[]): any[] {
  return rows.map((r) => ({
    ...r,
    pk: r.pk instanceof Uint8Array ? Array.from(r.pk) : r.pk,
    site_id: r.site_id instanceof Uint8Array ? Array.from(r.site_id) : r.site_id,
  }));
}

function decodeChange(ch: any): any[] {
  return [
    ch.table,
    ch.pk instanceof Uint8Array ? ch.pk : new Uint8Array(ch.pk),
    ch.cid,
    ch.val,
    ch.col_version,
    ch.db_version,
    ch.site_id instanceof Uint8Array ? ch.site_id : new Uint8Array(ch.site_id),
    ch.cl,
    ch.seq,
  ];
}

// --- HTTP server ---
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      const count = db.query("SELECT count(*) as c FROM users").get() as { c: number };
      return Response.json({
        node: NODE_ID,
        users: count.c,
        peer: PEER_URL || "none",
      });
    }

    // Write endpoint
    if (url.pathname === "/write" && req.method === "POST") {
      const body = await req.json();
      db.query("INSERT OR REPLACE INTO users(id, name, city) VALUES (?, ?, ?)").run(
        body.id,
        body.name,
        body.city
      );
      console.log(`[Node ${NODE_ID}] Wrote user ${body.id}: ${body.name} (${body.city})`);
      return Response.json({ ok: true, node: NODE_ID });
    }

    // Sync endpoint — receive changesets from peer
    if (url.pathname === "/sync" && req.method === "POST") {
      const changes = await req.json() as any[];
      if (changes.length === 0) return Response.json({ ok: true, applied: 0 });

      const stmt = db.prepare(
        "INSERT INTO crsql_changes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      let applied = 0;
      for (const ch of changes) {
        try {
          stmt.run(...decodeChange(ch));
          applied++;
        } catch (e) {
          // Duplicate or conflict — cr-sqlite handles via LWW
        }
      }
      if (applied > 0) {
        const count = db.query("SELECT count(*) as c FROM users").get() as { c: number };
        console.log(`[Node ${NODE_ID}] Received ${applied} changesets, now ${count.c} users`);
      }
      return Response.json({ ok: true, applied });
    }

    // Read all users
    if (url.pathname === "/users") {
      const rows = db.query("SELECT * FROM users ORDER BY id").all();
      return Response.json({ node: NODE_ID, users: rows });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[Node ${NODE_ID}] HTTP server on http://0.0.0.0:${PORT}`);

// --- Background sync loop ---
if (PEER_URL) {
  const syncInterval = setInterval(async () => {
    try {
      // Export local changes since last sync
      const changes = db
        .query("SELECT * FROM crsql_changes WHERE db_version > ?")
        .all(lastSentVersion) as any[];

      if (changes.length > 0) {
        // Update lastSentVersion to max db_version in this batch
        lastSentVersion = Math.max(...changes.map((c) => c.db_version));

        // Send to peer
        const res = await fetch(`${PEER_URL}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        body: JSON.stringify(encodeChanges(changes)),
        });
        const result = await res.json();
        if (result.applied > 0) {
          console.log(`[Node ${NODE_ID}] Pushed ${changes.length} changesets, peer applied ${result.applied}`);
        }
      }
    } catch (e) {
      // Peer not reachable — will retry next interval
    }
  }, 2000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    clearInterval(syncInterval);
    console.log(`[Node ${NODE_ID}] Shutting down...`);
    db.exec("SELECT crsql_finalize()");
    db.close();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(syncInterval);
    db.exec("SELECT crsql_finalize()");
    db.close();
    server.stop();
    process.exit(0);
  });
}
