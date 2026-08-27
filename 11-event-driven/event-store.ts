// ─── Event Store: append-only log of domain events ───────────────────────
//
// Event Sourcing core: kita simpan EVENTS, bukan state.
// State (aggregate) dibangun ulang dengan REPLAY event dari store ini.
//
// Event store adalah sumber kebenaran (source of truth). Immutable:
// sekali event ditulis, tidak pernah diubah/dihapus (append-only).
//
// Di production: EventStoreDB, Kafka topic, atau Postgres event table.

/** Satu event di event log. Immutable setelah ditulis. */
export interface DomainEvent {
	/** Unique event ID (UUID) */
	id: string;
	/** ID aggregate yang dimiliki event ini */
	aggregateId: string;
	/** Jenis event, mis. "TaskCreated", "TaskCompleted" */
	type: string;
	/** Payload event — data yang berubah */
	data: Record<string, unknown>;
	/** Versi aggregate SETELAH event ini di-apply (monoton naik per aggregate) */
	version: number;
	/** Kapan event terjadi (ISO 8601) */
	timestamp: string;
}

/** Handler yang dipanggil setiap kali event baru di-append (untuk projections) */
export type EventHandler = (event: DomainEvent) => void;

/** Error untuk optimistic concurrency conflict */
export class ConcurrencyError extends Error {
	constructor(
		public readonly aggregateId: string,
		public readonly expectedVersion: number,
		public readonly actualVersion: number,
	) {
		super(
			`Concurrency conflict for aggregate ${aggregateId}: ` +
				`expected version ${expectedVersion}, but actual is ${actualVersion}`,
		);
		this.name = "ConcurrencyError";
	}
}

/**
 * Append-only event store.
 *
 * - `append`: tulis event baru dengan optimistic concurrency check.
 * - `getEventsForAggregate`: ambil semua event untuk satu aggregate (untuk rebuild state).
 * - `getAllEvents`: ambil seluruh log (untuk replay projections).
 * - `subscribe`: daftarkan handler yang dipanggil saat event baru ditulis.
 */
export class EventStore {
	/** Log urut global. Append-only — tidak pernah di-mutate baris yang ada. */
	private readonly log: DomainEvent[] = [];
	/** Index: aggregateId → versi terakhir (untuk concurrency check cepat) */
	private readonly latestVersion = new Map<string, number>();
	/** Subscribers (projections) yang notify saat event append */
	private readonly subscribers: EventHandler[] = [];

	/** Versi terakhir sebuah aggregate (atau 0 kalau belum ada event). */
	currentVersion(aggregateId: string): number {
		return this.latestVersion.get(aggregateId) ?? 0;
	}

	/**
	 * Append event baru untuk sebuah aggregate.
	 * `expectedVersion` = versi yang command handler kira saat ini.
	 * Kalau mismatch → ConcurrencyError (optimistic concurrency control).
	 *
	 * Optimistic concurrency: kita tidak lock. Kita cuma cek di akhir:
	 * "apakah versi masih sama seperti saat aku baca?" Kalau tidak, berarti
	 * ada concurrency write lain yang lebih dulu → reject.
	 */
	append(
		aggregateId: string,
		type: string,
		data: Record<string, unknown>,
		expectedVersion: number,
	): DomainEvent {
		const actual = this.currentVersion(aggregateId);
		if (expectedVersion !== actual) {
			throw new ConcurrencyError(aggregateId, expectedVersion, actual);
		}

		const event: DomainEvent = {
			id: crypto.randomUUID(),
			aggregateId,
			type,
			data,
			version: actual + 1,
			timestamp: new Date().toISOString(),
		};

		this.log.push(event);
		this.latestVersion.set(aggregateId, event.version);

		// Notify semua subscribers (projections) — read model update async-ish.
		// Di production ini biasanya via message bus (Kafka, RabbitMQ) → eventual consistency.
		for (const handler of this.subscribers) {
			handler(event);
		}

		return event;
	}

	/** Semua event untuk satu aggregate, urut versi naik (untuk rebuild state). */
	getEventsForAggregate(aggregateId: string): DomainEvent[] {
		return this.log.filter((e) => e.aggregateId === aggregateId);
	}

	/** Seluruh event log, urut global (untuk replay projection dari nol). */
	getAllEvents(): readonly DomainEvent[] {
		return this.log;
	}

	/** Daftarkan subscriber. Langsung di-feed event yang sudah ada? pilih `replayExisting`. */
	subscribe(handler: EventHandler, replayExisting = false): void {
		this.subscribers.push(handler);
		if (replayExisting) {
			for (const event of this.log) handler(event);
		}
	}

	/**
	 * Replay semua event ke sebuah handler dari awal.
	 * Dipakai untuk membangun ulang projection dari scratch (mis. setelah ganti schema).
	 */
	replayTo(handler: EventHandler): void {
		for (const event of this.log) handler(event);
	}
}
