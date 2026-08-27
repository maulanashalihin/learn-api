# 12 — Microservices

## Apa itu Microservices?

**Microservices** adalah arsitektur di mana aplikasi dipecah menjadi service-service kecil yang **independently deployable**, masing-masing punya **single responsibility** dan berkomunikasi via network (HTTP, gRPC, message queue).

### Monolith vs Microservices

```
MONOLITH:                              MICROSERVICES:

  ┌─────────────────────┐               ┌──────────┐  ┌──────────┐
  │   One App           │               │  Order   │→ │  User    │
  │  ┌───────────────┐  │               │ Service  │  │ Service  │
  │  │ User module   │  │               └──────────┘  └──────────┘
  │  │ Order module  │  │                    ↕
  │  │ Payment mod.  │  │               ┌──────────┐  ┌──────────┐
  │  │ Auth module   │  │               │ Payment  │→ │  Auth    │
  │  └───────────────┘  │               │ Service  │  │ Service  │
  │  One DB, one deploy │               └──────────┘  └──────────┘
  └─────────────────────┘               Each: own DB, own deploy

  + Simple to build & test              + Independent scaling & deploy
  + Easy local dev                      + Fault isolation (1 service down ≠ all down)
  + No network calls between modules    + Tech diversity (Go for payment, TS for user)
  - One bug = whole app down           + Team autonomy
  - Must redeploy everything            - Network complexity
  - Hard to scale one part              - Distributed system hard (tracing, consistency)
  - Tech lock-in (one stack)            - Operational overhead (monitoring, CI/CD per service)
```

### Kapan service = "micro"?

Tidak ada aturan baku. Yang penting: **bounded context** — setiap service punya domain yang jelas dan tidak overlap. User-service peduli tentang users, order-service peduli tentang orders. Mereka tidak share database.

> **Conway's Law**: arsitektur microservices mengikuti struktur organisasi. Tim kecil (5-8 orang) per service = ukuran yang masuk akal.

---

## Service Discovery

Di monolith, modul call modul lain via function call. Di microservices, service call service lain via **network**. Tapi URL service bisa berubah (scale up = instance baru, deploy = IP berubah, crash = instance hilang).

**Service discovery** = mekanisme untuk service saling ketemu tanpa hardcode URL.

### Client-side vs Server-side Discovery

```
CLIENT-SIDE DISCOVERY:                  SERVER-SIDE DISCOVERY:

  Order Service                           Order Service
    │                                       │
    ├─ 1. Query registry                    ├─ 1. Call load balancer
    │     "where is user-service?"          │     (nginx, Envoy, AWS ALB)
    │                                       │
    ├─ 2. Registry returns                  ├─ 2. LB knows instances
    │     [10.0.0.1, 10.0.0.2]              │     (from registry)
    │                                       │
    ├─ 3. Pick one (round-robin)            └─ 3. LB forwards to healthy instance
    │
    └─ 4. Call directly

  + Client pilih instance sendiri         + Client gak peduli instance
  + No extra hop                          + Simpler client code
  - Client logic lebih kompleks           + LB handle load balancing + health
  - Must implement LB logic               - Extra network hop (through LB)

  Contoh: Netflix Eureka client           Contoh: Kubernetes Service, AWS ALB
```

### Registry Pattern (yang kita implementasi)

```
1. Startup:                    2. Heartbeat (periodic):         3. Discover:
   user-service                   user-service                     order-service
      │                               │                               │
      └─→ register("user-service",    └─→ heartbeat("user-service")    ├─→ discover("user-service")
            "http://10.0.0.5:3021")                                     │     → "http://10.0.0.5:3021"
                                                                        └─→ fetch("http://10.0.0.5:3021/users/u1")

4. Heartbeat missed (> timeout):
   registry marks user-service UNHEALTHY
   discover("user-service") → returns null (or other healthy instance)
```

