// ─── CRDTs (Conflict-free Replicated Data Types) ───────────────
//
// CRDT = struktur data yang merge tanpa konflik. Setiap node operasi
// independen; merge selalu konvergen ke state yang sama (Strong
// Eventual Consistency). Tidak butuh koordinasi/lock saat write.
//
// Dua family:
//   - State-based (CvRDT): kirim state penuh, merge = LUB (least
//     upper bound) yang commutative + associative + idempotent.
//   - Operation-based (CmRDT): kirim op, harus delivered reliably +
//     causal order. Demo ini pakai state-based (lebih simple).
//
// Implementasi: G-Counter, PN-Counter, G-Set, 2P-Set, OR-Set.

// ── G-Counter (Grow-only Counter) ──

export class GCounter {
	constructor(private readonly counts: Map<string, number> = new Map()) {}

	inc(nodeId: string, by = 1): void {
		this.counts.set(nodeId, (this.counts.get(nodeId) ?? 0) + by);
	}

	value(): number {
		let sum = 0;
		for (const v of this.counts.values()) sum += v;
		return sum;
	}

	merge(other: GCounter): GCounter {
		const merged = new Map(this.counts);
		for (const [k, v] of other.counts) {
			merged.set(k, Math.max(merged.get(k) ?? 0, v));
		}
		return new GCounter(merged);
	}

	state(): string {
		return (
			"{" +
			[...this.counts.entries()].map(([k, v]) => `${k}:${v}`).join(", ") +
			"}"
		);
	}
}

// ── PN-Counter (Positive-Negative Counter) ──

export class PNCounter {
	constructor(
		public readonly p: GCounter = new GCounter(),
		public readonly n: GCounter = new GCounter(),
	) {}

	inc(nodeId: string, by = 1): void {
		this.p.inc(nodeId, by);
	}

	dec(nodeId: string, by = 1): void {
		this.n.inc(nodeId, by);
	}

	value(): number {
		return this.p.value() - this.n.value();
	}

	merge(other: PNCounter): PNCounter {
		return new PNCounter(this.p.merge(other.p), this.n.merge(other.n));
	}

	state(): string {
		return `P=${this.p.state()} N=${this.n.state()} → ${this.value()}`;
	}
}

// ── G-Set (Grow-only Set) ──

export class GSet<T> {
	constructor(private readonly elements: Set<T> = new Set()) {}

	add(el: T): void {
		this.elements.add(el);
	}

	has(el: T): boolean {
		return this.elements.has(el);
	}

	value(): T[] {
		return [...this.elements].sort();
	}

	merge(other: GSet<T>): GSet<T> {
		return new GSet(new Set([...this.elements, ...other.elements]));
	}

	state(): string {
		return "{" + this.value().join(", ") + "}";
	}
}

// ── 2P-Set (Two-Phase Set: adds + removes, tombstone problem) ──

export class TwoPSet<T> {
	constructor(
		public readonly adds: GSet<T> = new GSet(),
		public readonly removes: GSet<T> = new GSet(),
	) {}

	add(el: T): void {
		this.adds.add(el);
	}

	remove(el: T): void {
		if (this.adds.has(el)) this.removes.add(el);
	}

	has(el: T): boolean {
		return this.adds.has(el) && !this.removes.has(el);
	}

	value(): T[] {
		return this.adds.value().filter((e) => !this.removes.has(e));
	}

	merge(other: TwoPSet<T>): TwoPSet<T> {
		return new TwoPSet(
			this.adds.merge(other.adds),
			this.removes.merge(other.removes),
		);
	}

	state(): string {
		return `adds=${this.adds.state()} removes=${this.removes.state()} → {${this.value().join(", ")}}`;
	}
}

// ── OR-Set (Observed-Remove Set) ──
//
// Setiap add pakai unique tag. Remove hanya hapus tag yang "observed"
// (ada di add saat remove). Add concurrent dengan remove → add menang
// (karena remove tidak observe tag add yang concurrent).

export class ORSet<T> {
	// element → set of tags
	private readonly elements: Map<T, Set<string>> = new Map();
	// semua tag yang pernah di-remove (tombstone, supaya tidak re-add)
	private readonly tombstones: Set<string> = new Set();

