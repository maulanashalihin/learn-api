import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { generateId } from "../shared/types.js";

// ─── tRPC Router Definition ─────────────────────────────────────
//
// tRPC = TypeScript RPC. Beda dengan gRPC (protobuf) atau REST (JSON),
// tRPC pakai TypeScript types sebagai schema. NO codegen, NO .proto file.
//
// Konsep inti:
//   - Router = kumpulan procedures (seperti endpoints)
//   - Procedure = function dengan input validation + typed output
//   - 3 jenis procedure: query (read), mutation (write), subscription (stream)
//   - Type safety end-to-end: server types auto-flow ke client via AppRouter type

// Context = data yang tersedia di setiap procedure (mis. user session, db)
interface Context {
	// Di production: user session, db connection, dll
	userId: string | null;
}

const t = initTRPC.context<Context>().create();

// ─── In-memory store ────────────────────────────────────────────
interface Task {
	id: string;
	title: string;
	done: boolean;
	createdAt: string;
}

const taskStore = new Map<string, Task>();

// Seed
for (const title of [
	"Belajar tRPC",
	"Belajar API Gateway",
	"Belajar WebSockets",
]) {
	const id = generateId();
	taskStore.set(id, {
		id,
		title,
		done: false,
		createdAt: new Date().toISOString(),
	});
}

// ─── Router: tasks ──────────────────────────────────────────────
// Setiap procedure:
//   .input(zodSchema) = validate input, type inferred otomatis
//   .query(handler)    = read operation (seperti GET)
//   .mutation(handler) = write operation (seperti POST/PUT/DELETE)

export const appRouter = t.router({
	// Query: list tasks (optional filter by done)
	tasks: t.router({
		list: t.procedure
			.input(z.object({ done: z.boolean().optional() }).optional())
			.query(({ input }) => {
				const tasks = [...taskStore.values()];
				if (input?.done === undefined) return tasks;
				return tasks.filter((t) => t.done === input.done);
			}),

		// Query: get single task by ID
		getById: t.procedure
			.input(z.object({ id: z.string().min(1) }))
			.query(({ input }) => {
				const task = taskStore.get(input.id);
				if (!task) return null;
				return task;
			}),
	}),

	// Mutation: create task
	create: t.procedure
		.input(z.object({ title: z.string().min(1, "Title is required") }))
		.mutation(({ input, ctx }) => {
			const task: Task = {
				id: generateId(),
				title: input.title.trim(),
				done: false,
				createdAt: new Date().toISOString(),
			};
			taskStore.set(task.id, task);
			console.log(`✅ Created by ${ctx.userId ?? "anonymous"}: ${task.title}`);
			return task;
		}),

	// Mutation: update task (partial)
	update: t.procedure
		.input(
			z.object({
				id: z.string().min(1),
				title: z.string().min(1).optional(),
				done: z.boolean().optional(),
			}),
		)
		.mutation(({ input }) => {
			const existing = taskStore.get(input.id);
			if (!existing) return null;

			const updated: Task = { ...existing };
			if (input.title !== undefined) updated.title = input.title.trim();
			if (input.done !== undefined) updated.done = input.done;

			taskStore.set(input.id, updated);
			return updated;
		}),

	// Mutation: delete task
	delete: t.procedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(({ input }) => {
			return taskStore.delete(input.id);
		}),
});

// ─── Export AppRouter TYPE (bukan value) ────────────────────────
// Ini adalah magic tRPC: client import type ini untuk dapat
// full TypeScript autocomplete dan type checking.
//
// type AppRouter = typeof appRouter
// Client: const client = createTRPCClient<AppRouter>({ ... })
// → client.tasks.list.query() → TypeScript tahu return type-nya Task[]

export type AppRouter = typeof appRouter;