| Registry Tool | Type | Notes |
|---------------|------|-------|
| **Consul** | Key-value store | HashiCorp, health checks built-in |
| **etcd** | Key-value store | CNCF, used by Kubernetes |
| **Eureka** | Service registry | Netflix OSS, client-side discovery |
| **Zookeeper** | Coordination service | Apache, hierarchical tree |
| **Kubernetes DNS** | DNS-based | `user-service.default.svc.cluster.local` |

> Di demo ini, registry in-memory. Di production: Consul/etcd + health checks + TTL.

---

## Circuit Breaker

### Masalah: Cascading Failure

Tanpa circuit breaker, kalau user-service lambat (mis. DB overload):

```
1. order-service call user-service → timeout 30s
2. order-service retry → timeout 30s lagi
3. 100 request masuk → 100 thread menunggu timeout
4. order-service thread pool habis → order-service DOWN
5. payment-service call order-service → timeout → payment-service DOWN
6. Semua service tumbang = CASCADING FAILURE
```

### Solusi: Circuit Breaker

Circuit breaker = "sekering listrik". Kalau service target terus gagal, breaker **putus** → stop calling, **fail fast**. Setelah cooldown, breaker **test** → kalau OK, **tutup** lagi.

```
    CLOSED ─────── failures >= threshold ──────→ OPEN
      ▲                                             │
      │                                             │ reset timeout elapsed
      │                                             ▼
    CLOSED ←────── successes >= threshold ──── HALF_OPEN
      ▲                                             │
      │                                             │ test call fails
      └─────────────────────────────────────────────┘
                                                    → OPEN (reset cooldown)
```

| State | Behavior | When |
|-------|----------|------|
| **CLOSED** | Calls go through normally | Default state, service healthy |
| **OPEN** | Calls rejected immediately (fast-fail), no network call | Failures ≥ threshold |
| **HALF_OPEN** | One test call allowed through | After reset timeout elapsed |

### Config (di code ini)

```typescript
new CircuitBreaker("user-service-breaker", {
  failureThreshold: 3,     // 3 failures → OPEN
  resetTimeoutMs: 5_000,   // 5s di OPEN → HALF_OPEN
  successThreshold: 2,     // 2 successes di HALF_OPEN → CLOSED
});
```

### Kenapa Half-Open?

Half-open adalah **probe**: biarkan **satu** call lewat untuk test apakah service sudah recover. Kalau call gagal → kembali OPEN (service masih down). Kalau call sukses → butuh `successThreshold` sukses beruntun untuk yakin service benar-benar sehat → CLOSED.

Tanpa half-open, kalau kita langsung tutup breaker setelah timeout, semua request yang tertahan akan langsung masuk ke service yang mungkin masih down → overload lagi.

---

## Related Patterns

Circuit breaker adalah salah satu dari sekumpulan **resilience patterns**. Mereka saling melengkapi:

| Pattern | Apa | Contoh |
|---------|-----|--------|
| **Circuit Breaker** | Stop calling service yang down | 3 failures → OPEN → fast-fail |
| **Retry** | Coba lagi kalau transient error | Retry 3x dengan exponential backoff |
| **Timeout** | Jangan tunggu selamanya | Timeout 5s per call, jangan 30s |
| **Bulkhead** | Isolasi resource per service | Thread pool terpisah per downstream service |
| **Fallback** | Response alternatif kalau gagal | Return cached data / default value / partial response |
| **Rate Limiting** | Batasi request rate | 100 req/s per client (lihat module 08-api-gateway) |

### Bulkhead

```
TANPA BULKHEAD:                    DENGAN BULKHEAD:

  Order Service                      Order Service
  ┌──────────────┐                   ┌──────┐ ┌──────┐
  │ Thread Pool  │                   │ Pool │ │ Pool │
  │   (100)      │                   │ User │ │ Pay  │
  │              │                   │ (50) │ │ (50) │
  └──────────────┘                   └──────┘ └──────┘
  user-service down →                user-service down →
  semua thread habis →               hanya user pool yang habis,
  payment-service juga down          payment-service masih jalan
```

> Nama "bulkhead" dari kapal: sekat kedap air. Kalau 1 kompartemen bocor, kapal tidak tenggelam.

