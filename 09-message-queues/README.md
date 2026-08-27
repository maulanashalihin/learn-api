# 09 — Message Queues

## Apa itu Message Queue?

**Message Queue** adalah komponen middleware yang menyimpan pesan sementara antara **producer** (pengirim) dan **consumer** (penerima). Producer mengirim pesan ke queue, consumer mengambil pesan dari queue dan memprosesnya. Mereka tidak perlu berjalan pada saat yang sama — queue mendecouple mereka.

```
PRODUCER                    QUEUE                     CONSUMER
  │                          │                          │
  ├── enqueue(msg) ────────→ [msg1, msg2, msg3] ─────→ dequeue(msg) ──→ process
  │                          │                          │
  │  Tidak perlu menunggu    │  Pesan disimpan          │  Ambil saat siap
  │  consumer siap           │  sampai di-consume       │  Process async
```

### Point-to-Point vs Pub/Sub

```
POINT-TO-POINT (Queue):              PUB/SUB (Topic):
                                     
  Producer ──→ [ Queue ] ──→ Consumer    Producer ──→ [ Topic ]
                                              ├──→ Subscriber A
  1 message = diproses 1 consumer            ├──→ Subscriber B
  (competing consumers)                       └──→ Subscriber C
                                             
  Consumer A ──→ msg1                   1 message = diproses SEMUA subscriber
  Consumer B ──→ msg2                   (fanout / broadcast)
  Consumer C ──→ msg3
```

| Aspek | Point-to-Point (Queue) | Pub/Sub (Topic) |
|-------|------------------------|-----------------|
| Delivery | 1 message → 1 consumer | 1 message → semua subscriber |
| Consumers | Competing (load balancing) | Independent (broadcast) |
| Use case | Task distribution, work queue | Notifications, event broadcast |
| Contoh | AWS SQS, RabbitMQ queue | Kafka topics, RabbitMQ fanout |

> Demo ini menggunakan **point-to-point** model. Lihat modul 10 (Event-Driven) untuk pub/sub.

## Delivery Semantics

Tiga jenis jaminan delivery yang berbeda:

### 1. At-Most-Once (paling ringan)

Pesan dikirim **0 atau 1 kali**. Bisa hilang, tapi tidak duplikat.

```
Producer ──→ send(msg) ──→ selesai (fire-and-forget)
                              │
                    Kalau network gagal → pesan HILANG
```

- Implementasi: kirim tanpa menunggu konfirmasi
- Trade-off: cepat, tapi bisa loss
- Use case: metrics, logs, data yang tidak critical

### 2. At-Least-Once (yang kita pakai)

Pesan dikirim **1 atau lebih kali**. Tidak hilang, tapi bisa duplikat.

```
Producer ──→ send(msg) ──→ retry sampai ACK diterima
                              │
                    Kalau ACK hilang → pesan DIKIRIM ULANG
                    Consumer harus IDEMPOTENT
```

- Implementasi: ack/nack + retry + visibility timeout
- Trade-off: no loss, tapi consumer harus handle duplikat
- Use case: email, order processing, payment (most common!)
- **Consumer WAJIB idempotent**: proses duplikat = proses sekali

### 3. Exactly-Once (paling berat)

Pesan dikirim **persis 1 kali**. Tidak hilang, tidak duplikat.

```
Producer ──→ send(msg) ──→ transactional ack
                              │
                    Harus atomic: send + process + ack = 1 transaction
                    Sangat sulit di distribusi sistem
```

- Implementasi: two-phase commit, transactional outbox, idempotent producer
- Trade-off: kompleks, latency tinggi, sering tidak possible
- Use case: financial transactions (tapi sering pakai at-least-once + idempotency)
- Kafka: "effectively-once" via idempotent producer + transactions

> **Praktik nyata**: Kebanyakan sistem pakai **at-least-once + idempotent consumer**. Lebih simple dan reliable daripada exactly-once.

## Konsep Penting

### 1. Message Envelope

Setiap message dibungkus dalam envelope dengan metadata:

```typescript
interface Message<T = unknown> {
  id: string;          // unique identifier
  type: string;        // "send-email", "process-order", dll
  payload: T;          // data bebas
  attempts: number;    // berapa kali sudah dicoba
  createdAt: string;   // ISO 8601 timestamp
  maxRetries: number;  // batas retry sebelum DLQ
}
```

### 2. Producer & Consumer

```
PRODUCER                              CONSUMER
  │                                     │
  ├── queue.enqueue("email-queue",      ├── msg = queue.dequeue("email-queue")
  │     "send-email", { to, subject })  │     // msg jadi invisible (visibility timeout)
  │                                     │
  │  Tidak peduli siapa yang            ├── try { handler(msg); queue.ack(id) }
  │  memproses atau kapan               │   catch { queue.nack(id) }
  │                                     │     // requeue dengan backoff atau DLQ
```

### 3. Ack / Nack

| Operation | Kapan | Efek |
|-----------|-------|------|
| **ACK** | Handler sukses | Message dihapus dari queue |
| **NACK** | Handler throw error | Message di-requeue dengan backoff, atau DLQ |

```
Handler sukses:
  msg ──→ handler() ──→ return  ──→ ACK ──→ hapus dari queue ✅

Handler gagal:
  msg ──→ handler() ──→ throw   ──→ NACK ──→ requeue (dengan backoff) 🔄
                                      └──→ atau DLQ (kalau max retries habis) 💀
```

### 4. Retry dengan Exponential Backoff

Setiap nack, message di-requeue dengan delay yang semakin lama:

```
Attempt 1 gagal → backoff 1s   (200ms di demo)
Attempt 2 gagal → backoff 2s   (400ms di demo)
Attempt 3 gagal → backoff 4s   (800ms di demo)
Attempt 4 gagal → DLQ 💀       (maxRetries = 3)
```

Formula: `backoff = base × 2^(attempts - 1)`

Kenapa exponential? Untuk menghindari **thundering herd** — kalau service down, semua retry sekaligus akan membebani service yang baru recovery. Exponential backoff memberi waktu recovery.

> Production biasanya menambahkan **jitter** (random ±) supaya retry tidak sinkron.

### 5. Dead Letter Queue (DLQ)

Setelah `maxRetries` habis, message pindah ke DLQ — queue terpisah untuk investigasi.

```
Main Queue: [msg1, msg2, msg3]
                │
                ├── msg1: attempt 1 fail → requeue
                ├── msg1: attempt 2 fail → requeue
                ├── msg1: attempt 3 fail → requeue
                └── msg1: attempt 4 fail → DLQ 💀

Dead Letter Queue: [msg1]  ← untuk investigasi manual
```

DLQ berguna untuk:

- **Poison messages**: message yang selalu gagal (malformed payload, invalid data)
- **Debugging**: lihat kenapa message gagal berulang
- **Replay**: fix bug → re-queue dari DLQ ke main queue
- **Alerting**: alarm kalau DLQ tidak kosong

### 6. Visibility Timeout

Saat consumer mengambil message, message jadi **invisible** ke consumer lain selama N detik. Kalau consumer tidak ack dalam waktu itu, message jadi **visible lagi**.

```
T=0s   Consumer A: dequeue(msg1) → msg1 invisible (visibility timeout = 30s)
T=15s  Consumer A: CRASH (tidak ack)
T=30s  Visibility timeout expired → msg1 visible lagi
T=31s  Consumer B: dequeue(msg1) → redelivered!

Ini menjamin AT-LEAST-ONCE delivery:
  Kalau consumer crash sebelum ack → message tidak hilang.
  Message dikirim ulang ke consumer lain.
```

Tanpa visibility timeout, 2 consumer bisa memproses message yang sama bersamaan. Dengan visibility timeout, hanya 1 consumer yang memproses pada satu waktu — tapi kalau crash, message dikembalikan.

> **AWS SQS**: visibility timeout default 30 detik, bisa di-extend per message.
> **RabbitMQ**: pakai consumer acknowledgment timeout (prefetch + ack).

## Queue Patterns

### Pattern 1: Work Queue (yang kita pakai)

Distribusi task ke multiple workers. Setiap message diproses 1 worker.

