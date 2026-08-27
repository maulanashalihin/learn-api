// ─── Demo: Distributed Systems — CAP, Consistency Models, Failures ──
//
// Demo ini menjalankan semua simulasi dalam 1 process:
//   Part 1: CAP Theorem (CP / AP / CA) dengan network partition
//   Part 2: Consistency Models (strong, eventual, causal, read-your-writes)
//   Part 3: Node Failure Simulation (crash-stop, crash-recovery, byzantine)
//
// Jalankan: npx tsx 13-distributed-systems/demo.ts

import { CapCluster, printSnapshot, printLog } from "./cap-theorem.js";
import {
	StrongRegister,
	EventualRegister,
	CausalStore,
	ReadYourWritesRegister,
} from "./consistency-models.js";

const BANNER = "═".repeat(67);
const PHASE = "─".repeat(67);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────
// PART 1: CAP THEOREM
// ─────────────────────────────────────────────────────────────────

function demoCP(): void {
	console.log(`\n${PHASE}`);
	console.log("  CP — Consistency + Partition tolerance");
	console.log(PHASE);
	console.log("  Saat partition, hanya sisi MAYORITAS yang accept write.");
	console.log("  Sisi minoritas REJECT write (jaga consistency).");
	console.log(
		"  Read selalu return latest (synchronous replication di mayoritas).\n",
	);

	const cluster = new CapCluster("CP", ["A", "B", "C", "D", "E"]);

	// Sebelum partition: write normal.
	console.log("▸ Sebelum partition — write ke A:");
	const w1 = cluster.write("A", "balance", "100");
	console.log(`  result: ${w1.ok ? "OK" : "REJECT"} (${w1.reason})`);
	printLog(cluster);
	printSnapshot(cluster, "State sebelum partition");

	// Partition: A,B | C,D,E  →  C,D,E mayoritas (3 dari 5).
	console.log("\n▸ Partition: [A,B] ⟘ [C,D,E] — grup C,D,E mayoritas (3/5):");
	cluster.partitionInto(["A", "B"], ["C", "D", "E"]);
	printLog(cluster);

	console.log("\n▸ Write dari mayoritas (C):");
	const w2 = cluster.write("C", "balance", "150");
	console.log(`  result: ${w2.ok ? "OK" : "REJECT"} (${w2.reason})`);
	printLog(cluster);

	console.log("\n▸ Write dari minoritas (A):");
	const w3 = cluster.write("A", "balance", "999");
	console.log(`  result: ${w3.ok ? "OK" : "REJECT"} (${w3.reason})`);
	printLog(cluster);

	console.log("\n▸ Read dari mayoritas (D) dan minoritas (A):");
	const rMaj = cluster.read("D", "balance");
	const rMin = cluster.read("A", "balance");
	console.log(
		`  read[D] = "${rMaj.value}" ${rMaj.stale ? "(STALE)" : "(latest)"}`,
	);
	console.log(
		`  read[A] = "${rMin.value}" ${rMin.stale ? "(STALE)" : "(latest, tapi tidak bisa write)"}`,
	);
	printSnapshot(cluster, "State saat partition");

	// Heal.
	console.log("\n▸ Heal partition:");
	cluster.heal();
	printLog(cluster);
	// CP tidak butuh reconcile (mayoritas sudah konsisten, minoritas catch-up).
	console.log(
		"  Catatan: CP tidak butuh reconcile — mayoritas selalu konsisten.",
	);
	console.log("  Minoritas (A,B) catch-up via replikasi normal setelah heal.");
	printSnapshot(cluster, "State setelah heal");
}