### Retry + Exponential Backoff

```typescript
// Jangan retry tanpa backoff — bisa membuat bad situation worse (thundering herd)
async function retry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === maxRetries - 1) throw e;
      await sleep(2 ** i * 100); // 100ms, 200ms, 400ms
    }
  }
  throw new Error("unreachable");
}
```

> **Penting**: retry dan circuit breaker harus dipakai bersama. Retry untuk transient errors (network blip), circuit breaker untuk sustained failures (service down). Retry tanpa circuit breaker = memperburuk overload.

---

## Distributed Tracing

### Masalah: "Error di service mana?"

Di monolith, 1 request = 1 process = stack trace. Di microservices, 1 request bisa melibatkan 5 service:

```
Client → API Gateway → Order Service → User Service
                                  ↘→ Payment Service → Notification Service
```

Kalau response lambat atau error, log di service mana yang harus di-check? Bagaimana urutan panggilan?

### Solusi: Trace + Span

**Trace** = satu request chain end-to-end. Punya **Trace ID** yang sama di semua service.

**Span** = satu unit kerja dalam trace. Punya **Span ID**, **Parent Span ID**, service name, operation, duration, status.

```
Trace a1b2c3d4 (GET /orders/o1)
└─ [s1] order-service: GET /orders/o1 (15ms) [OK]
   └─ [s2] order-service: call user-service (10ms) [OK]
      └─ [s3] user-service: GET /users/u1 (5ms) [OK]
```

### Context Propagation

Trace ID diturunkan antar service via **HTTP headers**:

```
order-service                          user-service
┌─────────────┐                       ┌─────────────┐
│ startSpan() │                       │             │
│ traceId: a1 │  ── fetch ──→         │ extract()   │
│ spanId: s2  │  X-Trace-Id: a1       │ traceId: a1 │
│             │  X-Span-Id:  s2       │ parentSpan: │
│             │                       │   s2        │
│             │                       │ spanId: s3  │
│             │                       │ startSpan() │
└─────────────┘                       └─────────────┘
```

Header yang dipakai di code ini:

- `X-Trace-Id` — ID trace (sama untuk semua span dalam 1 request chain)
- `X-Span-Id` — ID span caller (menjadi parentSpanId di callee)

> Di production: **W3C Trace Context** standard (`traceparent` header), **OpenTelemetry** SDK, visualisasi di **Jaeger** / **Zipkin** / **Datadog APM**.

### Sampling

Di high-traffic system, trace setiap request = terlalu banyak data. **Sampling** = hanya trace sebagian request:

| Strategy | Cara | Kapan |
|----------|------|-------|
| **Probabilistic** | Trace 1% request secara random | Default, general observability |
| **Rate-limited** | Max 10 traces/detik | Guarantee budget |
| **Always-on** | Trace semua request | Dev/staging, low traffic |
| **Tail-based** | Trace request yang error/lambat | Production, fokus debugging |

> Tail-based sampling paling powerful: trace dimulai di semua request, tapi hanya disimpan yang error atau lambat. Butuh buffer untuk menunggu request selesai sebelum decide.

---

## Saga Pattern (Distributed Transactions)

Di monolith, 1 DB = 1 transaction (ACID). Transfer uang + update saldo = commit atau rollback, atomik.

Di microservices, setiap service punya **DB sendiri**. Transfer uang (payment-service) + update order (order-service) + kirim email (notification-service) = tidak bisa 1 transaction.

**Saga** = rangkaian local transactions, masing-mailing di 1 service. Kalau satu gagal, jalankan **compensating transaction** (rollback logic) untuk langkah sebelumnya.

```
Order Saga (create order):

  Step 1: Order Service    → CREATE order       (local tx, commit)
  Step 2: Payment Service  → CHARGE payment     (local tx, commit)
  Step 3: Inventory Service → RESERVE items     (local tx, commit)
  Step 4: Shipping Service → SCHEDULE delivery  (local tx, commit)

  Kalau Step 3 gagal (out of stock):
    → Compensate Step 2: REFUND payment
    → Compensate Step 1: CANCEL order

  Hasil: order cancelled, payment refunded = consistent (tapi tidak atomik)
```

