// ─── Two-Phase Commit (2PC) ─────────────────────────────────────
//
// Implementasi algoritmik 2PC: 1 coordinator + N participants.
// Masing-masing participant punya "resource" (Map sebagai DB) yang
// bisa di-lock. Coordinator meng-orchestrate 2 fase:
//
//   Phase 1 (Prepare/Vote):  coordinator → PREPARE → participants
//                             participants vote YES (lock + durably log) / NO
//   Phase 2 (Commit/Abort):  all YES → COMMIT   |  any NO → ABORT
//
// 2PC adalah blocking protocol: kalau coordinator crash setelah
// participant vote YES, participant TIDAK BISA memutuskan sendiri
// apakah commit atau abort → mereka harus menunggu (holding locks).
//
// Ini bukan server. Simulasi in-memory untuk belajar algoritma.

// ── Types ──

export type Vote = "YES" | "NO";

export type ParticipantState =
	| "IDLE" // belum dapat PREPARE
	| "PREPARED" // vote YES, lock dipegang, menunggu keputusan
	| "COMMITTED" // dapat COMMIT, lock dilepas
	| "ABORTED"; // dapat ABORT, lock dilepas

export type CoordinatorState =
	| "IDLE"
	| "PREPARING" // mengirim PREPARE, menunggu vote
	| "PREPARED" // semua vote YES, siap commit
	| "COMMITTING" // mengirim COMMIT
	| "ABORTING" // mengirim ABORT
	| "DONE" // selesai (committed atau aborted)
	| "CRASHED"; // coordinator mati di tengah jalan

export interface ParticipantLog {
	/** Apakah participant menulis decision ke durable log (write-ahead). */
	preparedLogged: boolean;
	/** Decision final yang didapat dari coordinator. */
	decision: "COMMIT" | "ABORT" | null;
}

// ── Participant ──

export interface ParticipantBehavior {
	/** Return YES/NO saat dapat PREPARE. Default: YES. */
	vote?: () => Vote;
	/** Crash participant setelah vote (untuk skenario recovery). */
	crashAfterVote?: boolean;
	/** Crash participant sebelum vote (coordinator menunggu). */
	crashBeforeVote?: boolean;
}

export class Participant {
	readonly name: string;
	state: ParticipantState = "IDLE";
	lockHeld = false;
	alive = true;
	readonly resource = new Map<string, string>();
	readonly log: ParticipantLog = { preparedLogged: false, decision: null };
	private readonly behavior: ParticipantBehavior;

	constructor(name: string, behavior: ParticipantBehavior = {}) {
		this.name = name;
		this.behavior = behavior;
	}

	/** Phase 1: terima PREPARE, vote, lock resource, write durable log. */
	prepare(): Vote {
		if (!this.alive) throw new Error(`${this.name} crashed — cannot PREPARE`);
		if (this.behavior.crashBeforeVote) {
			this.alive = false;
			throw new Error(`${this.name} crashed BEFORE voting`);
		}
		const vote = this.behavior.vote ? this.behavior.vote() : "YES";
		if (vote === "YES") {
			// Tahan lock + tulis "PREPARED" ke durable log.
			this.lockHeld = true;
			this.log.preparedLogged = true;
			this.state = "PREPARED";
		} else {
			// Vote NO → langsung abort lokal, tidak perlu lock.
			this.state = "ABORTED";
			this.log.decision = "ABORT";
		}
		if (this.behavior.crashAfterVote) {
			// Vote sudah terkirim ke coordinator, tapi participant mati
			// sebelum dapat COMMIT/ABORT. Durable log "PREPARED" tersimpan.
			this.alive = false;
		}
		return vote;
	}

	/** Phase 2: terima COMMIT → apply, release lock. */
	commit(): void {
		if (!this.alive) throw new Error(`${this.name} crashed — cannot COMMIT`);
		this.resource.set("tx", "committed");
		this.lockHeld = false;
		this.state = "COMMITTED";
		this.log.decision = "COMMIT";
	}

	/** Phase 2: terima ABORT → rollback, release lock. */
	abort(): void {
		if (!this.alive) throw new Error(`${this.name} crashed — cannot ABORT`);
		this.lockHeld = false;
		this.state = "ABORTED";
		this.log.decision = "ABORT";
	}

	/** Recovery: participant hidup lagi, baca durable log. */
	recover(): void {
		this.alive = true;
		// Kalau ada log "PREPARED" tapi belum ada decision → participant
		// TIDAK TAHU apakah harus commit atau abort. Inilah blocking problem.
		// Dia harus bertanya ke coordinator (atau participant lain di 3PC).
		if (this.log.preparedLogged && this.log.decision === null) {
			this.state = "PREPARED";
			this.lockHeld = true; // re-acquire lock saat recovery
		}
	}

	/** Setelah recovery, coordinator memberitahu decision yang tertunda. */
	applyDecision(d: "COMMIT" | "ABORT"): void {
		if (d === "COMMIT") this.commit();
		else this.abort();
	}
}

// ── Coordinator ──

export interface CoordinatorBehavior {
	/** Crash coordinator setelah Phase 1 (semua YES) sebelum Phase 2. */
	crashAfterPrepare?: boolean;
	/** Crash coordinator sebelum Phase 2 setelah dapat vote (blocking). */
	crashAfterAllYes?: boolean;
}

export class Coordinator {
	readonly name: string;
	state: CoordinatorState = "IDLE";
	alive = true;
	/** Decision yang coordinator catat (durably, di production). */
	decision: "COMMIT" | "ABORT" | null = null;
	private readonly behavior: CoordinatorBehavior;

	constructor(name: string, behavior: CoordinatorBehavior = {}) {
		this.name = name;
		this.behavior = behavior;
	}

