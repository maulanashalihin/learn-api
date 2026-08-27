// ─── Demo: Microservices in Action ──────────────────────────────
//
// Demo ini menjalankan user-service + order-service dalam 1 process
// (di production: 2 process terpisah, 2 container, 2 pod).
//
// Flow:
//   Phase 1: Normal — order-service call user-service, breaker CLOSED, trace OK
//   Phase 2: Failures — user-service return 500, breaker trips CLOSED → OPEN
//   Phase 3: Fast-fail — breaker OPEN, order-service return 503 tanpa call
//   Phase 4: Recovery — user-service healthy, breaker HALF_OPEN → CLOSED
//
// Jalankan: npx tsx 12-microservices/demo.ts

import { ServiceRegistry } from "./service-registry.js";
import {
	CircuitBreaker,
	type CircuitState,
	type Transition,
} from "./circuit-breaker.js";
import { Tracer } from "./tracing.js";
import { startUserService, setUserFailMode } from "./user-service.js";
import { startOrderService } from "./order-service.js";
import type { Server } from "node:http";

// ── Constants ──
const USER_PORT = 3021;
const ORDER_PORT = 3022;
const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS = 5_000;
const SUCCESS_THRESHOLD = 2;

const BANNER = "═".repeat(67);
const PHASE = "─".repeat(67);

// ── Helpers ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function logBreaker(breaker: CircuitBreaker): void {
	const s = breaker.getStats();
	const failInfo =
		s.state === "CLOSED"
			? `failures: ${s.failureCount}/${FAILURE_THRESHOLD}`
			: s.state === "HALF_OPEN"
				? `successes: ${s.successCount}/${SUCCESS_THRESHOLD}`
				: `last failure: ${s.lastFailureTime ? `${Date.now() - s.lastFailureTime}ms ago` : "n/a"}`;
	console.log(`  🔧 Circuit Breaker: ${s.state} (${failInfo})`);
}

function logTransition(t: Transition, startTime: number): void {
	const elapsed = ((t.at - startTime) / 1000).toFixed(1);
	console.log(
		`  ⚡ TRANSITION: ${t.from} → ${t.to} (+${elapsed}s) — ${t.reason}`,
	);
}

interface OrderResponse {
	id?: string;
	userId?: string;
	items?: string[];
	total?: number;
	user: { id: string; name: string; email: string } | null;
	circuitBreakerState: CircuitState;
	traceId: string;
	error?: string;
	order?: {
		id: string;
		userId: string;
		items: string[];
		total: number;
		user: { id: string; name: string; email: string } | null;
	};
}

async function callOrder(
	orderId: string,
	label: string,
	breaker: CircuitBreaker,
	tracer: Tracer,
): Promise<OrderResponse | null> {
	const url = `http://localhost:${ORDER_PORT}/orders/${orderId}`;
	const start = Date.now();
	console.log(`\n▸ ${label}`);
	console.log(`  → GET ${url}`);

	try {
		const resp = await fetch(url);
		const body = (await resp.json()) as OrderResponse;
		const elapsed = Date.now() - start;

		if (resp.ok) {
			console.log(`  ← ${resp.status} OK (${elapsed}ms)`);
			console.log(
				`    order: ${body.id}, user: ${body.user?.name ?? "null"}, items: [${body.items?.join(", ") ?? ""}]`,
			);
		} else {
			// Error responses nest the order under body.order (fallback data)
			const ord = body.order;
			console.log(`  ← ${resp.status} (${elapsed}ms)`);
			console.log(`    error: ${body.error ?? "unknown"}`);
			console.log(
				`    order: ${ord?.id ?? "?"}, user: ${ord?.user?.name ?? "null (fallback)"}, items: [${ord?.items.join(", ") ?? ""}]`,
			);
		}

		logBreaker(breaker);
		console.log(`  📊 Trace ID: ${body.traceId.slice(0, 8)}`);
		tracer.printTraceTree(body.traceId);
		return body;
	} catch (err) {
		console.log(`  ✗ Request failed: ${(err as Error).message}`);
		return null;
	}
}

