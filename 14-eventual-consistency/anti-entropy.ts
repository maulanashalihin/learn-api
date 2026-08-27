// ─── Anti-Entropy dengan Merkle Tree ───────────────────────────
//
// Anti-entropy = proactive sync antar replica. Daripada kirim semua
// data (O(n)), bangun Merkle tree (hash tree) per replica. Bandingkan
// root hash: kalau sama → tidak ada perbedaan. Kalau beda → turun ke
// children untuk menemukan subtree yang berbeda, sampai ke leaf = key
// spesifik. Sinkronisasi hanya key yang berbeda → O(log n) perbandingan.
//
// Cassandra pakai ini antar node untuk repair berkala.

import { createHash } from "node:crypto";

export type KV = Record<string, string>;

/** Hash string → hex pendek (6 char) untuk display. */
function hash(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 6);
}

export interface MerkleNode {
	hash: string;
	// Leaf: punya key. Internal: punya children kiri/kanan.
	key?: string;
	value?: string;
	// true jika key benar-benar ada di replica; false = sentinel ∅.
	present?: boolean;
	left?: MerkleNode;
	right?: MerkleNode;
}

/**
 * Bangun Merkle tree dari KV map.
 *
 * Penting: tree dibangun over `keyUniverse` (sorted union semua key
 * di semua replica). Key yang tidak ada di `data` → leaf sentinel
 * "∅" (kosong). Dengan demikian struktur tree IDENTIK di semua replica
 * → perbandingan leaf-by-leaf exact, tidak ada false-positive akibat
 * key shift. Inilah cara Cassandra: Merkle tree over fixed token range.
 *
 * Leaf = hash(key:value), diurutkan by key. Parent = hash(L+R).
 * Kalau ganjil, leaf terakhir naik langsung sebagai child kanan.
 */
export function buildMerkleTree(data: KV, keyUniverse?: string[]): MerkleNode {
	const keys = keyUniverse ?? Object.keys(data).sort();
	if (keys.length === 0) {
		return { hash: hash("") };
	}

	// Bangun leaf level. Missing key → sentinel "∅".
	let level: MerkleNode[] = keys.map((k) => {
		const v = data[k];
		const present = v !== undefined;
		return {
			hash: hash(`${k}:${present ? v : "∅"}`),
			key: k,
			value: present ? v : "∅",
			present,
		};
	});

	// Bangun ke atas sampai 1 root
	while (level.length > 1) {
		const next: MerkleNode[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i];
			const right = level[i + 1];
			if (!right) {
				// ganjil: naik langsung
				next.push(left);
			} else {
				next.push({
					hash: hash(left.hash + right.hash),
					left,
					right,
				});
			}
		}
		level = next;
	}
	return level[0];
}

export interface DiffResult {
	keysOnlyInA: string[];
	keysOnlyInB: string[];
	keysDifferent: string[];
}

/**
 * Bandingkan dua Merkle tree yang dibangun over keyUniverse SAMA.
 * Karena struktur identik, walk leaf-by-leaf exact:
 *   - root hash sama → subtree identik, skip (O(1) prune)
 *   - leaf: bandingkan flag `present` & value
 *     • A present, B ∅        → keysOnlyInA
 *     • A ∅, B present        → keysOnlyInB
 *     • both present, val beda → keysDifferent
 *     • both ∅                → tidak ada (skip)
 */
export function compareMerkle(a: MerkleNode, b: MerkleNode): DiffResult {
	const result: DiffResult = {
		keysOnlyInA: [],
		keysOnlyInB: [],
		keysDifferent: [],
	};

	function walk(nA: MerkleNode | undefined, nB: MerkleNode | undefined): void {
		if (!nA || !nB) return;
		// Hash sama → subtree identik, skip (inilah efisiensi Merkle)
		if (nA.hash === nB.hash) return;

		// Leaf: punya key
		if (nA.key && nB.key) {
			const aPresent = nA.present !== false;
			const bPresent = nB.present !== false;
			if (aPresent && !bPresent) result.keysOnlyInA.push(nA.key);
			else if (!aPresent && bPresent) result.keysOnlyInB.push(nB.key);
			else if (aPresent && bPresent && nA.value !== nB.value) {
				result.keysDifferent.push(nA.key);
			}
			return;
		}

		// Internal: turun ke children
		walk(nA.left, nB.left);
		walk(nA.right, nB.right);
	}

	walk(a, b);
	return result;
}

/**
 * Sinkronisasi BIDIRECTIONAL antar dua replica berdasarkan diff.
 *   - keysOnlyInA  → copy A→B (key hanya ada di A)
 *   - keysOnlyInB  → copy B→A (key hanya ada di B)
 *   - keysDifferent → konflik value. Policy: A menang (source of truth).
 *     (Di production: LWW by timestamp, CRDT merge, atau app-level.)
 * Return daftar key yang di-sync beserta arah.
 */
export function syncBidirectional(
	a: KV,
	b: KV,
	diff: DiffResult,
): { dir: "A→B" | "B→A"; key: string; from: string; to: string }[] {
	const ops: { dir: "A→B" | "B→A"; key: string; from: string; to: string }[] =
		[];
	for (const k of diff.keysOnlyInA) {
		b[k] = a[k];
		ops.push({ dir: "A→B", key: k, from: a[k], to: a[k] });
	}
	for (const k of diff.keysOnlyInB) {
		a[k] = b[k];
		ops.push({ dir: "B→A", key: k, from: b[k], to: b[k] });
	}
	for (const k of diff.keysDifferent) {
		b[k] = a[k]; // A wins
		ops.push({ dir: "A→B", key: k, from: a[k], to: a[k] });
	}
	return ops;
}

