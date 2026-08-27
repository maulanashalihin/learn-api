// ─── Circuit Breaker ────────────────────────────────────────────
//
// Circuit breaker = "sekering listrik" untuk service calls.
// Kalau service target terus gagal, breaker "putus" (OPEN) → stop calling,
// fail-fast. Setelah cooldown, breaker "test" (HALF_OPEN) → kalau OK, tutup lagi.
//
// Kenapa penting? Tanpa circuit breaker, kalau user-service lambat/down:
//   order-service → retry → timeout → thread pool habis → order-service down
//   → payment-service call order-service → timeout → payment-service down
//   = cascading failure (semua service tumbang)
//
// Dengan circuit breaker, failure di-contained di satu service.
//
// State machine:
//
//   CLOSED ──── failures >= threshold ────→ OPEN
//     ▲                                       │
//     │                                       │ reset timeout elapsed
//     │                                       ▼
//   CLOSED ←── successes >= threshold ── HALF_OPEN
//     ▲                                       │
//     │                                       │ test call fails
//     └───────────────────────────────────────┘
//                                               → OPEN (reset cooldown)

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
	failureThreshold: number; // berapa failure sebelum OPEN (mis. 3)
	resetTimeoutMs: number; // berapa ms di OPEN sebelum HALF_OPEN (mis. 5000)
	successThreshold: number; // berapa success di HALF_OPEN sebelum CLOSED (mis. 2)
}

export interface Transition {
	from: CircuitState;
	to: CircuitState;
	at: number; // Date.now() ms
	reason: string;
}

export interface CircuitBreakerStats {
	name: string;
	state: CircuitState;
	failureCount: number;
	successCount: number;
	lastFailureTime: number | null;
	transitions: Transition[];
}

/** Thrown saat breaker OPEN — call ditolak tanpa menyentuh service target. */
export class CircuitOpenError extends Error {
	constructor(public readonly breakerName: string) {
		super(
			`Circuit breaker "${breakerName}" is OPEN — failing fast without calling service`,
		);
		this.name = "CircuitOpenError";
	}
}

export class CircuitBreaker {
	readonly name: string;
	state: CircuitState = "CLOSED";
	failureCount = 0;
	successCount = 0;
	lastFailureTime: number | null = null;
	transitions: Transition[] = [];

	private readonly opts: CircuitBreakerOptions;
	private halfOpenCallInFlight = false;
	private onTransition?: (t: Transition) => void;

	constructor(
		name: string,
		opts: CircuitBreakerOptions,
		onTransition?: (t: Transition) => void,
	) {
		this.name = name;
		this.opts = opts;
		this.onTransition = onTransition;
	}

	/**
	 * Wrap a function call with circuit breaker protection.
	 * - CLOSED: call goes through normally.
	 * - OPEN: fail fast (CircuitOpenError), no call made.
	 * - HALF_OPEN: let ONE call through to test recovery.
	 */
	async call<T>(fn: () => Promise<T>): Promise<T> {
		// ── OPEN: check if cooldown elapsed → HALF_OPEN, else fail fast ──
		if (this.state === "OPEN") {
			const elapsed =
				this.lastFailureTime !== null
					? Date.now() - this.lastFailureTime
					: Infinity;
			if (elapsed >= this.opts.resetTimeoutMs) {
				this.transition(
					"HALF_OPEN",
					`reset timeout (${this.opts.resetTimeoutMs}ms) elapsed — testing if service recovered`,
				);
			} else {
				throw new CircuitOpenError(this.name);
			}
		}

		// ── HALF_OPEN: only one test call at a time ──
		let isTestCall = false;
		if (this.state === "HALF_OPEN") {
			if (this.halfOpenCallInFlight) {
				// another test call is already running — fail fast
				throw new CircuitOpenError(this.name);
			}
			this.halfOpenCallInFlight = true;
			isTestCall = true;
		}

		try {
			const result = await fn();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure();
			throw error;
		} finally {
			if (isTestCall) this.halfOpenCallInFlight = false;
		}
	}

	private onSuccess(): void {
		if (this.state === "HALF_OPEN") {
			this.successCount++;
			if (this.successCount >= this.opts.successThreshold) {
				this.transition(
					"CLOSED",
					`${this.successCount} consecutive successes in half-open — service recovered`,
				);
				this.failureCount = 0;
				this.successCount = 0;
			}
		} else if (this.state === "CLOSED") {
			// reset failure count on success (consecutive failures only)
			this.failureCount = 0;
		}
	}

	private onFailure(): void {
		this.lastFailureTime = Date.now();
		if (this.state === "HALF_OPEN") {
			// test call failed → back to OPEN
			this.successCount = 0;
			this.transition(
				"OPEN",
				"test call failed in half-open — service still down",
			);
		} else if (this.state === "CLOSED") {
			this.failureCount++;
			if (this.failureCount >= this.opts.failureThreshold) {
				this.transition(
					"OPEN",
					`${this.failureCount} failures reached threshold (${this.opts.failureThreshold})`,
				);
			}
		}
	}

	private transition(to: CircuitState, reason: string): void {
		const t: Transition = {
			from: this.state,
			to,
			at: Date.now(),
			reason,
		};
		this.state = to;
		this.transitions.push(t);
		this.onTransition?.(t);
	}

	getStats(): CircuitBreakerStats {
		return {
			name: this.name,
			state: this.state,
			failureCount: this.failureCount,
			successCount: this.successCount,
			lastFailureTime: this.lastFailureTime,
			transitions: this.transitions,
		};
	}
}