function demoAP(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  AP — Availability + Partition tolerance");
	console.log(PHASE);
	console.log(
		"  Saat partition, KEDUA sisi accept write (availability > consistency).",
	);
	console.log(
		"  Read bisa stale. Setelah heal, reconcile (last-write-wins).\n",
	);

	const cluster = new CapCluster("AP", ["A", "B", "C", "D"]);

	// Sebelum partition.
	console.log("▸ Sebelum partition — write ke A:");
	cluster.write("A", "balance", "100");
	printLog(cluster);
	printSnapshot(cluster, "State sebelum partition");

	// Partition: A,B | C,D.
	console.log("\n▸ Partition: [A,B] ⟘ [C,D] — kedua sisi sama-sama accept:");
	cluster.partitionInto(["A", "B"], ["C", "D"]);
	printLog(cluster);

	console.log("\n▸ Write dari grup A (sisi kiri):");
	const wL = cluster.write("A", "balance", "200");
	console.log(`  result: ${wL.ok ? "OK" : "REJECT"} (${wL.reason})`);
	printLog(cluster);

	console.log("\n▸ Write dari grup C (sisi kanan) — key yang SAMA:");
	const wR = cluster.write("C", "balance", "300");
	console.log(`  result: ${wR.ok ? "OK" : "REJECT"} (${wR.reason})`);
	printLog(cluster);

	console.log("\n▸ Read dari kedua sisi (bisa divergen / stale):");
	const rL = cluster.read("A", "balance");
	const rR = cluster.read("C", "balance");
	console.log(
		`  read[A] = "${rL.value}" ${rL.stale ? "(STALE — belum lihat write C)" : "(latest di grup kiri)"}`,
	);
	console.log(
		`  read[C] = "${rR.value}" ${rR.stale ? "(STALE — belum lihat write A)" : "(latest di grup kanan)"}`,
	);
	printSnapshot(cluster, "State saat partition (DIVERGEN)");

	// Heal + reconcile.
	console.log("\n▸ Heal partition + reconcile (last-write-wins by version):");
	cluster.heal();
	printLog(cluster);
	cluster.reconcile();
	printLog(cluster);
	printSnapshot(cluster, "State setelah heal + reconcile (CONVERGE)");
	console.log(
		"  Catatan: write C (v3) menang karena version lebih tinggi dari write A (v2).",
	);
}

function demoCA(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  CA — Consistency + Availability (NO partition tolerance)");
	console.log(PHASE);
	console.log(
		"  Tidak ada partition tolerance — synchronous replication ke semua node.",
	);
	console.log(
		"  Kalau partition terjadi, sistem STOP (tidak menerima write sama sekali).\n",
	);

	const cluster = new CapCluster("CA", ["A", "B", "C"]);

	console.log("▸ Sebelum partition — write ke A (sync replication ke B,C):");
	cluster.write("A", "balance", "100");
	printLog(cluster);
	printSnapshot(cluster, "State sebelum partition");

	console.log("\n▸ Partition: [A] ⟘ [B,C] — CA sistem STOP:");
	cluster.partitionInto(["A"], ["B", "C"]);
	printLog(cluster);

	console.log("\n▸ Write dari A saat partition:");
	const w1 = cluster.write("A", "balance", "200");
	console.log(`  result: ${w1.ok ? "OK" : "REJECT"} (${w1.reason})`);

	console.log("\n▸ Write dari B saat partition:");
	const w2 = cluster.write("B", "balance", "200");
	console.log(`  result: ${w2.ok ? "OK" : "REJECT"} (${w2.reason})`);
	printLog(cluster);
	printSnapshot(
		cluster,
		"State saat partition (STOP — tidak ada write diterima)",
	);

	console.log("\n▸ Heal partition — sistem kembali normal:");
	cluster.heal();
	printLog(cluster);
	const w3 = cluster.write("A", "balance", "250");
	console.log(
		`\n▸ Write setelah heal: ${w3.ok ? "OK" : "REJECT"} (${w3.reason})`,
	);
	printLog(cluster);
	printSnapshot(cluster, "State setelah heal");
}

// ─────────────────────────────────────────────────────────────────
// PART 2: CONSISTENCY MODELS
// ─────────────────────────────────────────────────────────────────