// ── Visualisasi tree ──

function printTree(node: MerkleNode, indent = "", label = "root"): void {
	const present = node.present === false ? " (∅)" : "";
	const leaf = node.key
		? ` [leaf key=${node.key} val="${node.value}"${present}]`
		: "";
	console.log(`${indent}${label}: ${node.hash}${leaf}`);
	if (node.left) printTree(node.left, indent + "  ", "L");
	if (node.right) printTree(node.right, indent + "  ", "R");
}

// ── Demo ──

const SEP = "─".repeat(60);

export function runAntiEntropyDemo(): void {
	console.log("\n" + "═".repeat(60));
	console.log("  DEMO 2 — ANTI-ENTROPY (MERKLE TREE)");
	console.log("═".repeat(60));
	console.log(
		"2 replica divergen. Bandingkan via Merkle tree, sync hanya diff.\n",
	);

	const replicaA: KV = {
		"user:1": "Alice",
		"user:2": "Bob",
		"user:3": "Charlie",
		"user:4": "Diana",
		"user:5": "Eve",
		"user:6": "Frank",
	};

	// Replica B: user:2 berubah, user:5 hilang, user:7 baru
	const replicaB: KV = {
		"user:1": "Alice",
		"user:2": "BOB-UPDATED", // berubah
		"user:3": "Charlie",
		"user:4": "Diana",
		"user:6": "Frank",
		"user:7": "Grace", // baru
	};

	console.log(SEP);
	console.log("Replica A data:");
	console.log(
		"  " +
			Object.entries(replicaA)
				.map(([k, v]) => `${k}=${v}`)
				.join(", "),
	);
	console.log("Replica B data:");
	console.log(
		"  " +
			Object.entries(replicaB)
				.map(([k, v]) => `${k}=${v}`)
				.join(", "),
	);
	console.log();
	// Key universe = sorted union semua key di kedua replica.
	// Tree dibangun over universe ini → struktur IDENTIK → comparison exact.
	const keyUniverse = [
		...new Set([...Object.keys(replicaA), ...Object.keys(replicaB)]),
	].sort();

	const treeA = buildMerkleTree(replicaA, keyUniverse);
	const treeB = buildMerkleTree(replicaB, keyUniverse);

	console.log(SEP);
	console.log(
		`Key universe (union A∪B, ${keyUniverse.length} keys): ${keyUniverse.join(", ")}`,
	);
	console.log();
	console.log("Merkle Tree A (missing key → leaf ∅):");
	printTree(treeA);
	console.log();
	console.log("Merkle Tree B:");
	printTree(treeB);
	console.log();

	console.log(SEP);
	console.log("PERBANDINGAN:");
	console.log(`  Root A: ${treeA.hash}`);
	console.log(`  Root B: ${treeB.hash}`);
	console.log(
		`  Root ${treeA.hash === treeB.hash ? "SAMA (no diff)" : "BEDA → turun ke subtree"}`,
	);
	console.log();

	const diff = compareMerkle(treeA, treeB);
	console.log(SEP);
	console.log("DIFF (ditemukan via tree traversal, bukan full scan):");
	console.log(
		`  Keys only in A:  ${diff.keysOnlyInA.length ? diff.keysOnlyInA.join(", ") : "(none)"}`,
	);
	console.log(
		`  Keys only in B:  ${diff.keysOnlyInB.length ? diff.keysOnlyInB.join(", ") : "(none)"}`,
	);
	console.log(
		`  Keys different:  ${diff.keysDifferent.length ? diff.keysDifferent.join(", ") : "(none)"}`,
	);
	console.log();

	// Sync BIDIRECTIONAL: keysOnlyInA → A→B, keysOnlyInB → B→A, keysDifferent → A wins
	console.log(SEP);
	console.log("SYNC (bidirectional — anti-entropy saling repair):");
	console.log("  Policy untuk keysDifferent: A menang (source of truth).");
	const ops = syncBidirectional(replicaA, replicaB, diff);
	for (const op of ops) {
		console.log(`  ${op.dir}  ${op.key}: → "${op.to}"`);
	}
	console.log();

	// Verify convergence
	const treeA2 = buildMerkleTree(replicaA, keyUniverse);
	const treeB2 = buildMerkleTree(replicaB, keyUniverse);
	console.log(SEP);
	console.log("AFTER SYNC:");
	console.log(
		`  Replica A: ${Object.entries(replicaA)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")}`,
	);
	console.log(
		`  Replica B: ${Object.entries(replicaB)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")}`,
	);
	console.log(`  Root A: ${treeA.hash} → ${treeA2.hash}`);
	console.log(`  Root B: ${treeB.hash} → ${treeB2.hash}`);
	console.log(
		`  → ${treeA2.hash === treeB2.hash ? "✓ Root SAMA — replica konvergen" : "✗ Masih beda"}`,
	);
	console.log();

	console.log(SEP);
	console.log("INSIGHT:");
	console.log("  Full scan = O(n) perbandingan key. Merkle tree = O(log n)");
	console.log("  node yang dibandingkan, lalu hanya key di subtree yang beda");
	console.log("  yang di-transfer. Untuk 1M key dengan 1 key beda: ~20 node");
	console.log("  dibandingkan, 1 key di-sync. Efisiensi 1M:1.");
	console.log();
}
