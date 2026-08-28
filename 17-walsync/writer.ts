// ─── Writer App (Primary Node) ─────────────────────────────────────
//
// App ini jalan di primary node. Write langsung ke embedded SQLite.
// walsync (background process) ship WAL ke replica secara async.
//
// Jalankan:
//   npx tsx 17-walsync/writer.ts
//
// Prerequisite: start walsync primary dulu
//   ./walsync -mode primary -db /tmp/walsync-demo.db -replica http://localhost:9193

import express from "express";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "/tmp/walsync-demo.db";
const PORT = Number(process.env.PORT) || 9189;

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA wal_autocheckpoint = 0"); // walsync handles checkpoint
db.exec(`
	CREATE TABLE IF NOT EXISTS tasks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		done INTEGER DEFAULT 0,
		created_at TEXT DEFAULT (datetime('now'))
	)
`);

const app = express();
app.use(express.json());

app.get("/api/tasks", (_req, res) => {
	const rows = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all();
	res.json(rows);
});

app.post("/api/tasks", (req, res) => {
	const { title } = req.body as { title: string };
	if (!title) return res.status(400).json({ error: "title required" });
	const result = db.prepare("INSERT INTO tasks (title) VALUES (?)").run(title);
	const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.lastInsertRowid);
	console.log(`[WRITER] Inserted: id=${result.lastInsertRowid}, title="${title}"`);
	res.status(201).json(row);
});

app.put("/api/tasks/:id", (req, res) => {
	const id = Number(req.params.id);
	const { done } = req.body as { done: boolean };
	db.prepare("UPDATE tasks SET done = ? WHERE id = ?").run(done ? 1 : 0, id);
	const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
	res.json(row);
});

app.delete("/api/tasks/:id", (req, res) => {
	const id = Number(req.params.id);
	db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
	res.status(204).end();
});

app.get("/health", (_req, res) => {
	const count = db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number };
	res.json({ role: "primary", tasks: count.c, db: DB_PATH });
});

app.listen(PORT, () => {
	console.log(`[WRITER] Primary app on http://localhost:${PORT}`);
	console.log(`[WRITER] DB: ${DB_PATH}`);
	console.log(`[WRITER] walsync should be running: -mode primary -db ${DB_PATH}`);
});
