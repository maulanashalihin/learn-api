import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "./router.js";

// ─── tRPC Client ────────────────────────────────────────────────
//
// MAGIC tRPC: client import AppRouter TYPE (bukan runtime value).
// TypeScript auto-infer semua procedure signatures dari server.
//
// Artinya:
//   - Full autocomplete: client.tasks.list.query() → TypeScript tahu ini ada
//   - Type-safe input: client.create.mutate({ title: 123 }) → TYPE ERROR
//   - Type-safe output: const task = client.create.mutate(...) → task: Task
//   - NO codegen, NO .proto file, NO OpenAPI spec
//
// Syarat: client & server share TypeScript types (monorepo atau shared package)

const client = createTRPCClient<AppRouter>({
	links: [
		// httpBatchLink: batch multiple requests into 1 HTTP call (automatic)
		httpBatchLink({
			url: "http://localhost:3006/trpc",
		}),
	],
});

// ─── Demo: Call all procedures ──────────────────────────────────

async function demo() {
	console.log("┌─────────────────────────────────────────────┐");
	console.log("│     tRPC Client Demo — Type-safe calls      │");
	console.log("└─────────────────────────────────────────────┘\n");

	// 1. Query: list all tasks
	// TypeScript tahu return type: Task[]
	console.log("📋 tasks.list (query):");
	const tasks = await client.tasks.list.query();
	for (const task of tasks) {
		console.log(
			`   ${task.done ? "✅" : "⬜"} [${task.id.slice(0, 8)}] ${task.title}`,
		);
	}
	console.log();

	// 2. Query: list with filter (done: false)
	// Input type-safe: { done?: boolean } — TypeScript enforce
	console.log("📋 tasks.list (filter done=false):");
	const incomplete = await client.tasks.list.query({ done: false });
	console.log(`   ${incomplete.length} incomplete task(s)\n`);

	// 3. Mutation: create task
	// Input validated by Zod: { title: string (min 1 char) }
	console.log("➕ create (mutation):");
	const created = await client.create.mutate({
		title: "Belajar tRPC type safety",
	});
	console.log(`   ✅ Created: [${created.id.slice(0, 8)}] ${created.title}`);
	console.log(
		`   (TypeScript knows: created.id is string, created.done is boolean)\n`,
	);

	// 4. Query: getById
	console.log("🔍 tasks.getById (query):");
	const fetched = await client.tasks.getById.query({ id: created.id });
	console.log(`   Found: ${fetched?.title ?? "null"}\n`);

	// 5. Mutation: update (partial — only send changed fields)
	console.log("📝 update (mutation):");
	const updated = await client.update.mutate({ id: created.id, done: true });
	console.log(`   Updated: done=${updated?.done}\n`);

	// 6. Mutation: delete
	console.log("🗑️  delete (mutation):");
	const deleted = await client.delete.mutate({ id: created.id });
	console.log(`   Deleted: ${deleted}\n`);

	// 7. Error handling: Zod validation
	console.log("❌ Error handling (Zod validation — empty title):");
	try {
		// TypeScript would catch this at compile time, but let's test runtime too
		await client.create.mutate({ title: "" });
	} catch (err) {
		console.log(
			`   Validation error caught: ${(err as Error).message.slice(0, 100)}...\n`,
		);
	}

	// 8. Error handling: task not found
	console.log("❌ Error handling (getById non-existent):");
	const notFound = await client.tasks.getById.query({ id: "nonexistent" });
	console.log(`   Result: ${notFound} (null = not found)\n`);

	console.log("✅ Demo complete!");
	console.log(
		"\n💡 Key takeaway: every call above was type-checked by TypeScript.",
	);
	console.log("   No codegen, no .proto file — just shared types.\n");
	process.exit(0);
}

demo().catch((err) => {
	console.error("Demo failed:", err);
	console.error("   Pastikan tRPC server jalan: npm run trpc");
	process.exit(1);
});
