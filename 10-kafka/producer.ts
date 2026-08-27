// ─── Kafka Producer Demo ────────────────────────────────────────
//
// Producer = client yang menulis event ke topic.
// Setiap produce(topic, key, value) → broker tentukan partition by hash(key) % partitions.
// Record di-append ke partition (immutable, ordered). Offset = posisi di partition.
//
// Jalankan:  npx tsx 10-kafka/producer.ts

import {
	createDemoBroker,
	produceOrders,
	type LogRecord,
	type OrderEvent,
} from "./event-log.js";

// ─── Setup ──────────────────────────────────────────────────────

const broker = createDemoBroker();
const PARTITIONS = 3;
const EVENT_COUNT = 15;

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║          KAFKA PRODUCER — Event Log Demo                     ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log();
console.log(`Topic      : "orders"`);
console.log(`Partitions : ${PARTITIONS}`);
console.log(
	`Events     : ${EVENT_COUNT} (key: order-1 .. order-${EVENT_COUNT})`,
);
console.log(
	`Strategy   : hash(key) % ${PARTITIONS}  →  same key selalu ke partition yang sama`,
);
console.log();

// ─── Produce events ─────────────────────────────────────────────

const records = produceOrders(broker, EVENT_COUNT);

// ─── Tampilkan setiap produce ───────────────────────────────────

console.log("── Produce records ────────────────────────────────────────────");
for (const r of records) {
	console.log(
		`  key=${(r.key ?? "null").padEnd(9)} → partition ${r.partition} offset ${r.offset}  value=${JSON.stringify(r.value)}`,
	);
}
console.log();

// ─── Distribusi partition ───────────────────────────────────────

const topic = broker.getTopic("orders");
const sizes = topic.partitionSizes();

console.log("── Partition distribution ─────────────────────────────────────");
for (let p = 0; p < PARTITIONS; p++) {
	const recs = topic.partitions[p].records as LogRecord<OrderEvent>[];
	console.log(
		`  Partition ${p}: ${recs.length} records  offsets [0..${recs.length - 1}]`,
	);
	for (const r of recs) {
		console.log(
			`    offset=${r.offset}  key=${r.key}  order=${r.value.orderId}`,
		);
	}
}
console.log();
console.log(
	`  Total: ${sizes.reduce((a, b) => a + b, 0)} records across ${PARTITIONS} partitions`,
);
const SEP = ", ";
const dist = sizes.join(SEP);
console.log(`  Distribution: [${dist}]`);
console.log();

// ─── Key insight: same key → same partition (ordering guarantee) ──

console.log("── Key ordering guarantee ─────────────────────────────────────");
console.log(
	"  Same key SELALU ke partition yang sama → order preserved within partition.",
);
console.log(
	"  Contoh: 'order-1' selalu ke partition",
	records[0].partition,
	"(berapa kali pun di-produce)",
);
console.log();
console.log(
	"  Catatan: order HANYA guaranteed within partition, BUKAN across partitions.",
);
console.log(
	"  Kalau butuh total order → pakai 1 partition (tapi gak bisa parallel consume).",
);
console.log();

// ─── Retention ──────────────────────────────────────────────────

console.log("── Retention ──────────────────────────────────────────────────");
console.log("  Kafka gak hapus event setelah dibaca (beda sama queue).");
console.log("  Event di-retained selama retentionMs (di demo: 7 hari).");
console.log(
	"  Setelah itu, event lama di-trim. Tapi selama di-retain → bisa di-replay.",
);
console.log();
console.log(
	"✅ Producer selesai. Sekarang jalankan:  npx tsx 10-kafka/consumer.ts",
);
