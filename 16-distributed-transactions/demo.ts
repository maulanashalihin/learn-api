// ─── Demo: Distributed Transactions ─────────────────────────────
//
// Menjalankan 3 pola distributed transaction di 1 process:
//   1. Two-Phase Commit (2PC) — commit / abort / blocking problem
//   2. Saga — orchestration + choreography (forward + compensation)
//   3. Transactional Outbox — atomic write + poll + publish
//
// Jalankan: npx tsx 16-distributed-transactions/demo.ts

import {
	Coordinator,
	Participant,
	THREE_PC_PHASES,
} from "./two-phase-commit.js";
import { OrderSagaChoreography, OrderSagaOrchestrator, World } from "./saga.js";
import { Database, MessageBus, OrderService, OutboxPoller } from "./outbox.js";

const BANNER = "═".repeat(67);
const SECTION = "─".repeat(67);
const SUB = "·".repeat(67);

const sleep = (ms: number) => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};
function header(title: string): void {
	console.log(`\n${BANNER}`);
	console.log(`  ${title}`);
	console.log(BANNER);
}

function sub(title: string): void {
	console.log(`\n${SUB}\n  ${title}\n${SUB}`);
}

// ── 2PC demos ──

function printTwoPcState(coord: Coordinator, parts: Participant[]): void {
	console.log(
		`  Coordinator [${coord.name}]: ${coord.state}${coord.alive ? "" : " (DEAD)"}`,
	);
	for (const p of parts) {
		const lock = p.lockHeld ? "🔒lock" : "  free ";
		const alive = p.alive ? "" : " (DEAD)";
		console.log(`  Participant [${p.name}]: ${p.state} ${lock}${alive}`);
	}
}

function demo2pcCommit(): void {
	header("2PC — Skenario 1: Semua vote YES → COMMIT");
	const pA = new Participant("A-orders");
	const pB = new Participant("B-payments");
	const pC = new Participant("C-inventory");
	const coord = new Coordinator("coord-1");
	const parts = [pA, pB, pC];

	console.log("\n  Initial state:");
	printTwoPcState(coord, parts);

	const res = coord.run(parts);
	console.log("\n  Events:");
	for (const e of res.events) console.log(`  ${e}`);

	console.log("\n  Final state:");
	printTwoPcState(coord, parts);
	console.log(
		`\n  OUTCOME: ${res.outcome} — semua participant COMMITTED, lock dilepas.`,
	);
}

function demo2pcAbort(): void {
	header("2PC — Skenario 2: Satu vote NO → ABORT (rollback)");
	const pA = new Participant("A-orders");
	const pB = new Participant("B-payments", { vote: () => "NO" }); // payments reject
	const pC = new Participant("C-inventory");
	const coord = new Coordinator("coord-2");
	const parts = [pA, pB, pC];

	console.log("\n  Initial state:");
	printTwoPcState(coord, parts);

	const res = coord.run(parts);
	console.log("\n  Events:");
	for (const e of res.events) console.log(`  ${e}`);

	console.log("\n  Final state:");
	printTwoPcState(coord, parts);
	console.log(
		`\n  OUTCOME: ${res.outcome} — B vote NO, semua ABORTED, lock dilepas.`,
	);
}

function demo2pcCoordinatorCrash(): void {
	header("2PC — Skenario 3: Coordinator CRASH setelah Phase 1 → BLOCKING");
	console.log(
		"  (coordinator mati setelah semua vote YES, sebelum kirim COMMIT)",
	);

	const pA = new Participant("A-orders");
	const pB = new Participant("B-payments");
	const pC = new Participant("C-inventory");
	const coord = new Coordinator("coord-3", { crashAfterAllYes: true });
	const parts = [pA, pB, pC];

	console.log("\n  Initial state:");
	printTwoPcState(coord, parts);

	const res = coord.run(parts);
	console.log("\n  Events:");
	for (const e of res.events) console.log(`  ${e}`);

	console.log("\n  Final state — participants STUCK:");
	printTwoPcState(coord, parts);
	console.log(`\n  OUTCOME: ${res.outcome}`);
	console.log(`  ⚠ ${res.blockedReason}`);
	console.log(
		`  ⚠ Participant A, B, C tidak bisa memutuskan commit/abort sendiri.`,
	);
	console.log(
		`    Mereka pegang lock, menunggu coordinator hidup lagi. Inilah`,
	);
	console.log(`    BLOCKING PROBLEM 2PC — resource terkunci sampai recovery.`);
}

