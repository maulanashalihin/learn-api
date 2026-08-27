// ─── Demo: Raft Consensus in Action ──────────────────────────────
//
// Demo ini menjalankan Raft cluster (5 node) dalam 1 process sebagai
// in-memory simulation. Bukan server — ini algorithmic demo.
//
// Skenario:
//   Phase 1: Normal — leader election, log replication, commit
//   Phase 2: Leader crash — followers election-timeout, new leader
//   Phase 3: Network partition — split-brain prevention
//            Majority partition continues, minority stuck (no quorum)
//   Phase 4: Partition heal — minority rejoins, catches up
//   Phase 5: Old leader returns — steps down on higher term
//
// Jalankan: npx tsx 15-consensus/demo.ts

import { RaftCluster, RaftNode } from "./raft.js";
import type { RaftNode as RaftNodeType } from "./raft.js";

const BANNER = "═".repeat(67);
const PHASE = "─".repeat(67);
const SUB = "·".repeat(67);

// ── Helpers ──

function header(title: string): void {
	console.log(`\n${BANNER}`);
	console.log(`  ${title}`);
	console.log(`${BANNER}`);
}

function phase(title: string): void {
	console.log(`\n${PHASE}`);
	console.log(`  ${title}`);
	console.log(`${PHASE}`);
}

function printCluster(cluster: RaftCluster, label = "Cluster state"): void {
	console.log(
		`\n  ${label}  (tick=${cluster.now}, partition=${cluster.getPartitionInfo()})`,
	);
	console.log(`  ${SUB}`);
	const leader = cluster.getLeader();
	for (const node of cluster.allNodes()) {
		const down = cluster.isDown(node.id);
		const status = down ? "💀 CRASHED" : `${node.role.toUpperCase()}`;
		const vote = node.votedFor ? `votedFor=${node.votedFor}` : "votedFor=—";
		const logEntries =
			node.log.length > 0
				? node.log.map((e) => `#${e.index}(t${e.term}):${e.command}`).join(" ")
				: "(empty)";
		const sm =
			node.stateMachine.size > 0
				? [...node.stateMachine.entries()]
						.map(([k, v]) => `${k}=${v}`)
						.join(", ")
				: "{}";
		const leaderMark = !down && leader?.id === node.id ? " ◀ LEADER" : "";
		console.log(
			`  ${node.id}  ${status.padEnd(10)} term=${node.currentTerm}  ${vote}`,
		);
		console.log(
			`         log=[${logEntries}]  commit=${node.commitIndex}  applied=${node.lastApplied}${leaderMark}`,
		);
		console.log(`         stateMachine={${sm}}`);
	}
}

function printElectionResult(cluster: RaftCluster, leader: RaftNodeType): void {
	console.log(
		`\n  ✅ Leader terpilih: ${leader.id} (term=${leader.currentTerm})`,
	);
	console.log(
		`     Votes diterima: ${[...leader.votesReceived].join(", ")} ` +
			`(${leader.votesReceived.size}/${cluster.size} = majority ${Math.floor(cluster.size / 2) + 1})`,
	);
}

// Wait until all non-down nodes have commitIndex >= n (commit propagated to everyone)
function allCommitted(cluster: RaftCluster, n: number): boolean {
	return cluster
		.allNodes()
		.every((node) => cluster.isDown(node.id) || node.commitIndex >= n);
}

// Wait until leader + its reachable peers (same partition) have commitIndex >= n.
// Used when an isolated/minority node is partitioned away and can't commit.
function allCommittedMajority(
	cluster: RaftCluster,
	leaderId: string,
	n: number,
): boolean {
	const leader = cluster.getNode(leaderId);
	if (!leader || leader.commitIndex < n) return false;
	for (const peer of cluster.allNodes()) {
		if (peer.id === leaderId || cluster.isDown(peer.id)) continue;
		// Only check peers reachable from leader (same partition)
		if (
			leader.cluster &&
			leader.cluster.peersOf(leaderId).some((p) => p.id === peer.id)
		) {
			if (peer.commitIndex < n) return false;
		}
	}
	return true;
}

