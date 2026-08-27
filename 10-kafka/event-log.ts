// ─── In-memory Kafka-like Event Log ─────────────────────────────
//
// Apache Kafka bukan queue. Kafka adalah **distributed append-only event log**.
// Setiap topic adalah log yang ter-partition. Pesan gak dihapus setelah dibaca —
// pesan tetap ada (retention), bisa dibaca ulang (replay) berkali-kali.
//
// File ini adalah "broker" in-memory yang mendemonstrasikan konsep inti Kafka:
//   - Topic     : named log (e.g. "orders")
//   - Partition : log dipecah jadi N partition, distribusi by key hash
//   - Offset    : per-partition monotonically increasing sequence number
//   - Producer  : append record ke partition (dipilih by hash(key) % partitions)
//   - Consumer  : baca dari partition mulai offset tertentu
//   - Consumer Group : multiple consumer share group, partition di-split antar mereka
//   - Rebalance : kalau consumer join/leave, partition di-assign ulang
//   - Replay    : consumer bisa seek ke offset lama & baca ulang
//   - Retention : event di-retained selama configurable waktu (bukan dihapus setelah consume)
//
// Di production: Kafka cluster = multiple broker, replication, ZooKeeper/KRaft.
// Di sini: 1 process in-memory, cukup untuk paham konsepnya.

// ─── Types ──────────────────────────────────────────────────────

/** Satu record di log. Immutable setelah di-append. */
export interface LogRecord<V = unknown> {
	offset: number; // per-partition, 0-based, monotonically increasing
	partition: number;
	key: string | null; // null = round-robin partitioning
	value: V;
	timestamp: number; // Date.now() saat diproduksi
}

/** Konfigurasi topic. */
export interface TopicConfig {
	partitions: number;
	retentionMs: number; // event lebih tua dari ini boleh di-trim
}

// ─── Partition: append-only, immutable, ordered ─────────────────

class Partition {
	readonly records: LogRecord[] = [];

	/** Append record baru. Offset = index berikutnya (monoton). */
	append(rec: Omit<LogRecord, "offset">): LogRecord {
		const full: LogRecord = { ...rec, offset: this.records.length };
		this.records.push(full);
		return full;
	}

	/** Ambil semua record mulai dari offset (inclusive). Untuk consume & replay. */
	readFrom(fromOffset: number): LogRecord[] {
		if (fromOffset < 0) fromOffset = 0;
		return this.records.filter((r) => r.offset >= fromOffset);
	}

	/** Hapus record lebih tua dari cutoff timestamp (retention policy). */
	trimOlderThan(cutoff: number): number {
		const before = this.records.length;
		// NOTE: di Kafka asli, offset gak di-reset saat retention hapus record.
		// Consumer offset tetap valid — mereka cuma gak bisa baca record yang udah hilang.
		// Di demo ini kita keep array tapi tandai "log start offset" supaya offset tetap konsisten.
		const keep = this.records.filter((r) => r.timestamp >= cutoff);
		if (keep.length === this.records.length) return 0;
		const dropped = this.records.length - keep.length;
		// Geser offset supaya tetap 0-based? Tidak — itu akan break offset tracking.
		// Karena itu demo retention hanya melaporkan; kita simpan logStartOffset.
		this.records.length = 0;
		this.records.push(...keep);
		// Re-index offset supaya array tetap konsisten (demo-only; Kafka asli pakai log start offset)
		this.records.forEach((r, i) => (r.offset = i));
		return dropped;
	}

	get length(): number {
		return this.records.length;
	}
}

// ─── Topic: kumpulan partition + partitioning strategy ──────────

class Topic {
	readonly partitions: Partition[];
	readonly config: TopicConfig;
	private rrCounter = 0; // untuk round-robin saat key = null

	constructor(config: TopicConfig) {
		this.config = config;
		this.partitions = Array.from(
			{ length: config.partitions },
			() => new Partition(),
		);
	}

	/** Tentukan partition untuk key. hash(key) % partitions. null key → round-robin. */
	partitionFor(key: string | null): number {
		if (key === null) {
			const p = this.rrCounter % this.config.partitions;
			this.rrCounter++;
			return p;
		}
		// Simple deterministic hash (bukan Kafka asli: murmur2, tapi cukup untuk demo)
		let hash = 0;
		for (let i = 0; i < key.length; i++) {
			hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
		}
		return Math.abs(hash) % this.config.partitions;
	}

