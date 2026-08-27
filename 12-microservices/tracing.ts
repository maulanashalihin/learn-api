// ─── Distributed Tracing ────────────────────────────────────────
//
// Di monolith, 1 request = 1 process = mudah debug dengan stack trace.
// Di microservices, 1 request bisa melibatkan 5 service. Kalau ada error,
// log di service mana? Bagaimana urutan panggilan?
//
// Distributed tracing = "stack trace" untuk microservices.
// Setiap request chain dapat 1 Trace ID yang sama, diturunkan ke semua service.
// Setiap unit kerja = 1 Span (dengan Span ID + parent Span ID).
//
//   Trace a1b2 (GET /orders/o1)
//   ├─ Span s1: order-service "GET /orders/o1"        parent: null
//   │  └─ Span s2: order-service "call user-service"  parent: s1
//   │     └─ Span s3: user-service "GET /users/u1"    parent: s2
//
// Context propagation via HTTP headers:
//   X-Trace-Id: a1b2...   (sama untuk semua span dalam 1 trace)
//   X-Span-Id:  s2...     (ID span caller → jadi parentSpanId di callee)
//
// Di production: OpenTelemetry, Jaeger, Zipkin, Datadog APM.
// Mereka collect spans dari semua service → visualisasi trace tree + timeline.

export type SpanStatus = "OK" | "ERROR";

export interface SpanContext {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
}

export interface Span extends SpanContext {
	service: string;
	operation: string;
	startTime: number;
	endTime: number | null;
	durationMs: number | null;
	status: SpanStatus;
}

export interface TraceHeaders extends Record<string, string> {
	"x-trace-id": string;
	"x-span-id": string;
}

export class Tracer {
	private spans: Span[] = [];

	/**
	 * Start a new span.
	 * - No parentContext → root span (new traceId, parentSpanId = null)
	 * - With parentContext → child span (inherit traceId, parentSpanId = parent's spanId)
	 */
	startSpan(
		service: string,
		operation: string,
		parentContext?: SpanContext,
	): SpanContext {
		const traceId = parentContext?.traceId ?? crypto.randomUUID();
		const parentSpanId = parentContext?.spanId ?? null;
		const spanId = crypto.randomUUID();

		const span: Span = {
			traceId,
			spanId,
			parentSpanId,
			service,
			operation,
			startTime: Date.now(),
			endTime: null,
			durationMs: null,
			status: "OK",
		};
		this.spans.push(span);
		return { traceId, spanId, parentSpanId };
	}

	/** End a span — record duration and status. */
	endSpan(ctx: SpanContext, status: SpanStatus = "OK"): void {
		const span = this.spans.find((s) => s.spanId === ctx.spanId);
		if (!span || span.endTime !== null) return; // not found or already ended
		span.endTime = Date.now();
		span.durationMs = span.endTime - span.startTime;
		span.status = status;
	}

	/** Inject trace context into HTTP headers for propagation to downstream service. */
	propagate(ctx: SpanContext): TraceHeaders {
		return {
			"x-trace-id": ctx.traceId,
			"x-span-id": ctx.spanId,
		};
	}

	/** Extract trace context from incoming HTTP headers. Returns null if no trace. */
	extract(
		headers: Record<string, string | string[] | undefined>,
	): SpanContext | null {
		const traceId = headers["x-trace-id"];
		const spanId = headers["x-span-id"];
		if (typeof traceId === "string" && typeof spanId === "string") {
			return { traceId, spanId, parentSpanId: null };
		}
		return null;
	}

	/** All span IDs for a given trace. */
	getTraceIds(): string[] {
		return [...new Set(this.spans.map((s) => s.traceId))];
	}

	/** Print a trace as a tree, showing parent-child span relationships. */
	printTraceTree(traceId: string): void {
		const traceSpans = this.spans.filter((s) => s.traceId === traceId);
		if (traceSpans.length === 0) {
			console.log(`  Trace ${traceId.slice(0, 8)} — no spans found`);
			return;
		}

		// group spans by parentSpanId
		const childrenMap = new Map<string | null, Span[]>();
		for (const span of traceSpans) {
			const key = span.parentSpanId;
			if (!childrenMap.has(key)) childrenMap.set(key, []);
			childrenMap.get(key)!.push(span);
		}

		const roots = childrenMap.get(null) ?? [];
		console.log(`  Trace ${traceId.slice(0, 8)} (${traceSpans.length} spans)`);
		for (const root of roots) {
			this.printSpan(root, childrenMap, "   ");
		}
	}

	private printSpan(
		span: Span,
		childrenMap: Map<string | null, Span[]>,
		prefix: string,
	): void {
		const dur = span.durationMs !== null ? `${span.durationMs}ms` : "pending";
		const status = span.status === "OK" ? "[OK]" : "[ERROR]";
		const id = span.spanId.slice(0, 8);
		console.log(
			`${prefix}└─ [${id}] ${span.service}: ${span.operation} (${dur}) ${status}`,
		);
		const children = childrenMap.get(span.spanId) ?? [];
		for (const child of children) {
			this.printSpan(child, childrenMap, prefix + "   ");
		}
	}
}
