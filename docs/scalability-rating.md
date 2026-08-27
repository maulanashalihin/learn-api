# Scalability Rating — 16 API Technologies Ranked

Rating scalability semua teknologi di project ini across 5 dimensi.

## 5 Dimensi Scalability

| Dimensi | Artinya | Kenapa penting |
|---------|---------|----------------|
| **Horizontal scaling** | Bisa tambah node untuk handle lebih banyak load | Scale out, bukan scale up |
| **Throughput** | Berapa op/sec atau events/sec | Raw capacity |
| **Stateless** | Any node handle any request | No sticky sessions, easy load balance |
| **Geographic** | Bisa span multi-region | Latency global, disaster recovery |
| **Backpressure** | Handle overload gracefully | Gak crash saat spike |

## Rating Matrix (1-10)

| # | Teknologi | Horizontal | Throughput | Stateless | Geographic | Backpressure | **Overall** |
|---|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| 10 | **Kafka** | 10 | 10 | 9 | 9 | 9 | **9.4** |
| 11 | **Event-Driven (CQRS)** | 9 | 9 | 9 | 8 | 8 | **8.6** |
| 14 | **Eventual Consistency (CRDTs)** | 10 | 8 | 10 | 10 | 7 | **8.4** |
| 9 | **Message Queues** | 8 | 8 | 8 | 7 | 9 | **8.0** |
| 12 | **Microservices** | 9 | 7 | 8 | 7 | 7 | **7.6** |
| 6 | **gRPC** | 8 | 9 | 9 | 6 | 6 | **7.6** |
| 1 | **REST** | 9 | 7 | 10 | 9 | 5 | **7.4** |
| 8 | **API Gateway** | 8 | 7 | 9 | 8 | 6 | **7.2** |
| 3 | **Webhooks** | 7 | 7 | 8 | 8 | 6 | **7.0** |
| 7 | **tRPC** | 8 | 7 | 9 | 7 | 5 | **7.0** |
| 2 | **GraphQL** | 7 | 6 | 9 | 6 | 5 | **6.6** |
| 13 | **Distributed Systems (CAP)** | 7 | 6 | 7 | 7 | 6 | **6.6** |
| 5 | **WebSocket** | 5 | 6 | 3 | 4 | 5 | **4.6** |
| 15 | **Consensus (Raft)** | 4 | 4 | 5 | 4 | 6 | **4.6** |
| 4 | **SSE** | 5 | 5 | 3 | 4 | 4 | **4.2** |
| 16 | **Distributed Transactions** | 4 | 3 | 4 | 3 | 4 | **3.6** |

## Top 5 — Kenapa?

### 1. Kafka — 9.4/10 🏆

```
Producer → [Partition 0] → Consumer Group A (parallel)
          [Partition 1] →
          [Partition 2] → Consumer Group B (independent)
```

- **Horizontal**: tambah partition = tambah parallelism. Consumer group = scale consumers independently
- **Throughput**: jutaan events/sec. LinkedIn process trillions/day. Append-only log = sequential I/O = fast
- **Geographic**: MirrorMaker2 replicate across regions
- **Backpressure**: consumer polles at own pace. Slow consumer gak block producer
- **Kenapa bukan 10**: broker sendiri butuh resource. Cluster setup complex

### 2. Event-Driven (CQRS) — 8.6/10

```
Write side (command handler) → Event Store → Projection A (100 replicas for read)
                                         → Projection B (different shape)
```

- **Horizontal**: read side scale independently dari write side. 1 writer, 100 readers
- **Throughput**: writes = append-only (fast). Reads = dari projection (optimized, no join)
- **Kenapa bukan 10**: write side masih single bottleneck. Eventual consistency = stale reads

### 3. Eventual Consistency (CRDTs) — 8.4/10

```
Node A: [counter=5]    Node B: [counter=3]    Node C: [counter=8]
         \                  |                    /
          → merge(max) = [8, 8, 8] ← converge, no conflict
```

- **Horizontal**: no coordination needed. Setiap node independent. Add node = no rebalance
- **Geographic**: perfect untuk offline-first + multi-region. Figma pakai ini untuk real-time collab
- **Kenapa bukan 10**: limited data types (counter, set, register). Gak bisa semua operasi. Merge = O(n) state size

