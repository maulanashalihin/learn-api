import express from "express";
import type { Request, Response } from "express";
import { generateId } from "../shared/types.js";

// ─── Order Service (Backend Microservice) ───────────────────────
//
// Service ini hanya peduli tentang orders.
// Tidak tahu tentang users (hanya simpan userId sebagai reference).
// Untuk dapat user detail, gateway yang akan call user-service.

interface Order {
	id: string;
	userId: string;
	product: string;
	amount: number;
	status: "pending" | "paid" | "shipped";
}

const orders = new Map<string, Order>();

// Seed
orders.set("o1", {
	id: "o1",
	userId: "u1",
	product: "Laptop",
	amount: 1200,
	status: "paid",
});
orders.set("o2", {
	id: "o2",
	userId: "u1",
	product: "Mouse",
	amount: 25,
	status: "shipped",
});
orders.set("o3", {
	id: "o3",
	userId: "u2",
	product: "Keyboard",
	amount: 75,
	status: "pending",
});

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
	res.setHeader("X-Service", "order-service");
	next();
});

app.get("/orders", (req: Request, res: Response) => {
	// Optional filter by userId
	const userId = req.query.userId as string | undefined;
	const result = userId
		? [...orders.values()].filter((o) => o.userId === userId)
		: [...orders.values()];
	res.json(result);
});

app.get("/orders/:id", (req: Request, res: Response) => {
	const order = orders.get(req.params.id);
	if (!order) {
		res.status(404).json({ error: "Order not found" });
		return;
	}
	res.json(order);
});

app.post("/orders", (req: Request, res: Response) => {
	const { userId, product, amount } = req.body as {
		userId?: string;
		product?: string;
		amount?: number;
	};
	if (!userId?.trim() || !product?.trim() || typeof amount !== "number") {
		res.status(400).json({ error: "userId, product, and amount are required" });
		return;
	}
	const id = generateId();
	const order: Order = { id, userId, product, amount, status: "pending" };
	orders.set(id, order);
	res.status(201).json(order);
});

const PORT = 3012;
app.listen(PORT, () => {
	console.log(`  └─ Order Service running on port ${PORT}`);
});
