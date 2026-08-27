# 11 — Event-Driven Architecture (Event Sourcing + CQRS)

## Apa itu Event-Driven Architecture?

**Event-Driven Architecture (EDA)** adalah gaya arsitektur di mana komponen berkomunikasi lewat **event** — fakta yang sudah terjadi di masa lalu ("TaskCreated", "PaymentReceived"). Komponen producer memancarkan event tanpa peduli siapa yang mendengar; komponen consumer bereaksi terhadap event tersebut.

Berbeda dengan **request-driven** (REST: client minta, server jawab), di EDA alurnya **one-way**: sesuatu terjadi → event dipancarkan → pihak yang tertarik bereaksi. Ini membuat sistem **decoupled** — producer tidak tahu (dan tidak peduli) ada berapa consumer.

Modul ini fokus ke dua pattern yang dibangun di atas EDA: **Event Sourcing** dan **CQRS**.

```
REQUEST-DRIVEN (REST):              EVENT-DRIVEN:

  Client ──request──→ Server          Producer ──event──→ ??? (siapa saja)
  Client ←─response── Server          Consumer subscribe, reaksi async
  Tight coupling                      Loose coupling
  Sync                                Async / eventual
```

## Event Sourcing: simpan event, bukan state

Pada aplikasi CRUD biasa, kita simpan **state terakhir** di database:

```
tasks table:
  id    | title              | done
  t1    | Belajar ES         | true     ← state terakhir, history hilang
```

**Event Sourcing** membalik logikanya: simpan **event** (apa yang terjadi), dan bangun state dengan **replay** event.

```
event_store (append-only log):
  v1  TaskCreated    { title: "Belajar ES" }
  v2  TaskCompleted  {}
  v3  TaskReopened   {}

State dibangun ulang: replay v1 → v2 → v3 → { title: "Belajar ES", done: false }
```

### Kenapa simpan event, bukan state?

| Simpan state (CRUD) | Simpan event (Event Sourcing) |
|---------------------|-------------------------------|
| Hanya lihat hasil akhir | Lihat **seluruh history** |
| Update = overwrite (data lama hilang) | Append-only (tidak pernah hilang) |
| Audit trail = tabel log terpisah | Audit trail = event log itu sendiri |
| Sulit "undo" / "time travel" | Bisa replay ke titik waktu manapun |
| Schema state = schema query | Schema state lepas dari schema query |

### Aggregate: state = fold(events, apply)

**Aggregate** adalah entitas domain yang state-nya dibangun dari replay event. Inti event sourcing adalah persamaan:

```
state = fold(eventLog, apply)
```

Di code ini (`command-handler.ts`):

```ts
class TaskAggregate {
  state: TaskState  // { id, title, done, version, exists }

  // Pure mutation: terapkan satu event ke state
  apply(event: DomainEvent) {
    switch (event.type) {
      case "TaskCreated":   this.state.title = event.data.title; ...
      case "TaskCompleted": this.state.done = true; ...
      case "TaskRenamed":   this.state.title = event.data.title; ...
    }
    this.state.version = event.version;
  }

  // Bangun aggregate dari awal dengan replay semua event-nya
  static fromEvents(id, events) {
    const agg = new TaskAggregate(emptyState(id));
    for (const e of events) agg.apply(e);   // ← fold
    return agg;
  }
}
```

`apply` adalah **pure function** — tidak ada side effect, hanya mutasi state in-memory. Inilah yang membuat replay aman dan deterministik.

## CQRS: pisahkan write model dari read model

**CQRS** (Command Query Responsibility Segregation) = pisahkan operasi **write** (command) dari operasi **read** (query) ke dalam model yang berbeda.

```
CRUD (satu model):                CQRS (dua model):

  ┌─────────────┐                  Write side              Read side
  │  Same Model │                  ┌──────────┐            ┌──────────────┐
  │  read+write │                  │ Command  │            │  Projection  │
  │             │                  │ Handler  │──event──→  │  (read model)│
  └─────────────┘                  │  ↓ event │            │  ↓ query     │
  Optimize for both?               │ EventStore│←─replay── │              │
  Compromise.                      └──────────┘            └──────────────┘
                                   Optimize write          Optimize read
```

