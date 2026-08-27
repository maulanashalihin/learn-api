// ─── Consistency Models Simulator ───────────────────────────────
//
// Mendemonstrasikan spectrum consistency model dengan in-memory
// register yang direplikasi ke beberapa node:
//
//   • Strong (linearizable)    — read selalu return latest write
//   • Eventual                 — read bisa stale, tapi converge
//   • Causal                   — operasi causally-related terurut
//                                 sama di semua node; concurrent boleh
//                                 berbeda urutan. Vector clocks.
//   • Read-your-writes         — client selalu lihat write-nya sendiri
//
// Jalankan via demo.ts.

// ── Vector clock ──
// Map<nodeId, count>. Causality: A < B jika semua komponen A <= B dan
// minimal satu <. Concurrent jika tidak ada yang ≤.
type VClock = Record<string, number>;

function vclockCopy(vc: VClock): VClock {
	return { ...vc };
}

function vclockCompare(
	a: VClock,
	b: VClock,
): "before" | "after" | "equal" | "concurrent" {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	let aLess = false;
	let bLess = false;
	for (const k of keys) {
		const av = a[k] ?? 0;
		const bv = b[k] ?? 0;
		if (av < bv) aLess = true;
		if (av > bv) bLess = true;
	}
	if (!aLess && !bLess) return "equal";
	if (aLess && !bLess) return "before"; // a < b
	if (bLess && !aLess) return "after"; // a > b
	return "concurrent";
}

function vclockMerge(a: VClock, b: VClock): VClock {
	const out: VClock = { ...a };
	for (const [k, v] of Object.entries(b)) {
		out[k] = Math.max(out[k] ?? 0, v);
	}
	return out;
}

// ── Operation ──

interface Op {
	id: number;
	nodeId: string;
	type: "write" | "read";
	key: string;
	value?: string;
	vc: VClock;
	// dependency: op yang jadi kausal predecessor (untuk causal demo)
	dependsOn?: number;
}

// ── Strong / Linearizable register ──
// Single "source of truth" + synchronous replication. Read selalu latest.

export class StrongRegister {
	private value: string | null = null;
	private version = 0;
	readonly replicas: Map<string, { value: string | null; version: number }> =
		new Map();
	private replicaIds: string[];

	constructor(replicaIds: string[]) {
		this.replicaIds = replicaIds;
		for (const id of replicaIds) {
			this.replicas.set(id, { value: null, version: 0 });
		}
	}

	write(value: string, _clientId?: string): void {
		this.version += 1;
		this.value = value;
		// Synchronous replication: semua replica langsung update.
		for (const id of this.replicaIds) {
			const r = this.replicas.get(id)!;
			r.value = value;
			r.version = this.version;
		}
	}

	read(nodeId: string): { value: string | null; version: number } {
		const r = this.replicas.get(nodeId);
		if (!r) return { value: null, version: 0 };
		// Linearizable: selalu return latest (coordinator).
		return { value: this.value, version: this.version };
	}
}

// ── Eventual register ──
// Async replication dengan lag. Read bisa stale sampai propagation selesai.

export class EventualRegister {
	private value: string | null = null;
	private version = 0;
	readonly replicas: Map<string, { value: string | null; version: number }> =
		new Map();
	private replicaIds: string[];
	// Pending propagations: target → value+version yang belum sampai.
	private pending: { target: string; value: string | null; version: number }[] =
		[];
	readonly log: string[] = [];

	constructor(replicaIds: string[]) {
		this.replicaIds = replicaIds;
		for (const id of replicaIds) {
			this.replicas.set(id, { value: null, version: 0 });
		}
	}

	write(value: string, clientId: string): void {
		this.version += 1;
		this.value = value;
		// Coordinator langsung update, replica lain dijadwalkan (lag).
		this.log.push(
			`✎  WRITE by ${clientId}: "${value}" v${this.version} → coordinator updated, replica pending`,
		);
		for (const id of this.replicaIds) {
			this.pending.push({ target: id, value, version: this.version });
		}
	}

	// Simulasi propagasi: sebagian pesan sampai (count) sebagian belum.
	tick(propagateCount: number): void {
		const delivered = this.pending.splice(0, propagateCount);
		for (const m of delivered) {
			const r = this.replicas.get(m.target);
			if (r && m.version > r.version) {
				r.value = m.value;
				r.version = m.version;
			}
		}
		this.log.push(
			`⤳  TICK: ${delivered.length} propagation delivered, ${this.pending.length} still pending`,
		);
	}

	// Paksa semua propagasi selesai (converge).
	converge(): void {
		for (const m of this.pending) {
			const r = this.replicas.get(m.target);
			if (r && m.version > r.version) {
				r.value = m.value;
				r.version = m.version;
			}
		}
		this.pending = [];
		this.log.push(`⟳  CONVERGE: semua replica up-to-date`);
	}

	read(nodeId: string): {
		value: string | null;
		version: number;
		stale: boolean;
	} {
		const r = this.replicas.get(nodeId);
		if (!r) return { value: null, version: 0, stale: false };
		return {
			value: r.value,
			version: r.version,
			stale: r.version < this.version,
		};
	}
}

// ── Causal register (vector clocks) ──
// Setiap node simpan log operasi dengan vector clock. Operasi yang
// causally-related dilihat dalam urutan sama. Concurrent boleh beda.

interface CausalEntry {
	key: string;
	value: string;
	vc: VClock;
}

export class CausalStore {
	readonly nodes: Map<string, { vc: VClock; log: CausalEntry[] }> = new Map();
	private nodeIds: string[];
	private opCounter = 0;
	readonly log: string[] = [];

