# Learn API — Hands-on API Technologies

Project belajar **API technologies** dari Beginner sampai Production. Setiap teknologi punya working code (server + client) + README penjelasan konsep. Bukan teori doang — semua code sudah di-test dan verified jalan.

## Highlights

| Resource | Isi |
|----------|-----|
| [Learning Map](#learning-map) | 17 modul dari Beginner sampai Production |
| [Comparison Matrix](#comparison-matrix) | 8 teknologi vs 9 dimensi |
| [Decision Guide](#decision-guide--which-api-tech-should-i-use) | Flowchart: "tech mana yang harus saya pakai?" |
| [Scalability Rating](docs/scalability-rating.md) | 18 teknologi dirating across 5 dimensi scalability |
| [SQLite Replication Notes](docs/sqlite-replication-notes.md) | Kafka CDC, Debezium, Litestream WAL, multi-node tools |
| [FAQ](#faq) | 20+ pertanyaan umum per level |

## Stack

- **Runtime**: Node.js + TypeScript
- **HTTP**: Express
- **Transpile**: tsx (no build step, run .ts langsung)
- **Domain**: `Task` resource (CRUD) — dipakai ulang across modul supaya bisa compare apple-to-apple

## Learning Map

```
🟢 BEGINNER ─────────────────────────────────────────────── ✅ DONE
  01-rest/         REST APIs          CRUD, HTTP methods, status codes
  02-graphql/      GraphQL            Schema, resolvers, over/under-fetching
  03-webhooks/     Webhooks           Push pattern, HMAC signature, idempotency
  04-sse/          SSE                Server→Client stream, EventSource, wire format

🔵 INTERMEDIATE ────────────────────────────────────────── ✅ DONE
  05-websockets/   WebSockets         Bi-directional, HTTP upgrade, frames
  06-grpc/         gRPC               Protobuf, HTTP/2, 4 streaming types
  07-trpc/         tRPC               End-to-end type safety, Zod, zero codegen
  08-api-gateway/  API Gateway        Routing, auth, rate limit, aggregation

🟠 ADVANCED ────────────────────────────────────────────── ✅ DONE
  09-message-queues/   Message Queues     In-memory queue, retry, DLQ, visibility timeout
  10-kafka/            Kafka              Partitions, consumer groups, offset, replay
  11-event-driven/     Event-Driven       Event sourcing, CQRS, projections, sagas
  12-microservices/    Microservices      Service discovery, circuit breaker, tracing

🔴 EXPERT ──────────────────────────────────────────────── ✅ DONE
  13-distributed-systems/     Distributed Systems      CAP theorem, consistency models, failures
  14-eventual-consistency/    Eventual Consistency     Read repair, Merkle trees, CRDTs, vector clocks
  15-consensus/               Consensus Algorithms     Raft: leader election, log replication, partitions
  16-distributed-transactions/ Distributed Transactions  2PC, Saga, transactional outbox

🟣 PRODUCTION ──────────────────────────────────────────── ✅ DONE
  17-walsync/                 walsync                 WAL shipping replication, single-writer + multi-reader
  18-cr-sqlite/               cr-sqlite               CRDT multi-writer replication, write di mana saja, converge
```

## Quick Start

```bash
# Install dependencies
npm install

# Run any module — each is independent
npm run rest              # 01-rest:       http://localhost:3001/tasks
npm run graphql           # 02-graphql:    http://localhost:3002/graphql
npm run webhook:sender    # 03-webhooks:   http://localhost:3003 (start receiver too)
npm run webhook:receiver  #                http://localhost:3010/webhook
npm run sse               # 04-sse:        http://localhost:3004/events
npm run ws                # 05-websockets: ws://localhost:3005
npm run grpc:server       # 06-grpc:       port 50051
npm run trpc              # 07-trpc:       http://localhost:3006/trpc
npm run gateway           # 08-gateway:    http://localhost:3007/api (auto-starts backends)
npm run mq:producer      # 09-mq:         enqueue messages to queues
npm run mq:consumer      # 09-mq:         process with retry + DLQ
npm run kafka:producer   # 10-kafka:      write events to partitions
npm run kafka:consumer   # 10-kafka:      consumer group + replay
npm run eda              # 11-event-driven: event sourcing + CQRS demo
npm run microservices    # 12-microservices: circuit breaker + tracing demo
npm run dist-sys         # 13-dist-sys:   CAP theorem, consistency models, failures
npm run eventual         # 14-eventual:   read repair, Merkle trees, CRDTs, vector clocks
npm run consensus        # 15-consensus:  Raft leader election, log replication, partitions
npm run dist-tx          # 16-dist-tx:    2PC, Saga, transactional outbox
npm run walsync         # 17-walsync:   walsync WAL shipping replication demo
npm run cr-sqlite       # 18-cr-sqlite: cr-sqlite CRDT multi-writer replication demo

# Typecheck everything
npm run typecheck
```

## Project Structure

```
learn-api/
├── shared/
│   └── types.ts              # Task domain + in-memory store (shared across modules)
│
├── 01-rest/
│   ├── server.ts             # Express CRUD: GET/POST/PUT/PATCH/DELETE /tasks
│   └── README.md
│
├── 02-graphql/
│   ├── server.ts             # Apollo Server: Query + Mutation, schema & resolvers
│   └── README.md
│
├── 03-webhooks/
│   ├── sender.ts             # Service dengan events + webhook dispatch (HMAC)
│   ├── receiver.ts           # Webhook receiver + signature verification + idempotency
│   └── README.md
│
├── 04-sse/
│   ├── server.ts             # SSE endpoint, broadcast ke connected clients
│   ├── client.ts             # Node.js SSE client (raw HTTP, parse manual)
│   └── README.md
│
├── 05-websockets/
│   ├── server.ts             # WebSocket chat server (ws library)
│   ├── client.ts             # Interactive chat client (readline + ws)
│   └── README.md
│
├── 06-grpc/
│   ├── task.proto            # Protocol Buffers schema (service + messages)
│   ├── server.ts             # gRPC server: unary + server streaming
│   ├── client.ts             # gRPC client: calls all RPC methods
│   └── README.md
│
├── 07-trpc/
│   ├── router.ts             # tRPC router: procedures + Zod validation
│   ├── server.ts             # Express + tRPC middleware
│   ├── client.ts             # tRPC client: type-safe calls via AppRouter type
│   └── README.md
├── 08-api-gateway/
│   ├── gateway.ts            # Gateway: routing, auth, rate limit, aggregation
│   ├── user-service.ts       # Backend: users microservice
│   ├── order-service.ts      # Backend: orders microservice
│   └── README.md
│

├── 09-message-queues/
│   ├── queue.ts             # In-memory queue: ack/nack, retry, DLQ, visibility timeout
│   ├── producer.ts          # Demo producer: enqueue messages
│   ├── consumer.ts          # Demo consumer: process with retry + dead letter
│   └── README.md
│
├── 10-kafka/
│   ├── event-log.ts         # In-memory Kafka: topics, partitions, consumer groups, replay
│   ├── producer.ts          # Demo producer: write events with key-based partitioning
│   ├── consumer.ts          # Demo consumer group: parallel consumption + replay
│   └── README.md
│
├── 11-event-driven/
│   ├── event-store.ts       # Append-only event store with optimistic concurrency
│   ├── command-handler.ts   # CQRS write side: commands → aggregates → events
│   ├── projection.ts        # CQRS read side: projections (list, stats, activity feed)
│   ├── demo.ts              # End-to-end: command → event → store → projection
│   └── README.md
│
├── 12-microservices/
│   ├── service-registry.ts  # Service discovery: register, discover, heartbeat
│   ├── circuit-breaker.ts   # Circuit breaker: closed, open, half-open states
│   ├── tracing.ts           # Distributed tracing: trace IDs, spans, propagation
│   ├── user-service.ts      # Backend microservice (with fail mode toggle)
│   ├── order-service.ts     # Calls user-service via circuit breaker + tracing
│   ├── demo.ts              # Orchestrates: normal → fail → fast-fail → recovery
│   └── README.md
│
├── 13-distributed-systems/
│   ├── cap-theorem.ts       # CAP simulator: CP, AP, CA with network partitions
│   ├── consistency-models.ts # Strong, eventual, causal, read-your-writes
│   ├── demo.ts              # Orchestrates: CAP + consistency + failure types
│   └── README.md
│
├── 14-eventual-consistency/
│   ├── read-repair.ts       # Detect stale replicas on read, repair them
│   ├── anti-entropy.ts      # Merkle tree comparison for efficient sync
│   ├── crdt.ts              # G-Counter, PN-Counter, G-Set, 2P-Set, OR-Set
│   ├── vector-clocks.ts     # Track causality, detect concurrent updates
│   ├── demo.ts              # Orchestrates all 4 techniques
│   └── README.md
│
├── 15-consensus/
│   ├── raft.ts              # Raft: leader election, log replication, partitions
│   ├── demo.ts              # 5 phases: election, crash, partition, heal, stale leader
│   └── README.md
│
├── 16-distributed-transactions/
│   ├── two-phase-commit.ts  # 2PC: coordinator + participants, prepare/commit/abort
│   ├── saga.ts              # Saga: orchestration + choreography with compensations
│   ├── outbox.ts            # Transactional outbox: atomic DB write + event publish
│   ├── demo.ts              # Orchestrates: 2PC + Saga + Outbox scenarios
│   └── README.md
│
├── 17-walsync/
│   ├── writer.ts            # Express app (primary): CRUD tasks, write ke embedded SQLite
│   ├── reader.ts            # Express app (replica): read dari SQLite readonly, auto-reconnect
│   ├── demo.ts              # Orchestration: start walsync + apps, write, verify replication
│   └── README.md
│
├── 18-cr-sqlite/
│   ├── replicate.ts          # Bun app: HTTP server + CRDT changeset sync, multi-writer
│   ├── demo.ts               # 2-node local demo: write both nodes, verify convergence + conflict
│   └── README.md
│
├── faq/
│   └── README.md             # FAQ: common questions per level + general
│
├── docs/
│   ├── scalability-rating.md   # Scalability rating: 17 techs across 5 dimensions
│   └── sqlite-replication-notes.md # SQLite replication: Kafka CDC, Debezium, Litestream, multi-node tools
├── package.json              # Scripts for all modules
└── tsconfig.json             # Shared TypeScript config
```

## Comparison Matrix

| | REST | GraphQL | Webhooks | SSE | WebSocket | gRPC | tRPC | Gateway |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Direction** | Req→Res | Req→Res | Srv→Srv | S→C | Bi-dir | Req→Res | Req→Res | Proxy |
| **Transport** | HTTP | HTTP | HTTP | HTTP | WS | HTTP/2 | HTTP | HTTP |
| **Format** | JSON | JSON | JSON | Text | Text/Bin | Protobuf | JSON | Any |
| **Type safe** | Manual | Codegen | Manual | Manual | Manual | Codegen | Native | N/A |
| **Real-time** | — | Subs | Yes | Yes | Yes | Stream | Subs | — |
| **Browser** | Yes | Yes | N/A | Yes | Yes | No | Yes | Yes |
| **Streaming** | — | Subs | — | S→C | Bi-dir | 4 types | Subs | — |
| **Schema** | Optional | .graphql | — | — | — | .proto | TS types | — |
| **Codegen** | Optional | Yes | — | — | — | Yes | No | — |

## Key Takeaways per Level

### Beginner

| Tech | One-liner | Use when |
|------|-----------|----------|
| **REST** | URL=resource, HTTP method=action, stateless | Simple CRUD, public API, cacheable |
| **GraphQL** | Client determines data shape, single endpoint | Multiple clients with different needs, nested data |
| **Webhooks** | Server pushes to registered URLs on events | Notifications, integrations (Stripe, GitHub) |
| **SSE** | Server→Client push via HTTP stream, auto-reconnect | Notifications, feeds, LLM streaming (ChatGPT) |

### Intermediate

| Tech | One-liner | Use when |
|------|-----------|----------|
| **WebSocket** | Bi-directional persistent connection via HTTP upgrade | Chat, games, collaborative editing |
| **gRPC** | Protobuf binary + HTTP/2, 4 streaming types | Service-to-service internal, high performance |
| **tRPC** | TypeScript-native RPC, zero codegen, Zod validation | Full-stack TypeScript monorepo |
| **API Gateway** | Single entry point: routing, auth, rate limit, aggregation | Microservices, centralized cross-cutting concerns |

### Advanced

| Tech | One-liner | Use when |
|------|-----------|----------|
| **Message Queues** | Point-to-point, ack/nack, retry + DLQ, at-least-once | Async task processing, decoupling producers/consumers |
| **Kafka** | Append-only log, partitions, consumer groups, replay | Event streaming, audit log, high-throughput pipelines |
| **Event-Driven** | Event sourcing + CQRS, store events not state | Complex domains, audit trail, temporal queries |
| **Microservices** | Service discovery, circuit breaker, distributed tracing | Large teams, independent deploy, polyglot stack |

### Expert

| Tech | One-liner | Use when |
|------|-----------|----------|
| **Distributed Systems** | CAP theorem: pick 2 of 3 during partition. Consistency spectrum. | Understanding tradeoffs in any distributed system |
| **Eventual Consistency** | Read repair, Merkle sync, CRDTs, vector clocks | High availability, collab apps, offline-first |
| **Consensus (Raft)** | Leader election + log replication with majority quorum | etcd, Consul, ZooKeeper — any system needing strong consistency |
| **Distributed Transactions** | 2PC (blocking), Saga (compensating), Outbox (atomic publish) | Multi-service transactions, reliable event publishing |

### Production

| Tech | One-liner | Use when |
|------|-----------|----------|
| **Scaling SQLite (walsync)** | Embedded SQLite + async WAL shipping via HTTP. Single-writer, multi-reader. | Read-heavy workload, single geographic writer, multiple read replicas |

## Decision Guide — "Which API tech should I use?"

```
Is it a public API for 3rd parties?
  → REST (universal, cacheable, simple)

Full-stack TypeScript monorepo?
  → tRPC (end-to-end type safety, zero codegen)

Multiple clients with different data needs?
  → GraphQL (client picks fields, no over/under-fetching)

Real-time server→client push only?
  → SSE (simple, auto-reconnect, HTTP-native)

Multiple microservices behind one entry point?
  → API Gateway (routing, auth, rate limit, aggregation)

Async task processing (fire and forget)?
  → Message Queue (at-least-once, retry, DLQ for failures)

High-throughput event streaming with replay?
  → Kafka (append-only log, partitions, consumer groups)

Need full audit trail of state changes?
  → Event Sourcing (store events, rebuild state via replay)

Complex domain with many read models?
  → CQRS (separate write model from read projections)

Services calling each other, need failure isolation?
  → Circuit Breaker (prevent cascading failures)

Need to trace requests across multiple services?
  → Distributed Tracing (trace IDs, spans, context propagation)

High-performance service-to-service?
  → gRPC (protobuf binary, HTTP/2, streaming)

Server needs to notify other servers?
  → Webhooks (push pattern, HMAC signed)

Multiple microservices behind one entry point?
  → API Gateway (routing, auth, rate limit, aggregation)

Need multiple nodes to agree on a value?
  → Consensus (Raft: leader election + log replication, majority quorum)

Replicas diverge but must converge eventually?
  → Eventual Consistency (CRDTs, read repair, anti-entropy with Merkle trees)

Transaction spans multiple services/resources?
  → Saga (choreography or orchestration with compensating actions)

Need to atomically update DB + publish event?
  → Transactional Outbox (write to outbox table in same tx, poller publishes)

Coordinated transaction across resources with blocking?
  → 2PC (prepare + commit, but coordinator crash = blocked)

Scale SQLite reads across multiple servers?
  → walsync (embedded SQLite + async WAL shipping, single-writer + multi-reader)
```

## Scalability Rating

Rating scalability semua teknologi across 5 dimensi (horizontal, throughput, stateless, geographic, backpressure). Lihat: [`docs/scalability-rating.md`](docs/scalability-rating.md)

| Rank | Tech | Score | Why |
|:---:|------|:---:|-----|
| 1 | Kafka | 9.4 | Partition = parallelism, linear scale |
| 2 | Event-Driven (CQRS) | 8.6 | Read side scale independent from write |
| 3 | Eventual Consistency (CRDTs) | 8.4 | No coordination, multi-region |
| 4 | Message Queues | 8.0 | Competing consumers, backpressure |
| 5 | Microservices | 7.6 | Scale each service independently |
| ... | ... | ... | ... |
| 15 | Consensus (Raft) | 4.6 | Leader = bottleneck, by design |
| 16 | Distributed Transactions | 3.6 | Blocking locks, by design |
| 17 | Scaling SQLite (walsync) | 7.0 | Read replicas scale horizontally, single-writer bottleneck |

## FAQ

Pertanyaan yang sering muncul, dikelompokkan per level. Lihat: [`faq/README.md`](faq/README.md)

### Beginner

- [REST vs GraphQL: kapan pakai yang mana?](faq/README.md#rest-vs-graphql-kapan-pakai-yang-mana)
- [Apa beda PUT dan PATCH?](faq/README.md#apa-beda-put-dan-patch)
- [Kenapa webhook butuh signature?](faq/README.md#kenapa-webhook-butuh-signature)
- [SSE vs WebSocket: bedanya apa?](faq/README.md#sse-vs-websocket-bedanya-apa)
- [ChatGPT pakai SSE atau WebSocket?](faq/README.md#chatgpt-pakai-sse-atau-websocket)

### Intermediate

- [gRPC kenapa gak support browser?](faq/README.md#grpc-kenapa-gak-support-browser)
- ["Zero codegen" di tRPC artinya apa?](faq/README.md#zero-codegen-di-trpc-artinya-apa)
- [tRPC: jadi sharing same code antara frontend dan backend?](faq/README.md#trpc-jadi-sharing-same-code-antara-frontend-dan-backend)
- [API Gateway vs Service Mesh: bedanya apa?](faq/README.md#api-gateway-vs-service-mesh-bedanya-apa)

### Advanced

- [Message Queue vs Kafka: bedanya apa?](faq/README.md#message-queue-vs-kafka-bedanya-apa)
- [Event Sourcing: kenapa simpan event bukan state?](faq/README.md#event-sourcing-kenapa-simpan-event-bukan-state)
- [Circuit breaker: kenapa perlu?](faq/README.md#circuit-breaker-kenapa-perlu)
- [Microservices: kapan TIDAK pakai?](faq/README.md#microservices-kapan-tidak-pakai)

### Expert

- [CAP theorem: kenapa gak bisa dapat 3-3?](faq/README.md#cap-theorem-kenapa-gak-bisa-dapat-3-3)
- [Eventual consistency: bahaya gak?](faq/README.md#eventual-consistency-bahaya-gak)
- [Raft vs Paxos: kenapa Raft lebih populer?](faq/README.md#raft-vs-paxos-kenapa-raft-lebih-populer)
- [2PC vs Saga: kapan pakai yang mana?](faq/README.md#2pc-vs-saga-kapan-pakai-yang-mana)
- [Transactional Outbox: kenapa perlu?](faq/README.md#transactional-outbox-kenapa-perlu)

### Production

- [walsync vs LiteFS vs rqlite: bedanya apa?](faq/README.md#walsync-vs-litefs-vs-rqlite-bedanya-apa)
- [Kenapa walsync single-writer, tidak support multi-writer?](faq/README.md#kenapa-walsync-single-writer-tidak-support-multi-writer)
- [walsync sync delay berapa ms?](faq/README.md#walsync-sync-delay-berapa-ms)

### General

- [Mana yang paling sering dipakai di production?](faq/README.md#18-teknologi-ini-mana-yang-paling-sering-dipakai-di-production)
- [Kenapa pakai in-memory, bukan database beneran?](faq/README.md#project-ini-pakai-in-memory-bukan-database-beneran-kenapa)
- [Urutan belajar yang recommended?](faq/README.md#urutan-belajar-yang-recommended)
- [Bisakah skip Expert level?](faq/README.md#bisakah-saya-skip-expert-level)

## What's Next

Semua 5 level selesai! 🎉 Project ini sekarang punya 17 modul dari Beginner sampai Production, termasuk [walsync](https://github.com/maulanashalihin/walsync) — SQLite WAL shipping replication tool yang sudah di-deploy dan di-benchmark di server real.

**Langkah selanjutnya untuk pendalaman:**

- **Practice**: build real project dengan salah satu teknologi (mis. chat app pakai WebSocket, e-commerce pakai Saga)
- **Infrastructure**: coba teknologi real (RabbitMQ, Kafka, etcd) dan bandingkan dengan simulasi in-memory di sini
- **Deep dive**: baca paper asli — Raft (In Search of an Understandable Consensus Algorithm), Dynamo (Amazon), Spanner (Google)
- **Patterns**: pelajari patterns yang belum dicover — CQRS + Event Sourcing di production, service mesh (Istio), Chaos Engineering
