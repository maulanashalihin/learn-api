import { WebSocketServer, WebSocket } from "ws";

// ─── WebSocket Chat Server ──────────────────────────────────────
//
// WebSocket = protokol bi-directional di atas HTTP upgrade handshake.
// Beda dengan SSE (one-way server→client), WebSocket = two-way.
// Beda dengan REST (request-response), WebSocket = persistent connection.
//
// Use case: chat, collaborative editing, multiplayer games, live trading,
// real-time dashboards dengan interaksi dua arah.

interface ChatMessage {
	type: "join" | "leave" | "chat" | "system";
	username?: string;
	text?: string;
	timestamp: string;
}

// Track connected clients + usernames
const clients = new Map<WebSocket, string>(); // ws → username

const wss = new WebSocketServer({ port: 3005 });

console.log(`\n🔵 WebSocket Chat Server running on ws://localhost:3005`);
console.log(`   Client: npm run ws:client`);
console.log(`   Docs: see 05-websockets/README.md\n`);

wss.on("connection", (ws, req) => {
	const clientIP = req.socket.remoteAddress;
	console.log(`🔌 New connection from ${clientIP}`);

	// ─── Receive message from client ─────────────────────────────
	ws.on("message", (data) => {
		let msg: ChatMessage;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			ws.send(
				JSON.stringify({
					type: "system",
					text: "Invalid message format",
					timestamp: new Date().toISOString(),
				}),
			);
			return;
		}

		switch (msg.type) {
			case "join": {
				const username = msg.username ?? "anonymous";
				clients.set(ws, username);
				console.log(`✅ ${username} joined (${clients.size} online)`);

				// Notify everyone
				broadcast({
					type: "system",
					text: `${username} joined the chat`,
					timestamp: new Date().toISOString(),
				});
				break;
			}

			case "chat": {
				const username = clients.get(ws) ?? "anonymous";
				const chatMsg: ChatMessage = {
					type: "chat",
					username,
					text: msg.text,
					timestamp: new Date().toISOString(),
				};
				console.log(`💬 ${username}: ${msg.text}`);
				broadcast(chatMsg);
				break;
			}

			default:
				ws.send(
					JSON.stringify({
						type: "system",
						text: `Unknown message type: ${msg.type}`,
						timestamp: new Date().toISOString(),
					}),
				);
		}
	});

	// ─── Client disconnect ───────────────────────────────────────
	ws.on("close", () => {
		const username = clients.get(ws) ?? "anonymous";
		clients.delete(ws);
		console.log(`❌ ${username} left (${clients.size} online)`);
		broadcast({
			type: "system",
			text: `${username} left the chat`,
			timestamp: new Date().toISOString(),
		});
	});

	ws.on("error", (err) => {
		console.error(`WebSocket error: ${err.message}`);
	});

	// Welcome message
	ws.send(
		JSON.stringify({
			type: "system",
			text: 'Welcome! Send {"type":"join","username":"yourname"} to join.',
			timestamp: new Date().toISOString(),
		}),
	);
});

// ─── Broadcast to all connected clients ─────────────────────────
function broadcast(msg: ChatMessage): void {
	const payload = JSON.stringify(msg);
	for (const client of clients.keys()) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(payload);
		}
	}
}