	/** Append record ke partition yang dipilih. */
	produce<V>(key: string | null, value: V): LogRecord<V> {
		const partition = this.partitionFor(key);
		const rec = this.partitions[partition].append({
			partition,
			key,
			value,
			timestamp: Date.now(),
		});
		return rec as LogRecord<V>;
	}

	/** Baca dari sebuah partition mulai offset tertentu. */
	readFrom(partition: number, fromOffset: number): LogRecord[] {
		return this.partitions[partition].readFrom(fromOffset);
	}

	/** Jumlah record per partition (untuk laporan distribusi). */
	partitionSizes(): number[] {
		return this.partitions.map((p) => p.length);
	}
}

// ─── KafkaBroker: gateway ke semua topic + committed offsets ────

export class KafkaBroker {
	private topics = new Map<string, Topic>();
	// committedOffsets: groupId → partition → last committed offset (next to read)
	private committed = new Map<string, Map<number, number>>();

	createTopic(name: string, config: TopicConfig): Topic {
		if (this.topics.has(name)) {
			throw new Error(`Topic "${name}" already exists`);
		}
		const t = new Topic(config);
		this.topics.set(name, t);
		return t;
	}

	getTopic(name: string): Topic {
		const t = this.topics.get(name);
		if (!t) throw new Error(`Topic "${name}" not found`);
		return t;
	}

	/** Produce record ke topic. Partition ditentukan by key hash. */
	produce<V>(topic: string, key: string | null, value: V): LogRecord<V> {
		return this.getTopic(topic).produce(key, value);
	}

	/** Baca record dari topic/partition mulai offset. */
	readFrom(topic: string, partition: number, fromOffset: number): LogRecord[] {
		return this.getTopic(topic).readFrom(partition, fromOffset);
	}

	// ── Offset tracking (per consumer group, per partition) ──

	/** Commit offset = "sudah proses sampai sini, next read mulai offset+1". */
	commitOffset(groupId: string, partition: number, offset: number): void {
		let g = this.committed.get(groupId);
		if (!g) {
			g = new Map();
			this.committed.set(groupId, g);
		}
		g.set(partition, offset + 1); // simpan "next offset to read"
	}

	/** Offset yang sudah di-commit. Return 0 kalau belum pernah commit (start dari awal). */
	getCommittedOffset(groupId: string, partition: number): number {
		return this.committed.get(groupId)?.get(partition) ?? 0;
	}

	/** Terapkan retention: trim record lebih tua dari retentionMs di semua topic. */
	applyRetention(): { topic: string; dropped: number }[] {
		const now = Date.now();
		const report: { topic: string; dropped: number }[] = [];
		for (const [name, topic] of this.topics) {
			const cutoff = now - topic.config.retentionMs;
			let dropped = 0;
			for (const p of topic.partitions) dropped += p.trimOlderThan(cutoff);
			if (dropped > 0) report.push({ topic: name, dropped });
		}
		return report;
	}
}

// ─── Consumer & Consumer Group ──────────────────────────────────

/** Sebuah consumer dalam consumer group. Punya assigned partitions. */
export class Consumer {
	readonly id: string;
	readonly group: ConsumerGroup;
	// local position per partition: next offset to read (in-memory, belum di-commit)
	private position = new Map<number, number>();

	constructor(id: string, group: ConsumerGroup) {
		this.id = id;
		this.group = group;
	}

	/** Partitions yang sedang di-assign ke consumer ini. */
	get assignments(): number[] {
		return this.group.assignmentsFor(this);
	}

	/** Poll: baca record baru dari semua assigned partition mulai posisi saat ini. */
	poll(): LogRecord[] {
		const out: LogRecord[] = [];
		for (const partition of this.assignments) {
			const pos =
				this.position.get(partition) ??
				this.group.broker.getCommittedOffset(this.group.id, partition);
			const recs = this.group.broker.readFrom(this.group.topic, partition, pos);
			for (const r of recs) {
				out.push(r);
				this.position.set(partition, r.offset + 1);
			}
		}
		return out;
	}

