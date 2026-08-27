// ─── 09 — Message Queues ────────────────────────────────────────
//
// In-memory message queue dengan ack/nack semantics, retry dengan
// exponential backoff, Dead Letter Queue (DLQ), dan visibility timeout.
//
// Konsep yang didemonstrasikan:
//   1. Message envelope  — id, type, payload, attempts, createdAt, maxRetries
//   2. Producer          — enqueue() menambah message ke named queue
//   3. Consumer          — dequeue() mengambil & memproses message
//   4. Ack/Nack          — success → ack (hapus). throw → nack (requeue dengan retry)
//   5. Retry + backoff   — 1s, 2s, 4s, 8s... (exponential) sampai maxRetries
//   6. Dead Letter Queue — setelah maxRetries habis, message pindah ke DLQ
//   7. Visibility timeout — message yang di-pick jadi invisible N detik.
//                           Kalau gak di-ack, jadi visible lagi (at-least-once).
//   8. Multiple queues   — named queues ("email-queue", "order-queue", dll)
//
// Di production, ganti dengan RabbitMQ, AWS SQS, Redis Streams, BullMQ, dll.
// Code ini mendemonstrasikan KONSEP — bukan production-ready.

// ─── Message Envelope ───────────────────────────────────────────
//
// Setiap message dibungkus dalam envelope dengan metadata.
// Payload bebas — bisa object, string, number, apa saja.

export interface Message<T = unknown> {
	id: string;
	type: string;
	payload: T;
	attempts: number; // berapa kali sudah dicoba diproses
	createdAt: string; // ISO 8601
	maxRetries: number; // max retry sebelum masuk DLQ
}

// Internal representation — extends Message dengan scheduling metadata.
// Field ini gak boleh kelihatan dari luar (consumer gak perlu tahu).
interface QueuedMessage<T = unknown> extends Message<T> {
	visibleAt: number; // epoch ms — earliest time message bisa di-dequeue
	inFlight: boolean; // true selama consumer memproses
	ackDeadline: number; // epoch ms — kapan visibility timeout expired
}

// ─── Queue Configuration ────────────────────────────────────────

export interface QueueOptions {
	maxRetries?: number; // default 3 — berapa kali retry sebelum DLQ
	visibilityTimeoutMs?: number; // default 30_000 (30 detik)
	backoffBaseMs?: number; // default 1_000 — base untuk exponential backoff
}

export interface QueueStats {
	queueName: string;
	pending: number; // visible & ready untuk di-dequeue
	scheduled: number; // menunggu backoff (belum visible)
	inFlight: number; // sedang diproses consumer
	deadLetter: number; // jumlah message di DLQ
}

export type NackResult = "requeued" | "dead-lettered";

// ─── Message Queue ──────────────────────────────────────────────

export class MessageQueue {
	private queues = new Map<string, QueuedMessage[]>();
	private deadLetterQueues = new Map<string, QueuedMessage[]>();
	private readonly options: Required<QueueOptions>;
	private visibilityTimer: NodeJS.Timeout | null = null;

	constructor(options: QueueOptions = {}) {
		this.options = {
			maxRetries: options.maxRetries ?? 3,
			visibilityTimeoutMs: options.visibilityTimeoutMs ?? 30_000,
			backoffBaseMs: options.backoffBaseMs ?? 1_000,
		};
	}

	// ── Queue accessors ──────────────────────────────────────────

	private getQueue(name: string): QueuedMessage[] {
		let q = this.queues.get(name);
		if (!q) {
			q = [];
			this.queues.set(name, q);
		}
		return q;
	}

	private getDLQ(name: string): QueuedMessage[] {
		let q = this.deadLetterQueues.get(name);
		if (!q) {
			q = [];
			this.deadLetterQueues.set(name, q);
		}
		return q;
	}

	// ── Producer: enqueue ────────────────────────────────────────
	//
	// Tambah message ke queue. Return message id.
	// Message langsung visible (visibleAt = now).

	enqueue<T>(
		queueName: string,
		type: string,
		payload: T,
		opts?: { maxRetries?: number },
	): string {
		const id = crypto.randomUUID();
		const msg: QueuedMessage<T> = {
			id,
			type,
			payload,
			attempts: 0,
			createdAt: new Date().toISOString(),
			maxRetries: opts?.maxRetries ?? this.options.maxRetries,
			visibleAt: Date.now(),
			inFlight: false,
			ackDeadline: 0,
		};
		this.getQueue(queueName).push(msg);
		return id;
	}

	// ── Consumer: dequeue ────────────────────────────────────────
	//
	// Ambil message berikutnya yang visible. Kalau ada, mark as in-flight
	// dan set visibility timeout. Return copy tanpa internal fields.
	//
	// Kalau gak ada message yang visible, return null.

