// ─── Raft Consensus Algorithm (in-memory simulation) ──────────────
//
// Implementasi Raft yang simplified tapi functional: leader election
// + log replication. Dipakai oleh demo.ts untuk demonstrasi skenario
// crash, partition, dan recovery.
//
// Model simulasi: tick-based discrete event loop.
//   - `now` = logical clock (integer ticks, bukan ms real-time)
//   - Setiap node punya electionDeadline (tick saat timeout)
//   - Network call disimulasikan sinkron, dengan partition awareness
//   - Randomized election timeout mencegah split vote berulang
//
// Referensi: "In Search of an Understandable Consensus Algorithm"
// (Diego Ongaro, John Ousterhout, 2014)

// ── Types ──

export type NodeRole = "follower" | "candidate" | "leader";

export interface LogEntry {
	term: number;
	index: number; // 1-based, monotonik
	command: string; // format: "SET key=value" atau "INC key" (demo)
}

export interface RequestVoteRequest {
	term: number;
	candidateId: string;
	lastLogIndex: number;
	lastLogTerm: number;
}

export interface RequestVoteResponse {
	term: number;
	voteGranted: boolean;
	voterId: string;
}

export interface AppendEntriesRequest {
	term: number;
	leaderId: string;
	prevLogIndex: number;
	prevLogTerm: number;
	entries: LogEntry[];
	leaderCommit: number;
}

export interface AppendEntriesResponse {
	term: number;
	success: boolean;
	matchIndex: number;
	followerId: string;
}

// ── Deterministic PRNG (supaya demo reproducible) ──

class Rng {
	private state: number;
	constructor(seed: number) {
		this.state = seed >>> 0;
	}
	next(): number {
		// xorshift32
		this.state ^= this.state << 13;
		this.state ^= this.state >>> 17;
		this.state ^= this.state << 5;
		this.state >>>= 0;
		return this.state / 0xffffffff;
	}
	range(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}
}

// ── RaftNode ──

export class RaftNode {
	readonly id: string;
	role: NodeRole = "follower";
	currentTerm = 0;
	votedFor: string | null = null;
	log: LogEntry[] = [];
	commitIndex = 0;
	lastApplied = 0;
	stateMachine = new Map<string, string>();

	// Leader-only state
	nextIndex = new Map<string, number>();
	matchIndex = new Map<string, number>();

	// Election timing (in ticks)
	readonly baseElectionTimeout: number;
	electionDeadline: number;
	votesReceived = new Set<string>();

	// Reference ke cluster (di-inject saat node ditambahkan)
	cluster: RaftCluster | null = null;

	constructor(id: string, baseElectionTimeout: number, startDeadline: number) {
		this.id = id;
		this.baseElectionTimeout = baseElectionTimeout;
		this.electionDeadline = startDeadline;
	}

	get lastLogIndex(): number {
		return this.log.length > 0 ? this.log[this.log.length - 1].index : 0;
	}

	get lastLogTerm(): number {
		return this.log.length > 0 ? this.log[this.log.length - 1].term : 0;
	}

	// Reset election timer dengan jitter random (mencegah split vote)
	resetElectionTimer(now: number, rng: Rng): void {
		const jitter = rng.range(0, Math.floor(this.baseElectionTimeout / 2));
		this.electionDeadline = now + this.baseElectionTimeout + jitter;
	}

	// Step down ke follower kalau lihat term lebih tinggi
	stepDownIfStale(term: number): boolean {
		if (term > this.currentTerm) {
			this.currentTerm = term;
			this.role = "follower";
			this.votedFor = null;
			this.votesReceived.clear();
			return true;
		}
		return false;
	}

	// ── Leader Election ──

	startElection(now: number, rng: Rng): void {
		this.role = "candidate";
		this.currentTerm += 1;
		this.votedFor = this.id; // vote for self
		this.votesReceived = new Set([this.id]);
		// Reset timer: election timeout baru (kalau tidak menang, retry)
		this.resetElectionTimer(now, rng);

		const peers = this.cluster!.peersOf(this.id);
		let votes = 1; // self
		for (const peer of peers) {
			const res = peer.handleRequestVote({
				term: this.currentTerm,
				candidateId: this.id,
				lastLogIndex: this.lastLogIndex,
				lastLogTerm: this.lastLogTerm,
			});
			if (res.voteGranted) {
				votes += 1;
				this.votesReceived.add(peer.id);
			}
		}

		const majority = Math.floor(this.cluster!.size / 2) + 1;
		if (votes >= majority) {
			this.becomeLeader(now);
		}
		// Kalau tidak menang, tetap candidate — election timer akan
		// trigger election baru dengan term lebih tinggi.
	}