function demo2pcParticipantCrash(): void {
	header("2PC — Skenario 4: Participant CRASH setelah YES → recovery");
	console.log(
		"  (participant B vote YES lalu crash; coordinator blocked menunggu ACK)",
	);

	const pA = new Participant("A-orders");
	const pB = new Participant("B-payments", { crashAfterVote: true });
	const pC = new Participant("C-inventory");
	const coord = new Coordinator("coord-4");
	const parts = [pA, pB, pC];

	console.log("\n  Initial state:");
	printTwoPcState(coord, parts);

	const res = coord.run(parts);
	console.log("\n  Events:");
	for (const e of res.events) console.log(`  ${e}`);

	console.log("\n  State setelah crash (coordinator blocked):");
	printTwoPcState(coord, parts);
	console.log(`\n  OUTCOME: ${res.outcome}`);
	console.log(`  ⚠ ${res.blockedReason}`);

	// Recovery: B hidup lagi, baca durable log (PREPARED, decision=null).
	console.log("\n  --- RECOVERY ---");
	console.log(
		"  B restart → baca durable log: status=PREPARED, decision=UNKNOWN",
	);
	pB.recover();
	printTwoPcState(coord, parts);
	console.log(
		"  B butuh coordinator memberitahu decision (2PC: participant tidak",
	);
	console.log(
		"  bisa menyimpulkan sendiri). Coordinator hidup lagi, punya decision=COMMIT.",
	);
	coord.recover();
	if (coord.decision === "COMMIT") {
		pA.applyDecision("COMMIT");
		pB.applyDecision("COMMIT");
		pC.applyDecision("COMMIT");
	}
	console.log(
		"\n  State setelah recovery (coordinator apply decision ke semua):",
	);
	printTwoPcState(coord, parts);
	console.log(
		`\n  Recovery selesai: participant yang crash akhirnya COMMITTED setelah`,
	);
	console.log(
		`  coordinator kembali. Lock baru dilepas setelah recovery — selama itu,`,
	);
	console.log(`  resource terkunci. Inilah biaya blocking 2PC.`);
}

function demo3pc(): void {
	header("3PC — Three-Phase Commit (konsep, non-blocking)");
	console.log("\n  3PC menambah fase PreCommit antara Prepare dan Commit:\n");
	for (const p of THREE_PC_PHASES) console.log(`    ${p}`);
	console.log("\n  Kenapa non-blocking?");
	console.log(
		"    Setelah PreCommit, SEMUA participant tahu semua sudah vote YES.",
	);
	console.log(
		"    Kalau coordinator crash, participant bisa saling bertanya dan",
	);
	console.log(
		"    MENYIMPULKAN commit (karena PreCommit terjadi) atau abort (belum).",
	);
	console.log("\n  Kenapa jarang dipakai?");
	console.log("    • 3 round-trip = lebih lambat dari 2PC (2 round-trip).");
	console.log(
		"    • Asumsi synchronous network + no partition. Di network partition,",
	);
	console.log(
		"      quorum terpisah bisa ambil keputusan beda → inconsistent.",
	);
	console.log(
		"    • Paxos / Raft lebih robust untuk consensus → lebih populer.",
	);
}

// ── Saga demos ──

function printWorld(world: World, label: string): void {
	console.log(`\n  ${label}:`);
	console.log(world.snapshot());
}