	dequeue<T = unknown>(queueName: string): Message<T> | null {
		const now = Date.now();
		const q = this.getQueue(queueName);
		const msg = q.find((m) => !m.inFlight && m.visibleAt <= now);
		if (!msg) return null;

		msg.inFlight = true;
		msg.attempts++;
		msg.ackDeadline = now + this.options.visibilityTimeoutMs;

		return {
			id: msg.id,
			type: msg.type,
			payload: msg.payload as T,
			attempts: msg.attempts,
			createdAt: msg.createdAt,
			maxRetries: msg.maxRetries,
		};
	}

	// ── Ack: message berhasil diproses ───────────────────────────
	//
	// Hapus message dari queue. Handler sukses → ack.

	ack(queueName: string, messageId: string): boolean {
		const q = this.getQueue(queueName);
		const idx = q.findIndex((m) => m.id === messageId && m.inFlight);
		if (idx === -1) return false;
		q.splice(idx, 1);
		return true;
	}

	// ── Nack: message gagal diproses ──────────────────────────────
	//
	// Handler throw → nack. Jika attempts masih di bawah maxRetries,
	// requeue dengan exponential backoff. Kalau sudah exceed maxRetries,
	// pindah ke Dead Letter Queue.
	//
	// Backoff: backoffBase * 2^(attempts - 1)
	//   attempt 1 fail → 1s, attempt 2 fail → 2s, attempt 3 fail → 4s, ...

	nack(queueName: string, messageId: string): NackResult {
		const q = this.getQueue(queueName);
		const idx = q.findIndex((m) => m.id === messageId && m.inFlight);
		if (idx === -1) return "dead-lettered";

		const msg = q[idx];
		msg.inFlight = false;

		// attempts sudah di-increment di dequeue().
		// maxRetries = jumlah retry setelah initial attempt.
		// Total attempts = 1 (initial) + maxRetries.
		if (msg.attempts > msg.maxRetries) {
			// Max retries exceeded → move to DLQ
			q.splice(idx, 1);
			this.getDLQ(queueName).push(msg);
			return "dead-lettered";
		}

		// Requeue dengan exponential backoff
		const backoff = this.options.backoffBaseMs * 2 ** (msg.attempts - 1);
		msg.visibleAt = Date.now() + backoff;
		return "requeued";
	}

	// ── Visibility Timeout Enforcement ────────────────────────────
	//
	// Background interval yang cek apakah ada in-flight message yang
	// sudah exceed visibility timeout. Kalau ya, jadikan visible lagi.
	//
	// Ini mensimulasikan: consumer crash sebelum ack → message redelivered.
	// Inilah yang menjamin at-least-once delivery.

	startVisibilityEnforcement(intervalMs = 500): void {
		if (this.visibilityTimer) return;
		this.visibilityTimer = setInterval(() => {
			const now = Date.now();
			for (const q of this.queues.values()) {
				for (const msg of q) {
					if (msg.inFlight && msg.ackDeadline <= now) {
						msg.inFlight = false;
						msg.visibleAt = now;
						// attempts sudah di-increment → ini dihitung sebagai
						// failed attempt (consumer gak ack = dianggap gagal)
					}
				}
			}
		}, intervalMs);
		// unref supaya timer gak block process exit
		this.visibilityTimer.unref?.();
	}

	stop(): void {
		if (this.visibilityTimer) {
			clearInterval(this.visibilityTimer);
			this.visibilityTimer = null;
		}
	}

	// ── Introspection ────────────────────────────────────────────

	getStats(queueName: string): QueueStats {
		const q = this.queues.get(queueName) ?? [];
		const now = Date.now();
		let pending = 0;
		let scheduled = 0;
		let inFlight = 0;
		for (const m of q) {
			if (m.inFlight) inFlight++;
			else if (m.visibleAt <= now) pending++;
			else scheduled++;
		}
		return {
			queueName,
			pending,
			scheduled,
			inFlight,
			deadLetter: (this.deadLetterQueues.get(queueName) ?? []).length,
		};
	}

	getDeadLetters<T = unknown>(queueName: string): Message<T>[] {
		return (this.deadLetterQueues.get(queueName) ?? []).map((m) => ({
			id: m.id,
			type: m.type,
			payload: m.payload as T,
			attempts: m.attempts,
			createdAt: m.createdAt,
			maxRetries: m.maxRetries,
		}));
	}

	// Total messages masih di queue (pending + scheduled + inFlight)
	getQueueSize(queueName: string): number {
		return (this.queues.get(queueName) ?? []).length;
	}

	// List semua queue names yang pernah di-enqueue
	getQueueNames(): string[] {
		return [...this.queues.keys()];
	}
}