	constructor(nodeIds: string[]) {
		this.nodeIds = nodeIds;
		for (const id of nodeIds) {
			this.nodes.set(id, { vc: {}, log: [] });
		}
	}

	// Write lokal: increment vector clock node ini, simpan entry.
	write(
		nodeId: string,
		key: string,
		value: string,
		dependsOn?: { from: string; vc: VClock },
	): void {
		const node = this.nodes.get(nodeId)!;
		const base: VClock = dependsOn ? vclockCopy(dependsOn.vc) : {};
		// Merge dependency clock ke clock node.
		node.vc = vclockMerge(node.vc, base);
		// Increment komponen node sendiri.
		node.vc[nodeId] = (node.vc[nodeId] ?? 0) + 1;
		const entry: CausalEntry = { key, value, vc: vclockCopy(node.vc) };
		node.log.push(entry);
		this.opCounter += 1;
		this.log.push(
			`✎  WRITE [${nodeId}] ${key}="${value}" vc=${this.fmtVC(node.vc)}${dependsOn ? ` (depends on ${dependsOn.from})` : ""}`,
		);
	}

	// Propagate: kirim log node `from` ke node `to`. Node `to` hanya
	// accept entry yang causally ready (semua predecessor sudah ada).
	propagate(from: string, to: string): void {
		const src = this.nodes.get(from)!;
		const dst = this.nodes.get(to)!;
		let accepted = 0;
		for (const entry of src.log) {
			// Skip jika sudah ada (sama vc).
			if (dst.log.some((e) => vclockCompare(e.vc, entry.vc) === "equal"))
				continue;
			// Causal ready: semua komponen vc entry (kecuali komponen `from`)
			// harus ≤ clock dst. Sederhananya: merge dulu kalau causally ok.
			// Untuk demo, kita accept entry jika vc entry tidak "after" dst clock
			// pada komponen selain from — yaitu dependency sudah terpenuhi.
			let ready = true;
			for (const [k, v] of Object.entries(entry.vc)) {
				if (k === from) continue;
				if ((dst.vc[k] ?? 0) < v) {
					ready = false;
					break;
				}
			}
			if (ready) {
				dst.log.push({ ...entry, vc: vclockCopy(entry.vc) });
				dst.vc = vclockMerge(dst.vc, entry.vc);
				accepted += 1;
			}
		}
		this.log.push(
			`⤳  PROPAGATE ${from}→${to}: ${accepted} entry accepted (causally ready)`,
		);
	}

	// Baca nilai terbaru untuk key di node (entry dengan vc max dalam log).
	read(
		nodeId: string,
		key: string,
	): { value: string | null; vc: VClock | null } {
		const node = this.nodes.get(nodeId)!;
		let best: CausalEntry | null = null;
		for (const e of node.log) {
			if (e.key !== key) continue;
			if (!best) {
				best = e;
				continue;
			}
			const cmp = vclockCompare(best.vc, e.vc);
			if (cmp === "before") best = e;
			else if (cmp === "concurrent") {
				// Concurrent writes → conflict. Pilih salah satu (deterministic:
				// yang value-nya leksikografis lebih besar, sebagai tie-break).
				if (e.value > best.value) best = e;
			}
		}
		return best
			? { value: best.value, vc: best.vc }
			: { value: null, vc: null };
	}

	fmtVC(vc: VClock): string {
		const parts = this.nodeIds.map((id) => `${id}:${vc[id] ?? 0}`);
		return `{${parts.join(", ")}}`;
	}

	nodeLog(nodeId: string): { key: string; value: string; vc: string }[] {
		const node = this.nodes.get(nodeId)!;
		return node.log.map((e) => ({
			key: e.key,
			value: e.value,
			vc: this.fmtVC(e.vc),
		}));
	}
}

// ── Read-your-writes register ──
// Client punya session. Write langsung terlihat oleh client yang sama
// (sticky session / session cache), bahkan sebelum replikasi selesai.

export class ReadYourWritesRegister {
	private value: string | null = null;
	private version = 0;
	readonly replicas: Map<string, { value: string | null; version: number }> =
		new Map();
	private replicaIds: string[];
	// Session cache per client: client selalu lihat write-nya sendiri.
	private sessionCache: Map<string, { value: string | null; version: number }> =
		new Map();
	readonly log: string[] = [];

	constructor(replicaIds: string[]) {
		this.replicaIds = replicaIds;
		for (const id of replicaIds) {
			this.replicas.set(id, { value: null, version: 0 });
		}
	}

	write(clientId: string, nodeId: string, value: string): void {
		this.version += 1;
		this.value = value;
		// Update coordinator replica (nodeId) + session cache client.
		const r = this.replicas.get(nodeId);
		if (r) {
			r.value = value;
			r.version = this.version;
		}
		this.sessionCache.set(clientId, { value, version: this.version });
		this.log.push(
			`✎  WRITE by ${clientId}@${nodeId}: "${value}" v${this.version} → session cache updated`,
		);
	}

	// Client read: pakai session cache jika ada (read-your-writes).
	read(
		clientId: string,
		nodeId: string,
	): { value: string | null; version: number; source: string } {
		const cached = this.sessionCache.get(clientId);
		if (cached) {
			return { ...cached, source: "session-cache (read-your-writes)" };
		}
		const r = this.replicas.get(nodeId);
		if (!r) return { value: null, version: 0, source: "replica (empty)" };
		return { value: r.value, version: r.version, source: `replica ${nodeId}` };
	}

	// Propagate ke replica lain (async).
	propagateTo(nodeId: string): void {
		const r = this.replicas.get(nodeId);
		if (r) {
			r.value = this.value;
			r.version = this.version;
		}
		this.log.push(`⤳  PROPAGATE → ${nodeId}: v${this.version}`);
	}
}
