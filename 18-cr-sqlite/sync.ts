/**
 * sync.ts — cr-sqlite changeset exchange.
 *
 * Library: background loop push local changesets ke peers,
 * HTTP endpoint receive changesets dari peers.
 *
 * App tinggal import startSync() — tidak perlu pikir transport.
 *
 * Usage:
 *   import { startSync } from "./sync.ts";
 *   const stop = startSync(db, { nodeId: 1, port: 3001, peers: ["http://peer:3002"] });
 *   // ... app write/read normal pakai db.query() ...
 *   stop();  // graceful shutdown
 */

import type { Database } from "bun:sqlite";

export interface SyncConfig {
  nodeId: number;
  port: number;
  peers: string[];
  intervalMs?: number;
}

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

export function startSync(db: Database, config: SyncConfig): () => void {
  const { nodeId, port, peers, intervalMs = 2000 } = config;
  let lastSentVersion = 0;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  // HTTP server — hanya untuk /sync (receive changesets) + /health + /users
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        const count = db.query("SELECT count(*) as c FROM users").get() as { c: number };
        return Response.json({ node: nodeId, users: count.c, peers });
      }

      // Sync endpoint — receive changesets from peer
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
          console.log(`[Node ${nodeId}] Received ${applied} changesets, now ${count.c} users`);
        }
        return Response.json({ ok: true, applied });
      }

      // Read all users — untuk demo verification
      if (url.pathname === "/users") {
        const rows = db.query("SELECT * FROM users ORDER BY id").all();
        return Response.json({ node: nodeId, users: rows });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[Node ${nodeId}] Sync server on http://0.0.0.0:${port}`);

  // Background loop: push local changesets to peers
  if (peers.length > 0) {
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

        for (const peer of peers) {
          try {
            const res = await fetch(`${peer}/sync`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: payload,
            });
            const result = (await res.json()) as { applied: number };
            if (result.applied > 0) {
              console.log(
                `[Node ${nodeId}] Pushed ${changes.length} changesets to ${peer}, applied ${result.applied}`,
              );
            }
          } catch {
            // Peer unreachable — retry next interval
          }
        }
      } catch {
        // Query error — skip this tick
      }
    }, intervalMs);
  }

  // Return stop function for graceful shutdown
  return () => {
    if (syncTimer) clearInterval(syncTimer);
    console.log(`[Node ${nodeId}] Stopping sync...`);
    db.exec("SELECT crsql_finalize()");
    db.close();
    server.stop();
  };
}
