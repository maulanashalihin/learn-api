// ─── CAP Theorem Simulator ──────────────────────────────────────
//
// Simulasi cluster N node dengan key-value store. Network partition
// memecah cluster jadi 2 grup; pesan antar grup di-drop.
//
// Tiga mode demonstrasi:
//   CP  — Consistency + Partition tolerance: satu sisi reject write (stale),
//         sisi lain serve. Read selalu return latest.
//   AP  — Availability + Partition tolerance: kedua sisi accept write.
//         Setelah heal, reconcile (last-write-wins). Read bisa stale.
//   CA  — Consistency + Availability: tidak partition-tolerant.
//         Kalau partition terjadi, sistem berhenti (stop the world).
//
// Jalankan via demo.ts.

// ── Types ──

export type CapMode = "CP" | "AP" | "CA";

interface VersionedValue {
	value: string;
	version: number; // monotonic write counter (untuk last-write-wins)
	timestamp: number;
	nodeId: string;
}

interface Node {
	id: string;
	store: Map<string, VersionedValue>;
	alive: boolean;
}

// Pesan replikasi antar node.
interface ReplicationMessage {
	from: string;
	key: string;
	vv: VersionedValue;
}

// ── Cluster ──

export class CapCluster {
	readonly mode: CapMode;
	private nodes: Map<string, Node> = new Map();
	// Partition: jika di-set, pesan antar grup di-drop.
	private partition: { groupA: string[]; groupB: string[] } | null = null;
	// Log event untuk ditampilkan.
	readonly log: string[] = [];
	private writeCounter = 0;

	constructor(mode: CapMode, nodeIds: string[]) {
		this.mode = mode;
		for (const id of nodeIds) {
			this.nodes.set(id, { id, store: new Map(), alive: true });
		}
	}

	// ── Network helpers ──

	private canDeliver(from: string, to: string): boolean {
		if (from === to) return true;
		const p = this.partition;
		if (!p) return true;
		const inA = p.groupA.includes(from);
		const inB = p.groupB.includes(from);
		const toA = p.groupA.includes(to);
		const toB = p.groupB.includes(to);
		// Pesan hanya sampai jika di grup yang sama.
		if (inA && toA) return true;
		if (inB && toB) return true;
		return false; // antar grup → drop
	}

	// ── Partition control ──

	partitionInto(groupA: string[], groupB: string[]): void {
		this.partition = { groupA, groupB };
		this.log.push(
			`✂  PARTITION: [${groupA.join(",")}] ⟘ [${groupB.join(",")}] — pesan antar grup di-drop`,
		);
	}

	heal(): void {
		if (this.partition) {
			this.log.push("✚  HEAL: partition dihapus, pesan kembali bebas");
		}
		this.partition = null;
	}

	// ── Quorum helper ──
	// CP butuh mayoritas node alive & reachable untuk accept write.
	private majorityGroup(nodeId: string): boolean {
		const all = [...this.nodes.keys()];
		const p = this.partition;
		if (!p) return true; // tidak ada partition → selalu majority
		const myGroup = p.groupA.includes(nodeId) ? p.groupA : p.groupB;
		return myGroup.length * 2 > all.length;
	}

	// ── Write ──

	write(
		nodeId: string,
		key: string,
		value: string,
	): { ok: boolean; reason: string } {
		const node = this.nodes.get(nodeId);
		if (!node || !node.alive) {
			return { ok: false, reason: "node down" };
		}

		if (this.mode === "CP") {
			// CP: hanya grup mayoritas yang boleh write.
			if (!this.majorityGroup(nodeId)) {
				return {
					ok: false,
					reason: "minority side — reject write (stale, jaga consistency)",
				};
			}
		}

		if (this.mode === "CA") {
			// CA: tidak partition-tolerant. Partition = stop.
			if (this.partition) {
				// Seluruh sistem berhenti menerima write.
				return {
					ok: false,
					reason:
						"partition detected — CA system STOP (no partition tolerance)",
				};
			}
		}

		// AP: kedua sisi accept write (availability > consistency).

		this.writeCounter += 1;
		const vv: VersionedValue = {
			value,
			version: this.writeCounter,
			timestamp: Date.now(),
			nodeId,
		};
		node.store.set(key, vv);

		// Replikasi ke node lain yang reachable.
		const msgs: ReplicationMessage[] = [];
		for (const [targetId, target] of this.nodes) {
			if (targetId === nodeId) continue;
			if (this.canDeliver(nodeId, targetId)) {
				// Replikasi langsung (simulasi synchronous-ish untuk CP, async untuk AP).
				if (this.mode === "CP") {
					// CP: replikasi synchronous ke grup mayoritas.
					if (this.majorityGroup(targetId)) {
						target.store.set(key, vv);
						msgs.push({ from: nodeId, key, vv });
					}
				} else if (this.mode === "AP") {
					// AP: replikasi async — kita simpan "pending" tapi di simulasi ini
					// langsung terkirim ke grup sendiri. Grup lain baru dapat saat heal.
					if (this.partition) {
						const p = this.partition;
						const sameGroup =
							(p.groupA.includes(nodeId) && p.groupA.includes(targetId)) ||
							(p.groupB.includes(nodeId) && p.groupB.includes(targetId));
						if (sameGroup) {
							target.store.set(key, vv);
							msgs.push({ from: nodeId, key, vv });
						}
						// beda grup → tidak terkirim (drop), akan reconcile saat heal
					} else {
						target.store.set(key, vv);
						msgs.push({ from: nodeId, key, vv });
					}
				} else {
					// CA: synchronous replication ke semua (no partition).
					target.store.set(key, vv);
					msgs.push({ from: nodeId, key, vv });
				}
			}
		}

		this.log.push(
			`✎  WRITE [${nodeId}] ${key}="${value}" → replicated to ${msgs.length} peer(s)`,
		);
		return { ok: true, reason: "accepted" };
	}

