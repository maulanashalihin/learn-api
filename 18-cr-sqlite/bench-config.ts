/**
 * bench-config.ts — cari config terbaik cr-sqlite sync
 *
 * Jalan di OVH server. Start node1 locally, node2 via SSH ke Underconst.
 * Test matrix: HTTP/1.1 vs HTTP/3 × 5 intervals (2000/500/100/50/10ms)
 * Metric: batch propagation latency (50 writes → all appear di peer)
 *
 * Usage (di OVH):
 *   bun run bench-config.ts
 *
 * Output: /tmp/crsql-config-results.csv
 */

import { execSync } from "node:child_process";

const PORT = 3001;
const REMOTE_DIR = "/tmp/crsql-config-test";
const EXTENSION = "/tmp/crsql-test/crsqlite.so";
const BUN = "/home/ubuntu/.bun/bin/bun";
const UNDERCONST_HOST = "maulana@maulana.underconst.com";
const UNDERCONST_BUN = "/home/maulana/.bun/bin/bun";
const NUM_WRITES = 50;

const INTERVALS = [2000, 500, 100, 50, 10];
const PROTOCOLS = ["http1", "http3"] as const;

const RESULTS_CSV = "/tmp/crsql-config-results.csv";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sshRun(host: string, cmd: string): string {
  try {
    return execSync(`ssh -n -o StrictHostKeyChecking=no ${host} "${cmd.replace(/"/g, '\\"')}"`, {
      timeout: 30000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

function startNodeLocal(protocol: string, interval: number): Promise<void> {
  return new Promise((resolve) => {
    const certArgs = protocol === "http3" ? `${REMOTE_DIR}/cert.pem ${REMOTE_DIR}/key.pem` : "- -";
    const peerScheme = protocol === "http3" ? "https" : "http";
    const envFlag = protocol === "http3" ? "BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1" : "";

    try { execSync(`rm -f ${REMOTE_DIR}/node1.db ${REMOTE_DIR}/node1.db-wal ${REMOTE_DIR}/node1.db-shm`); } catch {}

    try {
      execSync(
        `screen -d -m bash -c 'SYNC_INTERVAL=${interval} ${envFlag} ${BUN} run ${REMOTE_DIR}/node.ts 1 ${PORT} ${REMOTE_DIR}/node1.db ${EXTENSION} ${certArgs} ${peerScheme}://maulana.underconst.com:${PORT} > ${REMOTE_DIR}/node1.log 2>&1'`,
        { stdio: "ignore" },
      );
    } catch {}
    setTimeout(() => resolve(), 2000);
  });
}

function startNodeRemote(protocol: string, interval: number): void {
  const certArgs = protocol === "http3" ? `${REMOTE_DIR}/cert.pem ${REMOTE_DIR}/key.pem` : "- -";
  const peerScheme = protocol === "http3" ? "https" : "http";
  const envFlag = protocol === "http3" ? "BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1" : "";

  try {
    execSync(
      `ssh -n -o StrictHostKeyChecking=no ${UNDERCONST_HOST} "screen -d -m bash -c 'cd ${REMOTE_DIR} && rm -f node2.db node2.db-wal node2.db-shm && SYNC_INTERVAL=${interval} ${envFlag} ${UNDERCONST_BUN} run node.ts 2 ${PORT} ${REMOTE_DIR}/node2.db ${EXTENSION} ${certArgs} ${peerScheme}://ovh.maulanabuilds.com:${PORT} > ${REMOTE_DIR}/node2.log 2>&1'"`,
      { stdio: "ignore", timeout: 15000 },
    );
  } catch {}
}
function killNodes(): void {
  try { execSync("fuser -k 3001/tcp 2>/dev/null; fuser -k 3001/udp 2>/dev/null; true", { stdio: "ignore" }); } catch {}
  try { execSync(`ssh -n -o StrictHostKeyChecking=no ${UNDERCONST_HOST} "screen -ls 2>/dev/null | grep -oP '\\d+\\.' | tr -d '.' | xargs -I{} screen -X -S {} quit 2>/dev/null; fuser -k ${PORT}/tcp 2>/dev/null; fuser -k ${PORT}/udp 2>/dev/null; true"`, { stdio: "ignore", timeout: 10000 }); } catch {}
}

async function healthCheck(scheme: string): Promise<boolean> {
  try {
    const isHttps = scheme === "https";
    const res = await fetch(`${scheme}://127.0.0.1:${PORT}/health`, isHttps ? { tls: { rejectUnauthorized: false } } as any : undefined);
    const data = await res.json() as { node?: number };
    return data.node !== undefined;
  } catch {
    return false;
  }
}

async function getRemoteUserCount(scheme: string): Promise<number> {
  try {
    const result = sshRun(UNDERCONST_HOST, `curl -sk ${scheme}://localhost:${PORT}/health 2>/dev/null`);
    const match = result.match(/"users":(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function writeRecords(scheme: string): Promise<number> {
  const start = Date.now();
  const promises: Promise<Response>[] = [];
  for (let i = 1; i <= NUM_WRITES; i++) {
    promises.push(
      fetch(`${scheme}://127.0.0.1:${PORT}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: i, name: `User${i}`, city: "SG" }),
        ...(scheme === "https" ? { tls: { rejectUnauthorized: false } } : {}),
      } as any).catch(() => new Response()),
    );
  }
  await Promise.all(promises);
  return Date.now() - start;
}

async function pollConvergence(scheme: string, timeoutMs: number): Promise<{ count: number; latency: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await getRemoteUserCount(scheme);
    if (count >= NUM_WRITES) {
      return { count, latency: Date.now() - start };
    }
    await sleep(100);
  }
  const count = await getRemoteUserCount(scheme);
  return { count, latency: Date.now() - start };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  cr-sqlite Config Finder — HTTP/1.1 vs HTTP/3 × 5 intervals ║");
  console.log(`║  ${NUM_WRITES} writes per config, batch propagation latency      ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");

  // Write CSV header
  const { writeFileSync, appendFileSync } = await import("node:fs");
  writeFileSync(RESULTS_CSV, "protocol,interval,batch_latency_ms,records_converged,write_ms\n");

  for (const protocol of PROTOCOLS) {
    for (const interval of INTERVALS) {
      const protoUpper = protocol.toUpperCase();
      console.log("");
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  Protocol: ${protoUpper}  |  Interval: ${interval}ms`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      killNodes();
      await sleep(1000);

      const scheme = protocol === "http3" ? "https" : "http";

      // Start nodes
      await startNodeLocal(protocol, interval);
      startNodeRemote(protocol, interval);
      console.log("  Starting nodes...");
      await sleep(3000);

      // Health check
      const localHealthy = await healthCheck(scheme);
      const remoteHealthy = sshRun(UNDERCONST_HOST, `curl -sk ${scheme}://localhost:${PORT}/health 2>/dev/null`);
      console.log(`  Health check: local=${localHealthy}, remote='${remoteHealthy}'`);

      if (!localHealthy || !remoteHealthy.includes("node")) {
        console.log("  ✗ Nodes failed — skipping");
        console.log(`    Local: ${localHealthy ? "OK" : "FAIL"}`);
        console.log(`    Remote: ${remoteHealthy || "FAIL"}`);
        appendFileSync(RESULTS_CSV, `${protocol},${interval},FAIL,0,0\n`);
        killNodes();
        continue;
      }

      console.log("  ✓ Both nodes healthy");

      // Write 50 records
      console.log(`  Writing ${NUM_WRITES} records...`);
      const writeMs = await writeRecords(scheme);
      console.log(`  Write phase: ${writeMs}ms`);

      // Poll for convergence
      console.log("  Polling Underconst for convergence...");
      const { count, latency } = await pollConvergence(scheme, 60000);

      if (count >= NUM_WRITES) {
        console.log(`  ✓ All ${count} records converged in ${latency}ms`);
      } else {
        console.log(`  ✗ Timeout: ${count}/${NUM_WRITES} converged in ${latency}ms`);
      }

      appendFileSync(RESULTS_CSV, `${protocol},${interval},${latency},${count},${writeMs}\n`);
      killNodes();
    }
  }

  killNodes();

  // Summary
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Results                                                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");

  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(RESULTS_CSV, "utf-8").trim().split("\n").slice(1);
  console.log("Protocol   Interval   Batch Lat    Converged    Write(ms)");
  console.log("-".repeat(64));
  for (const line of lines) {
    const [proto, intv, lat, conv, wms] = line.split(",");
    console.log(`${proto.padEnd(10)} ${intv}ms`.padEnd(21) + `${lat}`.padEnd(13) + `${conv}`.padEnd(13) + `${wms}`);
  }

  console.log(`\nResults: ${RESULTS_CSV}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