	becomeLeader(now: number): void {
		this.role = "leader";
		// Inisialisasi nextIndex/matchIndex untuk semua peers
		for (const peer of this.cluster!.peersOf(this.id)) {
			this.nextIndex.set(peer.id, this.lastLogIndex + 1);
			this.matchIndex.set(peer.id, 0);
		}
		// Kirim heartbeat awal (AppendEntries kosong)
		this.broadcastAppendEntries(now);
	}

	// ── RequestVote RPC handler ──

	handleRequestVote(req: RequestVoteRequest): RequestVoteResponse {
		// Update term kalau lebih tinggi
		this.stepDownIfStale(req.term);

		// Tolak kalau term lebih rendah
		if (req.term < this.currentTerm) {
			return {
				term: this.currentTerm,
				voteGranted: false,
				voterId: this.id,
			};
		}

		// Election restriction: candidate's log harus at least as up-to-date.
		// "Up-to-date" = lastLogTerm lebih besar, atau term sama & index >= .
		const upToDate =
			req.lastLogTerm > this.lastLogTerm ||
			(req.lastLogTerm === this.lastLogTerm &&
				req.lastLogIndex >= this.lastLogIndex);

		// Grant vote kalau belum vote di term ini (atau sudah vote untuk
		// candidate ini), DAN log candidate up-to-date.
		const canVote =
			(this.votedFor === null || this.votedFor === req.candidateId) && upToDate;

		if (canVote) {
			this.votedFor = req.candidateId;
			// Reset election timer (granting vote = leader mungkin akan datang)
			this.resetElectionTimer(this.cluster!.now, this.cluster!.rng);
		}

		return {
			term: this.currentTerm,
			voteGranted: canVote,
			voterId: this.id,
		};
	}

	// ── AppendEntries RPC handler ──

	handleAppendEntries(req: AppendEntriesRequest): AppendEntriesResponse {
		// Update term kalau lebih tinggi
		this.stepDownIfStale(req.term);

		// Tolak kalau term lebih rendah (leader stale)
		if (req.term < this.currentTerm) {
			return {
				term: this.currentTerm,
				success: false,
				matchIndex: this.lastLogIndex,
				followerId: this.id,
			};
		}

		// Term sama/lebih tinggi → recognize leader, reset timer
		this.role = "follower";
		this.resetElectionTimer(this.cluster!.now, this.cluster!.rng);

		// Consistency check: prevLogIndex harus match
		// (index ada & term cocok). Kalau log follower kosong di posisi itu,
		// tolak → leader akan decrement nextIndex & retry.
		if (req.prevLogIndex > 0) {
			const prevEntry = this.log.find((e) => e.index === req.prevLogIndex);
			if (!prevEntry || prevEntry.term !== req.prevLogTerm) {
				return {
					term: this.currentTerm,
					success: false,
					matchIndex: this.lastLogIndex,
					followerId: this.id,
				};
			}
		}

		// Append entries: hapus conflict (entry dengan index sama tapi
		// term beda) lalu append entry baru.
		for (const entry of req.entries) {
			const existing = this.log.find((e) => e.index === entry.index);
			if (existing) {
				if (existing.term !== entry.term) {
					// Conflict: hapus entry ini & semua setelahnya
					this.log = this.log.filter((e) => e.index < entry.index);
					this.log.push(entry);
				}
				// else: sama, skip
			} else {
				this.log.push(entry);
			}
		}

		// Update commitIndex kalau leaderCommit lebih tinggi
		if (req.leaderCommit > this.commitIndex) {
			const lastNewIndex =
				req.entries.length > 0
					? req.entries[req.entries.length - 1].index
					: req.prevLogIndex;
			this.commitIndex = Math.min(req.leaderCommit, lastNewIndex);
			this.applyCommitted();
		}

		return {
			term: this.currentTerm,
			success: true,
			matchIndex: this.lastLogIndex,
			followerId: this.id,
		};
	}

	// ── Log Replication (Leader-side) ──

	// Client mengirim command ke leader. Append ke log, lalu replicate.
	// Return true kalau committed (majority ACK), false kalau bukan leader.
	propose(command: string): boolean {
		if (this.role !== "leader") return false;

		const entry: LogEntry = {
			term: this.currentTerm,
			index: this.lastLogIndex + 1,
			command,
		};
		this.log.push(entry);
		// Replicate segera
		this.broadcastAppendEntries(this.cluster!.now);
		return true;
	}