	// ── Read ──

	read(nodeId: string, key: string): { value: string | null; stale: boolean } {
		const node = this.nodes.get(nodeId);
		if (!node || !node.alive) {
			return { value: null, stale: false };
		}
		const vv = node.store.get(key);
		if (!vv) return { value: null, stale: false };

		// Tentukan apakah read ini stale (AP saat partition: bisa stale).
		let stale = false;
		if (this.mode === "AP" && this.partition) {
			// Bandingkan dengan versi tertinggi di seluruh cluster.
			let maxVersion = vv.version;
			for (const [, n] of this.nodes) {
				const other = n.store.get(key);
				if (other && other.version > maxVersion) maxVersion = other.version;
			}
			stale = vv.version < maxVersion;
		}
		return { value: vv.value, stale };
	}

	// ── Byzantine injection ──
	// Simulasikan node `from` mengirim value BERBEDA ke node `to` tertentu
	// tanpa replikasi ke node lain. Dipakai untuk demo byzantine fault.
	injectMessage(from: string, to: string, key: string, value: string): void {
		const target = this.nodes.get(to);
		if (!target) return;
		this.writeCounter += 1;
		const vv: VersionedValue = {
			value,
			version: this.writeCounter,
			timestamp: Date.now(),
			nodeId: from,
		};
		target.store.set(key, vv);
		this.log.push(
			`✉  MSG ${from}→${to}: ${key}="${value}" (no replication, byzantine)`,
		);
	}

	// ── Reconciliation (AP setelah heal) ──
	// Last-write-wins berdasarkan version number (proxy untuk timestamp).
	reconcile(): void {
		if (this.mode !== "AP") return;
		const allKeys = new Set<string>();
		for (const [, n] of this.nodes) {
			for (const k of n.store.keys()) allKeys.add(k);
		}
		for (const key of allKeys) {
			// Cari versi tertinggi di seluruh cluster.
			let winner: VersionedValue | null = null;
			for (const [, n] of this.nodes) {
				const vv = n.store.get(key);
				if (vv) {
					if (!winner || vv.version > winner.version) winner = vv;
				}
			}
			if (winner) {
				for (const [, n] of this.nodes) {
					n.store.set(key, winner);
				}
			}
		}
		this.log.push(
			"⟳  RECONCILE (last-write-wins by version): semua node converge",
		);
	}

	// ── Failure simulation ──

	crash(nodeId: string): void {
		const n = this.nodes.get(nodeId);
		if (n) {
			n.alive = false;
			this.log.push(`✖  CRASH: node ${nodeId} down (crash-stop)`);
		}
	}

	recover(nodeId: string): void {
		const n = this.nodes.get(nodeId);
		if (n) {
			n.alive = true;
			this.log.push(`✚  RECOVER: node ${nodeId} alive lagi (crash-recovery)`);
		}
	}

	// ── Snapshot ──

	snapshot(): {
		id: string;
		alive: boolean;
		entries: { key: string; value: string; version: number }[];
	}[] {
		return [...this.nodes.values()].map((n) => ({
			id: n.id,
			alive: n.alive,
			entries: [...n.store.entries()].map(([key, vv]) => ({
				key,
				value: vv.value,
				version: vv.version,
			})),
		}));
	}

	drainLog(): string[] {
		const l = this.log.slice();
		this.log.length = 0;
		return l;
	}
}

// ── Pretty printers ──

export function printSnapshot(cluster: CapCluster, title: string): void {
	console.log(`\n  ── ${title} ──`);
	const snap = cluster.snapshot();
	for (const node of snap) {
		const status = node.alive ? "alive" : "DOWN";
		if (node.entries.length === 0) {
			console.log(`  [${node.id}] (${status}) { empty }`);
		} else {
			const entries = node.entries
				.map((e) => `${e.key}="${e.value}"(v${e.version})`)
				.join(", ");
			console.log(`  [${node.id}] (${status}) { ${entries} }`);
		}
	}
}

export function printLog(cluster: CapCluster): void {
	for (const line of cluster.drainLog()) {
		console.log(`  ${line}`);
	}
}
