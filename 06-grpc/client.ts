import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── gRPC Client ────────────────────────────────────────────────
//
// gRPC client = call methods yang didefinisikan di .proto file.
// Client pakai stub (proxy) yang auto-serialize/deserialize protobuf.
//
// Langkah:
//   1. Load .proto file yang SAMA dengan server
//   2. Buat client stub (new ServiceClient(address, credentials))
//   3. Call methods — auto send request via HTTP/2 + protobuf

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "task.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

// Buat client stub — connect ke gRPC server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new proto.taskapi.TaskService(
	"localhost:50051",
	grpc.credentials.createInsecure(),
);

// ─── Demo: Call all RPC methods ─────────────────────────────────

async function demo() {
	console.log("┌─────────────────────────────────────────────┐");
	console.log("│     gRPC Client Demo — TaskService          │");
	console.log("└─────────────────────────────────────────────┘\n");

	// 1. ListTasks (server streaming)
	console.log("📋 ListTasks (streaming):");
	await new Promise<void>((resolve) => {
		const stream = client.ListTasks({});
		stream.on("data", (task: { id: string; title: string; done: boolean }) => {
			console.log(
				`   ${task.done ? "✅" : "⬜"} [${task.id.slice(0, 8)}] ${task.title}`,
			);
		});
		stream.on("end", () => {
			console.log();
			resolve();
		});
		stream.on("error", (err: Error) => {
			console.error("   Stream error:", err.message);
			resolve();
		});
	});

	// 2. CreateTask (unary)
	console.log("➕ CreateTask:");
	const created = await new Promise<{
		id: string;
		title: string;
		done: boolean;
		created_at: string;
	}>((resolve, reject) => {
		client.CreateTask(
			{ title: "Belajar gRPC streaming" },
			(
				err: Error | null,
				response: {
					id: string;
					title: string;
					done: boolean;
					created_at: string;
				},
			) => {
				if (err) reject(err);
				else resolve(response);
			},
		);
	});
	console.log(`   ✅ Created: [${created.id.slice(0, 8)}] ${created.title}\n`);

	// 3. GetTask (unary)
	console.log("🔍 GetTask:");
	const fetched = await new Promise<{
		id: string;
		title: string;
		done: boolean;
	}>((resolve, reject) => {
		client.GetTask(
			{ id: created.id },
			(
				err: Error | null,
				response: { id: string; title: string; done: boolean },
			) => {
				if (err) reject(err);
				else resolve(response);
			},
		);
	});
	console.log(
		`   Found: [${fetched.id.slice(0, 8)}] ${fetched.title} (done: ${fetched.done})\n`,
	);

	// 4. UpdateTask (unary)
	console.log("📝 UpdateTask:");
	const updated = await new Promise<{
		id: string;
		title: string;
		done: boolean;
	}>((resolve, reject) => {
		client.UpdateTask(
			{ id: created.id, title: created.title, done: true },
			(
				err: Error | null,
				response: { id: string; title: string; done: boolean },
			) => {
				if (err) reject(err);
				else resolve(response);
			},
		);
	});
	console.log(`   Updated: [${updated.id.slice(0, 8)}] done=${updated.done}\n`);

	// 5. DeleteTask (unary)
	console.log("🗑️  DeleteTask:");
	const deleted = await new Promise<{ success: boolean }>((resolve, reject) => {
		client.DeleteTask(
			{ id: created.id },
			(err: Error | null, response: { success: boolean }) => {
				if (err) reject(err);
				else resolve(response);
			},
		);
	});
	console.log(`   Deleted: success=${deleted.success}\n`);

	// 6. Error handling: GetTask with non-existent ID
	console.log("❌ Error handling (GetTask non-existent):");
	await new Promise<void>((resolve) => {
		client.GetTask({ id: "nonexistent" }, (err: Error | null) => {
			if (err) {
				console.log(`   Error: ${err.message}`);
				console.log(
					`   (This is expected — gRPC returns structured error codes)\n`,
				);
			}
			resolve();
		});
	});

	console.log("✅ Demo complete!\n");
	client.close();
	process.exit(0);
}

demo().catch((err) => {
	console.error("Demo failed:", err);
	console.error("   Pastikan gRPC server jalan: npm run grpc:server");
	process.exit(1);
});
