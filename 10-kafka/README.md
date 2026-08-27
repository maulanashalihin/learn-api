# 10 — Kafka (Event Log)

## Apa itu Kafka?

**Apache Kafka** adalah **distributed append-only event log** — bukan queue. Perbedaan mendasar ini yang harus dipahami:

- **Queue** (RabbitMQ, SQS): pesan dihapus setelah dibaca. One-shot delivery.
- **Log** (Kafka): pesan tetap ada setelah dibaca. Bisa dibaca ulang berkali-kali. Pesan baru dihapus setelah **retention period** (bisa hari/minggu/forever).

Kafka dirancang untuk **event streaming** skala besar: jutaan events per detik, retained berhari-hari, bisa di-replay. Think of it sebagai "commit log" yang bisa di-subscribe oleh banyak consumer secara independen.

```
QUEUE (RabbitMQ)                    LOG (Kafka)

  Producer → [msg][msg][msg]          Producer → [0][1][2][3][4][5]...  (append-only)
             ↓ consume                          ↑ offset
  Consumer A ← msg (hapus)            Consumer A: read from offset 2 → [2][3][4]...
  Consumer B gak dapat msg            Consumer B: read from offset 0 → [0][1][2]...
                                      Event tetap ada → bisa replay
```

## Konsep Kunci

### 1. Topic

**Topic** = named log. Contoh: `orders`, `user-events`, `page-views`. Producer write ke topic, consumer read dari topic.

```
Topic "orders"   →  semua event order
Topic "users"    →  semua event user
Topic "payments" →  semua event payment
```

### 2. Partition

Setiap topic dipecah jadi **N partitions**. Partition adalah unit of parallelism:

```
Topic "orders" (3 partitions):

  Partition 0:  [order-1][order-4][order-7][order-10]...
  Partition 1:  [order-2][order-5][order-8][order-11]...
  Partition 2:  [order-3][order-6][order-9][order-12]...
```

**Kenapa partition?** Supaya bisa consume paralel. 1 partition → 1 consumer per group. 3 partitions → sampai 3 consumer paralel.

**Distribusi message ke partition:**

- **Key-based** (default): `hash(key) % numPartitions`. Same key → same partition → order preserved.
- **Round-robin**: kalau key = null, distribusi merata tanpa guarantee order.

```typescript
// Dari event-log.ts
partitionFor(key: string | null): number {
  if (key === null) return this.rrCounter++ % this.config.partitions; // round-robin
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % this.config.partitions; // key-based
}
```

### 3. Offset

**Offset** = per-partition monotonically increasing sequence number. Offset adalah "bookmark" — consumer track posisi baca via offset.

```
Partition 0:  [offset 0][offset 1][offset 2][offset 3][offset 4]
                                                ↑ consumer di sini
                                                committed offset = 3 (next to read)
```

- Offset **per partition**, bukan per topic.
- Offset **monotonically increasing** — gak pernah reset, gak pernah gap.
- Consumer **commit** offset setelah proses → kalau crash & restart, resume dari committed offset.

### 4. Consumer Group

**Consumer Group** = sekumpulan consumer yang share beban baca sebuah topic. Partitions di-assign ke consumer (1 partition → 1 consumer dalam group).

```
Topic "orders" (3 partitions), Group "order-processor" (2 consumers):

  Partition 0 ─┐
  Partition 1 ─┼→ consumer-1    (dapat 2 partitions)
  Partition 2 ───→ consumer-2   (dapat 1 partition)
```

**Rebalance**: kalau consumer join/leave, partition di-assign ulang otomatis. Ini yang bikin Kafka elastic — tambah consumer → beban terbagi.

```
consumer-2 join → REBALANCE:
  Partition 0,1 → consumer-1
  Partition 2   → consumer-2

consumer-2 leave → REBALANCE:
  Partition 0,1,2 → consumer-1 (semua balik ke 1 consumer)
```

> **Penting**: jumlah consumer per group gak boleh > jumlah partitions. Consumer lebih dari partition = idle (gak dapat partition).

### 5. Broker

**Broker** = satu server Kafka. Production: cluster = multiple brokers. Setiap partition di-replicate antar broker (leader + followers) untuk fault tolerance. Di demo ini: 1 broker in-memory.

