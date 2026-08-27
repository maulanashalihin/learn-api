// ─── Service Registry ───────────────────────────────────────────
//
// Service discovery = bagaimana service saling ketemu tanpa hardcode URL.
// Daripada order-service hardcode `http://localhost:3021`, dia tanya registry:
// "where is user-service?" → registry jawab URL-nya.
//
// Registry ini in-memory. Di production: Consul, etcd, Eureka, Zookeeper, atau
// Kubernetes DNS (service.name.svc.cluster.local).
//
// Cara kerja:
//   1. Service register(diri sendiri) saat startup → registry simpan name + URL
//   2. Service kirim heartbeat tiap N detik → "aku masih hidup"
//   3. Kalau heartbeat terlewat > timeout → service ditandai unhealthy
//   4. Caller discover(name) → dapat URL service yang healthy

export interface ServiceInstance {
	name: string;
	url: string;
	healthy: boolean;
	lastHeartbeat: number; // Date.now() ms
	registeredAt: number;
}

export interface ServiceInfo {
	name: string;
	url: string;
	healthy: boolean;
	lastHeartbeatMs: number; // ms since last heartbeat
	registeredAt: number;
}

export class ServiceRegistry {
	// name → list of instances (support multiple replicas)
	private services = new Map<string, Map<string, ServiceInstance>>();
	// round-robin counter per service name
	private rrIndex = new Map<string, number>();
	private heartbeatTimeoutMs: number;
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

	constructor(heartbeatTimeoutMs = 15_000) {
		this.heartbeatTimeoutMs = heartbeatTimeoutMs;
	}

	/** Service mendaftarkan diri ke registry. */
	register(name: string, url: string): void {
		if (!this.services.has(name)) {
			this.services.set(name, new Map());
		}
		const now = Date.now();
		this.services.get(name)!.set(url, {
			name,
			url,
			healthy: true,
			lastHeartbeat: now,
			registeredAt: now,
		});
		console.log(`  [registry] + registered "${name}" → ${url}`);
	}

	/** Service unregister saat shutdown. */
	deregister(name: string, url: string): void {
		this.services.get(name)?.delete(url);
		if (this.services.get(name)?.size === 0) {
			this.services.delete(name);
		}
		console.log(`  [registry] - deregistered "${name}" → ${url}`);
	}

	/** Service bilang "aku masih hidup" tiap interval. */
	heartbeat(name: string, url: string): void {
		const instance = this.services.get(name)?.get(url);
		if (!instance) return; // belum register (seharusnya tidak terjadi)
		instance.lastHeartbeat = Date.now();
		if (!instance.healthy) {
			instance.healthy = true;
			console.log(`  [registry] ♥ ${name} (${url}) kembali healthy`);
		}
	}

	/**
	 * Cari URL service by name. Hanya return instance yang healthy.
	 * Multiple instances → round-robin load balancing.
	 * Return null kalau service tidak ada atau semua instance unhealthy.
	 */
	discover(name: string): string | null {
		const instances = this.services.get(name);
		if (!instances || instances.size === 0) return null;

		const healthy = [...instances.values()].filter((s) => s.healthy);
		if (healthy.length === 0) return null;

		// round-robin antar instance yang healthy
		const idx = (this.rrIndex.get(name) ?? 0) % healthy.length;
		this.rrIndex.set(name, idx + 1);
		return healthy[idx].url;
	}

	/** List semua service dengan status kesehatan. */
	list(): ServiceInfo[] {
		const result: ServiceInfo[] = [];
		const now = Date.now();
		for (const instances of this.services.values()) {
			for (const s of instances.values()) {
				result.push({
					name: s.name,
					url: s.url,
					healthy: s.healthy,
					lastHeartbeatMs: now - s.lastHeartbeat,
					registeredAt: s.registeredAt,
				});
			}
		}
		return result;
	}

	/** Start background check: tandai unhealthy kalau heartbeat terlewat. */
	startHealthCheck(intervalMs = 5_000): void {
		this.healthCheckTimer = setInterval(() => {
			const now = Date.now();
			for (const instances of this.services.values()) {
				for (const s of instances.values()) {
					if (s.healthy && now - s.lastHeartbeat > this.heartbeatTimeoutMs) {
						s.healthy = false;
						console.log(
							`  [registry] ⚠ ${s.name} (${s.url}) ditandai UNHEALTHY — heartbeat terlewat`,
						);
					}
				}
			}
		}, intervalMs);
		this.healthCheckTimer.unref(); // jangan keep process alive
	}

	stop(): void {
		if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
	}
}