function demoSagaOrchestrationForward(): void {
	header("SAGA — Orchestration: forward path (semua sukses)");
	const world = new World();
	world.seedStock("SKU-1", 100);
	const orch = new OrderSagaOrchestrator(world);

	printWorld(world, "State awal");
	void orch.execute("order-1001", "SKU-1", 2, 250);
	for (const line of orch.trace) console.log(line);
	printWorld(world, "State akhir");
}

function demoSagaOrchestrationFailure(): void {
	header(
		"SAGA — Orchestration: failure path (payment declined → compensation)",
	);
	const world = new World();
	world.seedStock("SKU-1", 100);
	const orch = new OrderSagaOrchestrator(world, { paymentDeclined: true });

	printWorld(world, "State awal");
	void orch.execute("order-1002", "SKU-1", 3, 300);
	for (const line of orch.trace) console.log(line);
	printWorld(world, "State akhir (setelah compensation)");
	console.log(
		"\n  Perhatikan: step 1 (CreateOrder) & step 2 (ReserveStock) sukses,",
	);
	console.log(
		"  step 3 (ChargePayment) gagal → compensation jalan urutan TERBALIK:",
	);
	console.log(
		"  release stock → cancel order. Payment tidak pernah charged (gagal).",
	);
}

function demoSagaChoreography(): void {
	header("SAGA — Choreography: event-driven (forward + failure)");
	const world = new World();
	world.seedStock("SKU-1", 100);

	sub("Choreography — forward path (semua sukses)");
	const ch1 = new OrderSagaChoreography(world);
	void ch1.execute("order-2001", "SKU-1", 1, 99);
	for (const line of ch1.trace) console.log(line);
	printWorld(world, "State setelah forward");

	world.reset();
	world.seedStock("SKU-1", 100);

	sub("Choreography — failure path (payment declined)");
	const ch2 = new OrderSagaChoreography(world, { paymentDeclined: true });
	void ch2.execute("order-2002", "SKU-1", 1, 99);
	for (const line of ch2.trace) console.log(line);
	printWorld(world, "State setelah compensation (event-driven)");
	console.log(
		"\n  Choreography: tidak ada orchestrator. Compensation terjadi karena",
	);
	console.log(
		"  service react ke event (PaymentFailed → StockService release →",
	);
	console.log(
		"  OrderService cancel). Trade-off: flow sulit dilacak end-to-end.",
	);
}

// ── Outbox demos ──

function demoDualWriteProblem(): void {
	header("OUTBOX — Masalah dual-write (TANPA outbox)");
	const db = new Database();
	const bus = new MessageBus();
	const svc = new OrderService(db);

	sub("Kasus A: publish sukses → konsisten");
	const a = svc.createOrderDualWrite("Alice", 100, bus, false);
	console.log(
		`  orderWritten=${a.orderWritten}, eventPublished=${a.eventPublished}`,
	);
	console.log(
		`  DB orders: ${db.getOrders().length} row | Bus messages: ${bus.messages.length}`,
	);
	console.log(`  → konsisten: DB & bus sama-sama update.`);

	db.reset();
	bus.reset();

	sub("Kasus B: publish GAGAL setelah DB commit → event HILANG");
	const b = svc.createOrderDualWrite("Bob", 200, bus, true);
	console.log(
		`  orderWritten=${b.orderWritten}, eventPublished=${b.eventPublished}`,
	);
	console.log(
		`  DB orders: ${db.getOrders().length} row | Bus messages: ${bus.messages.length}`,
	);
	console.log(
		`  ⚠ INCONSISTENT: order Bob ada di DB, tapi event tidak pernah sampai ke bus.`,
	);
	console.log(
		`    Downstream service (shipping, analytics) tidak tahu order ini ada.`,
	);
}