| Saga Type | Cara | Trade-off |
|-----------|------|-----------|
| **Choreography** | Setiap service emit event, service lain react | Decentralized, tapi sulit trace flow |
| **Orchestration** | Central orchestrator coord-langkah | Centralized, tapi single point of coordination |

> Saga tidak memberi ACID. Memberi **eventual consistency**. Intermediate state bisa terlihat oleh client (order created tapi belum paid). Handle dengan UI state machine.

---

## Service Mesh

**Service mesh** = infrastructure layer untuk service-to-service communication. Menangani circuit breaking, retry, timeout, mTLS, tracing, load balancing — **tanpa code di service**.

```
TANPA SERVICE MESH:                    DENGAN SERVICE MESH (Istio/Linkerd):

  Order Service                         Order Service    ←─→ Sidecar Proxy (Envoy)
  ┌────────────────┐                      │                    │
  │ App code       │                      │ App code           │
  │ + retry logic  │                      │ (no retry logic)   │
  │ + circuit break│                      │ (no circuit break) │
  │ + tracing code │                      │ (no tracing code)  │
  │ + mTLS code    │                      │ (no mTLS code)     │
  │ + LB logic     │                      │ (no LB logic)      │
  └────────────────┘                      └────────────────────┘
                                               ↓
  Setiap service reimplements              Sidecar handles ALL cross-cutting
  resilience logic                          concerns transparently
```

| Service Mesh | Data Plane | Control Plane | Notes |
|---------------|-----------|---------------|-------|
| **Istio** | Envoy | Istiod | Most popular, feature-rich, complex |
| **Linkerd** | built-in (Rust) | built-in | Lightweight, simpler |
| **Consul Connect** | Envoy / built-in | Consul | HashiCorp ecosystem |
| **AWS App Mesh** | Envoy | AWS managed | Cloud-native |

### Sidecar Proxy

Setiap pod dapat **sidecar** — proxy kecil yang intercept semua traffic in/out. Service hanya bicara ke localhost sidecar, sidecar yang handle:

- **Load balancing** (round-robin, least-connections, weighted)
- **Circuit breaking** (per service, per instance)
- **Retry & timeout** (configurable via YAML, no code change)
- **mTLS** (mutual TLS antar service, automatic cert rotation)
- **Distributed tracing** (auto-inject trace headers)
- **Traffic splitting** (canary deploy: 5% to v2, 95% to v1)

> Di demo ini, circuit breaker & tracing di code service. Di production dengan service mesh, ini dipindah ke sidecar — service code jadi lebih simple.

---

## API Gateway vs Service Mesh

Keduanya sering dibingungkan. Mereka bekerja di **layer berbeda**:

```
                    North-South Traffic          East-West Traffic
                    (client → services)          (service ↔ service)

                         ┌─────────┐                  ┌──────────┐
  External Client ──────→│  API    │                  │ Service  │
                         │ Gateway │                  │   Mesh   │
                         └────┬────┘                  └────┬─────┘
                              │                            │
                    ┌─────────┴──────────┐    ┌────────────┴────────────┐
                    │  Auth, rate limit  │    │ mTLS, circuit breaker,  │
                    │  routing, CORS     │    │ retry, tracing, LB      │
                    │  aggregation       │    │ (service-to-service)    │
                    └────────────────────┘    └─────────────────────────┘
```

