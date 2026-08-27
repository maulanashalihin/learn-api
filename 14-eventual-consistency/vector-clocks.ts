// ─── Vector Clocks ─────────────────────────────────────────────
//
// Vector clock = array [c1, c2, ..., cn], satu counter per node.
// Track causality antar event di sistem terdistribusi TANPA wall-clock
// (yang unreliable karena clock skew).
//
// Aturan:
//   - Local event: increment komponen sendiri → [.., ci+1, ..]
//   - Send message: attach vector clock saat ini
//   - Receive message: increment komponen sendiri, lalu element-wise
//     max dengan clock dari pesan
//
// Deteksi relasi:
//   - A == B (equal): event sama
//   - A → B (happened-before): semua A[i] <= B[i] DAN minimal satu < (A ≠ B)
//   - Concurrent (||): tidak ada → maupun B → A → KONFLIK

export type NodeId = "N1" | "N2" | "N3";
export type Clock = Record<NodeId, number>;

export interface Event {
	id: string;
	node: NodeId;
	clock: Clock;
	desc: string;
}

const NODES: NodeId[] = ["N1", "N2", "N3"];

function zeroClock(): Clock {
	return { N1: 0, N2: 0, N3: 0 };
}

function copyClock(c: Clock): Clock {
	return { ...c };
}

function maxClock(a: Clock, b: Clock): Clock {
	return {
		N1: Math.max(a.N1, b.N1),
		N2: Math.max(a.N2, b.N2),
		N3: Math.max(a.N3, b.N3),
	};
}

function clockEqual(a: Clock, b: Clock): boolean {
	return a.N1 === b.N1 && a.N2 === b.N2 && a.N3 === b.N3;
}

/** A happened-before B? A ≤ B (semua) dan A ≠ B (minimal satu <). */
function happenedBefore(a: Clock, b: Clock): boolean {
	const le = a.N1 <= b.N1 && a.N2 <= b.N2 && a.N3 <= b.N3;
	const ne = !clockEqual(a, b);
	return le && ne;
}

/** Concurrent? tidak ada → maupun B → A. */
function isConcurrent(a: Clock, b: Clock): boolean {
	return !happenedBefore(a, b) && !happenedBefore(b, a) && !clockEqual(a, b);
}

function fmtClock(c: Clock): string {
	return `[N1:${c.N1} N2:${c.N2} N3:${c.N3}]`;
}

export class VectorClockNode {
	clock: Clock = zeroClock();
	events: Event[] = [];

	constructor(public readonly id: NodeId) {}

	/** Local event: increment komponen sendiri. */
	local(desc: string, eventId?: string): Event {
		this.clock[this.id]++;
		const ev: Event = {
			id: eventId ?? `${this.id}-${this.clock[this.id]}`,
			node: this.id,
			clock: copyClock(this.clock),
			desc,
		};
		this.events.push(ev);
		return ev;
	}

	/** Send: kirim clock saat ini (sebelum increment di receiver). */
	snapshot(): Clock {
		return copyClock(this.clock);
	}

	/** Receive: increment komponen sendiri, lalu max dengan clock pesan. */
	receive(from: Clock, desc: string, eventId?: string): Event {
		this.clock[this.id]++;
		this.clock = maxClock(this.clock, from);
		const ev: Event = {
			id: eventId ?? `${this.id}-${this.clock[this.id]}`,
			node: this.id,
			clock: copyClock(this.clock),
			desc,
		};
		this.events.push(ev);
		return ev;
	}
}

export type Relation = "equal" | "happened-before" | "concurrent";

export function relate(a: Clock, b: Clock): Relation {
	if (clockEqual(a, b)) return "equal";
	if (happenedBefore(a, b)) return "happened-before";
	if (happenedBefore(b, a)) return "happened-before"; // b → a
	return "concurrent";
}

// ── Demo ──

const SEP = "─".repeat(60);

