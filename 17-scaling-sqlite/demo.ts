// ─── Demo: Scaling SQLite with walsync ─────────────────────────────
//
// Demo ini menunjukkan SQLite replication dengan walsync:
//   1. Start walsync replica (background)
//   2. Start walsync primary (background, ships WAL to replica)
//   3. Start writer app (primary, port 9189)
//   4. Start reader app (replica, port 9188)
//   5. Write tasks via writer → verify replicated to reader
//   6. Show sync delay, read/write works on both nodes
//
// Prerequisite: download walsync binary
//   curl -L https://github.com/maulanashalihin/walsync/releases/latest/download/walsync-darwin-arm64 -o ./walsync
//   chmod +x ./walsync
//
// Jalankan:
//   npx tsx 17-scaling-sqlite/demo.ts
//
// Clean up:
//   rm -f /tmp/walsync-demo.db*

import { spawn, type ChildProcess } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PRIMARY_DB = "/tmp/walsync-demo-primary.db";
const REPLICA_DB = "/tmp/walsync-demo-replica.db";
const REPLICA_PORT = 9193;
const WRITER_PORT = 9189;
const READER_PORT = 9188;

// Try common binary locations
const WALSYNC_BIN: string | undefined = [
	"./walsync",
	"../walsync",
	"/tmp/walsync",
].find((p) => existsSync(p));

if (!WALSYNC_BIN) {
	console.error("walsync binary not found. Download it:");
	console.error("  curl -L https://github.com/maulanashalihin/walsync/releases/latest/download/walsync-darwin-arm64 -o ./walsync");
	console.error("  chmod +x ./walsync");
	process.exit(1);
}
const WALSYNC = WALSYNC_BIN; // narrowed: string (not undefined)

const procs: ChildProcess[] = [];

function cleanup(): void {
	for (const p of procs) {
		try { p.kill("SIGTERM"); } catch { /* process may already be dead */ }
	}
	try { unlinkSync(PRIMARY_DB); } catch { /* may not exist */ }
	try { unlinkSync(`${PRIMARY_DB}-wal`); } catch { /* may not exist */ }
	try { unlinkSync(`${PRIMARY_DB}-shm`); } catch { /* may not exist */ }
	try { unlinkSync(REPLICA_DB); } catch { /* may not exist */ }
	try { unlinkSync(`${REPLICA_DB}-wal`); } catch { /* may not exist */ }
	try { unlinkSync(`${REPLICA_DB}-shm`); } catch { /* may not exist */ }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

function start(label: string, cmd: string, args: string[], env?: Record<string, string>): ChildProcess {
	const proc = spawn(cmd, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	procs.push(proc);
	proc.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
	proc.stderr?.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
	return proc;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	return res.json();
}

async function main(): Promise<void> {
	console.log();
	console.log("╔" + "═".repeat(62) + "╗");
	console.log("║" + "  17 — SCALING SQLITE WITH WALSYNC".padEnd(62) + "║");
	console.log("║" + "  Single-writer + multi-reader replication".padEnd(62) + "║");
	console.log("╚" + "═".repeat(62) + "╝");
	console.log();
	console.log(`  walsync binary: ${WALSYNC}`);
	console.log(`  Primary DB:    ${PRIMARY_DB}`);
	console.log(`  Replica DB:    ${REPLICA_DB}`);

	// Clean slate
	cleanup();
	await sleep(100);

	// ── Step 1: Start walsync replica ──
	console.log("── Step 1: Start walsync replica ──────────────────────────");
	start("walsync-replica", WALSYNC, [
		"-mode", "replica",
		"-db", REPLICA_DB,
		"-listen", `:${REPLICA_PORT}`,
	]);
	await sleep(500);
	console.log("  ✓ Replica listening on :" + REPLICA_PORT);
	console.log();

	// ── Step 2: Start writer app (creates DB + table) ──
	console.log("── Step 2: Start writer app (primary) ────────────────────");
	start("writer", "npx", ["tsx", "17-scaling-sqlite/writer.ts"], { DB_PATH: PRIMARY_DB, PORT: String(WRITER_PORT) });
	await sleep(2000);
	console.log("  ✓ Writer app on http://localhost:" + WRITER_PORT);
	console.log();

	// ── Step 3: Start walsync primary (ships initial snapshot) ──
	console.log("── Step 3: Start walsync primary ──────────────────────────");
	start("walsync-primary", WALSYNC, [
		"-mode", "primary",
		"-db", PRIMARY_DB,
		"-replicas", `127.0.0.1:${REPLICA_PORT}`,
	]);
	await sleep(2000);
	console.log("  ✓ Primary shipping WAL to replica");
	console.log();

	// ── Step 4: Start reader app (replica) ──
	console.log("── Step 4: Start reader app (replica) ────────────────────");
	start("reader", "npx", ["tsx", "17-scaling-sqlite/reader.ts"], { DB_PATH: REPLICA_DB, PORT: String(READER_PORT) });
	await sleep(2000);
	console.log("  ✓ Reader app on http://localhost:" + READER_PORT);
	console.log();

	// ── Step 5: Write tasks via writer ──
	console.log("── Step 5: Write 3 tasks via writer (primary) ────────────");
	const tasks = ["Belajar walsync", "Setup replication", "Test read replica"];
	for (const title of tasks) {
		await fetchJson(`http://localhost:${WRITER_PORT}/api/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		});
		console.log(`  ✓ Written: "${title}"`);
		await sleep(300); // give walsync time to ship
	}
	console.log();

	// ── Step 6: Verify replication ──
	console.log("── Step 6: Verify replication on reader (replica) ────────");
	await sleep(1000); // wait for sync
	const readerData = await fetchJson(`http://localhost:${READER_PORT}/api/tasks`) as Array<{ id: number; title: string }>;
	console.log(`  Reader has ${readerData.length} tasks:`);
	for (const t of readerData) {
		console.log(`    id=${t.id} title="${t.title}"`);
	}

	const writerData = await fetchJson(`http://localhost:${WRITER_PORT}/api/tasks`) as Array<{ id: number; title: string }>;
	console.log();
	console.log(`  Writer has ${writerData.length} tasks (should match)`);
	console.log();

	// ── Summary ──
	console.log("═".repeat(60));
	console.log("  RINGKASAN");
	console.log("═".repeat(60));
	console.log();
	console.log("  Arsitektur:");
	console.log("    Writer app → SQLite (embedded, native speed)");
	console.log("    walsync primary → ship WAL → walsync replica");
	console.log("    Reader app → SQLite (embedded, readonly)");
	console.log();
	console.log("  Hasil:");
	const match = readerData.length === writerData.length;
	console.log(`    Writer: ${writerData.length} tasks`);
	console.log(`    Reader: ${readerData.length} tasks`);
	console.log(`    Replicated: ${match ? "✅ YES" : "❌ NO"}`);
	console.log();
	console.log("  Konsep:");
	console.log("    • App pakai embedded SQLite (zero overhead, no FUSE/TCP)");
	console.log("    • walsync = background process, ship WAL via HTTP");
	console.log("    • Single-writer (primary), multi-reader (replicas)");
	console.log("    • Eventual consistency (~100ms sync delay)");
	console.log();
	console.log("  Production: https://github.com/maulanashalihin/walsync");
	console.log();

	cleanup();
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	cleanup();
	process.exit(1);
});
