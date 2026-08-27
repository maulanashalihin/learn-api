# 16 — Distributed Transactions

## Apa itu Distributed Transaction?

**Distributed transaction** = transaksi yang span **multiple resources/services** — misal update database A + database B + kirim message ke queue, semua harus berhasil bareng atau gagal bareng (atomic).

Di monolith dengan 1 database, ACID mudah: `BEGIN ... COMMIT` — database jamin atomic. Di microservices / sistem terdistribasi, setiap service punya **DB sendiri**, dan message bus adalah sistem lain. Tidak ada satu coordinator yang bisa mengunci semua resource sekaligus dengan jaminan atomic跨-system.

```
MONOLITH (1 DB):                    MICROSERVICES (N DB + bus):

  ┌─────────────┐                    Order DB    Payment DB   Stock DB
  │  App        │                    ┌──────┐    ┌──────┐     ┌──────┐
  │  BEGIN      │                    │order │    │pay   │     │stock │
  │  update A   │  ← 1 tx, ACID      └──────┘    └──────┘     └──────┘
  │  update B   │                       ▲            ▲            ▲
  │  update C   │                       └─── network ┴────────────┘
  │  COMMIT     │                            tidak ada 1 tx global
  └─────────────┘
```

### ACID di single DB vs distributed ACID

| Properti | Single DB (mudah) | Distributed (sulit) |
|----------|-------------------|---------------------|
| **Atomicity** | `COMMIT`/`ROLLBACK` 1 DB | Butuh coordinator + protocol (2PC) atau saga |
| **Consistency** | Constraints, FK, triggers | Harus dijaga application-level cross-service |
| **Isolation** | Row locks, MVCC, isolation level | Tidak ada! intermediate state terlihat (saga) |
| **Durability** | WAL, fsync | Tiap service jamin sendiri; consensus untuk replicated |

> Inti: **Isolation** paling sulit di distributed. Di single DB, `SERIALIZABLE` mencegah read intermediate. Di distributed, tidak ada lock global — client bisa lihat "order created tapi belum paid".

---

## Two-Phase Commit (2PC)

2PC = protocol consensus paling klasik. **1 coordinator** + **N participants** (masing-masing pegang resource). Dua fase:

```
Coordinator                    Participant A   Participant B   Participant C
     │
     │  Phase 1: PREPARE ──────→│               │               │
     │                          │ vote YES/NO   │ vote YES/NO   │ vote YES/NO
     │←─────────────────────────│               │               │
     │  (collect all votes)
     │
     │  all YES?
     │  ├── YES → Phase 2: COMMIT ──→│ commit │ commit │ commit
     │  └── NO  → Phase 2: ABORT  ──→│ abort  │ abort  │ abort
     │
     │←── ACK ──────────────────│               │               │
```

### State machine

```
Participant:    IDLE ──PREPARE+YES──→ PREPARED (🔒lock) ──COMMIT──→ COMMITTED
                  │                        │
                  └──PREPARE+NO──→ ABORTED  └──ABORT──→ ABORTED

Coordinator:    IDLE → PREPARING → (all YES?) → PREPARED → COMMITTING → DONE
                                       │
                                       └── any NO → ABORTING → DONE
```

### Skenario di demo ini

1. **Semua YES → COMMIT** — semua participant COMMITTED, lock dilepas. ✓
2. **Satu NO → ABORT** — participant B vote NO, semua ABORTED (rollback). ✓
3. **Coordinator crash setelah Phase 1** — participants stuck di PREPARED, **lock dipegang**, tidak bisa memutuskan commit/abort sendiri. **BLOCKING PROBLEM**.
4. **Participant crash setelah YES** — coordinator blocked menunggu ACK. Recovery: participant hidup lagi, baca durable log (PREPARED, decision unknown), **butuh coordinator** memberitahu decision.

### The Blocking Problem (kenapa 2PC tidak populer)

```
Coordinator crash setelah semua vote YES:

  Participant A: PREPARED 🔒lock   ┐
  Participant B: PREPARED 🔒lock   ├─ TIDAK TAHU commit atau abort
  Participant C: PREPARED 🔒lock   ┘   → menunggu coordinator hidup lagi
                                        → lock dipegang selama itu
                                        → resource unavailable
```