## Log-based Messaging vs Queue-based

| Aspek | Queue (RabbitMQ, SQS) | Log (Kafka, Kinesis) |
|-------|----------------------|---------------------|
| **Setelah dibaca** | Pesan dihapus | Pesan tetap (retention) |
| **Replay** | ❌ Tidak bisa | ✅ Seek ke offset lama |
| **Multiple consumer** | Competing (pesan dibagi) | Independent groups (masing-masing baca full) |
| **Order** | FIFO per queue | Per partition (bukan across partitions) |
| **Throughput** | Sedang (10k-100k/s) | Tinggi (jutaan/s) |
| **Use case** | Task queue, RPC | Event streaming, audit log, analytics |
| **Retention** | Sampai di-ack | By time/size (bisa forever) |
| **Backpressure** | Queue depth limit | Consumer lag (offset behind) |

### Mental model

```
RabbitMQ = "Kirim pesan ini ke worker, pastikan diproses, lalu buang."
Kafka    = "Catat semua event ke log. Siapapun bisa baca kapanpun, berkali-kali."
```

## Partitioning Strategy

### Key-based (default Kafka)

`hash(key) % numPartitions`. Same key → always same partition.

```
key="user-123" → hash("user-123") % 3 = 1  → selalu partition 1
```

**Gunakan kalau**: butuh order guarantee per entity. Semua event untuk `user-123` ke partition yang sama → urut.

**Trap**: kalau satu key sangat hot (mis. `key="celebrity"`), partition itu jadi hotspot → gak seimbang.

### Round-robin (key = null)

Distribusi merata tanpa order guarantee.

```
msg1 → partition 0
msg2 → partition 1
msg3 → partition 2
msg4 → partition 0  (wrap around)
```

**Gunakan kalau**: gak butuh order, mau distribusi merata.

### Custom partitioner

Kafka bisa custom: partition by geo, by customer tier, dll. Di demo ini: simple hash (Kafka asli pakai murmur2).

## Consumer Groups & Rebalancing

### Satu topic, multiple consumer groups

Setiap consumer group baca topic secara independen — masing-masing punya offset sendiri:

```
Topic "orders":
  Group "order-processor"  → process orders (baca dari offset mereka)
  Group "audit-logger"     → log semua order untuk audit (baca dari offset mereka)
  Group "analytics"        → aggregate untuk dashboard (baca dari offset mereka)
```

3 group ini gak saling ganggu. Masing-masing baca full stream dari posisinya sendiri.

### Rebalance

Saat consumer join/leave/crash, Kafka trigger rebalance:

1. **Revoke** semua assignment sementara
2. **Re-assign** partitions ke consumer yang aktif (range / round-robin / sticky / cooperative)
3. Consumer yang dapat partition baru **resume dari committed offset**

```
consumer-2 crash → Kafka detect (heartbeat timeout) → rebalance → partition 2 ke consumer-1
```

> **Stop-the-world**: rebalance classic pause semua consumption. Kafka 2.4+ ada **cooperative rebalance** (incremental, gak pause semua).

## Delivery Semantics

| Semantic | Arti | Cara capai |
|----------|------|-----------|
| **At-most-once** | Pesan mungkin hilang, gak dobel | Commit offset sebelum proses |
| **At-least-once** (default) | Pesan gak hilang, mungkin dobel | Commit offset setelah proses |
| **Exactly-once** | Sekali proses, gak hilang/dobel | Transactional producer + consumer (idempotent + atomic) |

```typescript
// At-least-once (yang dipakai di demo):
const records = consumer.poll();      // baca
process(records);                      // proses
consumer.commit();                     // commit SETELAH proses
// Kalau crash setelah process tapi sebelum commit → reprocess (mungkin dobel)
```

**Exactly-once** di Kafka: pakai **transactional API** — producer + consumer dalam satu transaction, commit offset atomik dengan output. Mahal & kompleks. Sebagian besar sistem pakai at-least-once + **idempotent consumer** (dedup by event ID).

## Replay & Retention (Killer Feature)

### Replay

Consumer bisa **seek** ke offset manapun & baca ulang:

```typescript
consumer.seek(partition, 0);   // balik ke awal
consumer.poll();                // baca ulang semua event
```

**Use case replay:**

