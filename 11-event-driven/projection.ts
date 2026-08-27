// ─── CQRS Query Side: Projections / Materialized Views ───────────────────
//
// Projection = read model yang dibangun dengan SUBSCRIBE ke event store.
// Setiap event baru → projection update view-nya. View dioptimalkan untuk
// query tertentu (mis. list task, statistik), terpisah dari write model.
//
// Satu event log → BANYAK projection. Inilah kekuatan event sourcing:
// kamu bisa bikin view baru kapan saja dengan REPLAY seluruh event log.
//
// Eventual consistency: write side append event dulu, lalu projection
// update. Ada jeda kecil (di production via async message bus).

import type { DomainEvent } from "./event-store.js";

/**
 * Base projection: terima event, update view internal.
 * `handle` dipanggil oleh event store (subscribe) atau saat replay.
 */
export interface Projection {
	readonly name: string;
	handle(event: DomainEvent): void;
	/** Reset view ke kosong (untuk rebuild dari scratch via replay). */
	clear(): void;
}

// ─── Projection 1: Task List View ────────────────────────────────────────

/** Row di task-list-view: dioptimalkan untuk GET /tasks (list + filter). */
export interface TaskListRow {
	id: string;
	title: string;
	done: boolean;
	createdAt: string;
	completedAt: string | null;
}

/**
 * TaskListView — materialized view untuk query "list semua task".
 *
 * Daripada query aggregate satu-satu (replay event tiap kali), kita
 * simpan flat row yang siap di-serve. O(1) lookup, O(n) list.
 */
export class TaskListView implements Projection {
	readonly name = "task-list-view";
	private readonly rows = new Map<string, TaskListRow>();

	handle(event: DomainEvent): void {
		switch (event.type) {
			case "TaskCreated":
				this.rows.set(event.aggregateId, {
					id: event.aggregateId,
					title: event.data.title as string,
					done: false,
					createdAt: event.timestamp,
					completedAt: null,
				});
				break;
			case "TaskCompleted": {
				const row = this.rows.get(event.aggregateId);
				if (row) {
					row.done = true;
					row.completedAt = event.timestamp;
				}
				break;
			}
			case "TaskReopened": {
				const row = this.rows.get(event.aggregateId);
				if (row) {
					row.done = false;
					row.completedAt = null;
				}
				break;
			}
			case "TaskRenamed": {
				const row = this.rows.get(event.aggregateId);
				if (row) row.title = event.data.title as string;
				break;
			}
		}
	}

	/** Query: semua task, urut created. */
	all(): TaskListRow[] {
		return [...this.rows.values()].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
	}

	/** Query: hanya yang belum done. */
	pending(): TaskListRow[] {
		return this.all().filter((r) => !r.done);
	}

	/** Query: hanya yang done. */
	completed(): TaskListRow[] {
		return this.all().filter((r) => r.done);
	}

	/** Reset view (untuk rebuild dari scratch). */
	clear(): void {
		this.rows.clear();
	}
}

// ─── Projection 2: Task Stats View ───────────────────────────────────────

/** Row di task-stats-view: agregasi counter untuk dashboard. */
export interface TaskStats {
	total: number;
	completed: number;
	pending: number;
	/** Rasio penyelesaian (0..1) */
	completionRate: number;
}

/**
 * TaskStatsView — materialized view untuk query statistik/dashboard.
 *
 * View ini hanya simpan counter, bukan row detail. Sangat murah untuk
 * query "berapa total task, berapa yang selesai". Dibangun dari event
 * yang SAMA dengan TaskListView — bukti satu log → banyak view.
 */
export class TaskStatsView implements Projection {
	readonly name = "task-stats-view";
	private total = 0;
	private completed = 0;

	handle(event: DomainEvent): void {
		switch (event.type) {
			case "TaskCreated":
				this.total++;
				break;
			case "TaskCompleted":
				// Guard: jangan double-count kalau event di-replay ulang
				// (di demo ini replay selalu dari view yang di-clear, jadi aman).
				this.completed++;
				break;
			case "TaskReopened":
				this.completed--;
				break;
		}
	}

	stats(): TaskStats {
		return {
			total: this.total,
			completed: this.completed,
			pending: this.total - this.completed,
			completionRate: this.total === 0 ? 0 : this.completed / this.total,
		};
	}

	clear(): void {
		this.total = 0;
		this.completed = 0;
	}
}

// ─── Projection 3: Activity Feed (timeline event) ────────────────────────

/** Row di activity-feed: log aktivitas untuk audit / timeline UI. */
export interface ActivityEntry {
	eventId: string;
	aggregateId: string;
	type: string;
	description: string;
	timestamp: string;
}

const ACTIVITY_LABEL: Record<string, string> = {
	TaskCreated: "Task dibuat",
	TaskCompleted: "Task diselesaikan",
	TaskReopened: "Task dibuka kembali",
	TaskRenamed: "Task di-rename",
};

/**
 * ActivityFeedView — timeline aktivitas dari event log.
 * View ketiga untuk menunjukkan: satu event log bisa jadi banyak bentuk view
 * yang sangat berbeda (list, stats, timeline) tanpa menyentuh write side.
 */
export class ActivityFeedView implements Projection {
	readonly name = "activity-feed-view";
	private readonly feed: ActivityEntry[] = [];

	handle(event: DomainEvent): void {
		let description = ACTIVITY_LABEL[event.type] ?? event.type;
		if (event.type === "TaskCreated" || event.type === "TaskRenamed") {
			description += `: "${event.data.title as string}"`;
		}
		this.feed.push({
			eventId: event.id,
			aggregateId: event.aggregateId,
			type: event.type,
			description,
			timestamp: event.timestamp,
		});
	}

	recent(limit = 10): ActivityEntry[] {
		return this.feed.slice(-limit).reverse();
	}

	clear(): void {
		this.feed.length = 0;
	}
}
