# FAQ — Frequently Asked Questions

Pertanyaan yang sering muncul saat belajar API technologies. Dikelompokkan per level.

---

## Beginner

### REST vs GraphQL: kapan pakai yang mana?

| Kriteria | REST | GraphQL |
|----------|------|---------|
| Simple CRUD | ✅ | Overkill |
| Multiple client, kebutuhan beda | ❌ | ✅ |
| Public API (3rd party) | ✅ | Tergantung |
| Mobile (bandwidth limited) | ❌ | ✅ (less data) |
| Caching critical | ✅ | Butuh effort |
| Nested/relational complex | ❌ | ✅ |

Singkatnya: REST untuk simple + public, GraphQL untuk multiple client dengan kebutuhan field berbeda.

### Apa beda PUT dan PATCH?

- **PUT** = full replace. Kirim **semua** field. Field yang gak dikirim → di-reset.
- **PATCH** = partial update. Kirim **hanya** field yang berubah. Field lain gak tersentuh.

```bash
# PUT: harus kirim title DAN done
PUT /tasks/123  →  {"title":"Updated","done":true}

# PATCH: cukup kirim yang berubah
PATCH /tasks/123  →  {"done":true}
```

### Kenapa webhook butuh signature?

Tanpa signature, siapapun bisa POST ke URL receiver dan memalsukan event. Signature (HMAC) memastikan webhook benar dari sender, bukan attacker.

```
Sender:   HMAC-SHA256(payload, "secret") → signature
Receiver: compute ulang HMAC, compare dengan header
```

### SSE vs WebSocket: bedanya apa?

| | SSE | WebSocket |
|---|---|---|
| Direction | Server → Client saja | Bi-directional |
| Auto-reconnect | ✅ Built-in | ❌ Manual |
| Binary | ❌ Text only | ✅ |
| Complexity | Simple | Complex |

Rule of thumb: cuma butuh server push → SSE. Butuh two-way → WebSocket.

### ChatGPT pakai SSE atau WebSocket?

SSE. LLM generate token per token, push ke client via SSE stream. Client gak perlu kirim balik saat streaming — cukup terima.

---

## Intermediate

### gRPC kenapa gak support browser?

gRPC butuh raw HTTP/2 framing. Browser API (fetch, XMLHttpRequest) gak expose HTTP/2 framing control. Solusi: **gRPC-Web** — proxy yang translate HTTP/1.1 dari browser ke HTTP/2 gRPC ke server.

### "Zero codegen" di tRPC artinya apa?

Tidak ada step code generation untuk dapat type safety. gRPC butuh `protoc` (generate dari `.proto`), GraphQL butuh `graphql-codegen` (generate dari `.graphql`). tRPC tidak — TypeScript compiler saja sudah cukup.

```
gRPC:     .proto → protoc → generated code → import
GraphQL:  .graphql → graphql-codegen → generated types → import
tRPC:     router.ts → export type AppRouter → import type → done
```

### tRPC: jadi sharing same code antara frontend dan backend?

**Tidak.** Yang disharing **type saja, bukan runtime code**.

```typescript
// Server: router.ts (runtime code — handler, DB access — HANYA di server)
export const appRouter = t.router({ ... });
export type AppRouter = typeof appRouter;  // ← TYPE saja

// Client: import type (bukan runtime code)
import type { AppRouter } from "./router.js";
//     ^^^^ keyword `type` = cuma type, gak bawa handler function
```

Client tidak pernah melihat handler function atau database access. Client hanya tahu: "ada procedure `create`, input `{title: string}`, output `Task`". Itu pun cuma di compile-time.

### API Gateway vs Service Mesh: bedanya apa?

| | API Gateway | Service Mesh |
|---|---|---|
| Posisi | Client → services (north-south) | Service → service (east-west) |
| Fokus | External entry point | Internal communication |
| Contoh | Kong, AWS API Gateway | Istio, Linkerd |
| Fitur | Auth, rate limit, aggregation | mTLS, retry, circuit breaker, tracing |

Bisa pakai keduanya: Gateway untuk external, Service Mesh untuk internal.

---

## Advanced

### Message Queue vs Kafka: bedanya apa?