function demoStrong(): void {
	console.log(`\n${PHASE}`);
	console.log("  Strong Consistency (Linearizable)");
	console.log(PHASE);
	console.log(
		"  Read SELALU return latest write. Coordinator + sync replication.\n",
	);

	const reg = new StrongRegister(["R1", "R2", "R3"]);

	console.log("  Timeline:");
	console.log('  t1: write("alice")   → semua replica langsung v1');
	reg.write("alice");
	console.log(
		`  t2: read(R1) = "${reg.read("R1").value}" v${reg.read("R1").version}`,
	);
	console.log('  t3: write("bob")     → semua replica langsung v2');
	reg.write("bob");
	console.log(
		`  t4: read(R2) = "${reg.read("R2").value}" v${reg.read("R2").version}`,
	);
	console.log(
		`  t5: read(R3) = "${reg.read("R3").value}" v${reg.read("R3").version}`,
	);

	console.log(
		"\n  Hasil: setiap read return latest write. Tidak ada stale read.",
	);
	console.log(
		"  Trade-off: write lambat (tunggu semua replica ACK), tidak available saat partition.",
	);
}

function demoEventual(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  Eventual Consistency");
	console.log(PHASE);
	console.log(
		"  Read BISA stale sementara, tapi converge setelah propagasi selesai.\n",
	);

	const reg = new EventualRegister(["R1", "R2", "R3"]);

	console.log("  Timeline:");
	console.log('  t1: write("alice") → coordinator updated, replica pending');
	reg.write("alice", "client-1");
	for (const l of reg.log) console.log(`  ${l}`);
	reg.log.length = 0;

	console.log("\n  t2: read(R2) SEBELUM propagasi:");
	const r1 = reg.read("R2");
	console.log(
		`  read(R2) = "${r1.value}" v${r1.version} ${r1.stale ? "← STALE (belum converge)" : ""}`,
	);

	console.log("\n  t3: tick(1) — 1 propagation sampai:");
	reg.tick(1);
	for (const l of reg.log) console.log(`  ${l}`);
	reg.log.length = 0;
	const r2 = reg.read("R2");
	console.log(
		`  read(R2) = "${r2.value}" v${r2.version} ${r2.stale ? "← masih STALE" : "← up-to-date"}`,
	);

	console.log("\n  t4: converge() — semua propagation selesai:");
	reg.converge();
	for (const l of reg.log) console.log(`  ${l}`);
	reg.log.length = 0;
	for (const id of ["R1", "R2", "R3"]) {
		const r = reg.read(id);
		console.log(
			`  read(${id}) = "${r.value}" v${r.version} ${r.stale ? "STALE" : "converged"}`,
		);
	}

	console.log(
		"\n  Hasil: ada window stale, tapi akhirnya semua replica converge.",
	);
	console.log(
		"  Trade-off: read bisa stale, tapi write cepat & available saat partition.",
	);
}

