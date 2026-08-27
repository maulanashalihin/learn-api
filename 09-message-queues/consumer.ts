// ─── 09 — Message Queues: Consumer ──────────────────────────────
//
// Demo consumer yang memproses messages dengan:
//   - Ack/Nack semantics
//   - Retry dengan exponential backoff
//   - Dead Letter Queue setelah max retries
//   - Visibility timeout (at-least-once delivery)
//
// Jalankan:  npx tsx 09-message-queues/consumer.ts
//
// Karena queue in-memory, consumer ini juga enqueue messages sendiri
// (simulasi producer) lalu memprosesnya. Ini menunjukkan full lifecycle
// dalam satu process: enqueue → dequeue → process → ack/nack → retry → DLQ.

import { MessageQueue, type Message } from "./queue.js";

interface EmailPayload {
	to: string;
	subject: string;
	body: string;
}
// ─── Helpers ────────────────────────────────────────────────────

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

// Seeded PRNG (LCG) supaya demo reproducible — setiap run hasilnya sama.
// ~30% failure rate, tapi distribusi controlled.
let seed = 42;
function random(): number {
	seed = (seed * 1664525 + 1013904223) % 4294967296;
	return seed / 4294967296;
}

function timestamp(): string {
	return new Date().toISOString().split("T")[1].replace("Z", "");
}

// ─── Setup ──────────────────────────────────────────────────────
//
// Demo pakai backoff cepat (200ms base) supaya gak nunggu lama.
// Production: 1000ms (1s, 2s, 4s, 8s...).
// Visibility timeout: 3 detik untuk demo visibility timeout section.

const QUEUE_NAME = "email-queue";
const queue = new MessageQueue({
	maxRetries: 3,
	visibilityTimeoutMs: 3_000,
	backoffBaseMs: 200, // 200ms, 400ms, 800ms (demo) — production: 1000ms
});
queue.startVisibilityEnforcement();

// ─── Demo Part 1: Enqueue + Process with Retry & DLQ ────────────

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║          📥  MESSAGE QUEUE — CONSUMER DEMO               ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

console.log("─── Part 1: Enqueue 10 messages (simulating producer) ───\n");

const MESSAGE_COUNT = 10;
for (let i = 0; i < MESSAGE_COUNT; i++) {
	const id = queue.enqueue(QUEUE_NAME, "send-email", {
		to: `user${i}@example.com`,
		subject: `Email #${i}`,
		body: `This is email number ${i}`,
	});
	console.log(
		`  📧 enqueued [${id.slice(0, 8)}] send-email → user${i}@example.com`,
	);
}

console.log(`\n  ${MESSAGE_COUNT} messages enqueued to "${QUEUE_NAME}"`);
console.log(
	"  Handler akan fail ~30% secara random (seeded untuk reproducibility)\n",
);

// ─── Handler ────────────────────────────────────────────────────
//
// Handler yang "mengirim email". ~30% chance gagal (simulasi network error,
// SMTP timeout, dll). Consumer harus idempotent karena at-least-once delivery.
//
// Salah satu message (user3) adalah "poison message" — selalu gagal.
// Ini simulasi invalid email address yang gak akan pernah berhasil.
// Poison message inilah yang akhirnya masuk DLQ — persis seperti di production.

async function emailHandler(msg: Message<EmailPayload>): Promise<void> {
	// Simulasi processing time
	await sleep(50);

	// Poison message: email address invalid → selalu gagal.
	// Di production: malformed payload, missing required field, dll.
	// Ini yang akan habis retry dan masuk DLQ.
	if (msg.payload.to === "user3@example.com") {
		throw new Error(`Invalid email address: ${msg.payload.to} — missing TLD`);
	}

	// ~30% random failure rate untuk message lain (transient errors)
	if (random() < 0.3) {
		throw new Error(`SMTP timeout — failed to send to ${msg.payload.to}`);
	}

	// Success — "email terkirim"
}

// ─── Consumer Loop ──────────────────────────────────────────────

console.log("─── Part 2: Consumer processing (ack / nack / retry / DLQ) ───\n");

const results = {
	acked: 0,
	retried: 0,
	deadLettered: 0,
};

let emptyPolls = 0;
const MAX_EMPTY_POLLS = 50; // safety: stop kalau queue idle terlalu lama

while (true) {
	const stats = queue.getStats(QUEUE_NAME);

	// Berhenti kalau queue kosong (tidak ada pending, scheduled, atau in-flight)
	if (stats.pending === 0 && stats.scheduled === 0 && stats.inFlight === 0) {
		break;
	}

	const msg = queue.dequeue<EmailPayload>(QUEUE_NAME);

	if (!msg) {
		// Tidak ada message yang visible — mungkin ada yang scheduled (backoff)
		if (stats.scheduled > 0) {
			console.log(
				`  ⏳  ${timestamp()}  no visible messages, ${stats.scheduled} scheduled (waiting backoff)...`,
			);
		}
		emptyPolls++;
		if (emptyPolls > MAX_EMPTY_POLLS) {
			console.log("  ⚠️  Max empty polls reached, stopping.");
			break;
		}
		await sleep(100);
		continue;
	}
	emptyPolls = 0;

	const shortId = msg.id.slice(0, 8);
	const attemptStr = `attempt ${msg.attempts}/${msg.maxRetries + 1}`;

	try {
		await emailHandler(msg);
		queue.ack(QUEUE_NAME, msg.id);
		results.acked++;
		console.log(
			`  ✅ ACK    ${timestamp()}  [${shortId}] ${msg.type} → ${msg.payload.to}  (${attemptStr})`,
		);
	} catch (err) {
		const error = err as Error;
		const nackResult = queue.nack(QUEUE_NAME, msg.id);

		if (nackResult === "dead-lettered") {
			results.deadLettered++;
			console.log(
				`  💀 DLQ    ${timestamp()}  [${shortId}] ${msg.type} → ${msg.payload.to}  (${attemptStr}) — max retries exceeded`,
			);
			console.log(`           reason: ${error.message}`);
		} else {
			results.retried++;
			const backoffMs = 200 * 2 ** (msg.attempts - 1);
			console.log(
				`  🔄 NACK   ${timestamp()}  [${shortId}] ${msg.type} → ${msg.payload.to}  (${attemptStr}) — requeue, backoff ${backoffMs}ms`,
			);
			console.log(`           reason: ${error.message}`);
		}
	}
}