	add(el: T, tag: string): void {
		if (this.tombstones.has(tag)) return; // tag sudah di-remove
		let tags = this.elements.get(el);
		if (!tags) {
			tags = new Set();
			this.elements.set(el, tags);
		}
		tags.add(tag);
	}

	/**
	 * Remove: hapus SEMUA tag yang saat ini observe untuk element.
	 * Tag yang ditambahkan concurrent (belum dilihat) tetap ada.
	 */
	remove(el: T): void {
		const tags = this.elements.get(el);
		if (tags) {
			for (const t of tags) this.tombstones.add(t);
			this.elements.delete(el);
		}
	}

	has(el: T): boolean {
		const tags = this.elements.get(el);
		return !!tags && tags.size > 0;
	}

	value(): T[] {
		const result: T[] = [];
		for (const [el, tags] of this.elements) {
			if (tags.size > 0) result.push(el);
		}
		return result.sort();
	}

	merge(other: ORSet<T>): ORSet<T> {
		const merged = new ORSet<T>();
		// tombstones = union
		for (const t of this.tombstones) merged.tombstones.add(t);
		for (const t of other.tombstones) merged.tombstones.add(t);
		// elements = union of tags, minus tombstones
		const allEls = new Set<T>([
			...this.elements.keys(),
			...other.elements.keys(),
		]);
		for (const el of allEls) {
			const tags = new Set<string>([
				...(this.elements.get(el) ?? []),
				...(other.elements.get(el) ?? []),
			]);
			for (const t of tags) {
				if (!merged.tombstones.has(t)) {
					let m = merged.elements.get(el);
					if (!m) {
						m = new Set();
						merged.elements.set(el, m);
					}
					m.add(t);
				}
			}
		}
		return merged;
	}

	state(): string {
		const parts: string[] = [];
		for (const [el, tags] of this.elements) {
			parts.push(`${el}:[${[...tags].join(",")}]`);
		}
		return "{" + parts.join(", ") + "}";
	}
}

// ── Demo ──

const SEP = "─".repeat(60);