function demoOutboxSolution(): void {
	header("OUTBOX — Solusi: atomic write + poller publish");
	const db = new Database();
	const bus = new MessageBus();
	const svc = new OrderService(db);
	const poller = new OutboxPoller(db, bus);

	sub("Step 1: App tulis order + outbox event dalam 1 DB transaction");
	const id1 = svc.createOrderWithOutbox("Carol", 150);
	const id2 = svc.createOrderWithOutbox("Dave", 75);
	console.log(`  createOrderWithOutbox → ${id1}, ${id2}`);
	console.log(`  DB orders:    ${db.getOrders().length} row`);
	console.log(`  Outbox PENDING: ${db.getOutbox("PENDING").length} row(s)`);
	console.log(
		`  Bus messages: ${bus.messages.length} (belum ada — poller belum jalan)`,
	);
	console.log(`  → order & outbox atomic. Belum ada publish.`);

	sub("Step 2: Poller baca PENDING, publish ke bus, mark PUBLISHED");
	const n = poller.pollOnce();
	console.log(`  pollOnce() memproses ${n} event`);
	console.log(`  Outbox PENDING:  ${db.getOutbox("PENDING").length} row(s)`);
	console.log(`  Outbox PUBLISHED: ${db.getOutbox("PUBLISHED").length} row(s)`);
	console.log(`  Bus messages:    ${bus.messages.length}`);
	console.log(
		`  Poller stats: polled=${poller.stats.polled}, published=${poller.stats.published}, markedDone=${poller.stats.markedDone}`,
	);

	sub("Step 3: Verifikasi — tidak ada event hilang");
	const orders = db.getOrders();
	const published = bus.messages;
	console.log(`  Orders di DB:    ${orders.map((o) => o.id).join(", ")}`);
	console.log(
		`  Events di bus:   ${published.map((m) => m.aggregateId).join(", ")}`,
	);
	const allMatch = orders.every((o) =>
		published.some((m) => m.aggregateId === o.id),
	);
	console.log(
		`  Setiap order punya event di bus? ${allMatch ? "YA ✓" : "TIDAK ✗"}`,
	);
	console.log(`  → Tidak ada lost event. Dual-write problem terpecahkan.`);

	sub("Step 4: Idempotency — poller jalan lagi tidak duplikasi");
	const before = bus.messages.length;
	poller.pollOnce();
	const after = bus.messages.length;
	console.log(`  Bus messages sebelum re-poll: ${before}, sesudah: ${after}`);
	console.log(
		`  → Poller baca 0 PENDING (semua sudah PUBLISHED). Bus tidak duplikasi.`,
	);
	console.log(
		`    Tambahan: bus juga idempotent via eventId — walau publish dipanggil`,
	);
	console.log(`    ulang dengan eventId sama, tidak ada duplikat.`);
}

// ── Main ──

async function main(): Promise<void> {
	console.log(BANNER);
	console.log("  16 — Distributed Transactions");
	console.log("  2PC · Saga · Transactional Outbox");
	console.log(BANNER);
	console.log(
		"\n  Demo algoritmik in-memory. Bukan server. Jalankan tiap skenario",
	);
	console.log(
		"  untuk melihat state transition, lock, compensation, dan outbox.",
	);

	// 2PC
	demo2pcCommit();
	await sleep(120);
	demo2pcAbort();
	await sleep(120);
	demo2pcCoordinatorCrash();
	await sleep(120);
	demo2pcParticipantCrash();
	await sleep(120);
	demo3pc();

	// Saga
	demoSagaOrchestrationForward();
	await sleep(120);
	demoSagaOrchestrationFailure();
	await sleep(120);
	demoSagaChoreography();

	// Outbox
	demoDualWriteProblem();
	await sleep(120);
	demoOutboxSolution();

	console.log(`\n${BANNER}`);
	console.log("  Selesai — semua skenario distributed transaction selesai.");
	console.log(BANNER);
}

main().catch((err) => {
	console.error("Demo error:", err);
	process.exit(1);
});