| Aspek | API Gateway | Service Mesh |
|-------|-------------|-------------|
| **Traffic** | North-South (client → services) | East-West (service ↔ service) |
| **Layer** | Edge of system | Inside system (between services) |
| **Concerns** | Auth, rate limit, CORS, routing, aggregation | mTLS, circuit breaking, retry, tracing |
| **Deploy** | 1 instance (or few, LB'd) | Sidecar per pod |
| **Code change** | Service tidak tahu gateway | Service tidak tahu mesh |
| **Contoh** | Kong, AWS API Gateway, Nginx | Istio, Linkerd, Consul Connect |

> Mereka **complementary**, bukan either/or. Banyak system pakai keduanya: gateway di edge, mesh di internal.

---

## When to Use Microservices (and When NOT To)

### ✅ Use microservices when

- **Tim besar** (>50 engineers) — butuh parallel development tanpa conflict
- **Scale berbeda** — user-service butuh 10 instance, payment-service butuh 2
- **Domain jelas** — bounded context sudah well-defined
- **Deploy independence** — bisa deploy payment tanpa deploy user
- **Tech diversity** — payment butuh Go (performance), auth butuh Python (ML)
- **Fault isolation** — 1 service down tidak menumbangkan semua

### ❌ Jangan pakai microservices when

- **Tim kecil** (<10 engineers) — operational overhead > benefit
- **Startup early stage** — speed > scalability, monolith lebih cepat
- **Domain belum jelas** — belum tahu boundary, nanti refactoring mahal
- **Simple CRUD app** — tidak ada kompleksitas yang perlu dipecah
- **Low traffic** — tidak butuh independent scaling
- **Tidak ada DevOps maturity** — monitoring, CI/CD, container orchestration belum ada

> **Martin Fowler's advice**: "Start with a monolith. Extract microservices only when the monolith becomes painful." Banyak successful companies (Stack Overflow, Basecamp) tetap monolith.

---

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Independent deploy** — deploy 1 service tanpa redeploy semua
- **Independent scaling** — scale service yang butuh, bukan semua
- **Fault isolation** — 1 service down ≠ semua down (dengan circuit breaker)
- **Tech diversity** — setiap service bisa pakai tech stack terbaik untuk domain-nya
- **Team autonomy** — tim ownership jelas, parallel development
- **Easier to reason about** — service kecil lebih mudah dipahami daripada monolith besar

### ❌ Kekurangan

- **Network complexity** — setiap call = network hop (latency, failure, retry)
- **Distributed system hard** — partial failure, eventual consistency, debugging
- **Operational overhead** — monitoring, tracing, CI/CD per service
- **Data consistency** — tidak ada ACID cross-service, perlu saga pattern
- **Testing harder** — integration test across services, contract testing
- **Deployment complexity** — Docker, Kubernetes, service mesh, dll
- **Latency** — network call > function call (dari μs ke ms)

---

## Cara Coba

```bash
# Run demo (auto-starts both services in same process)
npx tsx 12-microservices/demo.ts

# Demo menunjukkan 4 phase:
# 1. Normal flow — order-service calls user-service, circuit breaker CLOSED
# 2. Failures — user-service returns 500, breaker trips to OPEN
# 3. Fast-fail — breaker OPEN, 503 returned without calling user-service
# 4. Recovery — user-service healthy, breaker HALF_OPEN → CLOSED

# Atau jalankan services terpisah (untuk eksplorasi manual):
# Terminal 1 — user-service
npx tsx 12-microservices/user-service.ts

# Terminal 2 — order-service
npx tsx 12-microservices/order-service.ts

# Terminal 3 — test manual
curl http://localhost:3022/orders/o1
curl http://localhost:3021/users/u1
curl http://localhost:3021/health

# Simulasi failure manual
curl -X POST http://localhost:3021/control/fail
curl http://localhost:3022/orders/o1   # → 502 (user-service returns 500)
curl -X POST http://localhost:3021/control/healthy
curl http://localhost:3022/orders/o1   # → 200 (recovered)
```

## Struktur File

```
12-microservices/
  service-registry.ts  → Service discovery (register, discover, heartbeat, health check)
  circuit-breaker.ts   → Circuit breaker pattern (CLOSED, OPEN, HALF_OPEN state machine)
  tracing.ts           → Distributed tracing (trace ID, span ID, propagation, trace tree)
  user-service.ts      → Backend microservice (users, health, fail simulation)
  order-service.ts     → Microservice yang call user-service via circuit breaker + tracing
  demo.ts              → Orchestrator: 4-phase demo (normal → fail → fast-fail → recover)
  README.md            → Penjelasan ini
```
