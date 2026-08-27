// ─── Kafka Consumer Group Demo ──────────────────────────────────
//
// Consumer Group = sekumpulan consumer yang share beban baca sebuah topic.
// Partitions di-assign ke consumer (1 partition → 1 consumer dalam group).
// Kalau consumer join/leave → rebalance (partition di-assign ulang).
//
// Demo ini menunjukkan:
//   1. Partition assignment (range strategy)
//   2. Parallel consumption (2 consumer baca partition berbeda bersamaan)
//   3. Offset tracking (commit setelah proses, resume dari committed offset)
//   4. Rebalance (consumer join/leave → reassign)
//   5. Replay (seek ke offset 0 → baca ulang event)
//
// Jalankan:  npx tsx 10-kafka/consumer.ts

import {
	createDemoBroker,
	produceOrders,
	ConsumerGroup,
	Consumer,
	type LogRecord,
	type OrderEvent,
} from "./event-log.js";

// ─── Setup: broker + topic + produce 15 events ──────────────────

const broker = createDemoBroker();
const EVENT_COUNT = 15;
produceOrders(broker, EVENT_COUNT);

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║       KAFKA CONSUMER GROUP — Parallel Consumption + Replay   ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log();
console.log(`Topic           : "orders" (3 partitions)`);
console.log(`Consumer Group  : "order-processor"`);
console.log(
	`Events produced : ${EVENT_COUNT} (sudah di-produce oleh producer stage)`,
);
console.log();

// ─── 1. Buat consumer group dengan 2 consumers ──────────────────

const group = new ConsumerGroup("order-processor", "orders", broker);
const c1 = new Consumer("consumer-1", group);
const c2 = new Consumer("consumer-2", group);

group.subscribe(c1);
console.log("── Step 1: consumer-1 joins ───────────────────────────────────");
printAssignment(group);

group.subscribe(c2);
console.log("── Step 2: consumer-2 joins → REBALANCE ──────────────────────");
console.log("  Partitions di-split antar 2 consumers (range assignment):");
printAssignment(group);
console.log();

// ─── 2. Parallel consumption ────────────────────────────────────

console.log("── Step 3: Parallel consumption ──────────────────────────────");
console.log("  Tiap consumer poll partition-nya sendiri → baca paralel.");
console.log();

const batch1 = c1.poll();
console.log(
	`  [consumer-1] polled ${batch1.length} records from partitions [${c1.assignments.join(", ")}]:`,
);
for (const r of batch1) printRecord(r);

const batch2 = c2.poll();
console.log(
	`  [consumer-2] polled ${batch2.length} records from partitions [${c2.assignments.join(", ")}]:`,
);
for (const r of batch2) printRecord(r);

console.log();
console.log(
	`  Total consumed: ${batch1.length + batch2.length} records (parallel, no overlap)`,
);
console.log();

// ─── 3. Offset tracking: commit & resume ────────────────────────

console.log("── Step 4: Commit offsets ────────────────────────────────────");
c1.commit();
c2.commit();
console.log("  Consumer commit offset = 'sudah proses sampai sini'.");
for (const p of c1.assignments) {
	console.log(
		`  [consumer-1] partition ${p} → committed offset ${broker.getCommittedOffset(group.id, p)}`,
	);
}
for (const p of c2.assignments) {
	console.log(
		`  [consumer-2] partition ${p} → committed offset ${broker.getCommittedOffset(group.id, p)}`,
	);
}
console.log();

console.log("── Step 5: Poll lagi (no new events) ─────────────────────────");
const more1 = c1.poll();
const more2 = c2.poll();
console.log(
	`  [consumer-1] got ${more1.length} records (sudah di posisi akhir)`,
);
console.log(
	`  [consumer-2] got ${more2.length} records (sudah di posisi akhir)`,
);
console.log(
	"  → Karena gak ada event baru, poll return kosong. Offset tetap konsisten.",
);
console.log();

