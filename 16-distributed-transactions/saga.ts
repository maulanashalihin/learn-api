// ─── Saga Pattern ───────────────────────────────────────────────
//
// Saga = rangkaian local transactions, masing-masing di 1 service.
// Tidak ada ACID global. Kalau satu langkah gagal, jalankan
// COMPENSATING TRANSACTION (semantic undo, BUKAN rollback) untuk
// langkah-langkah yang sudah sukses — urutan terbalik.
//
// Dua varian:
//   • Orchestration: central orchestrator panggil tiap step + compensation.
//   • Choreography: tiap service emit event, service lain react (no central brain).
//
// Demo: e-commerce order flow
//   1. Create Order  → compensate: Cancel Order
//   2. Reserve Stock → compensate: Release Stock
//   3. Charge Payment→ compensate: Refund Payment
//   4. Ship          → compensate: Cancel Shipment

// ── Shared domain (in-memory "service" state) ──

export interface OrderRecord {
	id: string;
	status: "CREATED" | "CANCELLED" | "CONFIRMED";
	total: number;
}
export interface StockRecord {
	sku: string;
	reserved: number; // qty sedang di-reserve
	available: number; // qty bebas
}
export interface PaymentRecord {
	orderId: string;
	amount: number;
	status: "CHARGED" | "REFUNDED" | "DECLINED";
}
export interface ShipmentRecord {
	orderId: string;
	status: "SHIPPED" | "CANCELLED";
}

/** State global simulasi — di production ini tersebar di 4 service + 4 DB. */
export class World {
	orders = new Map<string, OrderRecord>();
	stock = new Map<string, StockRecord>();
	payments = new Map<string, PaymentRecord>();
	shipments = new Map<string, ShipmentRecord>();
	/** Bus event untuk choreography. */
	events: DomainEvent[] = [];

	reset(): void {
		this.orders.clear();
		this.stock.clear();
		this.payments.clear();
		this.shipments.clear();
		this.events = [];
	}

	seedStock(sku: string, available: number): void {
		this.stock.set(sku, { sku, reserved: 0, available });
	}

	snapshot(): string {
		const o =
			[...this.orders.values()].map((x) => `${x.id}:${x.status}`).join(", ") ||
			"(none)";
		const s =
			[...this.stock.values()]
				.map((x) => `${x.sku}(avail=${x.available},reserved=${x.reserved})`)
				.join(", ") || "(none)";
		const p =
			[...this.payments.values()]
				.map((x) => `${x.orderId}:${x.status}`)
				.join(", ") || "(none)";
		const sh =
			[...this.shipments.values()]
				.map((x) => `${x.orderId}:${x.status}`)
				.join(", ") || "(none)";
		return `  Orders:    ${o}\n  Stock:     ${s}\n  Payments:  ${p}\n  Shipments: ${sh}`;
	}
}

// ── Domain events (untuk choreography) ──

export type DomainEvent =
	| {
			type: "OrderCreated";
			orderId: string;
			total: number;
			sku: string;
			qty: number;
	  }
	| { type: "StockReserved"; orderId: string; sku: string; qty: number }
	| { type: "StockReservationFailed"; orderId: string; reason: string }
	| { type: "PaymentCharged"; orderId: string; amount: number }
	| { type: "PaymentFailed"; orderId: string; reason: string }
	| { type: "OrderShipped"; orderId: string }
	| { type: "OrderCancelled"; orderId: string; reason: string }
	| { type: "StockReleased"; orderId: string; sku: string; qty: number }
	| { type: "PaymentRefunded"; orderId: string; amount: number };

// ── Step result ──

export interface StepResult {
	step: string;
	ok: boolean;
	detail: string;
}

// ── Orchestration Saga ──

export interface OrchestrationConfig {
	/** Paksa payment gagal (simulasi kartu declined). */
	paymentDeclined?: boolean;
	/** Paksa stock gagal. */
	stockShortage?: boolean;
}

/**
 * Orchestrator: panggil tiap step berurutan. Kalau ada yang gagal,
 * jalankan compensation untuk step yang sudah sukses, urutan terbalik.
 */
export class OrderSagaOrchestrator {
	private readonly world: World;
	private readonly cfg: OrchestrationConfig;
	/** Step yang sudah sukses — untuk compensation. */
	private readonly done: { step: string; compensate: () => string }[] = [];
	readonly trace: string[] = [];

	constructor(world: World, cfg: OrchestrationConfig = {}) {
		this.world = world;
		this.cfg = cfg;
	}

	private log(m: string): void {
		this.trace.push(m);
	}

