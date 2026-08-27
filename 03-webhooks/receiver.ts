import express from "express";
import type { Request, Response } from "express";

// ─── Webhook Receiver ───────────────────────────────────────────
//
// Receiver = server yang DAFTAR URL-nya ke sender.
// Ketika event terjadi, sender akan POST ke URL ini.
//
// Receiver harus:
//   1. Verifikasi signature (HMAC) — pastikan webhook benar dari sender
//   2. Process payload
//   3. Return 200 cepat (jangan block sender)
//   4. Idempotent — webhook bisa dikirim ulang (retry), jangan process 2x

import crypto from "node:crypto";

const WEBHOOK_SECRET = "shared-secret-key"; // sama dengan sender

const app = express();

// Raw body untuk verifikasi signature
// Kita butuh raw bytes, bukan parsed JSON, untuk compute HMAC
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// Track processed webhook IDs untuk idempotency
const processedIds = new Set<string>();

app.post("/webhook", (req: Request, res: Response) => {
	// 1. Verifikasi HMAC signature
	const signature = req.headers["x-webhook-signature"] as string | undefined;
	if (!signature) {
		res.status(401).json({ error: "Missing signature" });
		return;
	}

	const expectedSig = crypto
		.createHmac("sha256", WEBHOOK_SECRET)
		.update(req.body as Buffer) // raw body
		.digest("hex");

	// Timing-safe comparison (hindari timing attack)
	const sigBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expectedSig);
	if (
		sigBuffer.length !== expectedBuffer.length ||
		!crypto.timingSafeEqual(sigBuffer, expectedBuffer)
	) {
		res.status(401).json({ error: "Invalid signature" });
		return;
	}

	// 2. Parse payload — bisa throw kalau body bukan valid JSON
	let payload: { id: string; event: string; data: unknown; timestamp: string };
	try {
		payload = JSON.parse(req.body.toString()) as {
			id: string; // unique event ID untuk idempotency
			event: string; // jenis event: task.created, task.completed, dll
			data: unknown; // payload data
			timestamp: string; // kapan event terjadi
		};
	} catch {
		res.status(400).json({ error: "Invalid JSON payload" });
		return;
	}

	// 3. Idempotency check — jangan process 2x
	if (processedIds.has(payload.id)) {
		console.log(`⚠️  Duplicate webhook ${payload.id}, skipping`);
		res.status(200).json({ status: "duplicate", id: payload.id });
		return;
	}
	processedIds.add(payload.id);

	// 4. Process event
	console.log(`\n📨 Webhook received!`);
	console.log(`   Event: ${payload.event}`);
	console.log(`   ID:    ${payload.id}`);
	console.log(`   Time:  ${payload.timestamp}`);
	console.log(`   Data:  ${JSON.stringify(payload.data, null, 2)}`);

	// 5. Return 200 cepat — jangan block sender
	// Kalau processing lama, queue ke background worker di production
	res.status(200).json({ status: "ok", id: payload.id });
});

// Endpoint untuk lihat webhook yang sudah diterima
app.get("/webhooks", (_req: Request, res: Response) => {
	res.json({ received: [...processedIds] });
});

const PORT = 3010;
app.listen(PORT, () => {
	console.log(`\n🟢 Webhook Receiver running at http://localhost:${PORT}`);
	console.log(`   Listening for webhooks at POST /webhook`);
	console.log(`   Docs: see 03-webhooks/README.md\n`);
});