Tanpa CQRS, satu model harus melayani write (validasi, invariant) DAN read (filter, join, pagination) — sering kompromi. Dengan CQRS, write model dioptimalkan untuk konsistensi & invariant bisnis, read model dioptimalkan untuk query cepat.

### Command vs Event vs State

Tiga konsep ini sering tertukar. Bedanya:

| Konsep | Apa | Arah | Contoh | Bisa ditolak? |
|--------|-----|------|--------|---------------|
| **Command** | Intent / permintaan "lakukan X" | Masa depan | `CompleteTask(t1)` | ✅ Bisa (kalau invalid) |
| **Event** | Fakta yang sudah terjadi | Masa lalu | `TaskCompleted(v2)` | ❌ Tidak (sudah terjadi) |
| **State** | Snapshot aggregate saat ini | Sekarang | `{ title, done: true }` | — (hasil, bukan input) |

```
Command (request) ──validate──→ Event (fact) ──apply──→ State (snapshot)
   "lakukan X"        ↑              "X terjadi"          " kondisi sekarang"
                   ditolak kalau
                   melanggar invariant
```

Aturan emas: **command bisa ditolak, event tidak.** Event sudah terjadi — kamu hanya bisa bereaksi. Itu sebabnya event selalu pakai kata kerja past tense (`TaskCreated`, bukan `CreateTask`).

### Command Handler (write side)

Command handler jembatan command → event (`command-handler.ts`):

```ts
class TaskCommandHandler {
  handle(command: Command): DomainEvent {
    // 1. Load aggregate (replay event dari store)
    const agg = this.load(command.aggregateId);

    // 2. Validasi command terhadap state aggregate
    //    (mis. "tidak bisa complete task yang sudah completed")
    // 3. Tentukan event yang harus di-append
    // 4. Append ke store dengan expectedVersion = agg.state.version
    return this.store.append(..., agg.state.version);
  }
}
```

Command yang ditolak (invariant dilanggar) → throw `CommandRejectedError`, **tidak ada event yang ditulis**.

## Projections / Materialized Views

**Projection** = read model yang dibangun dengan **subscribe** ke event store. Setiap event baru → projection update view-nya. View dioptimalkan untuk query tertentu, terpisah dari write model.

Satu event log → **banyak projection**. Inilah kekuatan event sourcing: kamu bisa bikin view baru kapan saja tanpa menyentuh write side.

Di code ini (`projection.ts`) ada 3 projection dari event log yang SAMA:

| Projection | Bentuk view | Query yang dilayani |
|------------|-------------|---------------------|
| `TaskListView` | flat row per task | "list semua task", filter pending/completed |
| `TaskStatsView` | counter agregat | "berapa total, berapa selesai, completion rate" |
| `ActivityFeedView` | timeline event | "aktivitas terbaru untuk audit/dashboard" |

```ts
// Satu event log → 3 view berbeda
store.subscribe((e) => listView.handle(e));   // row detail
store.subscribe((e) => statsView.handle(e));  // counter
store.subscribe((e) => feedView.handle(e));   // timeline
```

### Event replay: rebuild projection dari nol

Karena projection dibangun murni dari event log, kamu bisa **rebuild** kapan saja: clear view, lalu replay seluruh event log. Berguna saat ganti schema projection, pindah DB, atau fix bug di projection logic.

```ts
// Reset semua view
for (const p of projections) p.clear();

// Replay seluruh event log ke setiap projection
for (const p of projections) {
  store.replayTo((e) => p.handle(e));
}
// → view kembali konsisten dengan event log
```

Demo menunjukkan ini di section 9, plus verifikasi konsistensi (stats completed == list-view completed).

## Optimistic Concurrency Control

Beberapa writer bisa membaca aggregate yang sama bersamaan. Bagaimana mencegah lost update?

**Optimistic concurrency**: tidak ada lock. Setiap event punya `version` (monoton naik per aggregate). Saat append, command handler kirim `expectedVersion` = versi yang dia kira saat ini. Event store cek: kalau mismatch → reject (`ConcurrencyError`).

```
Writer A: baca t1 @ v2 ──┐
Writer B: baca t1 @ v2 ──┤  (bersamaan)
                         │
Writer A: append(expectedVersion=2) → sukses → v3
Writer B: append(expectedVersion=2) → TOLAK (actual sudah v3)
```