export function runCrdtDemo(): void {
	console.log("\n" + "═".repeat(60));
	console.log("  DEMO 3 — CRDTs (Conflict-free Replicated Data Types)");
	console.log("═".repeat(60));
	console.log(
		"Setiap node operasi independen. Merge selalu konvergen, NO conflict.\n",
	);

	// ── G-Counter ──
	console.log(SEP);
	console.log("▶ G-Counter (Grow-only Counter)");
	console.log("  Merge = element-wise max. Value = sum semua node.\n");

	const gcA = new GCounter();
	const gcB = new GCounter();
	const gcC = new GCounter();
	gcA.inc("A", 3);
	gcA.inc("A", 2); // A total 5
	gcB.inc("B", 4);
	gcC.inc("C", 1);
	gcC.inc("C", 6); // C total 7

	console.log(`  Node A: ${gcA.state()} → value=${gcA.value()}`);
	console.log(`  Node B: ${gcB.state()} → value=${gcB.value()}`);
	console.log(`  Node C: ${gcC.state()} → value=${gcC.value()}`);

	const gcMerged = gcA.merge(gcB).merge(gcC);
	console.log(`  Merge A∪B∪C: ${gcMerged.state()} → value=${gcMerged.value()}`);
	console.log(`  → 5 + 4 + 7 = 16 ✓ (tidak ada double-counting)\n`);

	// ── PN-Counter ──
	console.log(SEP);
	console.log("▶ PN-Counter (Positive-Negative Counter)");
	console.log(
		"  Dua G-Counter: P (increments) & N (decrements). Value = P - N.\n",
	);

	const pnA = new PNCounter();
	const pnB = new PNCounter();
	pnA.inc("A", 5);
	pnA.dec("A", 2); // A: +3
	pnB.inc("B", 4);
	pnB.dec("B", 1); // B: +3
	pnB.dec("B", 1); // B: +2

	console.log(`  Node A: ${pnA.state()}`);
	console.log(`  Node B: ${pnB.state()}`);

	const pnMerged = pnA.merge(pnB);
	console.log(`  Merge: ${pnMerged.state()}`);
	console.log(`  → (5+4) - (2+2) = 7 ✓\n`);

	// ── G-Set ──
	console.log(SEP);
	console.log("▶ G-Set (Grow-only Set)");
	console.log("  Merge = union. Tidak bisa remove.\n");

	const gsA = new GSet<string>();
	const gsB = new GSet<string>();
	gsA.add("apple");
	gsA.add("banana");
	gsB.add("banana");
	gsB.add("cherry");

	console.log(`  Node A: ${gsA.state()}`);
	console.log(`  Node B: ${gsB.state()}`);
	console.log(`  Merge: ${gsA.merge(gsB).state()} ✓\n`);

	// ── 2P-Set ──
	console.log(SEP);
	console.log("▶ 2P-Set (Two-Phase Set)");
	console.log(
		"  adds-set + removes-set. Element ada jika di adds DAN tidak di removes.",
	);
	console.log(
		"  Masalah: setelah di-remove, tidak bisa di-add lagi (tombstone).\n",
	);

	const tpA = new TwoPSet<string>();
	tpA.add("x");
	tpA.add("y");
	tpA.remove("x"); // x di-tombstone
	const tpB = new TwoPSet<string>();
	tpB.add("y");
	tpB.add("z");

	console.log(`  Node A: ${tpA.state()}`);
	console.log(`  Node B: ${tpB.state()}`);

	// Simulasikan: setelah merge, node B mau add "x" lagi → tidak bisa!
	const tpMerged = tpA.merge(tpB);
	console.log(`  Merge A∪B: ${tpMerged.state()}`);
	console.log(`  → "x" hilang permanen. Add "x" lagi di B lalu re-merge:`);
	const tpB2 = new TwoPSet<string>();
	tpB2.add("x"); // coba add x lagi
	const tpReMerged = tpMerged.merge(tpB2);
	console.log(`  Re-merge: ${tpReMerged.state()}`);
	console.log(`  → "x" TETAP hilang! Ini tombstone problem 2P-Set.\n`);

	// ── OR-Set ──
	console.log(SEP);
	console.log("▶ OR-Set (Observed-Remove Set)");
	console.log(
		"  Setiap add punya unique tag. Remove hanya hapus tag yang di-observe.",
	);
	console.log(
		"  Concurrent add+remove → add menang (remove tidak lihat tag add baru).\n",
	);

	// Skenario: Node A add "item" tag=t1. Node B remove "item" (observe t1).
	// Concurrent: Node A add "item" lagi tag=t2 (B belum lihat).
	// Merge: t1 di-remove, t2 masih ada → "item" tetap ada. Add wins.
	const orA = new ORSet<string>();
	const orB = new ORSet<string>();

	orA.add("item", "t1");
	console.log(`  Node A: add("item", "t1") → ${orA.state()}`);

	// B remove "item" — B hanya observe t1 (belum terima t2)
	orB.remove("item");
	console.log(
		`  Node B: remove("item") (observe: tidak ada, B belum punya "item")`,
	);

	// Concurrent: A add lagi dengan tag baru
	orA.add("item", "t2");
	console.log(
		`  Node A: add("item", "t2") [concurrent dengan remove B] → ${orA.state()}`,
	);

	// Sebelum merge, simulasikan B juga punya t1 (sync partial) lalu remove
	// Untuk demo sederhana: B remove tidak observe apa-apa, jadi tidak ada efek
	const orMerged = orA.merge(orB);
	console.log(`  Merge A∪B: ${orMerged.state()}`);
	console.log(
		`  → "item" MASIH ADA (tag t2 survive). Add wins over concurrent remove ✓`,
	);

	// Skenario 2: remove yang observe → benar-benar hapus
	console.log();
	console.log(
		"  Skenario 2: remove SETELAH observe semua tag → benar-benar hapus:",
	);
	const orC = new ORSet<string>();
	orC.add("temp", "u1");
	orC.remove("temp"); // observe u1
	console.log(
		`  orC: add("temp","u1") lalu remove("temp") → has("temp")=${orC.has("temp")} ✓`,
	);
	console.log();

	console.log(SEP);
	console.log("INSIGHT:");
	console.log("  CRDT = Strong Eventual Consistency: merge commutative +");
	console.log("  associative + idempotent → semua node konvergen ke state");
	console.log("  sama TANPA koordinasi. Trade-off: metadata (tags, per-");
	console.log("  node counters) borok memory, & tidak semua operasi bisa");
	console.log("  (G-Set tidak bisa remove, 2P-Set tidak bisa re-add).");
	console.log("  Riak, Redis CRDT, Automerge, Yjs, Figma pakai CRDT.");
	console.log();
}