```
Producer ──→ [ work-queue ] ──→ Worker A: task1
                         ├──→ Worker B: task2
                         └──→ Worker C: task3

Use case: image processing, email sending, report generation
```

### Pattern 2: Fanout (Pub/Sub)

1 message → semua subscriber. Setiap subscriber punya queue sendiri.

```
Producer ──→ Exchange (fanout)
               ├──→ queue-A → Subscriber A
               ├──→ queue-B → Subscriber B
               └──→ queue-C → Subscriber C

Use case: event notifications, order created → update inventory + send email + log
```

### Pattern 3: Routing (Topic Exchange)

Message di-route ke queue berdasarkan routing key.

```
Producer ──→ Exchange (topic)
               routing key: "order.created"
                    ├──→ queue: order-processing  (bind: "order.*")
                    ├──→ queue: email-sender       (bind: "*.created")
                    └──→ queue: analytics          (bind: "order.#")

Use case: event-driven architecture, selective message routing
```

### Pattern 4: Request/Reply (RPC)

Consumer memproses dan mengirim reply ke reply queue.

```
Client ──→ [ request-queue ] ──→ Worker
                                   │
  Client ←── [ reply-queue ] ←─────┘  (correlation ID untuk match)

Use case: synchronous-style RPC over async queue
```

## Message Queue vs Kafka (Queue vs Log)

Perbedaan fundamental: **queue** (delete after consume) vs **log** (append-only, retain).

| Aspek | Message Queue (RabbitMQ, SQS) | Log (Kafka) |
|-------|-------------------------------|-------------|
| Model | Delete setelah ack | Append-only, retain by retention |
| Re-read | Tidak bisa (sudah dihapus) | Bisa replay dari offset |
| Ordering | Per queue (FIFO) | Per partition (strict order) |
| Throughput | ~50K msg/s | ~1M+ msg/s |
| Consumer | Pull + ack | Pull dari offset, commit offset |
| Replay | Susah (message hilang) | Mudah (reset offset) |
| Use case | Task queue, RPC | Event streaming, analytics, CDC |

```
QUEUE (RabbitMQ/SQS):              LOG (Kafka):
                                   
  [msg1] [msg2] [msg3]              | msg1 | msg2 | msg3 | msg4 | ...
     │      │      │                └─────────── offset ─────────┘
     consume → DELETE                 consumer baca dari offset
                                      tidak delete, hanya advance offset
                                      bisa replay: reset offset ke awal
```

> Kafka = immutable log. RabbitMQ = mutable queue. Pilihan tergantung kebutuhan replay.

## Real-world Tools

| Tool | Type | Language | Notes |
|------|------|----------|-------|
| **RabbitMQ** | AMQP broker | Erlang | Exchanges, bindings, routing, DLX. Mature, feature-rich |
| **AWS SQS** | Cloud managed | — | Visibility timeout built-in, FIFO & standard queues, auto-scaling |
| **Redis Streams** | In-memory log | C | Consumer groups, append-only, fast. Redis 5.0+ |
| **BullMQ** | Node.js library | TS | Queue di atas Redis. Retry, delays, rate limiting, priorities |
| **NATS** | Lightweight messaging | Go | Pub/sub, request/reply. JetStream untuk persistence |
| **Amazon MQ** | Managed ActiveMQ | Java | JMS API, AWS-managed RabbitMQ/ActiveMQ |
| **Azure Service Bus** | Cloud managed | — | Topics, queues, sessions, dead-lettering built-in |

### RabbitMQ Architecture

```
Producer ──→ Exchange ──→ Binding(routing key) ──→ Queue ──→ Consumer

Exchange types:
  direct   → routing key exact match
  topic    → routing key pattern match (order.*, user.created)
  fanout   → broadcast ke semua queue
  headers  → match berdasarkan header attributes
```

### AWS SQS

```bash
# Send message
aws sqs send-message --queue-url $URL --message-body '{"order":"ORD-001"}'

# Receive (visibility timeout = 30s)
aws sqs receive-message --queue-url $URL

# Delete (ack)
aws sqs delete-message --queue-url $URL --receipt-handle $HANDLE

# Dead Letter Queue: configure RedrivePolicy di queue settings
```

