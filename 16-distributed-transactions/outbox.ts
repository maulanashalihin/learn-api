// ─── Transactional Outbox Pattern ───────────────────────────────
//
// Masalah (dual-write): app mau update DB + publish event ke message
// bus (Kafka/RabbitMQ). Tidak bisa atomic跨 2 system:
//   • Update DB lalu publish → publish gagal = event hilang (DB updated, bus tidak).
//   • Publish lalu update DB → DB gagal = event palsu (bus ada, DB tidak).
//
// Solusi: tulis perubahan DB + tulis row ke tabel OUTBOX dalam SATU
// transaction DB (atomic, lokal). Process terpisah (poller/relay) baca
// outbox, publish ke bus, lalu mark row sebagai published.
//
//   App ──tx──→ DB (orders + outbox)        Poller ──→ Bus
//                  │ outbox rows               read → publish → mark
//
// Di production: poller = Debezium CDC (baca WAL) atau worker poll.
// Di sini: in-memory DB + synchronous poller loop.

// ── In-memory "database" dengan transaction support ──

export interface OrderRow {
	id: string;
	customer: string;
	amount: number;
	status: "NEW" | "CONFIRMED";
	createdAt: string;
}

export type OutboxStatus = "PENDING" | "PUBLISHED";

export interface OutboxRow {
	id: string; // event id (untuk idempotency consumer)
	aggregateId: string; // order id
	eventType: string;
	payload: unknown;
	status: OutboxStatus;
	createdAt: string;
	publishedAt: string | null;
	attempts: number;
}

/**
 * DB simulasi dengan begin/commit transaction. "Transaction" di sini
 * = buffer perubahan; commit = apply ke store atomik. Kalau gagal di
 * tengah → rollback (buffer dibuang, store tidak berubah).
 */
export class Database {
	private orders = new Map<string, OrderRow>();
	private outbox = new Map<string, OutboxRow>();
	private txBuffer: {
		orders: Map<string, OrderRow>;
		outbox: Map<string, OutboxRow>;
	} | null = null;

	begin(): void {
		if (this.txBuffer) throw new Error("transaction already in progress");
		this.txBuffer = { orders: new Map(), outbox: new Map() };
	}

	/** Insert/update order — harus di dalam tx. */
	writeOrder(row: OrderRow): void {
		if (!this.txBuffer) throw new Error("writeOrder outside transaction");
		this.txBuffer.orders.set(row.id, row);
	}

	/** Insert outbox event — harus di dalam tx (sama dengan writeOrder). */
	writeOutbox(row: OutboxRow): void {
		if (!this.txBuffer) throw new Error("writeOutbox outside transaction");
		this.txBuffer.outbox.set(row.id, row);
	}

	/** Commit: apply buffer ke store atomik. */
	commit(): void {
		if (!this.txBuffer) throw new Error("commit without begin");
		for (const [k, v] of this.txBuffer.orders) this.orders.set(k, v);
		for (const [k, v] of this.txBuffer.outbox) this.outbox.set(k, v);
		this.txBuffer = null;
	}

	/** Rollback: buang buffer, store tidak berubah. */
	rollback(): void {
		this.txBuffer = null;
	}

	/** Simulasikan kegagalan di tengah tx (setelah writeOrder, sebelum writeOutbox). */
	static simulateDualWriteFailure(): symbol {
		return SIMULATE_DUAL_WRITE_FAIL;
	}

	getOrders(): OrderRow[] {
		return [...this.orders.values()];
	}

	getOutbox(filter?: OutboxStatus): OutboxRow[] {
		const all = [...this.outbox.values()];
		return filter ? all.filter((r) => r.status === filter) : all;
	}

	getOrder(id: string): OrderRow | undefined {
		return this.orders.get(id);
	}

	getOutboxRow(id: string): OutboxRow | undefined {
		return this.outbox.get(id);
	}

	/** Update outbox row (dipakai poller setelah publish). */
	markPublished(id: string): void {
		const row = this.outbox.get(id);
		if (row) {
			row.status = "PUBLISHED";
			row.publishedAt = new Date().toISOString();
		}
	}

	incrementAttempt(id: string): void {
		const row = this.outbox.get(id);
		if (row) row.attempts += 1;
	}

	reset(): void {
		this.orders.clear();
		this.outbox.clear();
		this.txBuffer = null;
	}
}

const SIMULATE_DUAL_WRITE_FAIL = Symbol("dual-write-fail");

// ── Message bus (simulated) ──

