/**
 * Demo: cr-sqlite multi-writer replication — 2 node di 1 machine.
 *
 * Cara kerja:
 * 1. Download crsqlite extension (lihat README)
 * 2. Jalankan: bun run 18-cr-sqlite/demo.ts
 *
 * Demo ini:
 * - Start Node 1 (:3001) + Node 2 (:3002), saling terhubung
 * - Write Alice + Bob ke Node 1
 * - Write Charlie + Dewi ke Node 2
 * - Tunggu sync (~4 detik)
 * - Verify: kedua node punya 4 users (converged)
 * - Test conflict: update user 1 di kedua node → verify converge
 * - Cleanup
 */

import { spawn } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
const scriptDir = import.meta.dirname;

const EXTENSION = process.platform === "darwin" ? "./crsqlite.dylib" : "./crsqlite.so";
const DB1 = "/tmp/crsql-demo-node1.db";
const DB2 = "/tmp/crsql-demo-node2.db";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function start(name: string, cmd: string, args: string[], env?: Record<string, string>) {
  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  proc.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return proc;
}

async function fetchJSON(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  return res.json();
}

async function writeUser(port: number, id: number, name: string, city: string) {
  return fetchJSON(`http://localhost:${port}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, city }),
  });
}

async function getUsers(port: number) {
  return fetchJSON(`http://localhost:${port}/users`) as Promise<{
    node: number;
    users: { id: number; name: string; city: string }[];
  }>;
}

async function main() {
  // Check extension exists
  if (!existsSync(EXTENSION)) {
    const plat = process.platform === "darwin" ? "darwin-aarch64" : "linux-x86_64";
    console.error(`❌ ${EXTENSION} not found`);
    console.error(`   Download: curl -fsSL https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-${plat}.zip -o crsqlite.zip && unzip crsqlite.zip`);
    process.exit(1);
  }

  // Cleanup old DBs
  for (const f of [DB1, DB2, `${DB1}-wal`, `${DB1}-shm`, `${DB2}-wal`, `${DB2}-shm`]) {
    try { unlinkSync(f); } catch {}
  }

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  cr-sqlite Multi-Writer Replication Demo                  ║");
  console.log("║  CRDT-based SQLite sync — write di mana saja, converge    ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log();

  // Step 1: Start Node 1
  console.log("── Step 1: Start Node 1 (:3001) ────────────────────────────");
  const node1 = start("node1", process.execPath, [
    join(scriptDir, "replicate.ts"),
    "--node-id", "1", "--port", "3001",
    "--db", DB1, "--extension", EXTENSION,
    "--peer", "http://localhost:3002",
  ]);
  await sleep(1500);
  console.log("  ✓ Node 1 on http://localhost:3001");
  console.log();

  // Step 2: Start Node 2
  console.log("── Step 2: Start Node 2 (:3002) ────────────────────────────");
  const node2 = start("node2", process.execPath, [
    join(scriptDir, "replicate.ts"),
    "--node-id", "2", "--port", "3002",
    "--db", DB2, "--extension", EXTENSION,
    "--peer", "http://localhost:3001",
  ]);
  await sleep(1500);
  console.log("  ✓ Node 2 on http://localhost:3002");
  console.log();

  // Step 3: Write to Node 1
  console.log("── Step 3: Write Alice + Bob ke Node 1 ─────────────────────");
  await writeUser(3001, 1, "Alice", "Singapore");
  await writeUser(3001, 2, "Bob", "Jakarta");
  console.log("  ✓ Node 1: Alice (Singapore), Bob (Jakarta)");
  console.log();

  // Step 4: Write to Node 2
  console.log("── Step 4: Write Charlie + Dewi ke Node 2 ──────────────────");
  await writeUser(3002, 3, "Charlie", "Bandung");
  await writeUser(3002, 4, "Dewi", "Surabaya");
  console.log("  ✓ Node 2: Charlie (Bandung), Dewi (Surabaya)");
  console.log();

  // Step 5: Wait for sync
  console.log("── Step 5: Tunggu sync (CRDT changeset exchange) ───────────");
  process.stdout.write("  Waiting");
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    process.stdout.write(".");
  }
  console.log(" done");
  console.log();

  // Step 6: Verify convergence
  console.log("── Step 6: Verify convergence ──────────────────────────────");
  const r1 = await getUsers(3001);
  const r2 = await getUsers(3002);
  const converged = JSON.stringify(r1.users) === JSON.stringify(r2.users);

  console.log(`  Node 1: ${r1.users.map((u) => `${u.name}(${u.city})`).join(", ")}`);
  console.log(`  Node 2: ${r2.users.map((u) => `${u.name}(${u.city})`).join(", ")}`);
  console.log(`  Converged: ${converged ? "✅ YES" : "❌ NO"}`);
  console.log();

  // Step 7: Conflict test
  console.log("── Step 7: Conflict test — update user 1 di kedua node ─────");
  await writeUser(3001, 1, "Alice", "Tokyo");
  await writeUser(3002, 1, "Alice", "Paris");
  console.log("  Node 1: Alice → Tokyo");
  console.log("  Node 2: Alice → Paris");
  console.log("  (LWW: later write wins, both converge to same value)");
  console.log();

  await sleep(5000);

  const c1 = await getUsers(3001);
  const c2 = await getUsers(3002);
  const city1 = c1.users.find((u) => u.id === 1)?.city;
  const city2 = c2.users.find((u) => u.id === 1)?.city;
  const conflictResolved = city1 === city2;

  console.log(`  Node 1: Alice (${city1})`);
  console.log(`  Node 2: Alice (${city2})`);
  console.log(`  Conflict resolved: ${conflictResolved ? "✅ YES" : "❌ NO"}`);
  console.log();

  // Summary
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  Summary                                                  ║");
  console.log(`║  Multi-writer convergence: ${converged ? "✅" : "❌"}                              ║`);
  console.log(`║  Conflict resolution:      ${conflictResolved ? "✅" : "❌"}                              ║`);
  console.log("║  CRDT guarantee:           ✅ mathematical convergence    ║");
  console.log("║  Transport:                HTTP changeset exchange (~50 LOC)║");
  console.log("║  Infrastructure:           zero (no NATS, no sidecar)     ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Cleanup
  node1.kill("SIGTERM");
  node2.kill("SIGTERM");
  await sleep(500);
  for (const f of [DB1, DB2, `${DB1}-wal`, `${DB1}-shm`, `${DB2}-wal`, `${DB2}-shm`]) {
    try { unlinkSync(f); } catch {}
  }
  console.log("\nCleanup done.");
}

main();
