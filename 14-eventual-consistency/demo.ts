// ─── Demo: Eventual Consistency ────────────────────────────────
//
// Demo ini menunjukkan 4 mekanisme eventual consistency:
//   1. Read Repair — perbaiki replica stale saat dibaca
//   2. Anti-Entropy — sync via Merkle tree (efficient diff)
//   3. CRDTs — data structures yang merge tanpa konflik
//   4. Vector Clocks — track causality, deteksi concurrent writes
//
// Semua in-memory simulation. Jalankan:
//   npx tsx 14-eventual-consistency/demo.ts

import { runReadRepairDemo } from "./read-repair.js";
import { runAntiEntropyDemo } from "./anti-entropy.js";
import { runCrdtDemo } from "./crdt.js";
import { runVectorClockDemo } from "./vector-clocks.js";

function header(): void {
	console.log();
	console.log("╔" + "═".repeat(62) + "╗");
	console.log("║" + "  14 — EVENTUAL CONSISTENCY".padEnd(62) + "║");
	console.log(
		"║" +
			"  All replicas converge eventually, may diverge temporarily".padEnd(62) +
			"║",
	);
	console.log("╚" + "═".repeat(62) + "╝");
	console.log();
	console.log(
		"Eventual consistency = model di mana, jika tidak ada update baru,",
	);
	console.log(
		"semua replica akan konvergen ke state yang sama. Selama proses,",
	);
	console.log("replica bisa sementara berbeda (stale reads) — trade-off untuk");
	console.log("availability & low latency saat partition.");
	console.log();
	console.log("Demo ini menunjukkan 4 teknik untuk mencapai & memperbaiki");
	console.log("konsistensi eventual: read repair, anti-entropy (Merkle),");
	console.log("CRDTs, dan vector clocks.");
}

function footer(): void {
	console.log("═".repeat(60));
	console.log("  RINGKASAN");
	console.log("═".repeat(60));
	console.log();
	console.log(
		"  Teknik           | Trigger      | Cost          | Contoh produk",
	);
	console.log(
		"  ─────────────────┼──────────────┼───────────────┼─────────────────",
	);
	console.log(
		"  Read Repair      | on read      | read + write  | Cassandra, DynamoDB",
	);
	console.log(
		"  Anti-Entropy     | periodic     | O(log n) diff | Cassandra, Riak",
	);
	console.log(
		"  CRDTs            | on merge     | metadata      | Riak, Automerge, Yjs",
	);
	console.log(
		"  Vector Clocks    | per write    | O(n) clock    | Riak, Dynamo",
	);
	console.log();
	console.log("  Eventual consistency cocok untuk: high-availability system,");
	console.log("  collaborative editing, social media feeds, shopping cart —");
	console.log("  di mana stale reads sesaat dapat ditoleransi.");
	console.log();
}

async function main(): Promise<void> {
	header();

	runReadRepairDemo();
	runAntiEntropyDemo();
	runCrdtDemo();
	runVectorClockDemo();

	footer();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