| | Message Queue (RabbitMQ) | Kafka |
|---|---|---|
| Model | Point-to-point: message dihapus setelah diproses | Log: message tetap ada, bisa di-replay |
| Ordering | Per queue | Per partition |
| Throughput | Medium | High |
| Replay | ❌ | ✅ |
| Use case | Task processing, RPC | Event streaming, audit log |

Singkatnya: queue = "proses dan hapus", Kafka = "append dan replay".

### Event Sourcing: kenapa simpan event bukan state?

Dengan simpan event, kamu dapat:

1. **Audit trail**: tahu persis apa yang terjadi, kapan, oleh siapa
2. **Replay**: rebuild state dari awal kapan saja
3. **Time travel**: query state di titik waktu mana pun
4. **Multiple projections**: bangun view berbeda dari event yang sama

Tradeoff: kompleks. State rebuild butuh waktu. Eventual consistency antara write & read side.

### Circuit breaker: kenapa perlu?

Tanpa circuit breaker, kalau service A call service B yang down:

1. A menunggu timeout (mis. 30 detik)
2. A hold resources (thread, connection) selama menunggu
3. A juga jadi lambat → service yang call A juga menunggu
4. Cascading failure → seluruh sistem down

Circuit breaker: setelah N failure, **stop calling** B. Fail fast (1ms). B recover → test pelan-pelan (half-open) → normal lagi.

### Microservices: kapan TIDAK pakai?

- **Tim kecil** (< 5 orang): monolith lebih produktif
- **Domain sederhana**: gak perlu split
- **Belum clear boundary**: premature decomposition = pain
- **Latency critical**: network call antar service = overhead
- **Belum punya DevOps**: microservices butuh CI/CD, monitoring, service discovery

> "Don't start with microservices. Start with a monolith, extract when pain is real." — Martin Fowler

---

## Expert

### CAP theorem: kenapa gak bisa dapat 3-3?

Karena **network partition bisa terjadi kapan saja** (cable cut, switch failure, GC pause). Saat partition, kamu harus pilih:

- **C (Consistency)**: reject write di sisi yang gak bisa sync → tidak available
- **A (Availability)**: accept write di kedua sisi → data bisa divergent → tidak consistent

Tidak ada cara untuk accept write di kedua sisi DAN tetap konsisten tanpa komunikasi antar sisi. Fisika jaringan tidak mengizinkan.

> Catatan: CAP hanya paksa pilih **saat partition**. Normal operation = dapat 3-3.

### Eventual consistency: bahaya gak?

Bahaya kalau gak sadar konsekuensinya:

- **Stale reads**: kamu tulis, lalu baca, dapat data lama
- **Conflict**: dua orang edit sama, perlu merge strategy
- **Lost update**: write terakhir menang (last-write-wins) tanpa kamu sadar

Aman kalau:

- Pakai CRDTs (auto-merge, no conflict)
- Pakai vector clocks (detect conflict, resolve manual)
- Accept stale reads untuk use case yang gak critical (mis. "likes" count)

### Raft vs Paxos: kenapa Raft lebih populer?

Paxos (1998) lebih dulu, terbukti, tapi **sulit dipahami**. Raft (2014) didesain dengan satu goal: **understandability**. Algoritma Raft lebih mudah dijelaskan, diimplementasi, dan di-debug. Hasilnya: etcd, Consul, CockroachDB semua pakai Raft.

> "Raft is Paxos with better UX." — informal

### 2PC vs Saga: kapan pakai yang mana?

| | 2PC | Saga |
|---|---|---|
| Isolation | Full (locks held) | None (intermediate states visible) |
| Blocking | Ya (coordinator crash = stuck) | Tidak |
| Rollback | Undo | Compensating action (semantic undo) |
| Performance | Slow (locks) | Fast (no locks) |
| Use case | DB internal, single DB cluster | Microservices, cross-service |

2PC untuk transaction dalam satu database cluster. Saga untuk transaction across microservices.

### Transactional Outbox: kenapa perlu?

Masalah: update database + publish event (Kafka/RabbitMQ) — gak bisa atomik across 2 systems.