Participant yang vote YES **tidak bisa menyimpulkan** keputusan sendiri:

- Mungkin coordinator sudah kirim COMMIT ke participant lain sebelum crash → kalau saya abort, inconsistent.
- Mungkin coordinator belum kirim apa-apa → kalau saya commit, inconsistent.

Jadi **harus block** sampai coordinator recovery. Ini berarti resource terkunci tak terbatas → throughput turun, deadlock risk.

### Real-world 2PC

| Implementasi | Notes |
|--------------|-------|
| **XA** | X/Open standard untuk 2PC cross-resource (DB + JMS) |
| **JTA** | Java Transaction API — `UserTransaction`, `XAResource` |
| **Java EE / Jakarta** | App server manage XA transactions (Wildfly, WebLogic) |
| **PostgreSQL prepared tx** | `PREPARE TRANSACTION 'xid'` — 2PC participant side |

> 2PC jarang dipakai di microservices modern: blocking + synchronous + butuh XA-compatible resources. Lebih sering di monolith dengan multiple DB / DB+JMS.

---

## Three-Phase Commit (3PC)

3PC menambah fase **PreCommit** di antara Prepare dan Commit untuk mengatasi blocking problem 2PC.

```
Phase 1: CanCommit?   — coordinator tanya "kamu bisa commit?" → vote (NO LOCK yet)
Phase 2: PreCommit    — kalau semua YES → coordinator bilang "siap-siap commit"
                        semua participant ACK → SEMUA tahu consensus tercapai
Phase 3: DoCommit     — coordinator bilang "commit!" → participant commit
```

### Kenapa non-blocking?

Setelah **PreCommit**, semua participant tahu bahwa **semua sudah vote YES**. Jadi kalau coordinator crash:

- Sudah lewat PreCommit → participant bisa saling bertanya / pilih leader → **menyimpulkan COMMIT** (karena PreCommit hanya terjadi kalau semua setuju).
- Belum lewat PreCommit → **menyimpulkan ABORT** (belum ada consensus).

Tidak ada participant yang stuck tanpa keputusan → **non-blocking**.

### Kenapa 3PC jarang dipakai?

| Masalah | Detail |
|---------|--------|
| **Lebih lambat** | 3 round-trip vs 2PC 2 round-trip |
| **Asumsi network ideal** | Butuh synchronous + bounded delay + no partition |
| **Network partition = inconsistent** | Quorum terpisah bisa ambil keputusan beda (split-brain) |
| **Paxos/Raft lebih robust** | Consensus algorithm yang toleran partition → lebih populer |

> 3PC menyelesaikan crash failure tapi **tidak menyelesaikan network partition**. Di dunia real (network bisa partition), Paxos/Raft (module berikutnya) lebih aman. Karena itu 3PC lebih teoritis daripada praktis.

---

## Saga Pattern

Saga = **rangkaian local transactions**, masing-masing di 1 service (ACID lokal). Tidak ada ACID global. Kalau satu langkah gagal, jalankan **compensating transaction** (semantic undo) untuk langkah yang sudah sukses — **urutan terbalik**.

```
Order Saga (e-commerce):

  FORWARD (semua sukses):
    [1] Create Order    → [2] Reserve Stock → [3] Charge Payment → [4] Ship
     (commit)             (commit)            (commit)            (commit)
                                                                       ↓
                                                                  CONFIRMED

  FAILURE (step 3 gagal):
    [1] Create Order    → [2] Reserve Stock → [3] Charge Payment ✗
     (commit)             (commit)            (DECLINED)
                            ↓ COMPENSATION (reverse) ↓
                          [2] Release Stock ← [1] Cancel Order
                          (semantic undo)    (semantic undo)
                                                              → CANCELLED
```

### Compensating Transaction ≠ Rollback

| Rollback (single DB) | Compensating Transaction (saga) |
|----------------------|---------------------------------|
| Undo perubahan fisik (restore row) | **Semantic undo** — jalankan aksi baru yang "membatalkan" efek |
| `ROLLBACK` — data kembali ke state sebelum | Data TIDAK kembali — ada jejak (order CANCELLED, payment REFUNDED) |
| Atomic dengan tx asli | Transaksi baru, terpisah |