Di `event-store.ts`:

```ts
append(aggregateId, type, data, expectedVersion) {
  const actual = this.currentVersion(aggregateId);
  if (expectedVersion !== actual) {
    throw new ConcurrencyError(aggregateId, expectedVersion, actual);
  }
  // ...append event dengan version = actual + 1
}
```

Writer B yang ditolak tinggal reload aggregate (dapat v3) dan retry command-nya. Lebih scalable daripada pessimistic locking.

## Eventual Consistency: write vs read side

Di CQRS, write side dan read side **terpisah**. Saat command handler append event, projection belum tentu langsung update — ada jeda.

```
t0: Command → append event ke store        (write side konsisten)
t1: Event dipublikasi ke projection         (jeda = eventual consistency)
t2: Projection update view                  (read side konsisten)
```

Di demo ini, subscriber dipanggil **synchronous** di akhir `append`, jadi jeda ~0. Tapi di production, event biasanya mengalir lewat **message bus async** (Kafka, RabbitMQ, EventBridge) → ada jeda nyata. Konsekuensi:

- Query ke read model mungkin dapat data **sedikit lama** (stale read).
- Read model bisa **rebuild** kapan saja dari event log → self-healing.
- Untuk flow yang butuh read-after-write yang kuat, baca dari write model (aggregate) langsung, bukan projection.

> Di demo, `store.subscribe(handler)` langsung memanggil handler di akhir `append` — simulasi synchronous. Di production ini diganti message bus async.

## Saga: transaksi multi-aggregate

Event sourcing bekerja per-aggregate (satu aggregate = satu consistency boundary). Tapi bisnis sering butuh operasi yang menyentuh **banyak aggregate** sekaligus (mis. "buat order → kurangi stok → tarik saldo"). Tidak ada ACID transaction跨 aggregate.

**Saga** = pattern untuk koordinasi multi-aggregate via sequence of events:

```
OrderCreated ──→ StockReserved ──→ PaymentCharged ──→ OrderConfirmed
                                       │ fail
                                       ↓
                              Compensation: StockReleased, OrderCancelled
```

Setiap step adalah command ke aggregate lain, dipicu oleh event dari step sebelumnya. Kalau ada yang gagal, saga jalankan **compensation event** (rollback logis, bukan DB rollback). Saga bisa:

- **Choreography**: tiap service reaksi ke event service lain (decoupled, tapi alur sulit dilacak).
- **Orchestration**: satu orchestrator state machine mengatur sequence (lebih eksplisit, ada single point).

> Saga tidak diimplementasikan di demo ini (fokus single-aggregate ES + CQRS), tapi konsepnya penting untuk skala production.

## Real-world: Event Store & Tooling

| Tool | Tipe | Notes |
|------|------|-------|
| **EventStoreDB** | Purpose-built event store | Stream per aggregate, optimistic concurrency native, projections built-in |
| **Apache Kafka** | Distributed event log | Event log skala besar, dipakai sebagai event store + message bus |
| **PostgreSQL** | Relational DB | Event table + `SELECT ... FOR UPDATE` atau version column untuk concurrency |
| **AWS EventBridge** | Managed event bus | Serverless event routing, at-least-once delivery |
| **RabbitMQ** | Message broker | Lebih cocok untuk command/event transport, bukan long-term store |
| **Axon Framework** | Java ES+CQRS framework | Aggregate, command bus, event bus, projection — semua wired |
| **Marten** (Postgres + .NET) | Event store on Postgres | JSONB event table, LINQ projections |

### EventStoreDB vs Kafka sebagai event store

- **EventStoreDB**: dirancang sebagai event store — stream per aggregate, optimistic concurrency via `ExpectedVersion`, built-in projections. Pilihan "native" untuk ES.
- **Kafka**: log global yang di-partition. Bisa jadi event store tapi butuh disiplin: satu topic = satu event type (atau compacted topic per aggregate), concurrency via consumer group offset. Lebih cocok kalau kamu butuh event bus skala besar sekaligus.

## Kapan pakai Event Sourcing / CQRS?

### ✅ Pakai kalau

