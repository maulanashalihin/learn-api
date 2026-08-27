// ─── Order Service (Microservice yang call service lain) ────────
//
// Service ini peduli tentang orders. Untuk enrich order dengan user data,
// dia call user-service. Tapi ia TIDAK hardcode URL user-service —
// ia discover via ServiceRegistry.
//
// Saat call user-service, ia pakai CircuitBreaker (stop kalau user-service down)
// dan propagate Trace ID (supaya trace tree nyambung antar service).
//
//   Client → GET /orders/o1
//           → order-service start root span
//           → order-service discover("user-service") dari registry
//           → order-service breaker.call(() => fetch user-service)  ← circuit breaker
//           → user-service extract trace, start child span, return user
//           → order-service enrich order + user, return
//           → trace tree: order-service → user-service (parent-child)

import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import type { ServiceRegistry } from "./service-registry.js";
import type { Tracer, SpanContext } from "./tracing.js";
import { type CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

interface Order {
	id: string;
	userId: string;
	items: string[];
	total: number;
}

interface User {
	id: string;
	name: string;
	email: string;
}

interface EnrichedOrder extends Order {
	user: User | null;
}

// In-memory data store
const orders = new Map<string, Order>();
orders.set("o1", {
	id: "o1",
	userId: "u1",
	items: ["Laptop", "Mouse"],
	total: 1200,
});
orders.set("o2", { id: "o2", userId: "u2", items: ["Keyboard"], total: 80 });
orders.set("o3", {
	id: "o3",
	userId: "u3",
	items: ["Monitor", "Cable"],
	total: 350,
});

export function startOrderService(
	registry: ServiceRegistry,
	tracer: Tracer,
	breaker: CircuitBreaker,
	port: number,
): Promise<Server> {
	const app = express();
	app.use(express.json());

	app.use((_req, res, next) => {
		res.setHeader("X-Service", "order-service");
		next();
	});

	// ── GET /orders/:id — enrich dengan user data dari user-service ──
	app.get("/orders/:id", async (req: Request, res: Response) => {
		const order = orders.get(req.params.id);
		if (!order) {
			res.status(404).json({ error: "Order not found" });
			return;
		}

		// Start root span (atau child span kalau ada incoming trace context)
		const parentCtx = tracer.extract(req.headers);
		const rootCtx = tracer.startSpan(
			"order-service",
			`GET /orders/${req.params.id}`,
			parentCtx ?? undefined,
		);
		res.setHeader("X-Trace-Id", rootCtx.traceId);

		let callCtx: SpanContext | null = null;

		try {
			// Service discovery: cari URL user-service dari registry
			const userUrl = registry.discover("user-service");
			if (!userUrl) {
				throw new Error("user-service not found in registry");
			}

			// Start span untuk cross-service call
			callCtx = tracer.startSpan(
				"order-service",
				"call user-service (via circuit breaker)",
				rootCtx,
			);

			// Propagate trace context ke user-service via HTTP headers
			const traceHeaders = tracer.propagate(callCtx);

			// Call user-service MELALUI circuit breaker
			// Breaker akan: allow (CLOSED), fast-fail (OPEN), atau test (HALF_OPEN)
			const user = await breaker.call(async () => {
				const resp = await fetch(`${userUrl}/users/${order.userId}`, {
					headers: traceHeaders,
				});
				if (!resp.ok) {
					throw new Error(`user-service returned HTTP ${resp.status}`);
				}
				return (await resp.json()) as User;
			});

			// Sukses — end spans, return enriched order
			tracer.endSpan(callCtx, "OK");
			tracer.endSpan(rootCtx, "OK");

			const enriched: EnrichedOrder = { ...order, user };
			res.json({
				...enriched,
				circuitBreakerState: breaker.state,
				traceId: rootCtx.traceId,
			});
		} catch (error) {
			// End spans dengan ERROR
			if (callCtx) tracer.endSpan(callCtx, "ERROR");
			tracer.endSpan(rootCtx, "ERROR");

			if (error instanceof CircuitOpenError) {
				// Circuit breaker OPEN → fast-fail, tidak call user-service sama sekali
				// Fallback: return order tanpa user data (graceful degradation)
				const partial: EnrichedOrder = { ...order, user: null };
				res.status(503).json({
					error:
						"User service unavailable — circuit breaker OPEN (fast-fail, no call made)",
					order: partial,
					circuitBreakerState: breaker.state,
					traceId: rootCtx.traceId,
				});
			} else {
				// Actual call failure (user-service return 500, connection refused, dll)
				const partial: EnrichedOrder = { ...order, user: null };
				res.status(502).json({
					error: `Failed to fetch user: ${(error as Error).message}`,
					order: partial,
					circuitBreakerState: breaker.state,
					traceId: rootCtx.traceId,
				});
			}
		}
	});

	// ── GET /orders — list semua order (tanpa enrich) ──
	app.get("/orders", (req: Request, res: Response) => {
		const parentCtx = tracer.extract(req.headers);
		const spanCtx = tracer.startSpan(
			"order-service",
			"GET /orders",
			parentCtx ?? undefined,
		);
		tracer.endSpan(spanCtx, "OK");
		res.setHeader("X-Trace-Id", spanCtx.traceId);
		res.json([...orders.values()]);
	});

	// ── GET /health ──
	app.get("/health", (req: Request, res: Response) => {
		const parentCtx = tracer.extract(req.headers);
		const spanCtx = tracer.startSpan(
			"order-service",
			"GET /health",
			parentCtx ?? undefined,
		);
		tracer.endSpan(spanCtx, "OK");
		res.json({
			status: "ok",
			service: "order-service",
			circuitBreaker: breaker.getStats(),
			timestamp: new Date().toISOString(),
		});
	});

	return new Promise((resolve) => {
		const server = app.listen(port, () => {
			const url = `http://localhost:${port}`;
			registry.register("order-service", url);
			console.log(`  └─ Order Service running on port ${port}`);

			const hb = setInterval(() => {
				registry.heartbeat("order-service", url);
			}, 2_000);
			hb.unref();

			resolve(server);
		});
	});
}
