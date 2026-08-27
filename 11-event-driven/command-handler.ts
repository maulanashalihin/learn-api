// ─── CQRS Command Side: Aggregate + Command Handler ──────────────────────
//
// Command = intent untuk mengubah state ("lakukan X").
// Command handler validasi command terhadap state aggregate SAAT INI,
// lalu append event baru ke event store (kalau valid).
//
// Aggregate = entitas domain yang state-nya dibangun dari REPLAY event
// (event sourcing). Aggregate TIDAK menyimpan state sendiri di DB —
// state selalu di-rebuild dari event log.
//
// Write side (command) dan read side (query/projection) terpisah = CQRS.

import type { EventStore, DomainEvent } from "./event-store.js";

// ─── Task Aggregate ──────────────────────────────────────────────────────

/** State Task yang dibangun dari replay event. */
export interface TaskState {
	id: string;
	title: string;
	done: boolean;
	/** Versi = jumlah event yang sudah di-apply */
	version: number;
	/** Apakah aggregate sudah pernah dibuat (TaskCreated sudah di-apply)? */
	exists: boolean;
}

/** State awal sebelum ada event. */
function emptyTaskState(aggregateId: string): TaskState {
	return { id: aggregateId, title: "", done: false, version: 0, exists: false };
}

/**
 * TaskAggregate — menerapkan event ke state.
 *
 * `apply(event)` adalah pure function: gak ada side effect, cuma mutasi state
 * in-memory. Inilah inti event sourcing: state = fold(eventLog, apply).
 *
 * Method `handle*` adalah command logic: validasi + tentukan event apa yang
 * harus di-append. Command handler yang benar-benar menulis ke store.
 */
export class TaskAggregate {
	constructor(public readonly state: TaskState) {}

	/** Bangun aggregate dari awal dengan replay semua event-nya. */
	static fromEvents(aggregateId: string, events: DomainEvent[]): TaskAggregate {
		const agg = new TaskAggregate(emptyTaskState(aggregateId));
		for (const event of events) agg.apply(event);
		return agg;
	}

	/** Terapkan satu event ke state. Pure mutation, no side effects. */
	apply(event: DomainEvent): void {
		switch (event.type) {
			case "TaskCreated":
				this.state.title = event.data.title as string;
				this.state.exists = true;
				break;
			case "TaskCompleted":
				this.state.done = true;
				break;
			case "TaskRenamed":
				this.state.title = event.data.title as string;
				break;
			case "TaskReopened":
				this.state.done = false;
				break;
		}
		this.state.version = event.version;
	}
}

// ─── Commands ────────────────────────────────────────────────────────────

/** Command = intent. Berbeda dari event: event = fakta yang sudah terjadi. */
export type Command =
	| { kind: "CreateTask"; aggregateId: string; title: string }
	| { kind: "CompleteTask"; aggregateId: string }
	| { kind: "ReopenTask"; aggregateId: string }
	| { kind: "RenameTask"; aggregateId: string; title: string };

/** Error saat command ditolak karena melanggar invariant bisnis. */
export class CommandRejectedError extends Error {
	constructor(
		public readonly command: string,
		message: string,
	) {
		super(`${command} rejected: ${message}`);
		this.name = "CommandRejectedError";
	}
}

// ─── Command Handler (write side) ─────────────────────────────────────────

/**
 * Command handler: jembatan command → event.
 *
 * Alur:
 *   1. Load aggregate (replay event dari store untuk aggregateId).
 *   2. Validasi command terhadap state aggregate.
 *   3. Tentukan event yang harus di-append.
 *   4. Append ke store dengan expectedVersion = aggregate.state.version
 *      → optimistic concurrency check.
 *
 * Catatan: di CQRS murni, command handler TIDAK return data query.
 * Ia hanya return event yang di-append (atau throw kalau ditolak).
 */
export class TaskCommandHandler {
	constructor(private readonly store: EventStore) {}

	/** Load aggregate dengan replay event dari store. */
	private load(aggregateId: string): TaskAggregate {
		return TaskAggregate.fromEvents(
			aggregateId,
			this.store.getEventsForAggregate(aggregateId),
		);
	}

	handle(command: Command): DomainEvent {
		const agg = this.load(command.aggregateId);
		const s = agg.state;
		const v = s.version; // expectedVersion untuk optimistic concurrency

		switch (command.kind) {
			case "CreateTask": {
				if (s.exists) {
					throw new CommandRejectedError(
						"CreateTask",
						`task ${command.aggregateId} already exists`,
					);
				}
				if (!command.title.trim()) {
					throw new CommandRejectedError("CreateTask", "title cannot be empty");
				}
				return this.store.append(
					command.aggregateId,
					"TaskCreated",
					{ title: command.title },
					v,
				);
			}

			case "CompleteTask": {
				if (!s.exists) {
					throw new CommandRejectedError(
						"CompleteTask",
						`task ${command.aggregateId} does not exist`,
					);
				}
				if (s.done) {
					throw new CommandRejectedError(
						"CompleteTask",
						`task ${command.aggregateId} is already completed`,
					);
				}
				return this.store.append(command.aggregateId, "TaskCompleted", {}, v);
			}

			case "ReopenTask": {
				if (!s.exists) {
					throw new CommandRejectedError(
						"ReopenTask",
						`task ${command.aggregateId} does not exist`,
					);
				}
				if (!s.done) {
					throw new CommandRejectedError(
						"ReopenTask",
						`task ${command.aggregateId} is not completed`,
					);
				}
				return this.store.append(command.aggregateId, "TaskReopened", {}, v);
			}

			case "RenameTask": {
				if (!s.exists) {
					throw new CommandRejectedError(
						"RenameTask",
						`task ${command.aggregateId} does not exist`,
					);
				}
				if (!command.title.trim()) {
					throw new CommandRejectedError("RenameTask", "title cannot be empty");
				}
				if (command.title === s.title) {
					throw new CommandRejectedError(
						"RenameTask",
						"new title is the same as current title",
					);
				}
				return this.store.append(
					command.aggregateId,
					"TaskRenamed",
					{ title: command.title },
					v,
				);
			}
		}
	}
}