	/**
	 * Jalankan 2PC end-to-end. Return hasil + log transisi state.
	 * Throw kalau coordinator/participant crash di tengah (blocking).
	 */
	run(participants: Participant[]): TwoPhaseResult {
		const events: string[] = [];
		const log = (m: string) => events.push(m);

		// ── Phase 1: PREPARE ──
		this.state = "PREPARING";
		log(
			`[${this.name}] Phase 1: PREPARE → kirim ke ${participants.length} participant(s)`,
		);

		const votes = new Map<Participant, Vote>();
		for (const p of participants) {
			try {
				const v = p.prepare();
				votes.set(p, v);
				log(
					`  ${p.name} vote = ${v}${v === "YES" ? " (lock held, PREPARED logged)" : " (abort lokal)"}`,
				);
			} catch (e) {
				// Participant crash sebelum/saat vote → coordinator tidak dapat vote.
				this.state = "PREPARING";
				log(`  ${p.name} CRASHED — coordinator tidak menerima vote`);
				return {
					outcome: "BLOCKED",
					coordinatorState: this.state,
					participants: participants.map((p) => p.state),
					events,
					blockedReason: `coordinator menunggu vote dari ${p.name} yang crash`,
				};
			}
		}

		const allYes = [...votes.values()].every((v) => v === "YES");

		// ── Coordinator crash setelah Phase 1 (blocking problem) ──
		if (allYes && this.behavior.crashAfterAllYes) {
			this.alive = false;
			this.state = "CRASHED";
			log(
				`[${this.name}] CRASHED setelah semua vote YES — sebelum kirim COMMIT`,
			);
			log(
				`  → participants stuck di PREPARED, lock dipegang, TIDAK BISA memutuskan sendiri`,
			);
			return {
				outcome: "BLOCKED",
				coordinatorState: this.state,
				participants: participants.map((p) => p.state),
				events,
				blockedReason:
					"coordinator crash setelah Phase 1 — participants blocked (2PC blocking problem)",
			};
		}

		// ── Phase 2 ──
		if (allYes) {
			this.state = "PREPARED";
			this.decision = "COMMIT";
			this.state = "COMMITTING";
			log(
				`[${this.name}] Phase 2: semua YES → COMMIT → kirim ke semua participant`,
			);
			for (const p of participants) {
				try {
					p.commit();
					log(`  ${p.name} → COMMITTED (lock released)`);
				} catch {
					log(`  ${p.name} CRASHED — coordinator menunggu ACK (blocked)`);
					return {
						outcome: "BLOCKED",
						coordinatorState: this.state,
						participants: participants.map((p) => p.state),
						events,
						blockedReason: `${p.name} crash setelah YES — coordinator blocked menunggu ACK`,
					};
				}
			}
			this.state = "DONE";
			return {
				outcome: "COMMITTED",
				coordinatorState: this.state,
				participants: participants.map((p) => p.state),
				events,
			};
		}

		// Ada yang NO → ABORT
		this.state = "ABORTING";
		this.decision = "ABORT";
		const noVoter = [...votes.entries()].find(([, v]) => v === "NO")![0];
		log(
			`[${this.name}] Phase 2: ada NO (dari ${noVoter.name}) → ABORT → kirim ke semua participant`,
		);
		for (const p of participants) {
			if (p.state === "PREPARED" || p.state === "IDLE") {
				try {
					p.abort();
					log(`  ${p.name} → ABORTED (lock released, rollback)`);
				} catch {
					log(`  ${p.name} CRASHED — tidak bisa di-abort (blocked)`);
				}
			} else {
				log(`  ${p.name} sudah ABORTED (vote NO)`);
			}
		}
		this.state = "DONE";
		return {
			outcome: "ABORTED",
			coordinatorState: this.state,
			participants: participants.map((p) => p.state),
			events,
		};
	}

	/** Recovery coordinator: hidup lagi, punya decision di durable log. */
	recover(): void {
		this.alive = true;
		this.state = this.decision ? "DONE" : "IDLE";
	}
}

export interface TwoPhaseResult {
	outcome: "COMMITTED" | "ABORTED" | "BLOCKED";
	coordinatorState: CoordinatorState;
	participants: ParticipantState[];
	events: string[];
	blockedReason?: string;
}

// ── Three-Phase Commit (3PC) — ringkasan algoritmik ──
//
// 3PC menambah fase PreCommit di antara Prepare dan Commit:
//
//   Phase 1 (CanCommit?):  coordinator → "kamu bisa commit?" → participants vote
//   Phase 2 (PreCommit):   kalau semua YES → coordinator → "siap-siap commit"
//                          participants ACK (tidak ada lock dipegang full)
//   Phase 3 (DoCommit):    coordinator → "commit!" → participants commit
//
// Kunci non-blocking: setelah PreCommit, SEMUA participant tahu bahwa
// semua sudah vote YES. Jadi kalau coordinator crash, participant bisa
// saling bertanya / memilih leader dan MENYIMPULKAN commit (karena
// PreCommit sudah terjadi = semua setuju). Sebaliknya kalau belum
// PreCommit, mereka menyimpulkan abort.
//
// Trade-off: 3PC butuh 3 round-trip (lebih lambat) + asumsi tidak ada
// network partition. Di network partition, 3PC bisa inconsistent
// (quorum terpisah bisa ambil keputusan beda). Karena itu 3PC jarang
// dipakai di practice — Paxos/Raft lebih robust.
//
// (Tidak diimplementasi penuh di sini; konsep dijelaskan di README.)

export const THREE_PC_PHASES = [
	"Phase 1: CanCommit?  — vote (no lock yet)",
	"Phase 2: PreCommit   — 'prepare to commit', all know consensus reached",
	"Phase 3: DoCommit    — final commit (non-blocking if coordinator crashes)",
] as const;