// Build a 5-node cluster with staggered election deadlines
function buildCluster(seed = 42): RaftCluster {
	const cluster = new RaftCluster(seed, 10);
	// Stagger initial election deadlines so one node times out first
	const deadlines = [5, 8, 11, 14, 17];
	for (let i = 0; i < 5; i++) {
		cluster.addNode(new RaftNode(`n${i}`, 10, deadlines[i]));
	}
	return cluster;
}

// ── Main ──

async function main(): Promise<void> {
	console.log(BANNER);
	console.log("  Raft Consensus Algorithm — In-Memory Simulation");
	console.log(BANNER);
	console.log(`
  Cluster: 5 node (n0–n4). Quorum = majority = ⌊5/2⌋+1 = 3.
  Setiap node: Follower | Candidate | Leader.
  Term-based: setiap election increment term.
  Logical clock dalam "tick" (bukan ms real-time).

  RPCs:
    RequestVote(term, candidateId, lastLogIndex, lastLogTerm)
      → (term, voteGranted)
    AppendEntries(term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommit)
      → (term, success, matchIndex)
`);

	// ════════════════════════════════════════════════════════════════
	// PHASE 1: Normal — Leader Election + Log Replication
	// ════════════════════════════════════════════════════════════════
	header("PHASE 1 — Leader Election & Log Replication");

	phase("1a. Leader Election");
	const cluster = buildCluster(42);
	console.log(`
  Semua node mulai sebagai FOLLOWER, term=0.
  Election deadline di-stagger (n0=5, n1=8, n2=11, n3=14, n4=17).
  Node dengan deadline terkecil akan timeout duluan → jadi CANDIDATE.
`);
	printCluster(cluster, "Initial state");

	// Run until leader elected
	cluster.runUntil(() => cluster.getLeader() !== null, 50);
	const leader1 = cluster.getLeader()!;
	printElectionResult(cluster, leader1);
	console.log(`
  Flow election:
    1. n0 election-timeout → jadi CANDIDATE, term 0→1, vote for self
    2. n0 kirim RequestVote(term=1) ke n1,n2,n3,n4
    3. n1–n4 grant vote (log n0 up-to-date, belum vote di term 1)
    4. n0 dapat 5/5 votes ≥ majority(3) → jadi LEADER
    5. n0 kirim heartbeat (AppendEntries kosong) ke semua peer
`);

	phase("1b. Log Replication — client kirim SET x=42");
	console.log(`
  Client → Leader (n0): "SET x=42"
  Leader append ke log (index=1, term=1), lalu replicate.
`);
	const proposed1 = cluster.proposeToLeader("SET x=42");
	console.log(`  → Command diterima leader: ${proposed1}`);
	// Replicate + commit
	cluster.runUntil(() => allCommitted(cluster, 1), 20);
	printCluster(cluster, "Setelah SET x=42 committed");

	console.log(`
  Replication flow:
    1. Leader append entry #1(term=1, "SET x=42") ke log sendiri
    2. Leader kirim AppendEntries(entries=[#1]) ke n1–n4
    3. Follower append → reply ACK (success=true, matchIndex=1)
    4. Leader dapat 4 ACK + self = 5 ≥ majority(3)
    5. Leader update commitIndex=1, apply "SET x=42" ke state machine
    6. Leader piggyback commitIndex di AppendEntries berikutnya
    7. Follower lihat leaderCommit=1 → commit & apply juga
  Hasil: SEMUA node punya x=42 di state machine. Strong consistency.
`);

	phase("1c. Log Replication — multiple commands");
	cluster.proposeToLeader("SET y=10");
	cluster.runUntil(() => allCommitted(cluster, 2), 20);
	cluster.proposeToLeader("INC y");
	cluster.runUntil(() => allCommitted(cluster, 3), 20);
	printCluster(cluster, "Setelah SET y=10, INC y");
	console.log(`
  INC y → state machine: y = 10 + 1 = 11 (di semua node).
  Commit index naik 1→2→3. Log replication sequential & ordered.
`);

	// ════════════════════════════════════════════════════════════════
	// PHASE 2: Leader Crash → Re-election
	// ════════════════════════════════════════════════════════════════
	header("PHASE 2 — Leader Crash & Re-election");

	const crashedLeader = cluster.getLeader()!;
	console.log(`
  Skenario: leader ${crashedLeader.id} CRASH (process mati).
  Follower berhenti terima heartbeat → election timeout → new election.
`);
	phase("2a. Crash leader");
	cluster.crashNode(crashedLeader.id);
	printCluster(cluster, `Setelah crash ${crashedLeader.id}`);
	console.log(`
  ${crashedLeader.id} mati: tidak kirim heartbeat, tidak respond RPC.
  n1–n4 menunggu heartbeat... election timer terus jalan.
`);

	phase("2b. Followers elect new leader");
	cluster.runUntil(() => cluster.getLeader() !== null, 50);
	const leader2 = cluster.getLeader()!;
	printElectionResult(cluster, leader2);
	printCluster(cluster, "Setelah re-election");
	console.log(`
  Flow re-election:
    1. Salah satu follower (term ${leader2.currentTerm} terpilih) election-timeout
    2. Jadi CANDIDATE, term ${leader2.currentTerm - 1}→${leader2.currentTerm}, vote for self
    3. Kirim RequestVote(term=${leader2.currentTerm}) ke peer yang alive
    4. Dapat majority (dari 4 node alive, butuh 3) → jadi LEADER
    5. Kirim heartbeat, lanjutkan replication
  Term naik: ${crashedLeader.currentTerm} → ${leader2.currentTerm}. Term monotonik.
`);

	phase("2c. New leader replicates new command");
	cluster.proposeToLeader("SET z=99");
	cluster.runUntil(() => allCommitted(cluster, 4), 20);
	printCluster(cluster, "Setelah SET z=99 (old leader masih down)");
	console.log(`
  New leader ${leader2.id} menerima command, replicate ke 3 follower alive.
  ${crashedLeader.id} tidak dapat entry baru (crashed). Nanti catch up saat restart.
`);

	// ════════════════════════════════════════════════════════════════
	// PHASE 3: Network Partition (Split-Brain Prevention)
	// ════════════════════════════════════════════════════════════════
	header("PHASE 3 — Network Partition (Split-Brain Prevention)");

	// Restart old leader first for clean partition demo
	phase("3a. Restart old leader, stabilize");
	cluster.restartNode(crashedLeader.id, cluster.now);
	cluster.runUntil(() => allCommitted(cluster, 4), 30);
	printCluster(cluster, "Semua node healthy & caught up");
	console.log(`
  ${crashedLeader.id} restart → terima AppendEntries dari ${leader2.id},
  catch up entry #4, commit index naik ke 4. Semua konsisten.
`);

	phase("3b. Partition: majority [n0,n1,n2] | minority [n3,n4]");
	// Figure out which nodes — put current leader in majority
	const currentLeader = cluster.getLeader()!;
	const leaderSide = currentLeader.id;
	// Build groups: leader + 2 others = majority(3), rest = minority(2)
	const allIds = cluster.allNodes().map((n) => n.id);
	const majorityGroup = [
		leaderSide,
		...allIds.filter((id) => id !== leaderSide).slice(0, 2),
	];
	const minorityGroup = allIds.filter((id) => !majorityGroup.includes(id));
	cluster.setPartition([majorityGroup, minorityGroup]);
	console.log(`
  Network split menjadi 2 partition:
    Majority partition: [${majorityGroup.join(", ")}]  → ${majorityGroup.length} node (quorum ✓)
    Minority partition: [${minorityGroup.join(", ")}]  → ${minorityGroup.length} node (no quorum ✗)

  Node di partition berbeda TIDAK bisa saling kirim RPC.
  Pertanyaan: apakah minority bisa elect leader sendiri? (split-brain?)
`);
	printCluster(cluster, "Partition active");

	// Run some ticks in partition
	cluster.runUntil(() => false, 15);
	const leadersAfter = cluster.getLeaders();
	console.log(
		`\n  Leaders setelah 15 tick di partition: ` +
			(leadersAfter.length > 0
				? leadersAfter.map((n) => `${n.id}@term${n.currentTerm}`).join(", ")
				: "NONE"),
	);
	printCluster(cluster, "Selama partition");
	console.log(`
  Hasil:
    ✅ Majority partition [${majorityGroup.join(",")}]: leader ${currentLeader.id} tetap jalan,
       bisa commit entry baru (punya quorum 3).
    ❌ Minority partition [${minorityGroup.join(",")}]: TIDAK bisa elect leader.
       Candidate butuh ${Math.floor(cluster.size / 2) + 1} votes, hanya punya ${minorityGroup.length} node.
       Node di minority terus increment term (retry election) tapi gagal terus.
  → SPLIT-BRAIN DICEGAH. Hanya 1 leader yang valid (di majority).
`);

	cluster.proposeToLeader("SET w=7");
	cluster.runUntil(
		() => majorityGroup.every((id) => cluster.getNode(id)!.commitIndex >= 5),
		20,
	);
	printCluster(cluster, "Majority commit SET w=7 (minority tidak tahu)");
	console.log(`
  Majority side commit entry #5 (SET w=7). Minority tidak tahu entry ini.
  Minority node stuck di commit index 4, term terus naik (retry election).
`);

	// ════════════════════════════════════════════════════════════════
	// PHASE 4: Partition Heal — Minority Catches Up
	// ════════════════════════════════════════════════════════════════
	header("PHASE 4 — Partition Heal & Catch-Up");

	phase("4a. Heal network partition");
	cluster.healPartition();
	console.log(`
  Network dipulihkan. Semua node bisa komunikasi lagi.
  Minority node punya term lebih tinggi (dari retry election gagal).
  Leader majority (${currentLeader.id}) lihat term lebih tinggi → step down.
  New election → leader baru terpilih dengan term tertinggi.
`);
	cluster.runUntil(() => cluster.getLeader() !== null, 50);
	const leaderAfterHeal = cluster.getLeader()!;
	printElectionResult(cluster, leaderAfterHeal);
	printCluster(cluster, "Setelah heal + re-election");

	phase("4b. Minority catches up via AppendEntries");
	// Run until all nodes caught up to commit index 5
	cluster.runUntil(
		() => cluster.allNodes().every((n) => n.commitIndex >= 5),
		40,
	);
	printCluster(cluster, "Semua node caught up (commit=5)");
	console.log(`
  Flow catch-up:
    1. Leader baru kirim AppendEntries ke semua node (term=${leaderAfterHeal.currentTerm})
    2. Minority node (nextIndex < leader's lastLogIndex) terima entry #5
    3. Minority append, reply ACK
    4. Leader update matchIndex, commit entry #5
    5. Semua node apply "SET w=7" → state machine konsisten lagi
  → EVENTUAL CONSISTENCY setelah heal. Tidak ada data loss (entry #5 survived).
`);

	// ════════════════════════════════════════════════════════════════
	// PHASE 5: Old Leader Returns with Stale Term
	// ════════════════════════════════════════════════════════════════
	header("PHASE 5 — Old Leader Returns (Stale Term → Step Down)");

	// Fresh cluster for this scenario
	const cluster2 = buildCluster(99);
	cluster2.runUntil(() => cluster2.getLeader() !== null, 50);
	const oldLeader = cluster2.getLeader()!;
	const oldLeaderTerm = oldLeader.currentTerm;
	console.log(`
  Skenario: leader ${oldLeader.id} (term=${oldLeader.currentTerm}) terisolasi
  (network partition — isolated node, bukan minority partition).
  Cluster lainnya elect leader baru dengan term lebih tinggi.
  Saat ${oldLeader.id} reconnect, dia kirim AppendEntries dengan term lama
  → followers tolak → ${oldLeader.id} lihat term lebih tinggi → STEP DOWN.
`);
	printCluster(cluster2, "Fresh cluster, leader elected");

	phase("5a. Isolate old leader");
	cluster2.setPartition([
		[oldLeader.id],
		cluster2
			.allNodes()
			.filter((n) => n.id !== oldLeader.id)
			.map((n) => n.id),
	]);
	console.log(`  Partition: [${oldLeader.id}] | [rest of cluster]`);
	// Rest of cluster (majority partition) elects new leader with higher term.
	// n0 is isolated but NOT down, so getLeaders() still includes it.
	// We look for a leader among the majority partition (id !== oldLeader).
	cluster2.runUntil(() => {
		return cluster2.getLeaders().some((n) => n.id !== oldLeader.id);
	}, 50);
	const newLeader2 = cluster2.getLeaders().find((n) => n.id !== oldLeader.id)!;
	console.log(
		`\n  Old leader ${oldLeader.id}: masih ngaku leader term=${oldLeader.currentTerm} (isolated, tidak tahu dunia luar)`,
	);
	console.log(
		`  New leader ${newLeader2.id}: term=${newLeader2.currentTerm} (elected oleh majority partition)`,
	);
	// New leader commits something (propose directly — getLeader() might return isolated n0)
	newLeader2.propose("SET isolated=1");
	cluster2.runUntil(() => allCommittedMajority(cluster2, newLeader2.id, 1), 20);

	phase("5b. Reconnect old leader — sees higher term");
	cluster2.healPartition();
	console.log(`
  Network heal. ${oldLeader.id} (masih ngaku leader term=${oldLeader.currentTerm})
  kirim AppendEntries(term=${oldLeader.currentTerm}) ke followers.
  Followers punya term=${newLeader2.currentTerm} > ${oldLeader.currentTerm} → REJECT (success=false, term=${newLeader2.currentTerm}).
  ${oldLeader.id} lihat term lebih tinggi → stepDownIfStale → jadi FOLLOWER, term=${newLeader2.currentTerm}.
`);
	// Run until old leader steps down and catches up
	cluster2.runUntil(
		() =>
			oldLeader.role === "follower" &&
			oldLeader.currentTerm >= newLeader2.currentTerm,
		30,
	);
	printCluster(cluster2, "Setelah old leader step down & catch up");
	console.log(`
  Hasil:
    ${oldLeader.id}: role=FOLLOWER, term=${oldLeader.currentTerm} (naik dari ${oldLeaderTerm})
    ${newLeader2.id}: role=${newLeader2.role}, term=${newLeader2.currentTerm} (leader valid)
    Tidak ada 2 leader bersamaan. Safety guarantee terpenuhi.
  → Raft Safety: leader dengan term lebih rendah SELALU step down
    saat melihat term lebih tinggi. Tidak mungkin 2 leader di term yang sama.
`);

	// ════════════════════════════════════════════════════════════════
	// SUMMARY
	// ════════════════════════════════════════════════════════════════
	header("SUMMARY — Raft Guarantees");

	console.log(`
  ${SUB}
  Yang dibuktikan demo ini:

  1. LEADER ELECTION       — Follower timeout → Candidate → RequestVote
                             → majority → Leader. Term monotonik naik.

  2. LOG REPLICATION       — Leader append → AppendEntries → follower ACK
                             → majority ACK → commit → apply. Strong consistency.

  3. LEADER CRASH          — Followers election-timeout → new leader.
                             Service continues (high availability).

  4. SPLIT-BRAIN PREVENTION— Minority partition tidak punya quorum →
                             tidak bisa elect leader. Hanya majority yang valid.

  5. PARTITION HEAL        — Minority rejoin → catch up via AppendEntries.
                             Eventual consistency, no data loss.

  6. STALE LEADER STEP-DOWN— Old leader dengan term lebih rendah →
                             followers reject → step down ke follower.
                             Safety: tidak ada 2 leader di term yang sama.

  ${SUB}
  Raft = Consensus untuk crash-stop failures (nodes crash atau healthy).
  Bukan untuk Byzantine failures (nodes boong). Itu PBFT / blockchain.
  ${SUB}
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
