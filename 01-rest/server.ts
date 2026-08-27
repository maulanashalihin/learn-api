import express from "express";
import type { Request, Response } from "express";
import {
	taskStore,
	seedTasks,
	generateId,
	type Task,
	type NewTask,
} from "../shared/types.js";

const app = express();
app.use(express.json()); // parse JSON body

// Seed data saat server start
seedTasks();

// ─── REST API: Tasks Resource ───────────────────────────────────
// REST = REpresentational State Transfer
// Prinsip inti:
//   1. Resource diidentifikasi via URL (/tasks, /tasks/:id)
//   2. HTTP method = aksi (GET=read, POST=create, PUT=update, DELETE=delete)
//   3. Stateless — setiap request berdiri sendiri, no server-side session
//   4. Status code = hasil (200 OK, 201 Created, 404 Not Found, dll)

// GET /tasks — list semua task
// Query param ?done=true untuk filter
app.get("/tasks", (req: Request, res: Response) => {
	const tasks = [...taskStore.values()];
	const doneFilter = req.query.done;

	if (doneFilter === "true") {
		res.json(tasks.filter((t) => t.done));
		return;
	}
	if (doneFilter === "false") {
		res.json(tasks.filter((t) => !t.done));
		return;
	}

	res.json(tasks);
});

// GET /tasks/:id — ambil satu task by ID
app.get("/tasks/:id", (req: Request, res: Response) => {
	const task = taskStore.get(req.params.id);
	if (!task) {
		res.status(404).json({ error: "Task not found" });
		return;
	}
	res.json(task);
});

// POST /tasks — buat task baru
// Body: { "title": "..." }
app.post("/tasks", (req: Request, res: Response) => {
	const { title } = req.body as NewTask;

	// Validasi input
	if (!title || typeof title !== "string" || title.trim().length === 0) {
		res
			.status(400)
			.json({ error: "title is required and must be non-empty string" });
		return;
	}

	const task: Task = {
		id: generateId(),
		title: title.trim(),
		done: false,
		createdAt: new Date().toISOString(),
	};

	taskStore.set(task.id, task);
	res.status(201).json(task); // 201 Created
});

// PUT /tasks/:id — update seluruh resource (full replace)
// Body: { "title": "...", "done": true }
app.put("/tasks/:id", (req: Request, res: Response) => {
	const existing = taskStore.get(req.params.id);
	if (!existing) {
		res.status(404).json({ error: "Task not found" });
		return;
	}

	const { title, done } = req.body as Partial<NewTask & Pick<Task, "done">>;

	// PUT = full replace, jadi kita validasi semua field
	if (typeof title !== "string" || title.trim().length === 0) {
		res.status(400).json({ error: "title is required" });
		return;
	}
	if (typeof done !== "boolean") {
		res.status(400).json({ error: "done is required and must be boolean" });
		return;
	}

	const updated: Task = { ...existing, title: title.trim(), done };
	taskStore.set(req.params.id, updated);
	res.json(updated);
});

// PATCH /tasks/:id — partial update (hanya field yang dikirim)
// Body: { "done": true } atau { "title": "..." } atau keduanya
app.patch("/tasks/:id", (req: Request, res: Response) => {
	const existing = taskStore.get(req.params.id);
	if (!existing) {
		res.status(404).json({ error: "Task not found" });
		return;
	}

	const { title, done } = req.body as Partial<NewTask & Pick<Task, "done">>;
	const updated: Task = { ...existing };

	if (typeof title === "string") updated.title = title.trim();
	if (typeof done === "boolean") updated.done = done;

	taskStore.set(req.params.id, updated);
	res.json(updated);
});

// DELETE /tasks/:id — hapus task
app.delete("/tasks/:id", (req: Request, res: Response) => {
	const deleted = taskStore.delete(req.params.id);
	if (!deleted) {
		res.status(404).json({ error: "Task not found" });
		return;
	}
	res.status(204).end(); // 204 No Content — sukses, tidak ada body
});

// ─── Start server ───────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
	console.log(`\n🟢 REST API running at http://localhost:${PORT}`);
	console.log(`   Try: curl http://localhost:${PORT}/tasks`);
	console.log(`   Docs: see 01-rest/README.md\n`);
});