export function runVectorClockDemo(): void {
	console.log("\n" + "═".repeat(60));
	console.log("  DEMO 4 — VECTOR CLOCKS");
	console.log("═".repeat(60));
	console.log("3 node, masing-masing vector clock [N1 N2 N3].");
	console.log("Track causality, deteksi concurrent writes = konflik.\n");

	const n1 = new VectorClockNode("N1");
	const n2 = new VectorClockNode("N2");
	const n3 = new VectorClockNode("N3");

	// ── Timeline ──
	console.log(SEP);
	console.log("TIMELINE EVENT:\n");

	// N1: write x=1
	const e1 = n1.local("write x=1", "e1");
	console.log(`  e1  N1 local  "write x=1"        ${fmtClock(e1.clock)}`);

	// N1 → N2: send
	const m1 = n1.snapshot();
	console.log(`       N1 ──msg──→ N2  (attach ${fmtClock(m1)})`);

	// N2: receive, write x=2 (causal after e1)
	const e2 = n2.receive(m1, "write x=2 (after see x=1)", "e2");
	console.log(`  e2  N2 recv   "write x=2"        ${fmtClock(e2.clock)}`);

	// N3: independent local write x=99 (TIDAK tahu e1/e2)
	const e3 = n3.local("write x=99 (isolated)", "e3");
	console.log(
		`  e3  N3 local  "write x=99"       ${fmtClock(e3.clock)}  ← isolated`,
	);

	// N2 → N3: send (N2 punya e1, e2)
	const m2 = n2.snapshot();
	console.log(`       N2 ──msg──→ N3  (attach ${fmtClock(m2)})`);

	// N3: receive from N2 → sekarang N3 tahu e1, e2. Tapi e3 sudah terjadi sebelumnya.
	const e4 = n3.receive(m2, "receive from N2", "e4");
	console.log(`  e4  N3 recv   "receive N2"       ${fmtClock(e4.clock)}`);

	// N3: write x=3 (causal after e1, e2)
	const e5 = n3.local("write x=3 (after see all)", "e5");
	console.log(`  e5  N3 local  "write x=3"        ${fmtClock(e5.clock)}`);
	console.log();

	// ── Analisis relasi ──
	console.log(SEP);
	console.log("ANALISIS RELASI (causality detection):\n");

	const pairs: [Event, Event][] = [
		[e1, e2],
		[e1, e3],
		[e2, e3],
		[e3, e4],
		[e2, e5],
		[e3, e5],
	];

	for (const [a, b] of pairs) {
		const rel = relate(a.clock, b.clock);
		let symbol: string;
		let note: string;
		if (rel === "equal") {
			symbol = "==";
			note = "same event";
		} else if (rel === "happened-before") {
			// tentukan arah
			const ab = happenedBefore(a.clock, b.clock);
			symbol = ab ? "→" : "←";
			note = ab
				? `${a.id} happened-before ${b.id} (causal)`
				: `${b.id} happened-before ${a.id} (causal)`;
		} else {
			symbol = "||";
			note = `CONCURRENT → KONFLIK (butuh conflict resolution: LWW/CRDT/merge)`;
		}
		console.log(
			`  ${a.id} ${symbol} ${b.id}   ${fmtClock(a.clock)} vs ${fmtClock(b.clock)}`,
		);
		console.log(`        ${note}`);
	}
	console.log();

	// ── Highlight konflik ──
	console.log(SEP);
	console.log("KONFLIK DETECTED:\n");
	const conflictPair = [e2, e3] as [Event, Event];
	const [ca, cb] = conflictPair;
	console.log(`  ${ca.id} (${ca.desc}) ${fmtClock(ca.clock)}`);
	console.log(`  ${cb.id} (${cb.desc}) ${fmtClock(cb.clock)}`);
	console.log(`  Relasi: CONCURRENT (||)`);
	console.log(`  → Dua write ke "x" tanpa causal relationship.`);
	console.log(`  → Sistem tidak bisa tahu mana yang "terbaru".`);
	console.log(
		`  → Solusi: Last-Writer-Wins (LWW, butuh wall-clock — unreliable),`,
	);
	console.log(
		`            CRDT (merge otomatis), atau application-level resolution.`,
	);
	console.log();

	// ── Kenapa bukan wall-clock? ──
	console.log(SEP);
	console.log("KENAPA TIDAK PAKAI WALL-CLOCK (timestamp biasa)?\n");
	console.log("  1. Clock skew: clock node bisa beda puluhan ms-detik.");
	console.log("     N3 clock 10:00:01.500, N1 clock 10:00:01.400 — padahal");
	console.log("     N3 write terjadi sebelum N1 write secara causal.");
	console.log("  2. Tidak ada monotonicity guarantee: NTP bisa adjust clock");
	console.log("     mundur → timestamp tidak monoton → LWW bisa salah.");
	console.log("  3. Wall-clock tidak capture causality: dua write di node");
	console.log(
		"     berbeda di waktu hampir sama → tidak bisa tentukan urutan.",
	);
	console.log(
		"  Vector clock capture causality via happens-before, bukan time.",
	);
	console.log();

	// ── Final state ──
	console.log(SEP);
	console.log("FINAL VECTOR CLOCK STATE:\n");
	for (const n of [n1, n2, n3]) {
		console.log(`  ${n.id}: ${fmtClock(n.clock)}  (${n.events.length} events)`);
	}
	console.log();
}