// Produce 2 event baru → consumer langsung dapat
console.log("── Step 6: Produce 2 event baru → consumer dapat event baru ───");
const newRecs = produceOrders(broker, 2);
for (const r of newRecs) {
	console.log(
		`  produced: key=${r.key} → partition ${r.partition} offset ${r.offset}`,
	);
}
const fresh1 = c1.poll();
const fresh2 = c2.poll();
console.log(`  [consumer-1] got ${fresh1.length} new records`);
for (const r of fresh1) printRecord(r);
console.log(`  [consumer-2] got ${fresh2.length} new records`);
for (const r of fresh2) printRecord(r);
c1.commit();
c2.commit();
console.log();

// ─── 4. Rebalance: consumer leave ───────────────────────────────

console.log("── Step 7: consumer-2 leaves → REBALANCE ─────────────────────");
console.log("  Partitions consumer-2 di-assign ulang ke consumer-1.");
group.unsubscribe(c2);
printAssignment(group);
console.log("  consumer-1 resume dari committed offset (gak ulang dari awal):");
const afterLeave = c1.poll();
console.log(
	`  [consumer-1] polled ${afterLeave.length} records (sudah committed → kosong)`,
);
console.log();

// ─── 5. Replay: seek ke offset 0 ────────────────────────────────

console.log("── Step 8: REPLAY — seek ke offset 0 & reprocess ─────────────");
console.log("  Ini killer feature Kafka: event gak hilang setelah dibaca.");
console.log("  Consumer bisa seek ke offset manapun & baca ulang.");
console.log();

// Re-add consumer-2 supaya demo replay di kedua partition
group.subscribe(c2);
printAssignment(group);
console.log();

// Seek semua assigned partition ke offset 0
for (const p of c1.assignments) c1.seek(p, 0);
for (const p of c2.assignments) c2.seek(p, 0);

console.log("  Set seek: semua partition → offset 0");
const replay1 = c1.poll();
const replay2 = c2.poll();
console.log(`  [consumer-1] REPLAY: ${replay1.length} records dari awal`);
for (const r of replay1) printRecord(r, true);
console.log(`  [consumer-2] REPLAY: ${replay2.length} records dari awal`);
for (const r of replay2) printRecord(r, true);
console.log();
console.log(`  Total replayed: ${replay1.length + replay2.length} records`);
console.log();
console.log("  Use case replay:");
console.log("    - Bug di consumer → fix → reprocess semua event dari awal");
console.log("    - Tambah consumer baru → baca full history untuk build state");
console.log("    - Analytics: re-aggregate data historis dengan logic baru");
console.log();

// ─── 6. Retention demo ──────────────────────────────────────────

console.log("── Step 9: Retention ─────────────────────────────────────────");
console.log("  Event di-retained selama retentionMs (7 hari di demo).");
console.log("  applyRetention() trim event lebih tua dari retention window.");
const dropped = broker.applyRetention();
if (dropped.length === 0) {
	console.log(
		"  Tidak ada event yang di-trim (semua masih dalam retention window).",
	);
} else {
	for (const d of dropped)
		console.log(`  Topic "${d.topic}": ${d.dropped} events di-trim`);
}
console.log("  → Selama dalam retention, event selalu bisa di-replay.");
console.log();

console.log("✅ Consumer group demo selesai.");
console.log();
console.log("Ringkasan konsep:");
console.log("  • Topic = append-only log, ter-partition");
console.log(
	"  • Partition = unit of parallelism (1 partition → 1 consumer per group)",
);
console.log("  • Offset = bookmark per partition, commit untuk resume");
console.log("  • Consumer group = scale consumption horizontally + rebalance");
console.log(
	"  • Replay = seek ke offset lama (Kafka ≠ queue: event gak hilang)",
);
console.log("  • Retention = event di-keep selama configurable waktu");

// ─── Helpers ────────────────────────────────────────────────────

function printAssignment(g: ConsumerGroup): void {
	for (const a of g.assignmentSnapshot()) {
		const parts = a.partitions.length > 0 ? a.partitions.join(", ") : "(none)";
		console.log(`    ${a.consumer} → partitions [${parts}]`);
	}
}

function printRecord(r: LogRecord, isReplay = false): void {
	const tag = isReplay ? "REPLAY" : "      ";
	const order = r.value as OrderEvent;
	console.log(
		`    ${tag} partition=${r.partition} offset=${r.offset} key=${r.key} order=${order.orderId}`,
	);
}