### BullMQ (Node.js)

```typescript
import { Queue, Worker } from "bullmq";

const queue = new Queue("email", { connection: { host: "localhost", port: 6379 } });

// Producer
await queue.add("send-email", { to: "user@example.com", subject: "Hi" });

// Consumer
const worker = new Worker("email", async (job) => {
  await sendEmail(job.data);
}, { connection: { host: "localhost", port: 6379 } });

// BullMQ handle retry, backoff, DLQ, rate limiting otomatis
```

## Kapan Pakai Message Queue?

### ✅ Pakai message queue kalau

- **Async processing**: operasi lambat (email, image resize, report) tidak perlu block request
- **Load leveling**: handle burst traffic — queue absorbs spike, consumer process di steady rate
- **Decoupling**: producer tidak perlu tahu consumer details (endpoint, availability)
- **Reliability**: message survive consumer crash (persisted di broker)
- **Scalability**: tambah consumer untuk scale processing horizontally
- **Retry logic**: automatic retry dengan backoff untuk transient failures
- **Cross-service communication**: reliable async communication antar microservices

### ❌ Jangan pakai kalau

- **Synchronous response needed**: client butuh hasil langsung → pakai REST/gRPC
- **Real-time bidirectional**: chat, gaming → pakai WebSocket
- **Simple CRUD**: tidak ada async work → REST cukup
- **Very low latency required**: queue adds ~1-10ms overhead
- **Single server, no scaling needs**: over-engineering

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Decoupling**: producer dan consumer independent — perubahan satu tidak affect yang lain
- **Reliability**: message persistent di broker, survive restart/crash
- **Async processing**: request cepat return, heavy work di background
- **Load leveling**: queue absorbs traffic spike, consumer process di steady rate
- **Automatic retry**: transient errors di-handle dengan backoff, no manual intervention
- **Scalability**: tambah consumer untuk process lebih cepat (horizontal scaling)
- **Ordering guarantee**: FIFO queue preserve message order
- **Dead Letter Queue**: poison messages terisolasi, tidak block main queue

### ❌ Kekurangan

- **Added complexity**: komponen baru untuk deploy, monitor, scale
- **Latency overhead**: extra hop producer → broker → consumer (~1-10ms)
- **Eventual consistency**: async = tidak langsung selesai, harus handle "pending" state
- **Idempotency burden**: at-least-once = consumer harus handle duplikat
- **Debugging harder**: message flow across processes, sulit trace
- **Single point of failure**: broker down = semua queue stop (butuh HA setup)
- **Operational cost**: broker butuh resources, monitoring, backup, HA configuration
- **Ordering vs parallelism**: strict ordering = 1 consumer = no parallel processing

## Cara Coba

```bash
# Producer: enqueue messages ke multiple queues
npx tsx 09-message-queues/producer.ts

# Consumer: process dengan retry, DLQ, visibility timeout
npx tsx 09-message-queues/consumer.ts
```

### Yang akan Anda lihat di consumer

```
✅ ACK    — message berhasil diproses (hapus dari queue)
🔄 NACK   — message gagal, requeue dengan exponential backoff
💀 DLQ    — message gagal maxRetries kali, pindah ke Dead Letter Queue
📥 REDELIVERED — visibility timeout expired, message dikirim ulang
⏳  — menunggu message yang sedang dalam backoff period
```

Demo menggunakan:

- **backoff 200ms** (production: 1000ms — 1s, 2s, 4s, 8s)
- **visibility timeout 3s** (production: 30s)
- **maxRetries 3** (4 total attempts: 1 initial + 3 retries)
- **~30% random failure** + 1 poison message (selalu gagal → DLQ)

## Struktur File

```
09-message-queues/
  queue.ts      → In-memory message queue (enqueue, dequeue, ack, nack, retry, DLQ, visibility timeout)
  producer.ts   → Demo producer (enqueue ke multiple named queues)
  consumer.ts   → Demo consumer (process dengan retry + DLQ + visibility timeout demo)
  README.md     → Penjelasan ini
```
