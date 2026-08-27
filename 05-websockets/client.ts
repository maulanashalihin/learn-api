import WebSocket from "ws";
import readline from "node:readline";

// ─── WebSocket Chat Client (Node.js) ────────────────────────────
//
// Di browser, WebSocket API built-in:
//   const ws = new WebSocket("ws://localhost:3005");
//   ws.onmessage = (e) => console.log(e.data);
//   ws.send(JSON.stringify({ type: "chat", text: "hello" }));
//
// Di Node.js, kita pakai library `ws` yang juga implementasi WebSocket client.

const WS_URL = "ws://localhost:3005";
const username = process.argv[2] ?? "user-" + Math.floor(Math.random() * 1000);

console.log(`\n🔌 Connecting to ${WS_URL} as "${username}"...\n`);

const ws = new WebSocket(WS_URL);

// ─── Receive messages from server ───────────────────────────────
ws.on("message", (data) => {
	let msg: {
		type: string;
		username?: string;
		text?: string;
		timestamp: string;
	};
	try {
		msg = JSON.parse(data.toString());
	} catch {
		return;
	}

	const time = new Date(msg.timestamp).toLocaleTimeString();
	switch (msg.type) {
		case "system":
			console.log(`[${time}] 🔔 ${msg.text}`);
			break;
		case "chat":
			// Jangan echo pesan sendiri
			if (msg.username !== username) {
				console.log(`[${time}] 💬 ${msg.username}: ${msg.text}`);
			}
			break;
		default:
			console.log(`[${time}] ${JSON.stringify(msg)}`);
	}
});

ws.on("open", () => {
	console.log(`✅ Connected!\n`);

	// Send join
	ws.send(
		JSON.stringify({
			type: "join",
			username,
			timestamp: new Date().toISOString(),
		}),
	);

	// Read input from terminal
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
	});

	rl.prompt();

	rl.on("line", (line) => {
		const text = line.trim();
		if (!text) {
			rl.prompt();
			return;
		}

		if (text === "/quit") {
			ws.close();
			process.exit(0);
		}

		ws.send(
			JSON.stringify({
				type: "chat",
				text,
				timestamp: new Date().toISOString(),
			}),
		);

		// Echo pesan sendiri
		console.log(`[${new Date().toLocaleTimeString()}] 📤 you: ${text}`);
		rl.prompt();
	});
});

ws.on("close", () => {
	console.log("\n❌ Disconnected from server");
	process.exit(0);
});

ws.on("error", (err) => {
	console.error(`❌ Connection error: ${err.message}`);
	console.error("   Pastikan WebSocket server jalan: npm run ws");
	process.exit(1);
});
