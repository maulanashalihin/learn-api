import express from "express";
import type { Request, Response, NextFunction } from "express";
import { spawn } from "node:child_process";

// ─── API Gateway ────────────────────────────────────────────────
//
// API Gateway = single entry point untuk multiple backend services.
// Client hanya bicara dengan gateway. Gateway yang route ke service yang tepat.
//
// Tanggung jawab gateway:
//   1. Routing: /api/users/* → user-service, /api/orders/* → order-service
//   2. Auth: validasi API key sebelum forward request
//   3. Rate limiting: batasi request per client
//   4. Logging: log setiap request
//   5. Aggregation: gabungkan data dari multiple services dalam 1 response
//   6. Protocol translation: REST → gRPC, dll (tidak di demo ini)

// ─── Start backend services automatically ───────────────────────
// Di production, services jalan terpisah (Docker, Kubernetes, dll).
// Di demo ini, gateway spawn user-service dan order-service sebagai child processes.

const USER_SERVICE = "http://localhost:3011";
const ORDER_SERVICE = "http://localhost:3012";

function startService(name: string, script: string): void {
	const child = spawn("npx", ["tsx", script], {
		stdio: "pipe",
		cwd: process.cwd(),
	});
	child.stdout?.on("data", (data) => {
		const line = data.toString().trim();
		if (line) console.log(`  ${line}`);
	});
	child.stderr?.on("data", (data) => {
		console.error(`  [${name} error] ${data.toString().trim()}`);
	});
	child.on("exit", (code) => {
		console.log(`  [${name}] exited with code ${code}`);
	});
}

startService("user-service", "08-api-gateway/user-service.ts");
startService("order-service", "08-api-gateway/order-service.ts");

