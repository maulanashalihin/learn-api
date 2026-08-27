import express from "express";
import type { Request, Response } from "express";
import {
	taskStore,
	seedTasks,
	generateId,
	type Task,
} from "../shared/types.js";

// ─── SSE (Server-Sent Events) Server ────────────────────────────
//
// SSE = server push ke client via HTTP connection yang tetap terbuka.
//
// Karakteristik:
//   - One-way: server → client saja (client gak bisa kirim balik)
//   - HTTP biasa (no protocol upgrade seperti WebSocket)
//   - Auto-reconnect: browser EventSource auto reconnect kalau disconnect
//   - Text only (no binary)
//   - Format: "data: <payload>\n\n" per event
//
// Use case: live notifications, stock prices, chat messages (receive only),
// dashboard real-time updates, progress bars.

// Track semua connected SSE clients
// Set<Response> — setiap client = satu Response object dengan connection terbuka
const clients = new Set<Response>();

const app = express();
app.use(express.json());

// ─── SSE Endpoint ───────────────────────────────────────────────
// Client connect via GET /events
// Server keep connection open, push events sebagai text/event-stream

app.get("/events", (req: Request, res: Response) => {
	// SSE headers — wajib untuk browser EventSource
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		// CORS — restrict ke localhost untuk learning demo
		"Access-Control-Allow-Origin": "http://localhost:5173",
	});

	// Kirim initial comment untuk confirm connection
	res.write(": connected\n\n");

	// Register client
	clients.add(res);
	console.log(`📡 SSE client connected (total: ${clients.size})`);

	// Kirim existing tasks sebagai initial state
	const tasks = [...taskStore.values()];
	res.write(`event: init\ndata: ${JSON.stringify(tasks)}\n\n`);

	// Heartbeat setiap 15 detik — keep connection alive
	// Kalau gak ada data, proxy/firewall bisa close connection idle
	const heartbeat = setInterval(() => {
		res.write(": heartbeat\n\n");
	}, 15000);

	// Cleanup saat client disconnect
	req.on("close", () => {
		clients.delete(res);
		clearInterval(heartbeat);
		console.log(`📡 SSE client disconnected (total: ${clients.size})`);
	});
});

// ─── Task endpoints (trigger SSE push) ──────────────────────────

app.get("/tasks", (_req: Request, res: Response) => {
	res.json([...taskStore.values()]);
});

app.post("/tasks", (req: Request, res: Response) => {
	const { title } = req.body as { title: string };
	if (!title?.trim()) {
		res.status(400).json({ error: "title is required" });
		return;
	}

	const task: Task = {
		id: generateId(),
		title: title.trim(),
		done: false,
		createdAt: new Date().toISOString(),
	};
	taskStore.set(task.id, task);

	// 🔔 Push event ke semua SSE clients
	broadcast("task.created", task);

	res.status(201).json(task);
});

app.patch("/tasks/:id", (req: Request, res: Response) => {
	const existing = taskStore.get(req.params.id);
	if (!existing) {
		res.status(404).json({ error: "Task not found" });
		return;
	}

	const { title, done } = req.body as { title?: string; done?: boolean };
	const updated: Task = { ...existing };
	if (typeof title === "string") updated.title = title.trim();
	if (typeof done === "boolean") updated.done = done;

	taskStore.set(req.params.id, updated);

	// 🔔 Push event
	const eventType =
		done === true && !existing.done ? "task.completed" : "task.updated";
	broadcast(eventType, updated);

	res.json(updated);
});

app.delete("/tasks/:id", (req: Request, res: Response) => {
	const deleted = taskStore.delete(req.params.id);
	if (!deleted) {
		res.status(404).json({ error: "Task not found" });
		return;
	}

	broadcast("task.deleted", { id: req.params.id });
	res.status(204).end();
});

// ─── Broadcast function ─────────────────────────────────────────
// Kirim event ke semua connected SSE clients
//
// SSE format:
//   event: <event-type>\n     (optional — named event)
//   data: <payload>\n         (data, bisa multi-line)
//   id: <event-id>\n          (optional — for reconnect resume)
//   \n                        (blank line = end of event)

function broadcast(event: string, data: unknown): void {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

	for (const client of clients) {
		try {
			client.write(payload);
		} catch {
			// Client disconnected, remove dari set
			clients.delete(client);
		}
	}

	if (clients.size > 0) {
		console.log(`   📡 Broadcasted ${event} to ${clients.size} client(s)`);
	}
}

// ─── Start ──────────────────────────────────────────────────────
seedTasks();

const PORT = 3004;
app.listen(PORT, () => {
	console.log(`\n🟢 SSE Server running at http://localhost:${PORT}`);
	console.log(`   SSE endpoint:  GET http://localhost:${PORT}/events`);
	console.log(`   Create task:   POST http://localhost:${PORT}/tasks`);
	console.log(`   Client:        npm run sse:client`);
	console.log(`   Docs: see 04-sse/README.md\n`);
});