Contoh: tidak bisa "un-charge" kartu kredit. Compensation = **refund** (transaksi baru). Tidak bisa "un-send" email. Compensation = kirim email "maaf, batalkan".

### Choreography vs Orchestration

```
CHOREOGRAPHY (decentralized):       ORCHESTRATION (central):

  OrderService                        Orchestrator
    │ emit OrderCreated                  │ [1] call OrderService
    ▼                                    │ [2] call StockService
  StockService                           │ [3] call PaymentService ✗
    │ emit StockReserved                 │ ↩ compensate [2], [1]
    ▼                                    │
  PaymentService                         ▼
    │ emit PaymentCharged             (central brain tahu
    ▼                                  urutan + compensation)
  ShippingService

  + No central SPOF                   + Flow jelas, mudah trace
  + Service loose-coupled             + Compensation logic terpusat
  - Flow sulit dilacak               - Orchestrator = SPOF + coupling
  - Cyclic dependency risk           - Service tahu orchestrator
```

| Aspek | Choreography | Orchestration |
|-------|--------------|---------------|
| **Koordinator** | Tidak ada (event-driven) | Central orchestrator |
| **Coupling** | Loose (via event) | Tighter (orchestrator call) |
| **Traceability** | Sulit (follow event chain) | Mudah (1 log orchestrator) |
| **Cyclic dependency** | Bisa terjadi (A→B→A) | Tidak (orchestrator 1 arah) |
| **Business logic** | Tersebar di tiap service | Terpusat di orchestrator |
| **SPOF** | Tidak | Orchestrator |
| **Cocok untuk** | Saga sederhana, sedikit step | Saga kompleks, banyak step |

> Demo ini implementasi keduanya: `OrderSagaOrchestrator` (central) dan `OrderSagaChoreography` (event-driven).

### Isolation di Saga (masalah besar)

Saga **tidak punya isolation global**. Intermediate state terlihat oleh client/concurrent transaction:

```
T1: Create Order (status=CREATED) ────────────→ ... → CONFIRMED
                    ↑
T2: baca order ────┘ lihat status=CREATED (belum paid!)
    → mungkin kirim "order pending" email, atau buat decision salah
```

**Counterfeit saga** / anomaly yang muncul:

| Anomaly | Apa | Contoh |
|---------|-----|--------|
| **Lost update** | T2 overwrite T1 intermediate | T2 update stock saat T1 reserve |
| **Dirty read** | T2 baca state belum committed-final | Lihat order CREATED (belum paid) |
| **Non-repeatable read** | Baca 2x dapat hasil beda | Order CREATED → CANCELLED di tengah |

**Mitigasi (saga isolation levels):**

- **Semantic lock** — tandai record sebagai "pending" (`status=PENDING`); consumer tahu belum final.
- **Commutative updates** — design operasi urutan-independent (append, tidak overwrite).
- **Pessimistic view** — re-order step agar anomaly tidak critical.
- **Reread value** — baca ulang sebelum commit lokal, validasi tidak berubah.
- **Version number** — optimistic concurrency control (`version` field).

> Di demo, `OrderRecord.status` (`CREATED` → `CONFIRMED`/`CANCELLED`) adalah **semantic lock** sederhana — client bisa lihat status dan tahu order belum final.

### Real-world Saga

| Tool | Tipe | Notes |
|------|------|-------|
| **Temporal** | Orchestration | Durable workflow engine, replay-safe (Uber Cadence successor) |
| **Camunda / Zeebe** | Orchestration | BPMN workflow engine |
| **AWS Step Functions** | Orchestration | Serverless state machine |
| **Eventuate Tram** | Both | Saga framework (Chris Richardson) |
| **Narayana LRA** | Orchestration | Long Running Actions (microprofile) |
| **Axon Framework** | Choreography | Event-sourcing + saga |

---

## Transactional Outbox Pattern

### Masalah: Dual-Write

App mau **update DB** + **publish event** ke message bus (Kafka/RabbitMQ). Tidak bisa atomic跨 2 system:

```
DUAL-WRITE (BERBAHAYA):

  Opsi 1: DB dulu, lalu publish
    1. UPDATE orders SET ...     ← COMMIT (sukses)
    2. publish(event)            ← GAGAL (network/bus down)
    → DB updated, event HILANG. Downstream tidak tahu order ini ada.

  Opsi 2: publish dulu, lalu DB
    1. publish(event)            ← sukses
    2. UPDATE orders SET ...     ← GAGAL (DB down)
    → event palsu di bus. Downstream proses order yang tidak ada di DB.

  Opsi 3: XA 2PC (DB + bus)      ← blocking, lambat, bus jarang support XA.
```

### Solusi: Outbox

Tulis **perubahan DB + row ke tabel outbox** dalam **SATU DB transaction** (atomic, lokal). Process terpisah (poller/relay) baca outbox, publish ke bus, mark row published.

```
       App                          DB                         Bus
        │                            │                          │
        │  BEGIN tx                  │                          │
        ├─→ INSERT orders            │                          │
        ├─→ INSERT outbox (event)    │  ← 1 tx, atomic          │
        │  COMMIT                    │                          │
        │                            │                          │
        │                            │  ← poller baca PENDING ──→│ publish
        │                            │  ← mark PUBLISHED        │ (idempotent)
```

Karena order + outbox event ditulis dalam **1 transaction DB**, keduanya commit bareng atau rollback bareng. Tidak ada lagi "DB updated tapi event hilang".

### Komponen di demo

| Komponen | Role | Production equivalent |
|----------|------|----------------------|
| `Database` (with tx) | Simulasi DB dengan begin/commit | PostgreSQL, MySQL |
| `OrderService.createOrderWithOutbox` | App tulis order + outbox atomic | Application service |
| `OutboxPoller` | Baca PENDING, publish, mark done | Debezium CDC / worker poll |
| `MessageBus` | Penerima event (idempotent) | Kafka, RabbitMQ, EventBridge |

### Poller vs CDC

```
POLLER (query-based):              CDC (log-based, Debezium):

  Poller                           Debezium connector
    │ loop every N seconds           │ read DB WAL / binlog
    ├─ SELECT * FROM outbox          │ (row-level change stream)
    │  WHERE status='PENDING'        │
    ├─ publish each                  ├─ publish change event
    └─ UPDATE status='PUBLISHED'     └─ (no status column needed)
    
  + Simple, no infra                 + Low latency (real-time)
  + Any DB                           + No polling load on DB
  - Polling interval = latency       + Exactly-once via WAL position
  - DELETE old rows (cleanup)        - Butuh WAL access (Postgres/MySQL)
  - Load pada DB (query berulang)    - Infra lebih kompleks
```

### Idempotency (penting!)

Outbox **guarantee at-least-once delivery**, bukan exactly-once. Poller bisa publish event yang sama 2x (crash setelah publish, sebelum mark PUBLISHED → restart → publish lagi). Jadi **consumer harus idempotent**:

- **Event ID** — consumer track `eventId` yang sudah diproses, skip duplikat.
- **Business idempotency** — operasi commutative (refund 2x = tetap 1 refund via idempotency key).

Di demo, `MessageBus.publish` track `eventId` di `Set` → publish ulang eventId sama = skip (idempotent).

### Real-world Outbox

| Tool | Cara | Notes |
|------|------|-------|
| **Debezium** | CDC via WAL/binlog | Gold standard, Kafka Connect connector |
| **EventBridge** | CDC / poller | AWS managed, lambda relay |
| **Poller worker** | Query `outbox` table | Simple, butuh cleanup + indexing |
| **Knex/Prisma + outbox** | App-side, 1 tx | Library pattern, no CDC |

---

## Idempotency di Distributed Transactions

Idempotency = **operasi yang dijalankan N kali memberi hasil sama dengan 1 kali**. Critical di distributed transaction karena retry crash recovery bisa menyebabkan eksekusi berulang.

| Pattern | Cara | Contoh |
|---------|-----|--------|
| **Idempotency key** | Client kirim unique key; server track | Stripe: `Idempotency-Key` header |
| **Event ID dedup** | Consumer simpan eventId processed | Outbox consumer skip duplikat |
| **Version/Optimistic lock** | `WHERE version = X` di UPDATE | Cegah lost update |
| **Commutative state** | Design operasi urutan-independent | Balance += amount (bukan SET balance) |
| **State machine** | Cek status sebelum aksi | `if (order.status !== 'PAID') charge()` |

