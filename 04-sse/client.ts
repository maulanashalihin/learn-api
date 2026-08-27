// ─── SSE Client (Node.js) ───────────────────────────────────────
//
// Di browser, SSE pakai EventSource API (built-in):
//   const es = new EventSource("http://localhost:3004/events");
//   es.addEventListener("task.created", (e) => console.log(e.data));
//
// Di Node.js, gak ada EventSource built-in (sebelum Node 22).
// Kita pakai raw HTTP untuk connect dan parse SSE stream manual.
// Ini bagus untuk belajar — kita lihat exactly apa yang terjadi di wire.

import http from "node:http";

const SSE_HOST = "localhost";
const SSE_PORT = 3004;
const SSE_PATH = "/events";
const SSE_URL = `http://${SSE_HOST}:${SSE_PORT}${SSE_PATH}`;

console.log(`\n🔌 Connecting to SSE at ${SSE_URL}...\n`);

// Buat HTTP request dengan response streaming
const req = http.request(
	{
		hostname: SSE_HOST,
		port: SSE_PORT,
		path: SSE_PATH,
		method: "GET",
		headers: {
			Accept: "text/event-stream",
			"Cache-Control": "no-cache",
		},
	},
	(res) => {
		console.log(`✅ Connected (status: ${res.statusCode})`);
		console.log(`   Content-Type: ${res.headers["content-type"]}`);
		console.log(`   Listening for events...\n`);

		// SSE stream = text yang datang terus-menerus
		// Kita buffer dan parse per-event (dipisah oleh \n\n)
		let buffer = "";

		res.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();

			// Split by double newline = end of event
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? ""; // sisa incomplete event tetap di buffer

			for (const rawEvent of events) {
				parseSSEEvent(rawEvent);
			}
		});

		res.on("end", () => {
			console.log("\n❌ Connection closed by server");
		});
	},
);

req.on("error", (err: Error) => {
	console.error(`❌ Connection error: ${err.message}`);
	console.error("   Pastikan SSE server jalan: npm run sse");
});

req.end();

// ─── SSE Parser ─────────────────────────────────────────────────
// Format SSE per event:
//   event: task.created\n     → named event type
//   data: {"id":"..."}\n      → data payload (JSON)
//   : comment\n               → comment (ignore)
//   id: 123\n                 → event ID (for resume)
//   retry: 3000\n             → reconnect interval (ms)

function parseSSEEvent(raw: string): void {
	const lines = raw.split("\n");
	let eventType = "message"; // default event type
	const dataLines: string[] = [];

	for (const line of lines) {
		// Comment line (starts with :)
		if (line.startsWith(":")) continue;

		// Field: value
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const field = line.slice(0, colonIdx);
		const value = line.slice(colonIdx + 1).trimStart(); // 1 space prefix is optional

		if (field === "event") eventType = value;
		else if (field === "data") dataLines.push(value);
	}

	// Skip empty events (mis. heartbeat comments yang sudah difilter)
	if (dataLines.length === 0) return;

	const data = dataLines.join("\n");

	// Parse JSON kalau bisa, kalau gak biarkan string
	let parsed: unknown = data;
	try {
		parsed = JSON.parse(data);
	} catch {
		// data bukan JSON, biarkan sebagai string
	}

	// Print event
	const time = new Date().toLocaleTimeString();
	if (eventType === "init") {
		const tasks = parsed as Task[];
		console.log(`[${time}] 📋 Initial state: ${tasks.length} task(s)`);
		for (const t of tasks) {
			console.log(`   ${t.done ? "✅" : "⬜"} ${t.title}`);
		}
	} else {
		console.log(`\n[${time}] 📨 Event: ${eventType}`);
		console.log(`   Data: ${JSON.stringify(parsed, null, 2)}`);
	}
}

interface Task {
	id: string;
	title: string;
	done: boolean;
	createdAt: string;
}

// Graceful exit
process.on("SIGINT", () => {
	console.log("\n\n👋 Disconnecting...");
	req.destroy();
	process.exit(0);
});
