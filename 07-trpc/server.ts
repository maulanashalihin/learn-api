import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";

// ─── tRPC Server (Express adapter) ──────────────────────────────
//
// tRPC server = Express app dengan tRPC middleware di /trpc endpoint.
// Semua procedures di appRouter accessible via:
//   POST /trpc/tasks.list        → query
//   POST /trpc/create            → mutation
//   GET  /trpc/tasks.list        → query (GET juga support untuk simple queries)

const app = express();
app.use(express.json());

// Context function — dipanggil setiap request
// Di production: parse auth header, load user session, attach db connection
function createContext() {
	return {
		userId: null as string | null, // demo: no auth
	};
}

// Mount tRPC middleware
app.use(
	"/trpc",
	createExpressMiddleware({
		router: appRouter,
		createContext,
	}),
);

// Health check
app.get("/", (_req, res) => {
	res.json({
		status: "ok",
		trpc: "/trpc",
		procedures: ["tasks.list", "tasks.getById", "create", "update", "delete"],
	});
});

const PORT = 3006;
app.listen(PORT, () => {
	console.log(`\n🟢 tRPC Server running at http://localhost:${PORT}`);
	console.log(`   Endpoint: http://localhost:${PORT}/trpc`);
	console.log(`   Client:   npm run trpc:client`);
	console.log(`   Docs: see 07-trpc/README.md\n`);
});
