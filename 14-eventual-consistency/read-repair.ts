// ─── Read Repair ───────────────────────────────────────────────
//
// Read repair = mekanisme konsistensi "lazy": replica yang stale
// diperbaiki SAAT dibaca, bukan saat ditulis.
//
// 3 replica menyimpan key→{value,version}. Salah satu replica
// ketinggalan write (version lebih rendah). Client read dari semua
// replica, bandingkan version, lalu write-back value terbaru ke
// replica yang tertinggal.
//
// Cassandra & DynamoDB pakai pola ini.

export interface VersionedValue {
	value: string;
	version: number; // monotonic version per key
	writtenAt: number; // logical timestamp (ms)
}

export type ReplicaId = "R1" | "R2" | "R3";

export class Replica {
	constructor(
		public readonly id: ReplicaId,
		public readonly store = new Map<string, VersionedValue>(),
	) {}

	write(key: string, value: string, version: number): void {
		this.store.set(key, { value, version, writtenAt: Date.now() });
	}

	read(key: string): VersionedValue | undefined {
		return this.store.get(key);
	}

	has(key: string): boolean {
		return this.store.has(key);
	}
}

export interface ReadResult {
	from: ReplicaId;
	value: VersionedValue | undefined;
}

export interface RepairAction {
	key: string;
	staleReplica: ReplicaId;
	repairedWith: VersionedValue;
}

/**
 * Read dari semua replica. Return responses + replica yang paling
 * up-to-date (version tertinggi). Replica yang undefined atau version
 * lebih rendah dianggap stale.
 */
export function readFromAll(
	replicas: Replica[],
	key: string,
): { responses: ReadResult[]; latest: VersionedValue | null } {
	const responses: ReadResult[] = replicas.map((r) => ({
		from: r.id,
		value: r.read(key),
	}));

	let latest: VersionedValue | null = null;
	for (const r of responses) {
		if (!r.value) continue;
		if (latest === null || r.value.version > latest.version) {
			latest = r.value;
		}
	}
	return { responses, latest };
}

/**
 * Read repair: tulis value terbaru kembali ke replica yang stale.
 * Return daftar repair yang dilakukan.
 */
export function readRepair(
	replicas: Replica[],
	key: string,
	latest: VersionedValue,
): RepairAction[] {
	const repairs: RepairAction[] = [];
	for (const r of replicas) {
		const current = r.read(key);
		const isStale = !current || current.version < latest.version;
		if (isStale) {
			r.write(key, latest.value, latest.version);
			repairs.push({ key, staleReplica: r.id, repairedWith: latest });
		}
	}
	return repairs;
}

// ── Demo ──

const SEP = "─".repeat(60);

function fmt(v: VersionedValue | undefined): string {
	if (!v) return "— (missing)";
	return `"${v.value}" v${v.version}`;
}

export function runReadRepairDemo(): void {
	console.log("\n" + "═".repeat(60));
	console.log("  DEMO 1 — READ REPAIR");
	console.log("═".repeat(60));
	console.log("3 replica (R1, R2, R3). R3 miss write #2 → stale.\n");

	const r1 = new Replica("R1");
	const r2 = new Replica("R2");
	const r3 = new Replica("R3");
	const replicas = [r1, r2, r3];

	// Write #1: semua replica dapat
	for (const r of replicas) r.write("user:42", "Alice", 1);

	// Write #2: hanya R1 & R2 yang dapat (R3 miss — partition/crash)
	r1.write("user:42", "Alice Smith", 2);
	r2.write("user:42", "Alice Smith", 2);
	// R3 tidak dapat write #2 → stale

	console.log(SEP);
	console.log("BEFORE READ — state per replica:");
	for (const r of replicas) {
		console.log(`  ${r.id}: user:42 = ${fmt(r.read("user:42"))}`);
	}
	console.log(`  → R3 tertinggal (v1 vs v2)\n`);

	// READ dari semua replica
	console.log(SEP);
	console.log("READ user:42 dari semua replica:");
	const { responses, latest } = readFromAll(replicas, "user:42");
	for (const res of responses) {
		const mark =
			res.value && latest && res.value.version === latest.version
				? "✓ latest"
				: "✗ stale";
		console.log(`  ${res.from}: ${fmt(res.value)}  ${mark}`);
	}
	console.log(`  → Latest = ${latest ? fmt(latest) : "none"}\n`);

	// READ REPAIR
	console.log(SEP);
	console.log("READ REPAIR — write-back latest ke replica stale:");
	const repairs = readRepair(replicas, "user:42", latest!);
	if (repairs.length === 0) {
		console.log("  (tidak ada replica stale — semua konsisten)");
	} else {
		for (const p of repairs) {
			console.log(`  Repair ${p.staleReplica} ← ${fmt(p.repairedWith)}`);
		}
	}
	console.log();

	// AFTER
	console.log(SEP);
	console.log("AFTER REPAIR — state per replica:");
	for (const r of replicas) {
		console.log(`  ${r.id}: user:42 = ${fmt(r.read("user:42"))}`);
	}
	const allConsistent = replicas.every(
		(r) => r.read("user:42")?.version === latest!.version,
	);
	console.log(
		`  → ${allConsistent ? "✓ Semua replica konsisten" : "✗ Masih ada skew"}\n`,
	);

	// Key insight
	console.log(SEP);
	console.log("INSIGHT:");
	console.log("  Read repair = lazy consistency. Tidak ada background sync,");
	console.log("  tapi setiap read memperbaiki replica stale. Trade-off:");
	console.log("  read lebih mahal (quorum + compare + write-back), tapi");
	console.log("  write cepat (no synchronous repair). Cocok untuk read-");
	console.log("  heavy workload dengan toleransi stale reads sesaat.");
	console.log();
}