function demoCausal(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  Causal Consistency (Vector Clocks)");
	console.log(PHASE);
	console.log(
		"  Operasi causally-related dilihat dalam urutan SAMA di semua node.",
	);
	console.log(
		"  Operasi concurrent BOLEH berbeda urutan. Vector clocks track causality.\n",
	);

	const store = new CausalStore(["N1", "N2", "N3"]);

	console.log("  Skenario: 'reply' secara causal tergantung 'post'.");
	console.log("  Concurrent: N1 dan N3 write 'like' tanpa saling tahu.\n");

	// N1 write post.
	console.log('  t1: N1 write post="hello" (vc N1:1)');
	store.write("N1", "post", "hello");
	for (const l of store.log) console.log(`  ${l}`);
	store.log.length = 0;

	// Propagate post ke N2.
	console.log("\n  t2: propagate N1→N2 (post sampai di N2)");
	store.propagate("N1", "N2");
	for (const l of store.log) console.log(`  ${l}`);
	store.log.length = 0;

	// N2 write reply — depends on post (causal).
	console.log('\n  t3: N2 write reply="hi" — depends on post dari N1 (causal)');
	const postVc = store.nodes.get("N2")!.vc;
	store.write("N2", "reply", "hi", { from: "N1", vc: postVc });
	for (const l of store.log) console.log(`  ${l}`);
	store.log.length = 0;

	// Concurrent: N1 write like, N3 write like — tanpa saling tahu.
	console.log('\n  t4: N1 write like="👍" (concurrent, belum lihat N3)');
	store.write("N1", "like", "👍");
	for (const l of store.log) console.log(`  ${l}`);
	store.log.length = 0;

	console.log('\n  t5: N3 write like="❤️" (concurrent, belum lihat N1)');
	store.write("N3", "like", "❤️");
	for (const l of store.log) console.log(`  ${l}`);
	store.log.length = 0;

	// Propagate semua ke N3 untuk lihat urutan causal.
	console.log(
		"\n  t6: propagate N1→N3 dan N2→N3 (N3 lihat post + reply secara causal):",
	);
	store.propagate("N1", "N3");
	store.propagate("N2", "N3");
	for (const l of store.log) console.log(`  ${l}`);
	store.log.length = 0;

	console.log("\n  ── Log per node ──");
	for (const id of ["N1", "N2", "N3"]) {
		console.log(`  [${id}]:`);
		for (const e of store.nodeLog(id)) {
			console.log(`    ${e.key}="${e.value}" ${e.vc}`);
		}
	}

	console.log("\n  ── Read 'like' di tiap node (concurrent → bisa beda) ──");
	for (const id of ["N1", "N2", "N3"]) {
		const r = store.read(id, "like");
		console.log(
			`  read(${id}, like) = "${r.value}" ${r.vc ? store.fmtVC(r.vc) : "(null)"}`,
		);
	}

	console.log("\n  Hasil:");
	console.log(
		"  • post → reply: causal. Node yang sudah lihat reply PASTI sudah lihat post.",
	);
	console.log(
		"  • like@N1 vs like@N3: concurrent. Node bisa pilih salah satu (tie-break).",
	);
	console.log(
		"  Trade-off: lebih kuat dari eventual, lebih lemah dari linearizable.",
	);
}

function demoReadYourWrites(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  Read-Your-Writes Consistency");
	console.log(PHASE);
	console.log(
		"  Client SELALU lihat write-nya sendiri (session cache / sticky).\n",
	);

	const reg = new ReadYourWritesRegister(["R1", "R2"]);

	console.log(
		"  Skenario: client-A write, lalu langsung read — harus lihat write-nya.\n",
	);

	console.log('  t1: client-A write "alice" ke R1:');
	reg.write("client-A", "R1", "alice");
	for (const l of reg.log) console.log(`  ${l}`);
	reg.log.length = 0;

	console.log("\n  t2: client-A read dari R2 (beda replica, belum propagate):");
	const r1 = reg.read("client-A", "R2");
	console.log(
		`  read(client-A, R2) = "${r1.value}" v${r1.version} ← via ${r1.source}`,
	);
	console.log(
		"  → client-A lihat write-nya sendiri walau R2 belum propagate (read-your-writes).",
	);

	console.log("\n  t3: client-B (client berbeda) read dari R2:");
	const r2 = reg.read("client-B", "R2");
	console.log(
		`  read(client-B, R2) = "${r2.value}" v${r2.version} ← via ${r2.source}`,
	);
	console.log(
		"  → client-B TIDAK lihat write client-A (belum propagate) — tidak ada session cache.",
	);

	console.log("\n  t4: propagate ke R2, lalu client-B read lagi:");
	reg.propagateTo("R2");
	for (const l of reg.log) console.log(`  ${l}`);
	reg.log.length = 0;
	const r3 = reg.read("client-B", "R2");
	console.log(
		`  read(client-B, R2) = "${r3.value}" v${r3.version} ← via ${r3.source}`,
	);

	console.log(
		"\n  Hasil: read-your-writes = client-centric guarantee, bukan global consistency.",
	);
	console.log(
		"  Implementasi: sticky session, session token, atau client-side cache.",
	);
}