export interface PublishedMessage {
	eventId: string;
	eventType: string;
	aggregateId: string;
	payload: unknown;
	publishedAt: string;
}

export class MessageBus {
	readonly messages: PublishedMessage[] = [];
	/** Idempotency: track event id yang sudah pernah dipublish. */
	private readonly delivered = new Set<string>();

	publish(msg: Omit<PublishedMessage, "publishedAt">): boolean {
		// Idempotent: kalau eventId sama sudah pernah dipublish, skip.
		if (this.delivered.has(msg.eventId)) return false;
		this.messages.push({ ...msg, publishedAt: new Date().toISOString() });
		this.delivered.add(msg.eventId);
		return true;
	}

	reset(): void {
		this.messages.length = 0;
		this.delivered.clear();
	}
}

// ── Application service (the dual-write problem + outbox solution) ──

export class OrderService {
	private readonly db: Database;
	private seq = 0;

	constructor(db: Database) {
		this.db = db;
	}

	/**
	 * Anti-pattern: dual-write TANPA outbox. Update DB + publish langsung.
	 * Bisa kehilangan event kalau publish gagal setelah DB commit.
	 */
	createOrderDualWrite(
		customer: string,
		amount: number,
		bus: MessageBus,
		failPublish = false,
	): {
		orderWritten: boolean;
		eventPublished: boolean;
	} {
		const orderId = `ord-${++this.seq}`;
		const eventId = `evt-${orderId}`;
		// 1. Update DB (local tx — sukses).
		this.db.begin();
		this.db.writeOrder({
			id: orderId,
			customer,
			amount,
			status: "NEW",
			createdAt: new Date().toISOString(),
		});
		this.db.commit();
		const orderWritten = true;
		// 2. Publish event — bisa gagal! DB sudah committed, tidak bisa undo.
		let eventPublished = true;
		if (failPublish) {
			eventPublished = false; // event HILANG, tapi order sudah di DB → inconsistent
		} else {
			bus.publish({
				eventId,
				eventType: "OrderCreated",
				aggregateId: orderId,
				payload: { orderId, customer, amount },
			});
		}
		return { orderWritten, eventPublished };
	}

	/**
	 * Solusi: OUTBOX. Tulis order + outbox event dalam SATU DB transaction.
	 * Atomic — keduanya commit bareng atau rollback bareng.
	 */
	createOrderWithOutbox(customer: string, amount: number): string {
		const orderId = `ord-${++this.seq}`;
		const eventId = `evt-${orderId}`;
		this.db.begin();
		try {
			this.db.writeOrder({
				id: orderId,
				customer,
				amount,
				status: "NEW",
				createdAt: new Date().toISOString(),
			});
			this.db.writeOutbox({
				id: eventId,
				aggregateId: orderId,
				eventType: "OrderCreated",
				payload: { orderId, customer, amount },
				status: "PENDING",
				createdAt: new Date().toISOString(),
				publishedAt: null,
				attempts: 0,
			});
			this.db.commit(); // atomic: order + outbox bareng
		} catch {
			this.db.rollback();
			throw new Error(
				"createOrderWithOutbox failed — DB rolled back, no orphan event",
			);
		}
		return orderId;
	}
}

// ── Outbox poller / relay ──

export interface PollerStats {
	polled: number;
	published: number;
	markedDone: number;
}

export class OutboxPoller {
	private readonly db: Database;
	private readonly bus: MessageBus;
	readonly stats: PollerStats = { polled: 0, published: 0, markedDone: 0 };

	constructor(db: Database, bus: MessageBus) {
		this.db = db;
		this.bus = bus;
	}

	/**
	 * Satu siklus poll: baca semua PENDING, publish, mark PUBLISHED.
	 * Return jumlah event yang diproses.
	 */
	pollOnce(): number {
		const pending = this.db.getOutbox("PENDING");
		this.stats.polled += pending.length;
		let processed = 0;
		for (const row of pending) {
			this.db.incrementAttempt(row.id);
			const delivered = this.bus.publish({
				eventId: row.id,
				eventType: row.eventType,
				aggregateId: row.aggregateId,
				payload: row.payload,
			});
			if (delivered) this.stats.published += 1;
			// Idempotent: walau sudah pernah dipublish, tetap mark PUBLISHED.
			this.db.markPublished(row.id);
			this.stats.markedDone += 1;
			processed += 1;
		}
		return processed;
	}

	reset(): void {
		this.stats.polled = 0;
		this.stats.published = 0;
		this.stats.markedDone = 0;
	}
}
