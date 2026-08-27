// ─── Event-Driven Architecture Demo ──────────────────────────────────────
//
// Demo end-to-end: Command → Event (store) → Projection (read model).
//
// Alur yang ditunjukkan:
//   1. Create task    → TaskCreated   → projections update
//   2. Complete task  → TaskCompleted → projections update
//   3. Rename task    → TaskRenamed   → projections update
//   4. Invalid command (complete yang sudah completed) → REJECTED
//   5. Optimistic concurrency: append dengan expectedVersion salah → REJECTED
//   6. Tampilkan: event store, aggregate state (replay), projection views
//   7. Rebuild projection dari scratch (replay seluruh event log)

import { EventStore, type DomainEvent } from "./event-store.js";
import {
	TaskCommandHandler,
	TaskAggregate,
	type Command,
	CommandRejectedError,
} from "./command-handler.js";
import {
	TaskListView,
	TaskStatsView,
	ActivityFeedView,
	type Projection,
} from "./projection.js";

// ─── Helpers: pretty print ───────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function header(title: string): void {
	const line = "─".repeat(Math.max(8, 64 - title.length));
	console.log(`\n${BOLD}${CYAN}${line} ${title} ${line}${RESET}`);
}

function step(label: string): void {
	console.log(`\n${BOLD}${MAGENTA}▶ ${label}${RESET}`);
}

function ok(msg: string): void {
	console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg: string): void {
	console.log(`  ${RED}✗${RESET} ${msg}`);
}

function printEvent(e: DomainEvent, indent = "    "): void {
	const dataStr =
		Object.keys(e.data).length === 0 ? "{}" : JSON.stringify(e.data);
	console.log(
		`${indent}${YELLOW}v${e.version}${RESET} ${BOLD}${e.type}${RESET} ` +
			`${DIM}${e.aggregateId.slice(0, 8)}${RESET} ${DIM}${dataStr}${RESET}`,
	);
}

// ─── Setup: wire event store + projections ───────────────────────────────

const store = new EventStore();
const listView = new TaskListView();
const statsView = new TaskStatsView();
const feedView = new ActivityFeedView();

const projections: Projection[] = [listView, statsView, feedView];

// Subscribe semua projection ke event store.
// Saat event baru di-append → semua projection langsung update.
for (const p of projections) {
	store.subscribe((e) => p.handle(e));
}

const handler = new TaskCommandHandler(store);

/** Jalankan command dan print alur command → event. */
function run(command: Command): DomainEvent | null {
	const label =
		`${command.kind}(${command.aggregateId.slice(0, 8)}` +
		`${"title" in command ? `, "${command.title}"` : ""})`;
	try {
		const event = handler.handle(command);
		ok(`${label} → emitted ${BOLD}${event.type}${RESET} (v${event.version})`);
		printEvent(event);
		return event;
	} catch (err) {
		if (err instanceof CommandRejectedError) {
			fail(`${label} → ${RED}${err.message}${RESET}`);
		} else {
			fail(`${label} → ${RED}${(err as Error).message}${RESET}`);
		}
		return null;
	}
}

/** Tampilkan aggregate state yang di-rebuild dari event log. */
function printAggregate(aggregateId: string): void {
	const events = store.getEventsForAggregate(aggregateId);
	const agg = TaskAggregate.fromEvents(aggregateId, events);
	const s = agg.state;
	console.log(
		`  ${BOLD}Aggregate ${s.id.slice(0, 8)}${RESET} (rebuilt from ${events.length} event(s))`,
	);
	console.log(`    title:   "${s.title}"`);
	console.log(`    done:    ${s.done}`);
	console.log(`    version: ${s.version}`);
	console.log(`    exists:  ${s.exists}`);
}

// ─── Demo flow ───────────────────────────────────────────────────────────