- 🐛 Bug di consumer logic → fix → reprocess semua event dari awal
- 🆕 Tambah consumer baru → baca full history untuk build state (CQRS, materialized view)
- 📊 Analytics: re-aggregate data historis dengan logic baru
- 🔄 Rebuild database dari event log (event sourcing)

### Retention

Event di-keep selama **retention period** (bukan dihapus setelah consume):

```
retention.ms = 604800000  (7 hari)   → event > 7 hari di-trim
retention.ms = -1          (forever) → event gak pernah dihapus
```

```
[old events trimmed] [retention window: 7 hari] [new events]
                      ↑ masih bisa replay        ↑ live
```

> Beda sama queue: queue hapus setelah ack. Kafka hapus by age/size, regardless of consumption.

## Order Guarantees

```
WITHIN partition:  ✅ order guaranteed (append-only, FIFO)
ACROSS partitions: ❌ no order guarantee
```

```
Partition 0:  [A1][A2][A3]   → A1 sebelum A2 sebelum A3 (guaranteed)
Partition 1:  [B1][B2][B3]   → B1 sebelum B2 sebelum B3 (guaranteed)
Tapi A1 vs B1: siapa duluan? Tidak terdefinisi (parallel partitions).
```

**Kalau butuh total order** → pakai 1 partition. Tapi konsekuensi: gak bisa parallel consume (throughput terbatas). Tradeoff: order vs parallelism.

**Workaround**: pakai key supaya event yang related ke partition yang sama. Mis. `key=orderId` → semua event order-X urut di 1 partition, tapi order berbeda tetap paralel.

## Cara Kerja Demo

### `event-log.ts` — In-memory broker

Implementasi core Kafka concepts:

- `KafkaBroker` — gateway ke topics + committed offsets
- `Topic` — kumpulan partition + partitioning strategy (hash/round-robin)
- `Partition` — append-only array, offset = index
- `ConsumerGroup` — manage consumer membership + rebalance (range assignment)
- `Consumer` — poll assigned partitions, commit offset, seek (replay)

### `producer.ts` — Produce demo

```
npx tsx 10-kafka/producer.ts
```

- Bikin topic "orders" (3 partitions)
- Produce 15 events (key: order-1..order-15)
- Tampilkan: partition distribution, offset, key ordering guarantee

### `consumer.ts` — Consumer group + replay demo

```
npx tsx 10-kafka/consumer.ts
```

- Consumer group "order-processor" dengan 2 consumers
- **Step 1-2**: join & rebalance → partition assignment
- **Step 3**: parallel consumption (consumer-1 dapat partition 0,1; consumer-2 dapat partition 2)
- **Step 4-5**: commit offset, poll lagi (kosong, sudah di akhir)
- **Step 6**: produce event baru → consumer langsung dapat
- **Step 7**: consumer leave → rebalance → partition di-assign ulang
- **Step 8**: **REPLAY** — seek ke offset 0 → baca ulang semua event
- **Step 9**: retention check

## Cara Coba

```bash
# Producer: tulis 15 event ke topic "orders" (3 partitions)
npx tsx 10-kafka/producer.ts

# Consumer group: parallel consumption + replay
npx tsx 10-kafka/consumer.ts
```

> **Catatan**: demo ini in-memory (1 process). Producer & consumer jalan terpisah, masing-masing bikin broker sendiri. Di Kafka asli, broker adalah server persistent yang shared oleh semua client. Konsep yang didemonstrasikan sama persis.

## Real-world Implementations

| Product | Type | Notes |
|---------|------|-------|
| **Apache Kafka** | Open-source | The original, Java/Scala. Paling populer. |
| **Redpanda** | Open-source | Kafka-compatible, C++ (no JVM), faster |
| **AWS Kinesis** | Cloud service | AWS version of Kafka. Streams = topics, shards = partitions |
| **GCP Pub/Sub** | Cloud service | Google's managed. Ordered topics = partitioning |
| **Azure Event Hubs** | Cloud service | Azure's Kafka-compatible service |
| **Confluent Cloud** | Cloud service | Kafka as a service (by Kafka creators) |
| **Apache Pulsar** | Open-source | Kafka alternative, built-in multi-tenancy |
| **NATS JetStream** | Open-source | Lightweight, Go-based |

