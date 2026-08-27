// ─── 09 — Message Queues: Producer ──────────────────────────────
//
// Demo producer yang enqueue messages ke multiple named queues.
//
// Jalankan:  npx tsx 09-message-queues/producer.ts
//
// Producer hanya menambah message ke queue. Consumer (terpisah) yang
// memproses. Di demo ini, queue in-memory — jadi producer dan consumer
// gak share state across processes. Lihat consumer.ts untuk full lifecycle.
//
// Di production (RabbitMQ, SQS, dll), producer dan consumer jalan di
// process terpisah dan queue persistent di broker.

import { MessageQueue } from "./queue.js";

// ─── Setup ──────────────────────────────────────────────────────

const queue = new MessageQueue({
	maxRetries: 3,
	visibilityTimeoutMs: 30_000,
	backoffBaseMs: 1_000, // 1s, 2s, 4s...
});

const EMAIL_QUEUE = "email-queue";
const ORDER_QUEUE = "order-queue";

// ─── Enqueue messages ───────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║          📤  MESSAGE QUEUE — PRODUCER DEMO               ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

console.log("─── Enqueuing messages to email-queue ───\n");

const emailMessages = [
	{
		to: "alice@example.com",
		subject: "Welcome to our app!",
		body: "Thanks for signing up.",
	},
	{
		to: "bob@example.com",
		subject: "Your order has shipped",
		body: "Tracking: 1Z999...",
	},
	{
		to: "charlie@example.com",
		subject: "Password reset",
		body: "Click here to reset.",
	},
	{
		to: "diana@example.com",
		subject: "Weekly newsletter",
		body: "This week's top stories.",
	},
	{
		to: "eve@example.com",
		subject: "Invoice #1024",
		body: "Your invoice is ready.",
	},
	{
		to: "frank@example.com",
		subject: "Account verification",
		body: "Verify your email.",
	},
	{
		to: "grace@example.com",
		subject: "Meeting reminder",
		body: "Tomorrow at 10am.",
	},
];

for (const email of emailMessages) {
	const id = queue.enqueue(EMAIL_QUEUE, "send-email", email);
	console.log(`  📧 enqueued  [${id.slice(0, 8)}]  send-email → ${email.to}`);
}

console.log("\n─── Enqueuing messages to order-queue ───\n");

const orderMessages = [
	{ orderId: "ORD-001", customerId: "C-100", total: 49.99, items: 2 },
	{ orderId: "ORD-002", customerId: "C-200", total: 129.5, items: 5 },
	{ orderId: "ORD-003", customerId: "C-300", total: 12.0, items: 1 },
];

for (const order of orderMessages) {
	const id = queue.enqueue(ORDER_QUEUE, "process-order", order);
	console.log(
		`  📦 enqueued  [${id.slice(0, 8)}]  process-order → ${order.orderId} ($${order.total})`,
	);
}

// ─── Queue state ────────────────────────────────────────────────

console.log("\n─── Queue state after enqueuing ───\n");

for (const name of queue.getQueueNames()) {
	const stats = queue.getStats(name);
	console.log(`  ${name}:`);
	console.log(`    pending:    ${stats.pending}`);
	console.log(`    scheduled:  ${stats.scheduled}`);
	console.log(`    in-flight:  ${stats.inFlight}`);
	console.log(`    dead-letter:${stats.deadLetter}`);
}

console.log(
	`\n  Total messages enqueued: ${emailMessages.length + orderMessages.length}`,
);
console.log(`  Queues: ${queue.getQueueNames().join(", ")}`);

// ─── Summary ────────────────────────────────────────────────────

console.log("\n─── Summary ───\n");
console.log("  Producer selesai enqueue. Messages menunggu di queue.");
console.log("  Jalankan consumer untuk memproses:");
console.log("    npx tsx 09-message-queues/consumer.ts\n");
console.log(
	"  Di production, producer dan consumer jalan di process terpisah.",
);
console.log("  Queue persistent di broker (RabbitMQ, SQS, Redis, dll).");

queue.stop();