// ─────────────────────────────────────────────────────────────────
// PART 3: NODE FAILURE SIMULATION
// ─────────────────────────────────────────────────────────────────

function demoCrashStop(): void {
	console.log(`\n${PHASE}`);
	console.log("  Failure: Crash-Stop");
	console.log(PHASE);
	console.log(
		"  Node gagal dan TIDAK pernah recover. Sistem harus punya replica.\n",
	);

	const cluster = new CapCluster("AP", ["A", "B", "C"]);

	console.log("▸ Sebelum crash — write ke A, replikasi ke B,C:");
	cluster.write("A", "data", "v1");
	printLog(cluster);
	printSnapshot(cluster, "State sebelum crash");

	console.log("\n▸ Node A crash (crash-stop, tidak recover):");
	cluster.crash("A");
	printLog(cluster);

	console.log("\n▸ Write ke A (gagal — node down):");
	const w = cluster.write("A", "data", "v2");
	console.log(`  result: ${w.ok ? "OK" : "REJECT"} (${w.reason})`);

	console.log(
		"\n▸ Write ke B (masih jalan — availability terjaga karena replica):",
	);
	const w2 = cluster.write("B", "data", "v2");
	console.log(`  result: ${w2.ok ? "OK" : "REJECT"} (${w2.reason})`);
	printLog(cluster);
	printSnapshot(cluster, "State setelah crash-stop");
	console.log(
		"  Catatan: A tidak pernah recover. Data tetap available via B,C (replication).",
	);
}

function demoCrashRecovery(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  Failure: Crash-Recovery");
	console.log(PHASE);
	console.log(
		"  Node gagal, lalu restart. Harus catch-up (missed writes saat down).\n",
	);

	const cluster = new CapCluster("AP", ["A", "B", "C"]);

	console.log("▸ Sebelum crash — write ke A:");
	cluster.write("A", "data", "v1");
	printLog(cluster);

	console.log("\n▸ Node A crash:");
	cluster.crash("A");
	printLog(cluster);

	console.log("\n▸ Saat A down — write ke B (A miss write ini):");
	cluster.write("B", "data", "v2");
	printLog(cluster);
	printSnapshot(cluster, "State saat A down (missed v2)");

	console.log("\n▸ Node A recover — butuh catch-up:");
	cluster.recover("A");
	printLog(cluster);
	// Simulasi catch-up: A menerima replikasi dari B.
	console.log(
		"▸ A catch-up via replikasi dari B (anti-entropy / read-repair):",
	);
	// Replikasi manual: write B lagi ke A (di real system: merkle tree / log exchange).
	const bNode = cluster.snapshot().find((n) => n.id === "B")!;
	for (const e of bNode.entries) {
		cluster.write("B", e.key, e.value);
	}
	printLog(cluster);
	printSnapshot(cluster, "State setelah A catch-up");
	console.log(
		"  Catatan: A kembali konsisten setelah catch-up. Window recovery = missed writes.",
	);
}