> Tanpa idempotency, retry = double-charge, double-ship, double-refund. **Selalu design idempotent dari awal** di distributed transaction.

---

## Perbandingan Pola

| Pola | Atomicity | Isolation | Performance | Failure mode | Complexity |
|------|-----------|-----------|-------------|--------------|------------|
| **2PC** | Strong (atomic) | Strong (lock) | Lambat (sync, blocking) | Blocking (coordinator crash) | Medium |
| **3PC** | Strong | Strong | Lebih lambat (3 RTT) | Non-blocking crash, tapi partition unsafe | Tinggi |
| **Saga** | Eventual (compensation) | Tidak ada (semantic lock) | Cepat (async) | Compensation, eventual consistent | Medium |
| **Outbox** | Atomic DB+event (local) | N/A (bukan tx protocol) | Cepat (async publish) | At-least-once (idempotent consumer) | Rendah |

### Kapan pakai yang mana?

```
Butuh atomicity跨 multiple DB/resource, bisa tolerir blocking?
  → 2PC (XA/JTA) — monolith multi-DB, DB+JMS

Butuh atomicity tapi tidak bisa tolerir blocking, async OK?
  → Saga — microservices, long-running business process

Cuma mau publish event reliably setelah DB update?
  → Outbox — selalu! Ini building block, bukan alternatif saga

Butuh consensus yang toleran partition?
  → Paxos / Raft (module berikutnya) — bukan 2PC/3PC
```

> **Outbox dan Saga saling melengkapi**: Saga step = local tx + outbox event. Outbox memastikan event saga terkirim reliably. Bukan either/or.

---

## Kelebihan & Kekurangan

### 2PC

```
+ Strong atomicity (real ACID跨 resource)
+ Isolation via lock
+ Simple conceptually (2 fase)
- BLOCKING: coordinator crash = participant stuck, lock held
- Synchronous: semua participant harus nunggu, throughput turun
- Butuh XA-compatible resources
- Tidak scale untuk banyak participant
- Coordinator = SPOF
```

### 3PC

```
+ Non-blocking (crash failure)
+ Participant bisa menyimpulkan keputusan tanpa coordinator
- 3 round-trip (lebih lambat)
- TIDAK aman terhadap network partition (split-brain)
- Asumsi synchronous network (unrealistic)
- Jarang diimplementasi → Paxos/Raft lebih populer
```

### Saga

```
+ Async, high throughput (no global lock)
+ Toleran failure (compensation)
+ Cocok microservices (each service own tx)
+ Long-running transaction OK
- TIDAK ada isolation (intermediate state visible)
- Compensation = semantic undo, bukan rollback (jejak tetap ada)
- Complex to reason about (many partial states)
- Choreography sulit trace; orchestration = SPOF
- Tidak ada automatic rollback — harus design compensation manual
```

### Outbox

```
+ Atomic DB + event (solve dual-write)
+ Reliable event delivery (at-least-once)
+ Decouple write path from publish path
+ Works with any DB
- At-least-once (butuh idempotent consumer)
- Poller = latency; CDC = infra complexity
- Outbox table grow (butuh cleanup/retention)
- Ordering: event order vs publish order (per partition)
```

---

## Cara Menjalankan

```bash
# Jalankan semua demo (2PC + Saga + Outbox)
npx tsx 16-distributed-transactions/demo.ts

# Atau via script (setelah parent agent tambahkan ke package.json)
npm run distx
```

### Yang akan tampil

1. **2PC** — 4 skenario: commit, abort, coordinator crash (blocking), participant crash + recovery
2. **3PC** — konsep non-blocking (explain)
3. **Saga** — orchestration (forward + failure/compensation) + choreography (forward + failure)
4. **Outbox** — dual-write problem (anti-pattern) + outbox solution (atomic write + poll + publish + idempotency)

### File