// ─── Gateway server ─────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Middleware 1: Request Logging ──────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
	const start = Date.now();
	res.on("finish", () => {
		const duration = Date.now() - start;
		console.log(
			`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
		);
	});
	next();
});

// ─── Middleware 2: Authentication ───────────────────────────────
// Check API key header. Di production: JWT, OAuth2, dll.
const VALID_API_KEYS = new Set(["demo-key-123", "test-key-456"]);

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
	const apiKey = req.headers["x-api-key"] as string | undefined;

	// Skip auth untuk health check
	if (req.path === "/health") {
		next();
		return;
	}

	if (!apiKey || !VALID_API_KEYS.has(apiKey)) {
		res
			.status(401)
			.json({ error: "Invalid or missing API key. Set X-Api-Key header." });
		return;
	}

	// Attach client identity untuk rate limiting
	req.headers["x-client-id"] = apiKey;
	next();
});

// ─── Middleware 3: Rate Limiting ────────────────────────────────
// Simple in-memory rate limiter: 10 requests per 10 seconds per client
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 10_000; // 10 seconds
const RATE_LIMIT_MAX = 30; // 30 requests per window (demo-friendly)

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
	if (req.path === "/health") {
		next();
		return;
	}

	const clientId = req.headers["x-client-id"] as string;
	const now = Date.now();
	let limit = rateLimitMap.get(clientId);

	if (!limit || now > limit.resetAt) {
		limit = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
		rateLimitMap.set(clientId, limit);
	}

	limit.count++;

	// Rate limit headers
	res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
	res.setHeader(
		"X-RateLimit-Remaining",
		String(Math.max(0, RATE_LIMIT_MAX - limit.count)),
	);
	res.setHeader("X-RateLimit-Reset", String(Math.ceil(limit.resetAt / 1000)));

	if (limit.count > RATE_LIMIT_MAX) {
		res.status(429).json({
			error: "Rate limit exceeded",
			retryAfter: Math.ceil((limit.resetAt - now) / 1000),
		});
		return;
	}

	next();
});

// ─── Routing: Proxy ke backend services ─────────────────────────
// Gateway forward request ke service yang tepat berdasarkan path prefix.

// /api/users/* → user-service (port 3011) /users/*
// /api/users     → /users
// /api/users/u1  → /users/u1
app.use("/api/users", async (req: Request, res: Response) => {
	const path = req.originalUrl.replace("/api/users", "/users");
	await proxyRequest(req, res, USER_SERVICE, path);
});

// /api/orders/* → order-service (port 3012) /orders/*
app.use("/api/orders", async (req: Request, res: Response) => {
	const path = req.originalUrl.replace("/api/orders", "/orders");
	await proxyRequest(req, res, ORDER_SERVICE, path);
});

// ─── Aggregation: Dashboard endpoint ────────────────────────────
// 1 request ke gateway → gateway call 2 services → gabungkan response
// Client tidak perlu tahu ada 2 service di belakang
app.get("/api/dashboard", async (req: Request, res: Response) => {
	try {
		const apiKey = req.headers["x-api-key"] as string;

		// Parallel calls ke 2 services
		const [usersResp, ordersResp] = await Promise.all([
			fetch(`${USER_SERVICE}/users`, { headers: { "X-Api-Key": apiKey } }),
			fetch(`${ORDER_SERVICE}/orders`, { headers: { "X-Api-Key": apiKey } }),
		]);

		const users = (await usersResp.json()) as {
			id: string;
			name: string;
			email: string;
		}[];
		const orders = (await ordersResp.json()) as {
			id: string;
			userId: string;
			product: string;
			amount: number;
			status: string;
		}[];

		// Aggregate: group orders by user
		const dashboard = users.map((user) => ({
			...user,
			orders: orders.filter((o) => o.userId === user.id),
			totalSpent: orders
				.filter((o) => o.userId === user.id)
				.reduce((sum, o) => sum + o.amount, 0),
		}));

		res.json({
			totalUsers: users.length,
			totalOrders: orders.length,
			totalRevenue: orders.reduce((sum, o) => sum + o.amount, 0),
			users: dashboard,
		});
	} catch (err) {
		res
			.status(502)
			.json({
				error: "Failed to aggregate data from backend services",
				detail: (err as Error).message,
			});
	}
});

// Health check (no auth)
app.get("/api/health", (_req: Request, res: Response) => {
	res.json({ status: "ok", services: ["user-service", "order-service"] });
});

// ─── Proxy function ─────────────────────────────────────────────
// Forward request ke backend service, return response ke client
async function proxyRequest(
	req: Request,
	res: Response,
	targetBase: string,
	path: string,
): Promise<void> {
	try {
		const url = `${targetBase}${path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (req.headers["x-api-key"]) {
			headers["X-Api-Key"] = req.headers["x-api-key"] as string;
		}

		const response = await fetch(url, {
			method: req.method,
			headers,
			body: ["GET", "HEAD"].includes(req.method)
				? undefined
				: JSON.stringify(req.body),
			signal: AbortSignal.timeout(5000),
		});

		const data = await response.text();
		res.status(response.status);
		// Forward service identifier header
		const serviceHeader = response.headers.get("X-Service");
		if (serviceHeader) res.setHeader("X-Served-By", serviceHeader);
		res.send(data || undefined);
	} catch (err) {
		res.status(502).json({
			error: `Backend service unavailable: ${(err as Error).message}`,
		});
	}
}

// ─── Start gateway ──────────────────────────────────────────────
const PORT = 3007;
app.listen(PORT, () => {
	console.log(`\n🟢 API Gateway running at http://localhost:${PORT}`);
	console.log(`   Routes:`);
	console.log(`     /api/users/*  → user-service (port 3011)`);
	console.log(`     /api/orders/* → order-service (port 3012)`);
	console.log(`     /api/dashboard → aggregated (users + orders)`);
	console.log(`     /api/health    → health check (no auth)`);
	console.log(`   Auth: X-Api-Key header (try: demo-key-123)`);
	console.log(`   Docs: see 08-api-gateway/README.md\n`);
});