- **Audit trail penting**: finance, healthcare, legal — harus tahu *apa, kapan, kenapa*.
- **Complex domain logic**: invariant bisnis rumit, state berasal dari banyak transisi.
- **Read patterns beragam**: butuh list, stats, timeline, search — semua dari data yang sama.
- **Time travel / replay**: debugging, undo, analisis historis, rebuild view.
- **Eventual consistency acceptable**: read model boleh sedikit lag.

### ❌ Jangan pakai kalau

- **CRUD sederhana**: kalau domain cuma create/update/delete tanpa logic, ES = over-engineering.
- **Butuh strong consistency di read**: read-after-write harus kuat → CQRS menyulitkan.
- **Tim belum familiar**: ES + CQRS punya learning curve tajam; event schema evolution, idempotency projection, eventual consistency — semua jadi tanggung jawabmu.
- **Volume event rendah & read = write**: kalau read dan write mirip volumenya dan shape-nya sama, pisah model tidak ada untungnya.

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Full audit trail**: event log = sumber kebenaran, history tidak pernah hilang (append-only).
- **Time travel**: replay event ke titik waktu manapun untuk debug/analisis.
- **Decoupled read/write**: write model fokus invariant, read model fokus query — masing-masing optimal.
- **Multiple read models**: satu event log → tak terbatas bentuk view (list, stats, search, timeline).
- **Rebuildable**: projection rusak/schema berubah? replay dari event log, tidak ada data hilang.
- **Natural integration**: event = kontrak publik antar service (event-driven microservices).
- **No object-relational impedance**: aggregate = in-memory object, bukan tabel.

### ❌ Kekurangan

- **Complexity**: event schema evolution, idempotent projection, eventual consistency, snapshotting — semua harus kamu tangani.
- **Learning curve**: konsep command/event/state, CQRS, saga tidak intuitif untuk tim CRUD.
- **Eventual consistency**: read model lag → UI bisa lihat data stale, butuh penanganan UX.
- **Storage grows**: event log monoton membesar (butuh snapshotting + archiving).
- **Query di write model sulit**: aggregate tidak dirancang untuk query → harus lewat projection.
- **Versioning event**: schema event berubah seiring waktu → butuh upcaster/migration.
- **Debugging harder**: alur tersebar di command handler + projection + bus, bukan satu stack trace.

## Cara Coba

```bash
# Run demo end-to-end
npx tsx 11-event-driven/demo.ts
```

Demo menampilkan alur lengkap:

1. **Create** 3 task → `TaskCreated` event → projections update
2. **Complete** task → `TaskCompleted` event → projections update
3. **Rename** task → `TaskRenamed` event → projections update
4. **Invalid command** (complete yang sudah completed, rename ke title sama, complete task tidak ada) → **REJECTED**
5. **Optimistic concurrency**: writer B dengan stale version → **REJECTED**
6. **Event store contents** (source of truth, append-only log)
7. **Aggregate state** rebuilt dari replay event
8. **3 projection views**: task-list, task-stats, activity-feed
9. **Rebuild projection dari scratch** + verifikasi konsistensi

Output menampilkan jelas alur: `command → event → store → projection`.

## Struktur File

```
11-event-driven/
  event-store.ts      → Append-only event log + optimistic concurrency + subscribe/replay
  command-handler.ts  → CQRS write side: TaskAggregate (event sourcing) + CommandHandler
  projection.ts       → CQRS read side: 3 projections (list, stats, activity feed)
  demo.ts             → Demo end-to-end: command → event → projection
  README.md           → Penjelasan ini
```

## Konsep Kunci (cepat)

- **Event** = fakta masa lalu, immutable, past tense (`TaskCreated`).
- **Command** = intent masa depan, bisa ditolak (`CreateTask`).
- **Aggregate** = entitas yang state-nya = `fold(events, apply)`.
- **Event Store** = append-only log, source of truth, optimistic concurrency via version.
- **Projection** = read model yang subscribe ke event log; satu log → banyak view.
- **CQRS** = pisahkan write model (command) dari read model (query).
- **Eventual consistency** = read model menyusul write model (jeda async).
- **Replay** = rebuild state/projection dari event log kapan saja.
- **Saga** = koordinasi transaksi multi-aggregate via event + compensation.