### 4. Message Queues — 8.0/10

```
Producer → [Queue] → Consumer 1
                   → Consumer 2  (competing consumers = parallel)
                   → Consumer 3
```

- **Horizontal**: competing consumers = scale workers independently
- **Backpressure**: queue absorbs spikes. Producer gak block. Consumer process at own pace
- **Kenapa bukan 10**: single broker = bottleneck. Message dihapus setelah diproses (no replay). Ordering hanya per queue

### 5. Microservices — 7.6/10

```
                    ┌→ User Service (scale: 5 pods)
API Gateway ────────┼→ Order Service (scale: 10 pods)
                    └→ Payment Service (scale: 3 pods)
```

- **Horizontal**: scale each service independently sesuai load-nya sendiri
- **Kenapa bukan 10**: network overhead, distributed complexity, service-to-service latency

## Bottom 3 — Kenapa?

### 14. SSE — 4.2/10

```
Server ──── persistent connection ──── Client 1
      ──── persistent connection ──── Client 2
      ──── persistent connection ──── Client 3
      (each connection = 1 file descriptor + memory)
```

- **Stateful**: 1 connection per client. Server must hold connection open
- **Horizontal**: hard. Need shared pub/sub (Redis) untuk broadcast across nodes
- **Limit**: ~10K-65K connections per node (file descriptor limit)
- **Kenapa rendah**: connection-bound, not throughput-bound

### 15. Consensus (Raft) — 4.6/10

```
Leader ←─── heartbeat ───→ Follower 1
       ←─── heartbeat ───→ Follower 2
       ←─── heartbeat ───→ Follower 3

Every write: Leader → majority ACK → commit
```

- **Write throughput**: semua write lewat leader. Leader = bottleneck. Add node = lebih banyak replication, bukan lebih cepat
- **Horizontal**: add node = more fault tolerance, NOT more throughput. 3 nodes vs 5 nodes = same write speed
- **Kenapa rendah**: consensus = trade throughput untuk consistency. By design

### 16. Distributed Transactions (2PC) — 3.6/10

```
Coordinator ── PREPARE → Participant A (lock held)
            ── PREPARE → Participant B (lock held)
            ── PREPARE → Participant C (lock held)
            ← all YES
            ── COMMIT → A, B, C (unlock)
```

- **Blocking**: locks held during prepare→commit. Other transactions wait
- **Throughput**: terrible. Every transaction blocks multiple resources
- **Horizontal**: add participants = slower (more locks, more network)
- **Kenapa terendah**: by design, 2PC sacrifices everything untuk atomicity

## Scalability vs Other Priorities

Scalability bukan satu-satunya metric. Kadang yang "less scalable" justru yang kamu butuh:

| Kalau prioritas kamu... | Pilih teknologi | Walau scalability-nya... |
|-------------------------|----------------|--------------------------|
| Strong consistency | Raft (4.6) | Rendah — by design |
| Atomic transactions | 2PC (3.6) | Terendah — by design |
| Real-time bi-directional | WebSocket (4.6) | Rendah — connection-bound |
| Simplicity | REST (7.4) | Cukup — tapi simple |
| Type safety | tRPC (7.0) | Cukup — tapi DX terbaik |

## Real-world scalability numbers

| Tech | Real-world throughput | Source |
|------|----------------------|--------|
| **Kafka** | 7 trillion messages/day | LinkedIn |
| **gRPC** | ~1M req/sec per node | Google internal |
| **REST** | ~100K req/sec per node (Express) | Typical Node.js |
| **WebSocket** | ~65K connections per node | FD limit (can tune to 1M+) |
| **Raft (etcd)** | ~10K writes/sec | etcd benchmark |

## TL;DR

```
Most scalable:     Kafka (9.4) — designed for scale, partition-based parallelism
Least scalable:    2PC (3.6)   — blocking locks, by design
Sweet spot:        REST + Message Queue + Kafka = common scalable stack
```

Kafka menang karena **partition = parallelism**. Tambah partition = tambah throughput. Tambah consumer = tambah processing power. Ini satu-satunya teknologi di list yang scale **linearly** dengan resource yang ditambah.
