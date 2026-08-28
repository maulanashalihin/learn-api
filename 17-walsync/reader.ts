// ─── Reader App (Replica Node) ─────────────────────────────────────
//
// App ini jalan di replica node. Read dari embedded SQLite (readonly).
// walsync (background process) terima WAL dari primary → apply ke DB.
//
// Jalankan:
//   npx tsx 17-walsync/reader.ts
//
// Prerequisite: start walsync replica dulu
//   ./walsync -mode replica -db /tmp/walsync-demo.db -listen :9193
//
// v0.8.0+: walsync corrupts -shm after each WAL ship (same inode).
// SQLite detects invalid checksum → rebuilds from WAL → updates -shm.
// Persistent readonly connection sees new frames via mmap. Natural pattern.
//
// v1.0.0: Auto-reconnect on snapshot. When primary checkpoints →
// snapshot → DB file replaced (new inode) → old connection stale →
// catch error → reopen.

import express from "express";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "/tmp/walsync-demo.db";
const PORT = Number(process.env.PORT) || 9188;

let readDb: DatabaseSync | null = null;

function getReadDb(): DatabaseSync | null {
	if (readDb) return readDb;
	try {
		readDb = new DatabaseSync(DB_PATH, { readOnly: true });
		return readDb;
	} catch {
		return null; // DB not yet replicated
	}
}

function readQuery<T>(sql: string, ...params: unknown[]): T[] {
	const db = getReadDb();
	if (!db) return []; // DB not yet replicated
	try {
		return db.prepare(sql).all(...(params as never[])) as T[];
	} catch (err) {
		if (err instanceof Error && "code" in err) {
			const code = err.code as string;
			// Snapshot replaced DB file → stale connection → reopen
			if (code === "SQLITE_IOERR" || code === "SQLITE_NOTADB" || code === "SQLITE_CANTOPEN") {
				readDb = null;
				return readQuery(sql, ...params); // retry with fresh connection
			}
		}
		throw err;
	}
}

const app = express();
app.use(express.json());

app.get("/api/tasks", (_req, res) => {
	const rows = readQuery<{ id: number; title: string; done: number; created_at: string }>(
		"SELECT * FROM tasks ORDER BY id DESC",
	);
	res.json(rows);
});

app.get("/api/tasks/:id", (req, res) => {
	const id = Number(req.params.id);
	const rows = readQuery<{ id: number; title: string; done: number; created_at: string }>(
		"SELECT * FROM tasks WHERE id = ?",
		id,
	);
	if (rows.length === 0) return res.status(404).json({ error: "not found" });
	res.json(rows[0]);
});

app.get("/health", (_req, res) => {
	const rows = readQuery<{ c: number }>("SELECT COUNT(*) as c FROM tasks");
	res.json({ role: "replica", tasks: rows[0]?.c ?? 0, db: DB_PATH });
});

app.listen(PORT, () => {
	console.log(`[READER] Replica app on http://localhost:${PORT}`);
	console.log(`[READER] DB: ${DB_PATH} (readonly)`);
	console.log(`[READER] walsync should be running: -mode replica -db ${DB_PATH}`);
});