	// Kirim AppendEntries ke semua peers (heartbeat kalau entries kosong)
	broadcastAppendEntries(now: number): void {
		if (this.role !== "leader") return;

		for (const peer of this.cluster!.peersOf(this.id)) {
			const next = this.nextIndex.get(peer.id) ?? 1;
			const prevLogIndex = next - 1;
			const prevLogTerm =
				prevLogIndex > 0
					? (this.log.find((e) => e.index === prevLogIndex)?.term ?? 0)
					: 0;

			// Entries mulai dari nextIndex sampai akhir log
			const entries = this.log.filter((e) => e.index >= next);

			const res = peer.handleAppendEntries({
				term: this.currentTerm,
				leaderId: this.id,
				prevLogIndex,
				prevLogTerm,
				entries,
				leaderCommit: this.commitIndex,
			});

			if (res.term > this.currentTerm) {
				// Leader stale → step down
				this.stepDownIfStale(res.term);
				return;
			}

			if (res.success) {
				// Update nextIndex & matchIndex
				const newMatch = res.matchIndex;
				this.matchIndex.set(peer.id, newMatch);
				this.nextIndex.set(peer.id, newMatch + 1);
			} else {
				// Decrement nextIndex, retry next tick
				this.nextIndex.set(peer.id, Math.max(1, next - 1));
			}
		}

		this.updateCommitIndex();
	}

	// Update commitIndex berdasarkan matchIndex majority.
	// Rule: cari N tertinggi sehingga majority matchIndex >= N,
	// DAN log[N].term == currentTerm (safety: hanya commit entry dari term sendiri).
	updateCommitIndex(): void {
		if (this.role !== "leader") return;

		const majority = Math.floor(this.cluster!.size / 2) + 1;
		// Kumpulkan matchIndex dari semua peers + self (self = lastLogIndex)
		const indices = [this.lastLogIndex];
		for (const peer of this.cluster!.peersOf(this.id)) {
			indices.push(this.matchIndex.get(peer.id) ?? 0);
		}
		indices.sort((a, b) => a - b);
		// majority-th dari tertinggi = indices[len - majority]
		const majorityMatched = indices[indices.length - majority];

		// Cari N tertinggi <= majorityMatched dengan log[N].term == currentTerm
		for (let n = majorityMatched; n > this.commitIndex; n--) {
			const entry = this.log.find((e) => e.index === n);
			if (entry && entry.term === this.currentTerm) {
				this.commitIndex = n;
				this.applyCommitted();
				break;
			}
		}
	}

	// Apply entry yang sudah committed ke state machine
	applyCommitted(): void {
		while (this.lastApplied < this.commitIndex) {
			this.lastApplied += 1;
			const entry = this.log.find((e) => e.index === this.lastApplied);
			if (entry) this.applyCommand(entry.command);
		}
	}

	private applyCommand(command: string): void {
		const parts = command.match(/^(\w+)\s+([^=\s]+)(?:=(.+))?$/);
		if (!parts) return;
		const [, op, key, val] = parts;
		if (op === "SET") {
			this.stateMachine.set(key, val ?? "");
		} else if (op === "INC") {
			const cur = parseInt(this.stateMachine.get(key) ?? "0", 10);
			this.stateMachine.set(key, String(cur + 1));
		} else if (op === "DEL") {
			this.stateMachine.delete(key);
		}
	}

	// ── Snapshot (untuk logging) ──

	snapshot(): NodeSnapshot {
		return {
			id: this.id,
			role: this.role,
			term: this.currentTerm,
			votedFor: this.votedFor,
			logLen: this.log.length,
			lastLogIndex: this.lastLogIndex,
			lastLogTerm: this.lastLogTerm,
			commitIndex: this.commitIndex,
			lastApplied: this.lastApplied,
			stateMachine: new Map(this.stateMachine),
			electionDeadline: this.electionDeadline,
		};
	}
}

export interface NodeSnapshot {
	id: string;
	role: NodeRole;
	term: number;
	votedFor: string | null;
	logLen: number;
	lastLogIndex: number;
	lastLogTerm: number;
	commitIndex: number;
	lastApplied: number;
	stateMachine: Map<string, string>;
	electionDeadline: number;
}

// ── RaftCluster ──

export class RaftCluster {
	private _nodes: Map<string, RaftNode> = new Map();
	now = 0;
	rng: Rng;
	baseElectionTimeout: number;

