import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateId } from "../shared/types.js";

// ─── gRPC Server ────────────────────────────────────────────────
//
// gRPC server = implementasi service yang didefinisikan di .proto file.
// Beda dengan Express (HTTP), gRPC pakai HTTP/2 + Protocol Buffers.
//
// Langkah:
//   1. Load .proto file → dapat service definition
//   2. Implement setiap RPC method
//   3. Bind server ke port
//   4. Start server

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "task.proto");

// Load proto definition
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
});

// Cast ke any karena grpc-js types gak fully typed untuk dynamic proto loading
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

// In-memory store (sama seperti modul lain)
const taskStore = new Map<
	string,
	{ id: string; title: string; done: boolean; created_at: string }
>();

// Seed data
for (const title of ["Belajar gRPC", "Belajar tRPC", "Belajar API Gateway"]) {
	const id = generateId();
	taskStore.set(id, {
		id,
		title,
		done: false,
		created_at: new Date().toISOString(),
	});
}

// ─── Implement TaskService ──────────────────────────────────────
// Setiap method: (call, callback) untuk unary, (call) untuk streaming
// call.request = parsed protobuf message
// callback(error, response) = return result

const taskService = {
	// Unary RPC: CreateTask
	CreateTask(
		call: grpc.ServerUnaryCall<
			{ title: string },
			{ id: string; title: string; done: boolean; created_at: string }
		>,
		callback: grpc.sendUnaryData<{
			id: string;
			title: string;
			done: boolean;
			created_at: string;
		}>,
	) {
		const title = call.request.title?.trim();
		if (!title) {
			callback({
				code: grpc.status.INVALID_ARGUMENT,
				message: "title is required",
			} as grpc.ServiceError);
			return;
		}

		const id = generateId();
		const task = {
			id,
			title,
			done: false,
			created_at: new Date().toISOString(),
		};
		taskStore.set(id, task);
		console.log(`✅ Created: ${title}`);
		callback(null, task);
	},

	// Unary RPC: GetTask
	GetTask(
		call: grpc.ServerUnaryCall<
			{ id: string },
			{ id: string; title: string; done: boolean; created_at: string }
		>,
		callback: grpc.sendUnaryData<{
			id: string;
			title: string;
			done: boolean;
			created_at: string;
		}>,
	) {
		const task = taskStore.get(call.request.id);
		if (!task) {
			callback({
				code: grpc.status.NOT_FOUND,
				message: "Task not found",
			} as grpc.ServiceError);
			return;
		}
		callback(null, task);
	},

	// Unary RPC: UpdateTask
	UpdateTask(
		call: grpc.ServerUnaryCall<
			{ id: string; title: string; done: boolean },
			{ id: string; title: string; done: boolean; created_at: string }
		>,
		callback: grpc.sendUnaryData<{
			id: string;
			title: string;
			done: boolean;
			created_at: string;
		}>,
	) {
		const existing = taskStore.get(call.request.id);
		if (!existing) {
			callback({
				code: grpc.status.NOT_FOUND,
				message: "Task not found",
			} as grpc.ServiceError);
			return;
		}

		const updated = {
			...existing,
			title: call.request.title || existing.title,
			done: call.request.done,
		};
		taskStore.set(call.request.id, updated);
		console.log(`📝 Updated: ${updated.title}`);
		callback(null, updated);
	},

	// Unary RPC: DeleteTask
	DeleteTask(
		call: grpc.ServerUnaryCall<{ id: string }, { success: boolean }>,
		callback: grpc.sendUnaryData<{ success: boolean }>,
	) {
		const deleted = taskStore.delete(call.request.id);
		if (!deleted) {
			callback({
				code: grpc.status.NOT_FOUND,
				message: "Task not found",
			} as grpc.ServiceError);
			return;
		}
		console.log(`🗑️  Deleted: ${call.request.id}`);
		callback(null, { success: true });
	},

	// Server Streaming RPC: ListTasks
	// Server kirim setiap Task sebagai stream message
	ListTasks(
		call: grpc.ServerWritableStream<
			{ done: boolean },
			{ id: string; title: string; done: boolean; created_at: string }
		>,
	) {
		const doneFilter = call.request.done;
		const tasks = [...taskStore.values()];

		for (const task of tasks) {
			if (doneFilter !== undefined && task.done !== doneFilter) continue;
			call.write(task); // kirim setiap task sebagai stream message
		}

		call.end(); // signal: stream selesai
		console.log(`📋 Listed ${tasks.length} task(s)`);
	},
};

// ─── Start gRPC server ──────────────────────────────────────────
const server = new grpc.Server();
server.addService(proto.taskapi.TaskService.service, taskService);

const PORT = 50051;
server.bindAsync(
	`0.0.0.0:${PORT}`,
	grpc.ServerCredentials.createInsecure(),
	(err) => {
		if (err) {
			console.error(`❌ Failed to bind: ${err.message}`);
			process.exit(1);
		}
		console.log(`\n🔵 gRPC Server running on port ${PORT}`);
		console.log(`   Client: npm run grpc:client`);
		console.log(`   Docs: see 06-grpc/README.md\n`);
	},
);