	/** Commit posisi saat ini ke broker (persisten across restart dalam session). */
	commit(): void {
		for (const partition of this.assignments) {
			const pos = this.position.get(partition);
			if (pos !== undefined) {
				this.group.broker.commitOffset(this.group.id, partition, pos - 1);
			}
		}
	}

	/** Seek: set posisi ke offset tertentu. Inti dari replay — baca ulang event lama. */
	seek(partition: number, offset: number): void {
		this.position.set(partition, offset);
	}

	/** Reset posisi ke committed offset (mis. setelah rebalance dapat partition baru). */
	resetToCommitted(partition: number): void {
		this.position.set(
			partition,
			this.group.broker.getCommittedOffset(this.group.id, partition),
		);
	}
}

/** Consumer Group: sekumpulan consumer yang share beban baca sebuah topic. */
export class ConsumerGroup {
	readonly id: string;
	readonly topic: string;
	readonly broker: KafkaBroker;
	private consumers: Consumer[] = [];
	// assignment: partition → consumer
	private assignment = new Map<number, Consumer>();

	constructor(id: string, topic: string, broker: KafkaBroker) {
		this.id = id;
		this.topic = topic;
		this.broker = broker;
	}

	/** Consumer join group → trigger rebalance. */
	subscribe(consumer: Consumer): void {
		this.consumers.push(consumer);
		this.rebalance();
	}

	/** Consumer leave group → trigger rebalance. */
	unsubscribe(consumer: Consumer): void {
		this.consumers = this.consumers.filter((c) => c.id !== consumer.id);
		this.rebalance();
	}

	get size(): number {
		return this.consumers.length;
	}

	/** Partitions yang di-assign ke consumer tertentu. */
	assignmentsFor(consumer: Consumer): number[] {
		const out: number[] = [];
		for (const [partition, c] of this.assignment) {
			if (c.id === consumer.id) out.push(partition);
		}
		return out.sort((a, b) => a - b);
	}

	/** Snapshot assignment saat ini (untuk laporan). */
	assignmentSnapshot(): { consumer: string; partitions: number[] }[] {
		return this.consumers.map((c) => ({
			consumer: c.id,
			partitions: this.assignmentsFor(c),
		}));
	}

	/**
	 * Rebalance: re-assign partitions ke consumers.
	 * Strategy: range assignment — partitions consecutive di-bagi antar consumer.
	 *   N partitions, M consumers → consumer i dapat range [start, start+len).
	 *   Contoh: 3 partitions, 2 consumers → c0=[0,1], c1=[2].
	 *
	 * Di Kafka asli: range (default) atau round-robin atau sticky/cooperative.
	 * Setelah rebalance, consumer yang dapat partition baru resume dari committed offset.
	 */
	private rebalance(): void {
		const topic = this.broker.getTopic(this.topic);
		const totalPartitions = topic.config.partitions;
		const m = this.consumers.length;
		this.assignment.clear();

		if (m === 0) return;

		const per = Math.floor(totalPartitions / m);
		const remainder = totalPartitions % m;
		let cursor = 0;
		for (let i = 0; i < m; i++) {
			const len = per + (i < remainder ? 1 : 0);
			for (let p = cursor; p < cursor + len; p++) {
				this.assignment.set(p, this.consumers[i]);
				// Consumer baru dapat partition → reset posisi ke committed offset
				this.consumers[i].resetToCommitted(p);
			}
			cursor += len;
		}
	}
}

// ─── Demo helper: bikin broker + topic "orders" dengan 3 partitions ──

export interface OrderEvent {
	orderId: string;
	amount: number;
}

/** Bikin broker dengan topic "orders" (3 partitions, retention 7 hari). */
export function createDemoBroker(): KafkaBroker {
	const broker = new KafkaBroker();
	broker.createTopic("orders", {
		partitions: 3,
		retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 hari
	});
	return broker;
}

/** Produce N order events (key: order-1..order-N) ke topic "orders". */
export function produceOrders(
	broker: KafkaBroker,
	count: number,
): LogRecord<OrderEvent>[] {
	const records: LogRecord<OrderEvent>[] = [];
	for (let i = 1; i <= count; i++) {
		const rec = broker.produce<OrderEvent>("orders", `order-${i}`, {
			orderId: `order-${i}`,
			amount: Math.round(Math.random() * 1000) + 10,
		});
		records.push(rec);
	}
	return records;
}