### Kafka vs Kinesis

| | Kafka | Kinesis |
|---|------|---------|
| Partition unit | Partition | Shard |
| Position | Offset | Sequence number |
| Retention | Configurable (forever possible) | Max 365 hari |
| Self-hosted | ✅ | ❌ (AWS only) |
| Pricing | Per broker | Per shard-hour + data |

## Kapan Pakai Kafka?

### ✅ Pakai Kafka kalau

- **Event streaming**: stream events antar microservices (event-driven architecture)
- **Audit log**: perlu record semua event untuk compliance/debugging
- **Replay**: butuh baca ulang event (bug fix, rebuild state)
- **High throughput**: jutaan events/detik
- **Multiple consumers**: banyak system baca stream yang sama secara independen
- **Real-time analytics**: stream → aggregate → dashboard
- **Event sourcing**: event log sebagai source of truth, state = projection
- **CDC (Change Data Capture)**: stream perubahan database ke sistem lain

### ❌ Jangan pakai Kafka kalau

- **Task queue / RPC**: butuh request-response, pakai RabbitMQ/gRPC
- **Low volume**: beberapa pesan/detik → overkill (kompleksitas > benefit)
- **Small team**: Kafka butuh expertise untuk operate (cluster, monitoring, tuning)
- **Butuh per-message routing**: RabbitMQ lebih flexible (routing keys, exchanges)
- **Simple async job**: pakai SQS/Redis queue, jauh lebih simple

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Replay**: event gak hilang, bisa di-baca ulang berkali-kali (killer feature)
- **High throughput**: jutaan events/detik, horizontal scalable
- **Decoupling**: producer gak peduli siapa consumer, consumer gak peduli siapa producer
- **Multiple independent consumers**: tiap group baca full stream tanpa ganggu group lain
- **Durability**: event persisted ke disk + replicated → tahan broker crash
- **Order guarantee**: within partition, FIFO
- **Retention-based**: data di-keep by time/size, bukan by consumption → flexible replay window
- **Ecosystem**: Kafka Connect (integrasi), Streams (stream processing), SQL (ksqlDB)

### ❌ Kekurangan

- **Complexity**: deploy & operate cluster butuh expertise (ZooKeeper/KRaft, broker config, monitoring)
- **No per-message routing**: gak ada routing key/exchange seperti RabbitMQ. Routing = topic + partition key
- **Order hanya within partition**: gak ada total order (kecuali 1 partition = no parallelism)
- **Heavy**: butuh JVM, memory, disk. Overkill untuk volume kecil
- **Rebalance pain**: rebalance classic pause consumption (cooperative rebalance bantu, tapi kompleks)
- **Exactly-once sulit**: perlu transactional API, overhead tinggi. Kebanyakan pakai at-least-once + idempotent
- **No push**: consumer pull (poll) dari broker, bukan broker push. Butuh poll loop
- **Message size limit**: default 1MB per message (bisa di-raise, tapi bukan design untuk payload besar)

## Struktur File

```
10-kafka/
  event-log.ts   → In-memory Kafka-like broker (topic, partition, offset, consumer group, replay, retention)
  producer.ts    → Demo producer: tulis 15 event, tampilkan partition distribution
  consumer.ts    → Demo consumer group: parallel consumption, offset tracking, rebalance, replay
  README.md      → Penjelasan ini
```

## Konsep → Code Mapping

| Konsep | Di code |
|--------|---------|
| Topic | `KafkaBroker.createTopic("orders", { partitions: 3, retentionMs })` |
| Partition | `Topic.partitions[]` — array of append-only `Partition` |
| Offset | `LogRecord.offset` — index di partition (0-based, monoton) |
| Key-based partitioning | `Topic.partitionFor(key)` — `hash(key) % partitions` |
| Producer | `KafkaBroker.produce(topic, key, value)` |
| Consumer Group | `ConsumerGroup` — manage membership + rebalance |
| Rebalance | `ConsumerGroup.rebalance()` — range assignment |
| Offset commit | `Consumer.commit()` → `KafkaBroker.commitOffset()` |
| Replay | `Consumer.seek(partition, offset)` → `poll()` |
| Retention | `KafkaBroker.applyRetention()` — trim by timestamp |