console.log(
	`${BOLD}${CYAN}╔════════════════════════════════════════════════════════════════════╗${RESET}`,
);
console.log(
	`${BOLD}${CYAN}║  11 — Event-Driven Architecture: Event Sourcing + CQRS              ║${RESET}`,
);
console.log(
	`${BOLD}${CYAN}╚════════════════════════════════════════════════════════════════════╝${RESET}`,
);
console.log(
	`${DIM}Write side: Command → Aggregate (replay) → validate → append Event${RESET}`,
);
console.log(
	`${DIM}Read side:  Event Store → subscribe → Projection (materialized view)${RESET}`,
);

// ── 1. Create tasks ──────────────────────────────────────────────────────
header("1. Create tasks (CreateTask → TaskCreated)");
const t1 = crypto.randomUUID();
const t2 = crypto.randomUUID();
const t3 = crypto.randomUUID();

step("Create task #1");
run({ kind: "CreateTask", aggregateId: t1, title: "Belajar Event Sourcing" });
step("Create task #2");
run({ kind: "CreateTask", aggregateId: t2, title: "Belajar CQRS" });
step("Create task #3");
run({ kind: "CreateTask", aggregateId: t3, title: "Belajar Projections" });

// ── 2. Complete a task ───────────────────────────────────────────────────
header("2. Complete task (CompleteTask → TaskCompleted)");
step("Complete task #1");
run({ kind: "CompleteTask", aggregateId: t1 });

// ── 3. Rename a task ─────────────────────────────────────────────────────
header("3. Rename task (RenameTask → TaskRenamed)");
step("Rename task #2");
run({
	kind: "RenameTask",
	aggregateId: t2,
	title: "Belajar CQRS & Projections",
});

// ── 4. Invalid command: complete already-completed task ──────────────────
header("4. Invalid command — rejected by invariant");
step("Try to complete task #1 again (already done)");
run({ kind: "CompleteTask", aggregateId: t1 });

step("Try to rename task #2 to the same title");
run({
	kind: "RenameTask",
	aggregateId: t2,
	title: "Belajar CQRS & Projections",
});

step("Try to complete a non-existent task");
run({ kind: "CompleteTask", aggregateId: crypto.randomUUID() });

// ── 5. Optimistic concurrency conflict ───────────────────────────────────
header("5. Optimistic concurrency control");
const t1Version = store.currentVersion(t1);
console.log(
	`${DIM}  Task #1 saat ini di versi ${t1Version}. Dua writer membaca state di v${t1Version}.${RESET}`,
);
console.log(
	`${DIM}  Writer A append dengan expectedVersion=${t1Version} → sukses → v${t1Version + 1}.${RESET}`,
);
console.log(
	`${DIM}  Writer B (stale, masih pegang v${t1Version}) append → ditolak (actual sudah v${t1Version + 1}).${RESET}`,
);
step(`Writer A: append dengan expectedVersion=${t1Version} (benar)`);
try {
	store.append(t1, "TaskReopened", {}, t1Version);
	ok(`append berhasil → v${t1Version + 1}`);
} catch (err) {
	fail(`seharusnya berhasil: ${(err as Error).message}`);
}
step(
	`Writer B: append dengan expectedVersion=${t1Version} (STALE — actual sudah ${t1Version + 1})`,
);
try {
	store.append(t1, "TaskCompleted", {}, t1Version);
	fail("seharusnya ditolak karena stale version!");
} catch (err) {
	ok(`ditolak dengan benar: ${RED}${(err as Error).message}${RESET}`);
}

// ── 6. Event store contents ──────────────────────────────────────────────
header("6. Event store contents (source of truth)");
const all = store.getAllEvents();
console.log(`  Total events: ${BOLD}${all.length}${RESET}\n`);
for (const e of all) printEvent(e);

// ── 7. Aggregate state rebuilt from events ───────────────────────────────
header("7. Aggregate state — rebuilt by replaying events");
printAggregate(t1);
printAggregate(t2);
printAggregate(t3);

