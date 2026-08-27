// ─── User Service (Backend Microservice) ────────────────────────
//
// Service ini hanya peduli tentang users. Tidak tahu tentang orders.
// Ini prinsip microservice: single responsibility + independent deployability.
//
// Fitur:
//   - GET /users/:id   → return user (atau 500 kalau fail mode aktif)
//   - GET /health      → health check
//   - POST /control/fail    → toggle fail mode ON (simulasi service bermasalah)
//   - POST /control/healthy → toggle fail mode OFF
//   - Register ke ServiceRegistry + kirim heartbeat periodic
//   - Participate in distributed tracing (extract headers → create span → end span)

import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import type { ServiceRegistry } from "./service-registry.js";
import type { Tracer, SpanContext } from "./tracing.js";

interface User {
	id: string;
	name: string;
	email: string;
}

// In-memory data store. Di production: PostgreSQL per service.
const users = new Map<string, User>();
users.set("u1", { id: "u1", name: "Alice", email: "alice@example.com" });
users.set("u2", { id: "u2", name: "Bob", email: "bob@example.com" });
users.set("u3", { id: "u3", name: "Charlie", email: "charlie@example.com" });

// Flag untuk simulasi kegagalan. Di-toggle via control endpoint atau export.
let failMode = false;

/** Toggle fail mode dari luar (dipakai demo.ts, same-process). */
export function setUserFailMode(enabled: boolean): void {
	failMode = enabled;
	console.log(
		`  [user-service] fail mode ${enabled ? "ENABLED — /users/:id will return 500" : "DISABLED — healthy"}`,
	);
}

export function startUserService(
	registry: ServiceRegistry,
	tracer: Tracer,
	port: number,
): Promise<Server> {
	const app = express();
	app.use(express.json());

	// Set service identity header
	app.use((_req, res, next) => {
		res.setHeader("X-Service", "user-service");
		next();
	});

	// ── GET /users/:id ──
	app.get("/users/:id", (req: Request, res: Response) => {
		// Extract trace context dari incoming headers (propagated oleh caller)
		const parentCtx = tracer.extract(req.headers);
		const spanCtx = tracer.startSpan(
			"user-service",
			`GET /users/${req.params.id}`,
			parentCtx ?? undefined,
		);
		res.setHeader("X-Trace-Id", spanCtx.traceId);

		// Simulasi kegagalan: fail mode global ATAU ?fail=true query param
		const shouldFail = failMode || req.query.fail === "true";
		if (shouldFail) {
			tracer.endSpan(spanCtx, "ERROR");
			res.status(500).json({
				error: "Simulated failure (fail mode active)",
				traceId: spanCtx.traceId,
			});
			return;
		}

		const user = users.get(req.params.id);
		if (!user) {
			tracer.endSpan(spanCtx, "ERROR");
			res.status(404).json({
				error: "User not found",
				traceId: spanCtx.traceId,
			});
			return;
		}

		tracer.endSpan(spanCtx, "OK");
		res.json(user);
	});

	// ── GET /health ──
	app.get("/health", (req: Request, res: Response) => {
		const parentCtx = tracer.extract(req.headers);
		const spanCtx = tracer.startSpan(
			"user-service",
			"GET /health",
			parentCtx ?? undefined,
		);
		tracer.endSpan(spanCtx, "OK");
		res.json({
			status: "ok",
			service: "user-service",
			failMode,
			timestamp: new Date().toISOString(),
		});
	});

	// ── Control endpoints (untuk demo) ──
	app.post("/control/fail", (_req: Request, res: Response) => {
		failMode = true;
		res.json({ status: "fail mode enabled" });
	});

	app.post("/control/healthy", (_req: Request, res: Response) => {
		failMode = false;
		res.json({ status: "fail mode disabled" });
	});

	return new Promise((resolve) => {
		const server = app.listen(port, () => {
			const url = `http://localhost:${port}`;
			registry.register("user-service", url);
			console.log(`  └─ User Service running on port ${port}`);

			// Heartbeat ke registry tiap 2 detik
			const hb = setInterval(() => {
				registry.heartbeat("user-service", url);
			}, 2_000);
			hb.unref();

			resolve(server);
		});
	});
}
