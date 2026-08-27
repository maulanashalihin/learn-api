import express from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import type { Request, Response } from "express";
import {
	taskStore,
	seedTasks,
	generateId,
	type Task,
} from "../shared/types.js";

// ─── GraphQL Schema (Type Definitions) ──────────────────────────
// Schema = kontrak. Mendefinisikan:
//   - Tipe data apa yang ada (Task)
//   - Query apa yang bisa client panggil (read)
//   - Mutation apa yang bisa client panggil (write)
//
// Beda dengan REST yang URL = resource,
// GraphQL punya SINGLE endpoint (/graphql) dan client
// menentukan APA yang dia mau via query language.

const typeDefs = /* GraphQL */ `
  type Task {
    id: ID!
    title: String!
    done: Boolean!
    createdAt: String!
  }

  input NewTaskInput {
    title: String!
  }

  input UpdateTaskInput {
    title: String
    done: Boolean
  }

  type Query {
    # Ambil semua task. Optional filter by done.
    tasks(done: Boolean): [Task!]!

    # Ambil satu task by ID.
    task(id: ID!): Task
  }

  type Mutation {
    # Buat task baru. Return task yang baru dibuat.
    createTask(input: NewTaskInput!): Task!

    # Update task (partial). Return task yang diupdate.
    updateTask(id: ID!, input: UpdateTaskInput!): Task

    # Hapus task. Return true jika sukses.
    deleteTask(id: ID!): Boolean!
  }
`;

// ─── Resolvers ──────────────────────────────────────────────────
// Resolver = function yang mengisi data untuk setiap field di schema.
// Setiap field di schema punya resolver.
// Kalau gak ada resolver eksplisit, GraphQL default-nya baca property
// dari parent object (default field resolver).
//
// Signature: (parent, args, context, info) => result

const resolvers = {
	Query: {
		// args = argument dari query, mis. { done: true }
		tasks: (_parent: unknown, args: { done?: boolean }): Task[] => {
			const tasks = [...taskStore.values()];
			if (args.done === undefined) return tasks;
			return tasks.filter((t) => t.done === args.done);
		},

		// args = { id: "..." }
		task: (_parent: unknown, args: { id: string }): Task | null => {
			return taskStore.get(args.id) ?? null;
		},
	},

	Mutation: {
		createTask: (
			_parent: unknown,
			args: { input: { title: string } },
		): Task => {
			const task: Task = {
				id: generateId(),
				title: args.input.title.trim(),
				done: false,
				createdAt: new Date().toISOString(),
			};
			taskStore.set(task.id, task);
			return task;
		},

		updateTask: (
			_parent: unknown,
			args: { id: string; input: { title?: string; done?: boolean } },
		): Task | null => {
			const existing = taskStore.get(args.id);
			if (!existing) return null;

			const updated: Task = { ...existing };
			if (typeof args.input.title === "string")
				updated.title = args.input.title.trim();
			if (typeof args.input.done === "boolean") updated.done = args.input.done;

			taskStore.set(args.id, updated);
			return updated;
		},

		deleteTask: (_parent: unknown, args: { id: string }): boolean => {
			return taskStore.delete(args.id);
		},
	},
};

// ─── Start server ───────────────────────────────────────────────
async function start() {
	seedTasks();

	const app = express();
	app.use(express.json());

	const apollo = new ApolloServer({ typeDefs, resolvers });
	await apollo.start();

	// Mount GraphQL endpoint di /graphql
	app.use("/graphql", expressMiddleware(apollo));

	// Health check
	app.get("/", (_req: Request, res: Response) => {
		res.json({ status: "ok", graphql: "/graphql" });
	});

	const PORT = 3002;
	app.listen(PORT, () => {
		console.log(`\n🔵 GraphQL API running at http://localhost:${PORT}/graphql`);
		console.log(`   Try: curl -X POST http://localhost:${PORT}/graphql \\`);
		console.log(`        -H 'Content-Type: application/json' \\`);
		console.log(`        -d '{"query":"{ tasks { id title done } }"}'`);
		console.log(`   Docs: see 02-graphql/README.md\n`);
	});
}

start();