// ── Main ──
async function main(): Promise<void> {
	const demoStart = Date.now();

	console.log(
		"\n╔═══════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  12 — Microservices: Service Discovery, Circuit Breaker,     ║",
	);
	console.log(
		"║       & Distributed Tracing                                  ║",
	);
	console.log(
		"╚═══════════════════════════════════════════════════════════════╝\n",
	);

	// ── Create shared infrastructure ──
	const registry = new ServiceRegistry(15_000);
	registry.startHealthCheck(5_000);

	const tracer = new Tracer();

	const breaker = new CircuitBreaker(
		"user-service-breaker",
		{
			failureThreshold: FAILURE_THRESHOLD,
			resetTimeoutMs: RESET_TIMEOUT_MS,
			successThreshold: SUCCESS_THRESHOLD,
		},
		(t) => logTransition(t, demoStart),
	);

	// ── Start services ──
	console.log("▸ Starting services...\n");
	const userServer = await startUserService(registry, tracer, USER_PORT);
	const orderServer = await startOrderService(
		registry,
		tracer,
		breaker,
		ORDER_PORT,
	);

	// Wait for services to be ready
	await sleep(500);

	// ── Show service registry ──
	console.log("\n▸ Service Registry (service discovery):\n");
	const services = registry.list();
	console.log(
		"  ┌────────────────┬───────────────────────────┬──────────┬────────────────┐",
	);
	console.log(
		"  │ Service        │ URL                       │ Health   │ Last Heartbeat │",
	);
	console.log(
		"  ├────────────────┼───────────────────────────┼──────────┼────────────────┤",
	);
	for (const s of services) {
		const health = s.healthy ? "healthy  " : "UNHEALTHY";
		const hb = `${(s.lastHeartbeatMs / 1000).toFixed(1)}s ago`;
		console.log(
			`  │ ${s.name.padEnd(14)} │ ${s.url.padEnd(25)} │ ${health} │ ${hb.padEnd(14)} │`,
		);
	}
	console.log(
		"  └────────────────┴───────────────────────────┴──────────┴────────────────┘",
	);

	// ═══════════════════════════════════════════════════════════════
	// PHASE 1: Normal Flow
	// ═══════════════════════════════════════════════════════════════
	console.log(`\n${BANNER}`);
	console.log("  PHASE 1: Normal Flow (Circuit Breaker: CLOSED)");
	console.log(`${BANNER}`);
	console.log(
		"  order-service calls user-service → gets user data → enriches order",
	);
	console.log(
		"  Circuit breaker CLOSED, trace spans logged across services.\n",
	);

	await callOrder("o1", "Request 1 — normal flow", breaker, tracer);

	// ═══════════════════════════════════════════════════════════════
	// PHASE 2: Simulate Failures
	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  PHASE 2: Simulate Failures (Circuit Breaker: CLOSED → OPEN)");
	console.log(`${BANNER}`);
	console.log(`  user-service set to FAIL mode. Each call returns 500.`);
	console.log(
		`  After ${FAILURE_THRESHOLD} failures, circuit breaker trips to OPEN.\n`,
	);

	console.log("▸ Toggling user-service to FAIL mode...\n");
	setUserFailMode(true);

	await callOrder("o1", `Request 2 — failure #1`, breaker, tracer);
	await callOrder("o1", `Request 3 — failure #2`, breaker, tracer);
	await callOrder(
		"o1",
		`Request 4 — failure #3 (threshold reached!)`,
		breaker,
		tracer,
	);

	// ═══════════════════════════════════════════════════════════════
	// PHASE 3: Fast-Fail
	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  PHASE 3: Fast-Fail (Circuit Breaker: OPEN)");
	console.log(`${BANNER}`);
	console.log("  Breaker is OPEN — order-service returns 503 IMMEDIATELY");
	console.log(
		"  without calling user-service. Note the response time (<5ms vs ~10ms).\n",
	);

	await callOrder(
		"o1",
		"Request 5 — fast-fail (no call to user-service)",
		breaker,
		tracer,
	);
	await callOrder("o1", "Request 6 — fast-fail again", breaker, tracer);

	// ═══════════════════════════════════════════════════════════════
	// PHASE 4: Recovery
	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log(
		"  PHASE 4: Recovery (Circuit Breaker: OPEN → HALF_OPEN → CLOSED)",
	);
	console.log(`${BANNER}`);
	console.log(
		`  user-service set back to HEALTHY. Waiting ${RESET_TIMEOUT_MS / 1000}s`,
	);
	console.log("  for circuit breaker reset timeout → HALF_OPEN (test call).\n");

	console.log("▸ Toggling user-service back to HEALTHY mode...\n");
	setUserFailMode(false);

	console.log(`▸ Waiting ${RESET_TIMEOUT_MS / 1000}s for reset timeout...\n`);
	await sleep(RESET_TIMEOUT_MS + 200);

	await callOrder(
		"o1",
		`Request 7 — HALF_OPEN test call (need ${SUCCESS_THRESHOLD} successes)`,
		breaker,
		tracer,
	);

	await callOrder(
		"o1",
		`Request 8 — HALF_OPEN test call #2 (success threshold reached!)`,
		breaker,
		tracer,
	);

	// ═══════════════════════════════════════════════════════════════
	// Summary: Circuit Breaker Transitions
	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  Circuit Breaker State Transitions (full history)");
	console.log(`${BANNER}\n`);

	const transitions = breaker.getStats().transitions;
	console.log("  #  Time     From        → To         Reason");
	console.log(
		"  ─  ───────  ──────────    ─────────   ──────────────────────────────────────",
	);
	for (let i = 0; i < transitions.length; i++) {
		const t = transitions[i];
		const elapsed = ((t.at - demoStart) / 1000).toFixed(1);
		console.log(
			`  ${i + 1}  +${elapsed}s  ${t.from.padEnd(10)} → ${t.to.padEnd(10)} ${t.reason}`,
		);
	}

	// ═══════════════════════════════════════════════════════════════
	// Summary: All Trace Trees
	// ═══════════════════════════════════════════════════════════════
	console.log(`\n\n${BANNER}`);
	console.log("  All Trace Trees (distributed tracing across services)");
	console.log(`${BANNER}\n`);

	const traceIds = tracer.getTraceIds();
	for (let i = 0; i < traceIds.length; i++) {
		console.log(`\n  Trace #${i + 1}:`);
		tracer.printTraceTree(traceIds[i]);
	}

	// ── Final registry state ──
	console.log(`\n\n${BANNER}`);
	console.log("  Final Service Registry State");
	console.log(`${BANNER}\n`);
	const finalServices = registry.list();
	for (const s of finalServices) {
		console.log(
			`  ${s.name}: ${s.url} — ${s.healthy ? "healthy" : "UNHEALTHY"} (heartbeat ${(s.lastHeartbeatMs / 1000).toFixed(1)}s ago)`,
		);
	}

	console.log(
		"\n\n╔═══════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  ✓ Demo complete.                                             ║",
	);
	console.log(
		"║  Key takeaways:                                               ║",
	);
	console.log(
		"║  • Service Registry: discover services without hardcoding URL ║",
	);
	console.log(
		"║  • Circuit Breaker: prevent cascading failures, fail fast     ║",
	);
	console.log(
		"║  • Distributed Tracing: follow requests across services       ║",
	);
	console.log(
		"╚═══════════════════════════════════════════════════════════════╝\n",
	);

	// Cleanup
	registry.stop();
	userServer.close();
	orderServer.close();
	process.exit(0);
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