function demoByzantine(): void {
	console.log(`\n\n${PHASE}`);
	console.log("  Failure: Byzantine (node jahat / bug — kirim pesan konflik)");
	console.log(PHASE);
	console.log(
		"  Node A kirim value BERBEDA ke node berbeda. Tanpa consensus, sistem divergen.\n",
	);

	// Simulasi sederhana: 3 node, A byzantine.
	const cluster = new CapCluster("AP", ["A", "B", "C"]);

	console.log(
		"▸ Node A (byzantine) kirim value BERBEDA ke B dan C (tanpa replikasi):",
	);
	// A "berbohong": kirim X ke B, kirim Y ke C — pesan konflik.
	cluster.injectMessage("A", "B", "claim", "A-says-X");
	cluster.injectMessage("A", "C", "claim", "A-says-Y");
	printLog(cluster);
	printSnapshot(
		cluster,
		"State — B dan C punya claim BERBEDA dari A (DIVERGEN)",
	);

	console.log(
		"\n  Tanpa Byzantine fault tolerance (BFT), B dan C tidak tahu mana yang benar.",
	);
	console.log(
		"  Solusi: Byzantine consensus (PBFT, PoW) — butuh ≥ 3f+1 node untuk tolerate f byzantine.",
	);
	console.log(
		"  Contoh real: blockchain (PoW/PoS), Tendermint, Hyperledger Fabric.",
	);
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(
		"\n╔═══════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  13 — Distributed Systems: CAP, Consistency & Failures       ║",
	);
	console.log(
		"╚═══════════════════════════════════════════════════════════════╝\n",
	);

	// ═══════════════════════════════════════════════════════════════
	console.log(`${BANNER}`);
	console.log("  PART 1: CAP THEOREM (Consistency · Availability · Partition)");
	console.log(`${BANNER}`);
	console.log("  Pilih 2 dari 3 saat partition. Normal operation = semua 3.\n");

	demoCP();
	demoAP();
	demoCA();

	await sleep(100);

	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  PART 2: CONSISTENCY MODELS (spectrum)");
	console.log(`${BANNER}`);
	console.log("  linearizable → sequential → causal → eventual → weak\n");

	demoStrong();
	demoEventual();
	demoCausal();
	demoReadYourWrites();

	await sleep(100);

	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  PART 3: NODE FAILURE SIMULATION");
	console.log(`${BANNER}`);
	console.log("  crash-stop · crash-recovery · byzantine\n");

	demoCrashStop();
	demoCrashRecovery();
	demoByzantine();

	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  Summary: CAP Trade-off Matrix");
	console.log(`${BANNER}\n`);
	console.log(
		"  ┌─────┬──────────────┬───────────────┬──────────────────────────────────┐",
	);
	console.log(
		"  │ Mode│ Sacrifice    │ Saat Partition│ Contoh                           │",
	);
	console.log(
		"  ├─────┼──────────────┼───────────────┼──────────────────────────────────┤",
	);
	console.log(
		"  │ CP  │ Availability │ Minoritas reject write, mayoritas serve      │",
	);
	console.log(
		"  │     │              │               │ MongoDB, HBase, etcd             │",
	);
	console.log(
		"  ├─────┼──────────────┼───────────────┼──────────────────────────────────┤",
	);
	console.log(
		"  │ AP  │ Consistency  │ Kedua sisi accept, reconcile setelah heal     │",
	);
	console.log(
		"  │     │              │               │ Cassandra, DynamoDB (eventual)  │",
	);
	console.log(
		"  ├─────┼──────────────┼───────────────┼──────────────────────────────────┤",
	);
	console.log(
		"  │ CA  │ Partition    │ Sistem STOP (tidak tolerate partition)        │",
	);
	console.log(
		"  │     │ tolerance    │               │ Spanner (sync), single-node RDBMS│",
	);
	console.log(
		"  └─────┴──────────────┴───────────────┴──────────────────────────────────┘",
	);

	console.log(
		"\n\n╔═══════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  ✓ Demo complete.                                             ║",
	);
	console.log(
		"║  Key takeaways:                                               ║",
	);
	console.log(
		"║  • CAP: saat partition, pilih C atau A. Normal = semua 3.     ║",
	);
	console.log(
		"║  • Consistency spectrum: linearizable → causal → eventual     ║",
	);
	console.log(
		"║  • Failures: crash-stop, crash-recovery, byzantine            ║",
	);
	console.log(
		"║  • Replication + consensus = jantung distributed systems      ║",
	);
	console.log(
		"╚═══════════════════════════════════════════════════════════════╝\n",
	);
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