// ── 8. Projection views (read side) ──────────────────────────────────────
header("8. Projection views (materialized read models)");

step("task-list-view (GET /tasks)");
for (const row of listView.all()) {
	console.log(
		`    ${row.done ? GREEN : YELLOW}${row.done ? "✓" : "○"}${RESET} ` +
			`${row.id.slice(0, 8)} "${row.title}" ${DIM}created ${row.createdAt.slice(11, 19)}${RESET}`,
	);
}

step("task-list-view — pending only (filter)");
for (const row of listView.pending()) {
	console.log(`    ${YELLOW}○${RESET} ${row.id.slice(0, 8)} "${row.title}"`);
}

step("task-stats-view (dashboard counters)");
const st = statsView.stats();
console.log(
	`    total: ${BOLD}${st.total}${RESET}  completed: ${GREEN}${st.completed}${RESET}  ` +
		`pending: ${YELLOW}${st.pending}${RESET}  completionRate: ${(st.completionRate * 100).toFixed(0)}%`,
);

step("activity-feed-view (recent timeline)");
for (const entry of feedView.recent(10)) {
	console.log(
		`    ${DIM}${entry.timestamp.slice(11, 19)}${RESET} ${entry.description} ` +
			`${DIM}(${entry.aggregateId.slice(0, 8)})${RESET}`,
	);
}

// ── 9. Rebuild projections from scratch ──────────────────────────────────
header("9. Rebuild projections from scratch (event replay)");
console.log(
	`${DIM}  Simulasi: ganti schema projection → clear semua view → replay${RESET}`,
);
console.log(
	`${DIM}  seluruh event log. View harus kembali konsisten.${RESET}\n`,
);

for (const p of projections) p.clear();
console.log(`  Setelah clear:`);
console.log(`    task-list-view rows : ${listView.all().length}`);
console.log(`    task-stats-view     : ${JSON.stringify(statsView.stats())}`);
console.log(`    activity-feed-view  : ${feedView.recent().length} entries`);

step("Replay all events ke setiap projection");
for (const p of projections) {
	store.replayTo((e) => p.handle(e));
	ok(`${p.name} rebuilt`);
}

console.log(`\n  Setelah replay:`);
console.log(`    task-list-view rows : ${listView.all().length}`);
const st2 = statsView.stats();
console.log(
	`    task-stats-view     : total=${st2.total} completed=${st2.completed} ` +
		`pending=${st2.pending} rate=${(st2.completionRate * 100).toFixed(0)}%`,
);
console.log(`    activity-feed-view  : ${feedView.recent(100).length} entries`);

// Verifikasi konsistensi: stats harus match list view
const listCompleted = listView.completed().length;
if (listCompleted === st2.completed) {
	ok(
		`konsistensi terverifikasi: list-view completed (${listCompleted}) == stats completed (${st2.completed})`,
	);
} else {
	fail(
		`INKONSISTEN: list-view completed (${listCompleted}) != stats completed (${st2.completed})`,
	);
}

// ── Summary ──────────────────────────────────────────────────────────────
header("Ringkasan");
console.log(
	`  ${BOLD}Write side${RESET}:  Command → CommandHandler → EventStore (append-only log)`,
);
console.log(
	`  ${BOLD}State${RESET}:       Aggregate rebuilt via replay: state = fold(events, apply)`,
);
console.log(
	`  ${BOLD}Read side${RESET}:   EventStore → subscribe/replay → Projections (views)`,
);
console.log(
	`  ${BOLD}Concurrency${RESET}: optimistic — expectedVersion check saat append`,
);
console.log(
	`  ${BOLD}Consistency${RESET}: eventual — write side update dulu, read model menyusul`,
);
console.log(
	`\n${DIM}Coba ubah command/projection di kode lalu re-run untuk eksplorasi lebih lanjut.${RESET}\n`,
);