	async execute(
		orderId: string,
		sku: string,
		qty: number,
		total: number,
	): Promise<SagaOutcome> {
		this.log(
			`\n=== ORCHESTRATION SAGA: order ${orderId} (sku=${sku}, qty=${qty}, total=${total}) ===`,
		);

		// Step 1: Create Order
		const s1 = this.createOrder(orderId, total);
		this.log(`  [1] Create Order  → ${s1.ok ? "OK" : "FAIL"}: ${s1.detail}`);
		if (!s1.ok) return this.finish("FAILED", "create order gagal");
		this.done.push({
			step: "CreateOrder",
			compensate: () => this.cancelOrder(orderId),
		});

		// Step 2: Reserve Stock
		const s2 = this.reserveStock(orderId, sku, qty);
		this.log(`  [2] Reserve Stock → ${s2.ok ? "OK" : "FAIL"}: ${s2.detail}`);
		if (!s2.ok)
			return this.compensate("FAILED", `reserve stock gagal: ${s2.detail}`);
		this.done.push({
			step: "ReserveStock",
			compensate: () => this.releaseStock(orderId, sku, qty),
		});

		// Step 3: Charge Payment
		const s3 = this.chargePayment(orderId, total);
		this.log(`  [3] Charge Payment→ ${s3.ok ? "OK" : "FAIL"}: ${s3.detail}`);
		if (!s3.ok)
			return this.compensate("FAILED", `charge payment gagal: ${s3.detail}`);
		this.done.push({
			step: "ChargePayment",
			compensate: () => this.refundPayment(orderId, total),
		});

		// Step 4: Ship
		const s4 = this.ship(orderId);
		this.log(`  [4] Ship          → ${s4.ok ? "OK" : "FAIL"}: ${s4.detail}`);
		if (!s4.ok) return this.compensate("FAILED", `ship gagal: ${s4.detail}`);
		this.done.push({
			step: "Ship",
			compensate: () => this.cancelShipment(orderId),
		});

		// Semua sukses → confirm order
		const order = this.world.orders.get(orderId)!;
		order.status = "CONFIRMED";
		this.log(`  ✓ All steps OK → order CONFIRMED`);
		return this.finish("COMPLETED", "all 4 steps succeeded");
	}

	/** Jalankan compensation urutan terbalik. */
	private compensate(
		outcome: SagaOutcome["result"],
		reason: string,
	): SagaOutcome {
		this.log(`  ↩ COMPENSATION (reverse order) — reason: ${reason}`);
		// Pop dari stack → urutan terbalik otomatis.
		while (this.done.length > 0) {
			const { step, compensate } = this.done.pop()!;
			const msg = compensate();
			this.log(`    compensate ${step}: ${msg}`);
		}
		return this.finish(outcome, reason);
	}

	private finish(result: SagaOutcome["result"], reason: string): SagaOutcome {
		this.log(`  → RESULT: ${result} (${reason})`);
		return { result, reason, trace: this.trace };
	}

	// ── Forward actions (local transactions) ──

	private createOrder(orderId: string, total: number): StepResult {
		this.world.orders.set(orderId, { id: orderId, status: "CREATED", total });
		return {
			step: "CreateOrder",
			ok: true,
			detail: `order ${orderId} created`,
		};
	}

	private reserveStock(orderId: string, sku: string, qty: number): StepResult {
		const st = this.world.stock.get(sku);
		if (!st)
			return {
				step: "ReserveStock",
				ok: false,
				detail: `sku ${sku} tidak dikenal`,
			};
		if (this.cfg.stockShortage || st.available < qty) {
			return {
				step: "ReserveStock",
				ok: false,
				detail: `stock kurang (avail=${st.available}, need=${qty})`,
			};
		}
		st.available -= qty;
		st.reserved += qty;
		return { step: "ReserveStock", ok: true, detail: `${qty} ${sku} reserved` };
	}

	private chargePayment(orderId: string, amount: number): StepResult {
		if (this.cfg.paymentDeclined) {
			this.world.payments.set(orderId, { orderId, amount, status: "DECLINED" });
			return { step: "ChargePayment", ok: false, detail: "kartu declined" };
		}
		this.world.payments.set(orderId, { orderId, amount, status: "CHARGED" });
		return { step: "ChargePayment", ok: true, detail: `${amount} charged` };
	}

	private ship(orderId: string): StepResult {
		this.world.shipments.set(orderId, { orderId, status: "SHIPPED" });
		return { step: "Ship", ok: true, detail: `shipped` };
	}

	// ── Compensating actions (semantic undo) ──

	private cancelOrder(orderId: string): string {
		const o = this.world.orders.get(orderId);
		if (o) o.status = "CANCELLED";
		return `order ${orderId} cancelled`;
	}

