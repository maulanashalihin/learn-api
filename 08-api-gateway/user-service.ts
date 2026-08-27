import express from "express";
import type { Request, Response } from "express";
import { generateId } from "../shared/types.js";

// ─── User Service (Backend Microservice) ────────────────────────
//
// Service ini hanya peduli tentang users.
// Tidak tahu tentang orders, gateway, atau service lain.
// Ini adalah prinsip microservice: single responsibility.

interface User {
	id: string;
	name: string;
	email: string;
}

const users = new Map<string, User>();

// Seed
users.set("u1", { id: "u1", name: "Alice", email: "alice@example.com" });
users.set("u2", { id: "u2", name: "Bob", email: "bob@example.com" });
users.set("u3", { id: "u3", name: "Charlie", email: "charlie@example.com" });

const app = express();
app.use(express.json());

// Service identifier header — gateway bisa tahu dari mana response berasal
app.use((_req, res, next) => {
	res.setHeader("X-Service", "user-service");
	next();
});

app.get("/users", (_req: Request, res: Response) => {
	res.json([...users.values()]);
});

app.get("/users/:id", (req: Request, res: Response) => {
	const user = users.get(req.params.id);
	if (!user) {
		res.status(404).json({ error: "User not found" });
		return;
	}
	res.json(user);
});

app.post("/users", (req: Request, res: Response) => {
	const { name, email } = req.body as { name?: string; email?: string };
	if (!name?.trim() || !email?.trim()) {
		res.status(400).json({ error: "name and email are required" });
		return;
	}
	const id = generateId();
	const user: User = { id, name: name.trim(), email: email.trim() };
	users.set(id, user);
	res.status(201).json(user);
});

const PORT = 3011;
app.listen(PORT, () => {
	console.log(`  └─ User Service running on port ${PORT}`);
});