| File | Isi |
|------|-----|
| `two-phase-commit.ts` | Coordinator + Participant class, 2PC algorithm, 3PC konsep |
| `saga.ts` | OrderSagaOrchestrator + OrderSagaChoreography, World state |
| `outbox.ts` | Database (with tx), OrderService, OutboxPoller, MessageBus |
| `demo.ts` | Orkestrasi semua skenario + print state transitions |
| `README.md` | Konsep + code walkthrough (ini) |

---

## Code Walkthrough

### 2PC (`two-phase-commit.ts`)

```typescript
// Participant: vote YES → lock + write durable log "PREPARED"
prepare(): Vote {
  const vote = this.behavior.vote?.() ?? "YES";
  if (vote === "YES") {
    this.lockHeld = true;          // tahan lock
    this.log.preparedLogged = true; // durable log
    this.state = "PREPARED";
  }
  return vote;
}

// Coordinator: Phase 1 collect votes, Phase 2 commit/abort
run(participants): TwoPhaseResult {
  // Phase 1: PREPARE
  for (const p of participants) votes.set(p, p.prepare());
  const allYes = [...votes.values()].every(v => v === "YES");

  // Crash injection: coordinator mati setelah Phase 1 → blocking
  if (allYes && this.behavior.crashAfterAllYes) { ... return BLOCKED; }

  // Phase 2: COMMIT (all yes) atau ABORT (any no)
  if (allYes) { for (const p of participants) p.commit(); }
  else        { for (const p of participants) p.abort(); }
}
```

Kunci blocking problem: kalau coordinator crash setelah semua vote YES, participant di state PREPARED dengan lock — `recover()` re-acquire lock, dan **butuh coordinator** (`applyDecision`) untuk tahu commit/abort.

### Saga (`saga.ts`)

```typescript
// Orchestration: step berurutan, push ke stack, compensate reverse
async execute(...) {
  this.done.push({ step: "CreateOrder", compensate: () => this.cancelOrder(...) });
  this.done.push({ step: "ReserveStock", compensate: () => this.releaseStock(...) });
  if (!chargePayment(...)) return this.compensate("FAILED", ...);
}

private compensate(...) {
  while (this.done.length > 0) {       // pop = reverse order
    const { compensate } = this.done.pop()!;
    compensate();                       // semantic undo
  }
}
```

Compensation = **stack pop** → urutan terbalik otomatis. `releaseStock` dan `cancelOrder` adalah **compensating transactions** (transaksi baru yang membatalkan efek), bukan rollback.

### Outbox (`outbox.ts`)

```typescript
// Atomic: order + outbox event dalam 1 DB transaction
createOrderWithOutbox(customer, amount) {
  this.db.begin();
  this.db.writeOrder({ id, customer, amount, status: "NEW", ... });
  this.db.writeOutbox({ id: eventId, aggregateId: id, eventType: "OrderCreated", status: "PENDING", ... });
  this.db.commit();  // atomic — keduanya bareng atau rollback bareng
  return id;
}

// Poller: baca PENDING, publish (idempotent), mark PUBLISHED
pollOnce() {
  for (const row of this.db.getOutbox("PENDING")) {
    this.bus.publish({ eventId: row.id, ... });  // idempotent via eventId
    this.db.markPublished(row.id);
  }
}
```

`MessageBus.publish` track `eventId` di `Set` → publish ulang eventId sama = no-op. Inilah **idempotency** yang membuat at-least-once delivery aman.

---

## Kesimpulan

Distributed transaction adalah trade-off antara **consistency** dan **availability/performance** (CAP theorem):

- **2PC** pilih consistency + isolation, bayar dengan blocking + synchronous.
- **3PC** coba perbaiki blocking, tapi gagal di partition.
- **Saga** pilih availability + performance, bayar dengan eventual consistency + no isolation.
- **Outbox** bukan tx protocol, tapi **building block** yang solve dual-write — dipakai bersama saga.

> Aturan praktis: **Outbox selalu** (reliable event), **Saga untuk cross-service business process**, **2PC hanya kalau butuh strong consistency跨 few XA resources dan bisa tolerir blocking**, **Paxos/Raft untuk consensus yang partition-tolerant**.

Berikutnya: **Consensus (Paxos/Raft)** — bagaimana cluster node mencapai agreement tanpa coordinator, toleran terhadap crash DAN partition.