// ─── Part 1 Summary ─────────────────────────────────────────────

console.log("\n─── Processing complete ───\n");
console.log(`  ✅ Acked (success):        ${results.acked}`);
console.log(`  🔄 Retried (then success): ${results.retried}`);
console.log(`  💀 Dead-lettered:          ${results.deadLettered}`);
console.log(
	`  📊 Total processed:        ${results.acked + results.deadLettered}`,
);

// ─── DLQ contents ───────────────────────────────────────────────

const deadLetters = queue.getDeadLetters<EmailPayload>(QUEUE_NAME);
if (deadLetters.length > 0) {
	console.log(`\n─── Dead Letter Queue (${deadLetters.length} messages) ───\n`);
	for (const dlq of deadLetters) {
		console.log(
			`  💀 [${dlq.id.slice(0, 8)}] type=${dlq.type}  attempts=${dlq.attempts}  to=${dlq.payload.to}`,
		);
		console.log(`     createdAt: ${dlq.createdAt}`);
	}
	console.log("\n  DLQ messages perlu investigasi manual:");
	console.log("    - Cek kenapa handler selalu gagal");
	console.log("    - Fix bug, lalu re-queue (dead-letter → main queue)");
	console.log("    - Atau discard kalau memang invalid (poison message)");
}

// ─── Demo Part 3: Visibility Timeout (at-least-once delivery) ───

console.log("\n─── Part 3: Visibility Timeout demo (at-least-once) ───\n");
console.log("  Scenario: consumer dequeue message, tapi CRASH sebelum ack.");
console.log("  Visibility timeout expired → message jadi visible lagi.\n");

// Reset seed untuk section ini
seed = 99;

// Enqueue 1 message khusus untuk visibility timeout demo
const vtId = queue.enqueue(QUEUE_NAME, "send-email", {
	to: "visibility-test@example.com",
	subject: "Visibility timeout test",
	body: "This message will be redelivered",
});
console.log(`  📧 enqueued [${vtId.slice(0, 8)}] for visibility timeout test`);
console.log(`     visibility timeout = 3 seconds\n`);

// Dequeue — simulasikan consumer pick up
const vtMsg = queue.dequeue(QUEUE_NAME);
if (vtMsg) {
	console.log(
		`  📥 dequeued [${vtMsg.id.slice(0, 8)}] — consumer sedang memproses...`,
	);
	console.log(`     ⚠️  Consumer CRASH! Tidak ack, tidak nack.\n`);
	console.log(`  ⏳  Menunggu visibility timeout (3 detik)...\n`);

	// Jangan ack atau nack — simulasikan crash.
	// Visibility enforcement akan membuat message visible lagi setelah timeout.
	// Kita tunggu dan poll.
	let redelivered = false;
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		const retryMsg = queue.dequeue(QUEUE_NAME);
		if (retryMsg) {
			console.log(
				`  📥 REDELIVERED [${retryMsg.id.slice(0, 8)}] — message visible lagi!`,
			);
			console.log(
				`     attempts sekarang: ${retryMsg.attempts} (di-increment dari crash)`,
			);
			console.log(
				`     Ini adalah at-least-once delivery: consumer baru bisa proses.`,
			);
			// Ack message ini
			queue.ack(QUEUE_NAME, retryMsg.id);
			console.log(
				`  ✅ ACK    [${retryMsg.id.slice(0, 8)}] — berhasil diproses oleh consumer baru\n`,
			);
			redelivered = true;
			break;
		}
		if (i % 4 === 0) {
			console.log(
				`  ⏳  ${timestamp()}  masih menunggu... (message invisible)`,
			);
		}
	}

	if (!redelivered) {
		console.log(
			"  ⚠️  Visibility timeout tidak triggered dalam waktu yang expected.",
		);
	}
}

// ─── Final Summary ──────────────────────────────────────────────

console.log("─── Final Summary ───\n");
console.log("  Message queue demo complete. Yang didemonstrasikan:");
console.log(
	"    ✅ Message envelope (id, type, payload, attempts, createdAt, maxRetries)",
);
console.log("    ✅ Producer: enqueue ke named queue");
console.log("    ✅ Consumer: dequeue + process");
console.log("    ✅ Ack (success → remove) / Nack (fail → requeue)");
console.log("    ✅ Retry dengan exponential backoff (200ms, 400ms, 800ms)");
console.log("    ✅ Dead Letter Queue setelah max retries (3)");
console.log("    ✅ Visibility timeout → at-least-once delivery");
console.log("    ✅ Multiple named queues (email-queue, order-queue)");
console.log("\n  Production equivalents:");
console.log("    RabbitMQ  — AMQP broker, exchanges, bindings");
console.log("    AWS SQS   — managed queue, visibility timeout built-in");
console.log("    Redis Streams — append-only log dengan consumer groups");
console.log("    BullMQ    — Node.js queue di atas Redis");

queue.stop();
