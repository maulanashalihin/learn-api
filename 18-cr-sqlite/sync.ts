/**
 * sync.ts — cr-sqlite changeset exchange.
 *
 * Library: background loop push local changesets ke peers,
 * route handler receive changesets dari peers.
 *
 * TIDAK bikin Bun.serve sendiri. App mount route di server
 * yang sudah ada. Ini in-app — semuanya satu proses, satu server.
 *
 * Usage:
 *   import { syncRoutes, startPushLoop } from "./sync.ts";
 *
 *   const stopPush = startPushLoop(db, { peers: ["http://peer:3002"] });
 *
 *   Bun.serve({
 *     port: 3001,
 *     fetch(req) {
 *       const match = syncRoutes(db, 1, req);  // /sync, /health, /users
 *       if (match) return match;
 *       // ... route app kamu lainnya
 *     },
 *   });
 */

import type { Database } from "bun:sqlite";
import type { Request } from "bun";

export interface PushConfig {
  peers: string[];
  intervalMs?: number;
  nodeId: number;
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

/**
 * Route handler untuk /sync, /health, /users.
 * Return Response kalau route match, undefined kalau tidak.
 * App panggil ini di fetch() server yang sudah ada.
 */
export async function syncRoutes(
  db: Database,
  nodeId: number,
  req: Request,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  // Health check
  if (url.pathname === "/health") {
    const count = db.query("SELECT count(*) as c FROM users").get() as { c: number };
    return Response.json({ node: nodeId, users: count.c });
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

  return undefined;
}

/**
 * Background loop: push local changesets ke peers.
 * Return stop function.
 */
export function startPushLoop(db: Database, config: PushConfig): () => void {
  const { peers, intervalMs = 2000, nodeId } = config;
  let lastSentVersion = 0;

  const timer = setInterval(async () => {
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
          const isHttp3 = peer.startsWith("https://");
          const fetchOpts: any = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          };
          if (isHttp3) {
            fetchOpts.protocol = "http3";
            fetchOpts.tls = { rejectUnauthorized: false };
          }
          const res = await fetch(`${peer}/sync`, fetchOpts);
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

  return () => clearInterval(timer);
}