```
❌ Dual-write (BISA GAGAL):
   1. DB.commit()     ← sukses
   2. Kafka.send()    ← GAGAL (network down)
   → DB updated tapi event hilang. Data inconsistent.

✅ Outbox (AMAN):
   1. DB: INSERT order + INSERT outbox_event (SAME transaction)
   2. Outbox poller: read pending events → publish → mark done
   → Kalau step 2 gagal, retry. Event gak hilang.
```

---

## Production

### walsync vs LiteFS vs rqlite: bedanya apa?

| Tool | Read | Write | Model | Multi-writer | Failover |
|------|-----:|------:|-------|:---:|:---:|
| **walsync** | 348K | 84K | Embedded + WAL ship | ❌ | Manual |
| LiteFS | 220K | 6K | FUSE + LTX | ❌ | Manual |
| rqlite | ~10K | ~5K | TCP + Raft | ❌ | Auto (Raft) |

walsync menang di read/write speed karena app pakai embedded SQLite langsung (no FUSE, no TCP). LiteFS intercept setiap write via FUSE (fsync per write). rqlite pakai TCP + Raft consensus per write.

walsync kalah di failover: manual (tidak ada consensus). rqlite punya automatic failover via Raft leader election.

### Kenapa walsync single-writer, tidak support multi-writer?

WAL shipping = primary write WAL → replica apply WAL. Kalau dua node write bersamaan, WAL conflict — tidak ada merge mechanism. Multi-writer butuh conflict resolution (CRDT, operational transform, atau consensus).

Tool yang support multi-writer: Marmot (CDC + Nats), cr-sqlite (CRDT), dqlite (Raft). Tapi semua punya overhead: CDC intercept setiap write, CRDT butuh metadata per row, Raft butuh quorum per write.

walsync pilih: single-writer, zero overhead, embedded speed. Niche = read-heavy workload dengan satu writer.

### walsync sync delay berapa ms?

~100ms median (33-210ms range). Diukur dengan 2 Singapore VPS (~20ms latency). Burst 50 writes dalam 94ms (debounced batch).

Sync delay = network latency + WAL ship time. walsync debounce WAL changes (50ms default) untuk batch multiple writes into one ship. Jadi single write = ~50ms debounce + ~20ms network = ~70ms. Burst = satu ship untuk semua.

---

## General

### 16 teknologi ini, mana yang paling sering dipakai di production?

Top 5 paling common:

1. **REST** — hampir semua public API
2. **Webhooks** — Stripe, GitHub, Slack integrations
3. **Message Queues** — async task processing (email, notifications)
4. **Kafka** — event streaming, analytics pipelines
5. **API Gateway** — microservices entry point

Sisanya untuk use case spesifik: gRPC (internal high-perf), tRPC (TS monorepo), WebSocket (chat), Raft (distributed consistency).

### Project ini pakai in-memory, bukan database beneran. Kenapa?

Fokus belajar **konsep dan algoritma**, bukan infrastructure setup. In-memory cukup untuk paham:

- REST: HTTP method + status code
- Kafka: partition + consumer group + replay
- Raft: leader election + log replication

Untuk production: ganti in-memory store dengan PostgreSQL, Redis, RabbitMQ, Kafka, etcd. Konsep tetap sama.

### Urutan belajar yang recommended?

1. **REST** dulu (fondasi)
2. **GraphQL** (bandingkan dengan REST)
3. **SSE** (real-time push, simple)
4. **WebSocket** (real-time two-way)
5. **Message Queues** (async processing)
6. **Kafka** (event streaming)
7. **API Gateway** (microservices)
8. **Microservices** (circuit breaker, tracing)
9. **Distributed Systems** (CAP, consistency)
10. **Consensus** (Raft)
11. Sisanya sesuai kebutuhan

### Bisakah saya skip Expert level?

Ya, untuk sebagian besar application developer. Expert level relevan kalau:

- Build distributed database / storage system
- Work di infrastructure team (Kubernetes, etcd)
- Design system yang butuh strong consistency across nodes
- Research distributed systems

Application developer biasanya cukup sampai Advanced: pakai Kafka, RabbitMQ, API Gateway, circuit breaker. Consensus dan CAP theorem = nice to know, jarang harus implement sendiri.