	// Partition simulation: set node yang "down" (crashed)
	private downNodes = new Set<string>();
	// Network partition: groups of isolated nodes.
	// Node di group berbeda tidak bisa saling komunikasi.
	// Node di group sama bisa komunikasi (kalau tidak down).
	private partitionGroups: string[][] | null = null;

	constructor(seed = 42, baseElectionTimeout = 10) {
		this.rng = new Rng(seed);
		this.baseElectionTimeout = baseElectionTimeout;
	}

	get size(): number {
		return this._nodes.size;
	}

	addNode(node: RaftNode): void {
		node.cluster = this;
		this._nodes.set(node.id, node);
	}

	getNode(id: string): RaftNode | undefined {
		return this._nodes.get(id);
	}

	allNodes(): RaftNode[] {
		return Array.from(this._nodes.values());
	}

	// Peers yang bisa dihubungi node ini (tidak down, tidak di partition lain)
	peersOf(id: string): RaftNode[] {
		const result: RaftNode[] = [];
		for (const peer of this._nodes.values()) {
			if (peer.id === id) continue;
			if (this.downNodes.has(peer.id)) continue; // peer crashed
			if (this.downNodes.has(id)) continue; // self crashed (no comms)
			if (!this.canCommunicate(id, peer.id)) continue; // partitioned
			result.push(peer);
		}
		return result;
	}

	private canCommunicate(a: string, b: string): boolean {
		if (this.partitionGroups === null) return true;
		for (const group of this.partitionGroups) {
			if (group.includes(a) && group.includes(b)) return true;
		}
		return false;
	}

	// ── Failure simulation controls ──

	crashNode(id: string): void {
		this.downNodes.add(id);
		const node = this._nodes.get(id);
		if (node) {
			// Crashed node tidak berpartisipasi — role freeze
			// (di real life: process mati, state di disk)
		}
	}

	restartNode(id: string, now: number): void {
		this.downNodes.delete(id);
		const node = this._nodes.get(id);
		if (node) {
			// Restart: reset election timer, tetap follower dengan term lama
			// (state log & term di-persist di disk, tidak hilang)
			node.role = "follower";
			node.votedFor = null;
			node.votesReceived.clear();
			node.resetElectionTimer(now, this.rng);
		}
	}

	isDown(id: string): boolean {
		return this.downNodes.has(id);
	}

	// Set partition: array of groups. Node di group berbeda tidak komunikasi.
	setPartition(groups: string[][]): void {
		this.partitionGroups = groups;
	}

	healPartition(): void {
		this.partitionGroups = null;
	}

	getPartitionInfo(): string {
		if (this.partitionGroups === null) return "none";
		return this.partitionGroups.map((g) => `[${g.join(",")}]`).join(" | ");
	}

	// ── Tick: advance logical clock ──

	tick(): void {
		this.now += 1;

		// Cek election timeout untuk node yang tidak down
		for (const node of this._nodes.values()) {
			if (this.downNodes.has(node.id)) continue;
			if (node.role === "leader") continue; // leader tidak election-timeout

			if (this.now >= node.electionDeadline) {
				node.startElection(this.now, this.rng);
			}
		}

		// Leader kirim heartbeat periodik (setiap tick, simplified)
		for (const node of this._nodes.values()) {
			if (this.downNodes.has(node.id)) continue;
			if (node.role === "leader") {
				node.broadcastAppendEntries(this.now);
			}
		}
	}

	// Run ticks sampai kondisi terpenuhi atau maxTicks
	runUntil(predicate: () => boolean, maxTicks = 100): boolean {
		for (let i = 0; i < maxTicks; i++) {
			if (predicate()) return true;
			this.tick();
		}
		return predicate();
	}

	// ── Helpers untuk demo ──

	getLeader(): RaftNode | null {
		for (const node of this._nodes.values()) {
			if (this.downNodes.has(node.id)) continue;
			if (node.role === "leader") return node;
		}
		return null;
	}

	getLeaders(): RaftNode[] {
		const leaders: RaftNode[] = [];
		for (const node of this._nodes.values()) {
			if (this.downNodes.has(node.id)) continue;
			if (node.role === "leader") leaders.push(node);
		}
		return leaders;
	}

	// Propose command ke leader. Return leaderId atau null kalau no leader.
	proposeToLeader(command: string): string | null {
		const leader = this.getLeader();
		if (!leader) return null;
		const ok = leader.propose(command);
		return ok ? leader.id : null;
	}
}
