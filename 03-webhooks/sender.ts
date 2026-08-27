import express from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import {
	taskStore,
	seedTasks,
	generateId,
	type Task,
} from "../shared/types.js";

// ─── Webhook Sender ─────────────────────────────────────────────
//
// Sender = service yang punya event.
// Ketika event terjadi (task dibuat, task selesai),
// sender POST ke semua URL yang terdaftar.
//
// Konsep penting:
//   - Webhook = "reverse API" — bukan client yang request,
//     tapi SERVER yang push ke client yang terdaftar.
//   - Sender butuh URL receiver yang reachable via HTTP.
//   - Signature (HMAC) supaya receiver bisa verifikasi.
//   - Retry: kalau receiver down, sender coba lagi.

const WEBHOOK_SECRET = "shared-secret-key"; // sama dengan receiver

// Daftar URL yang mau terima webhook
const subscriptions = new Set<string>(); // URL strings

const app = express();
app.use(express.json());

// ─── Subscription management ────────────────────────────────────
// Receiver mendaftarkan URL-nya ke sender
// POST /subscribe { "url": "http://localhost:3010/webhook" }

app.post("/subscribe", (req: Request, res: Response) => {
	const { url } = req.body as { url?: string };
	if (!url || !url.startsWith("http")) {
		res.status(400).json({ error: "url is required and must start with http" });
		return;
	}
	subscriptions.add(url);
	console.log(`✅ Subscribed: ${url} (total: ${subscriptions.size})`);
	res.json({ status: "subscribed", url, total: subscriptions.size });
});

app.delete("/subscribe", (req: Request, res: Response) => {
	const { url } = req.body as { url?: string };
	if (!url) {
		res.status(400).json({ error: "url is required" });
		return;
	}
	subscriptions.delete(url);
	console.log(`❌ Unsubscribed: ${url} (total: ${subscriptions.size})`);
	res.json({ status: "unsubscribed", url, total: subscriptions.size });
});

// ─── Task endpoints (trigger webhooks) ──────────────────────────
// Sama seperti REST, tapi setiap aksi trigger webhook ke subscriber

app.post("/tasks", async (req: Request, res: Response) => {
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

	// 🔔 Fire webhook: task.created
	await fireWebhook("task.created", task);

	res.status(201).json(task);
});

app.patch("/tasks/:id", async (req: Request, res: Response) => {
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

	// 🔔 Fire webhook: task.completed (hanya kalau done berubah ke true)
	if (done === true && !existing.done) {
		await fireWebhook("task.completed", updated);
	} else {
		await fireWebhook("task.updated", updated);
	}

	res.json(updated);
});

app.get("/tasks", (_req: Request, res: Response) => {
	res.json([...taskStore.values()]);
});

// ─── Webhook dispatch function ──────────────────────────────────
// Ini inti dari webhook: POST event ke semua subscriber

async function fireWebhook(event: string, data: unknown): Promise<void> {
	if (subscriptions.size === 0) {
		console.log(`   (no subscribers, skipping webhook for ${event})`);
		return;
	}

	const payload = {
		id: generateId(), // unique event ID
		event, // event type
		data, // event payload
		timestamp: new Date().toISOString(),
	};

	const body = JSON.stringify(payload);

	// HMAC signature: receiver verifikasi ini untuk pastikan webhook dari kita
	const signature = crypto
		.createHmac("sha256", WEBHOOK_SECRET)
		.update(body)
		.digest("hex");

	// Kirim ke semua subscriber secara paralel
	const deliveries = [...subscriptions].map(async (url) => {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Webhook-Signature": signature,
					"X-Webhook-Event": event,
				},
				body,
				signal: AbortSignal.timeout(5000), // 5s timeout
			});

			if (response.ok) {
				console.log(`   ✅ Delivered ${event} to ${url} (${response.status})`);
				return;
			}
			console.log(`   ❌ Failed ${event} to ${url} (${response.status})`);
			// Production: queue for retry dengan exponential backoff
		} catch (err) {
			console.log(
				`   ❌ Error delivering ${event} to ${url}: ${(err as Error).message}`,
			);
			// Production: retry queue (Redis + BullMQ, SQS, dll)
		}
	});

	await Promise.all(deliveries);
}

// ─── Start ──────────────────────────────────────────────────────
seedTasks();

const PORT = 3003;
app.listen(PORT, () => {
	console.log(`\n🟢 Webhook Sender running at http://localhost:${PORT}`);
	console.log(`   1. Start receiver:  npm run webhook:receiver`);
	console.log(
		`   2. Subscribe:       curl -X POST http://localhost:${PORT}/subscribe \\`,
	);
	console.log(
		`                         -H 'Content-Type: application/json' \\`,
	);
	console.log(
		`                         -d '{"url":"http://localhost:3010/webhook"}'`,
	);
	console.log(
		`   3. Create task:     curl -X POST http://localhost:${PORT}/tasks \\`,
	);
	console.log(
		`                         -H 'Content-Type: application/json' \\`,
	);
	console.log(`                         -d '{"title":"Test webhook"}'`);
	console.log(`   Docs: see 03-webhooks/README.md\n`);
});