	private releaseStock(orderId: string, sku: string, qty: number): string {
		const st = this.world.stock.get(sku);
		if (st) {
			st.reserved -= qty;
			st.available += qty;
		}
		return `${qty} ${sku} released back to stock`;
	}

	private refundPayment(orderId: string, amount: number): string {
		const p = this.world.payments.get(orderId);
		if (p) p.status = "REFUNDED";
		return `${amount} refunded`;
	}

	private cancelShipment(orderId: string): string {
		const sh = this.world.shipments.get(orderId);
		if (sh) sh.status = "CANCELLED";
		return `shipment ${orderId} cancelled`;
	}
}

// ── Choreography Saga ──
//
// Tidak ada orchestrator. Tiap service subscribe ke event bus dan
// react. Flow ditentukan oleh rangkaian reaksi. Compensation juga
// event-driven: event "PaymentFailed" → StockService release →
// OrderService cancel.

export interface ChoreographyConfig {
	paymentDeclined?: boolean;
}

export class OrderSagaChoreography {
	private readonly world: World;
	private readonly cfg: ChoreographyConfig;
	readonly trace: string[] = [];

	constructor(world: World, cfg: ChoreographyConfig = {}) {
		this.world = world;
		this.cfg = cfg;
	}

	private log(m: string): void {
		this.trace.push(m);
	}

	private emit(e: DomainEvent): void {
		this.world.events.push(e);
		this.log(`  📤 event: ${e.type}`);
	}

	/** Proses event satu per satu (synchronous simulation of async bus). */
	async execute(
		orderId: string,
		sku: string,
		qty: number,
		total: number,
	): Promise<SagaOutcome> {
		this.log(`\n=== CHOREOGRAPHY SAGA: order ${orderId} ===`);
		this.log(`  OrderService: create order ${orderId}`);
		this.world.orders.set(orderId, { id: orderId, status: "CREATED", total });
		this.emit({ type: "OrderCreated", orderId, total, sku, qty });

		// StockService reacts to OrderCreated
		const st = this.world.stock.get(sku);
		if (!st || st.available < qty) {
			const reason = st
				? `stock kurang (avail=${st.available})`
				: `sku ${sku} tidak dikenal`;
			this.log(`  StockService: reserve FAILED — ${reason}`);
			this.emit({ type: "StockReservationFailed", orderId, reason });
			// OrderService reacts to StockReservationFailed → cancel
			this.log(`  OrderService: react StockReservationFailed → cancel order`);
			this.world.orders.get(orderId)!.status = "CANCELLED";
			this.emit({ type: "OrderCancelled", orderId, reason });
			return { result: "FAILED", reason, trace: this.trace };
		}
		st.available -= qty;
		st.reserved += qty;
		this.log(`  StockService: reserve OK (${qty} ${sku})`);
		this.emit({ type: "StockReserved", orderId, sku, qty });

		// PaymentService reacts to StockReserved
		if (this.cfg.paymentDeclined) {
			this.world.payments.set(orderId, {
				orderId,
				amount: total,
				status: "DECLINED",
			});
			this.log(`  PaymentService: charge FAILED — kartu declined`);
			this.emit({ type: "PaymentFailed", orderId, reason: "kartu declined" });
			// Compensation chain (event-driven, reverse):
			this.log(`  StockService: react PaymentFailed → release stock`);
			st.reserved -= qty;
			st.available += qty;
			this.emit({ type: "StockReleased", orderId, sku, qty });
			this.log(`  OrderService: react StockReleased → cancel order`);
			this.world.orders.get(orderId)!.status = "CANCELLED";
			this.emit({ type: "OrderCancelled", orderId, reason: "payment failed" });
			return { result: "FAILED", reason: "kartu declined", trace: this.trace };
		}
		this.world.payments.set(orderId, {
			orderId,
			amount: total,
			status: "CHARGED",
		});
		this.log(`  PaymentService: charge OK (${total})`);
		this.emit({ type: "PaymentCharged", orderId, amount: total });

		// ShippingService reacts to PaymentCharged
		this.world.shipments.set(orderId, { orderId, status: "SHIPPED" });
		this.log(`  ShippingService: ship OK`);
		this.emit({ type: "OrderShipped", orderId });

		this.world.orders.get(orderId)!.status = "CONFIRMED";
		this.log(`  OrderService: react OrderShipped → confirm order`);
		return {
			result: "COMPLETED",
			reason: "all steps succeeded (event-driven)",
			trace: this.trace,
		};
	}
}

export interface SagaOutcome {
	result: "COMPLETED" | "FAILED";
	reason: string;
	trace: string[];
}
