# SQLite Replication & Sync — Catatan Pengayaan

Diskusi tentang sinkronisasi database antar server: Kafka sebagai transport, Debezium CDC, Litestream WAL reading, dan tools multi-node SQLite replication.

## Daftar Isi

- [Kafka untuk sync database antar server?](#kafka-untuk-sync-database-antar-server)
- [Debezium bisa capture SQLite?](#debezium-bisa-capture-sqlite)
- [Cara Litestream baca WAL](#cara-litestream-baca-wal)
- [Tools multi-node SQLite replication](#tools-multi-node-sqlite-replication)

---

## Kafka untuk sync database antar server?

**Bisa**, tapi Kafka bukan database sync tool. Kafka adalah event log. Yang sync database-nya adalah pattern di sekitar Kafka.

### Cara kerjanya

```
Server A (SQLite)                    Server B (SQLite)
  │                                    │
  │ 1. App write to DB                  │
  │ 2. Capture change                   │
  │    (CDC atau app-level)             │
  │    ↓                                │
  │  Kafka topic: "db-changes"          │
  │    [event: INSERT user {id:1}]      │
  │    [event: UPDATE user {id:1}]      │
  │    ↓                                │
  │ 3. Consumer reads event             │
  │    → apply to local DB              │
  │                                    │
  └────────────────────────────────────┘
```

### 2 cara capture change

**Cara 1: CDC (Change Data Capture) — otomatis**

Tool seperti Debezium baca database transaction log (WAL/binlog) dan publish ke Kafka. Tidak perlu ubah application code.

```
PostgreSQL WAL → Debezium → Kafka → Sink Connector → Target DB
```

Tapi Debezium support PostgreSQL, MySQL, MongoDB, Oracle, SQL Server. SQLite connector masih incubating.

**Cara 2: Application-level event publishing — manual**

Aplikasi yang tulis ke DB juga publish event ke Kafka. Inilah Transactional Outbox pattern (modul 16):

```
App:
  1. INSERT INTO users (...)        ← write to SQLite
  2. INSERT INTO outbox (event)     ← same transaction
  3. Outbox poller → Kafka.publish  ← async, separate process

Consumer di Server B:
  4. Kafka.consume → INSERT INTO users (...)  ← apply to local SQLite
```

Ini yang cocok untuk embedded database — kamu kontrol di application level.

### Apakah datanya akan sama?

**Eventually yes, tapi tidak langsung.**

```
Waktu:     0s        1s        2s        3s
Server A:  [write]   [publish]  —         —
Kafka:     —         [event]    [event]   —
Server B:  [stale]   [stale]   [stale]   [synced] ← converge
```

- Server B stale selama beberapa detik sampai event sampai
- Kalau Server B juga write ke row yang sama → conflict. Perlu resolution strategy (last-write-wins, CRDT, atau manual)
- Ini = eventual consistency (modul 14)

### Yang perlu di-handle

| Masalah | Solusi |
|---------|--------|
| Conflict (dua server edit row sama) | Last-write-wins, vector clocks, atau CRDT |
| Ordering | Kafka partition by key (mis. `user_id`) → order guaranteed within partition |
| Exactly-once | Consumer idempotent (cek apakah event sudah di-apply) |
| Schema evolution | Tambah field = aman. Ubah/hapus = breaking. Pakai schema registry. |
| Initial sync | Replay semua event dari awal (Kafka retention) atau bulk copy dulu |

### TL;DR

```
Bisa?     Ya — Kafka sebagai event transport + app-level CDC
Cocok?    Tergantung. Kalau cuma sync 2-3 embedded DB = overkill.
          Kalau sudah punya Kafka infra + banyak consumer = masuk akal.

Kafka = plumbing, bukan engine. Dia angkut event dari A ke B.
Yang capture dan apply = komponen lain.
```

---

## Debezium bisa capture SQLite?

**Tidak production-ready.** Ada connector tapi masih incubating/experimental.

### Status (per Aug 2026)

| Status | Detail |
|--------|--------|
| **Repo** | [`debezium/debezium-connector-sqlite`](https://github.com/debezium/debezium-connector-sqlite) |
| **Dibuat** | June 2026 — sangat baru |
| **Status** | Incubating (experimental, bukan production) |
| **Stars** | 1 star, 1 fork — belum ada yang pakai seriously |
| **Design doc** | [DDD-44](https://github.com/debezium/debezium-design-documents/pull/49) |

### Cara kerja Debezium SQLite (design)

SQLite tidak punya WAL streaming seperti PostgreSQL. Debezium SQLite pakai approach berbeda:

```
SQLite DB
  ├── users table
  ├── orders table
  └── _debezium_cdc_log   ← Debezium bikin tabel ini
      (trigger insert ke sini setiap INSERT/UPDATE/DELETE)
           │
           ▼
      JDBC polling loop
      (baca _debezium_cdc_log periodically)
           │
           ▼
      Kafka topic
```

### Perbedaan dengan connector lain

| | PostgreSQL/MySQL | SQLite |
|---|---|---|
| Capture method | Read WAL/binlog (transaction log) | Trigger + polling (no WAL access) |
| Overhead | Minimal (read existing log) | Higher (trigger fires on every write) |
| Latency | Sub-second | Seconds (polling interval) |
| Maturity | Production (jutaan deployment) | Incubating (belum ada production user) |

### Kenapa SQLite sulit di-CDC?

PostgreSQL/MySQL punya transaction log (WAL/binlog) — append-only log dari semua perubahan. Debezium tinggal baca log itu, zero overhead.

SQLite punya WAL, tapi:

- WAL format internal, tidak documented untuk external consumption
- WAL bisa di-checkpoint (merged ke main DB file) kapan saja
- Tidak ada API untuk stream WAL changes secara reliable

Makanya Debezium SQLite fallback ke trigger + polling — approach yang lebih lambat dan lebih invasif.

### Practical recommendation

| Kebutuhan | Tool | Status |
|-----------|------|--------|
| SQLite CDC ke Kafka | Debezium SQLite | Incubating, jangan production |
| SQLite replication | Litestream | Production, stream WAL ke S3 |
| SQLite multi-node strong consistency | rqlite | Production, Raft + SQLite |
| SQLite edge sync | Turso / libSQL | Production, built-in replication |
| App-level event publishing | Transactional Outbox (modul 16) | Always works, any DB |

---

## Cara Litestream baca WAL

Litestream baca WAL **langsung sebagai file** — bukan lewat SQLite API, tapi parse binary format-nya sendiri.

### Step by step

```
1. Buka file "app.db-wal" langsung (file I/O, bukan SQLite API)
   ↓
2. Parse WAL header (32 bytes)
   - Validate magic: 0x377f0682 atau 0x377f0683
   - Read page size
   - Read salt1, salt2 (untuk verify integrity)
   ↓
3. Loop baca WAL frames
   Setiap frame = WALFrameHeader (24 bytes) + page data (pageSize bytes)
   
   Frame header berisi:
   - page number (pgno)     → halaman DB mana yang berubah
   - commit count           → marker akhir transaction
   - salt1, salt2           → verify frame valid
   - checksum1, checksum2   → verify data integrity
   
   ↓
4. Verify setiap frame:
   - Salt match?    → kalau tidak, EOF (WAL sudah di-checkpoint/reset)
   - Checksum match? → kalau tidak, EOF (corrupt atau truncated)
   ↓
5. Kumpulkan pages yang berubah → package jadi LTX file
   ↓
6. Upload LTX ke replica storage (S3, SFTP, etc.)
```

### Kunci: long-running read transaction

Litestream tidak cuma baca file. Dia juga pegang read lock supaya WAL gak di-checkpoint:

```
Litestream process:
  BEGIN read-only transaction      ← acquire SHARED lock
  SELECT 1;                         ← trivial query, lock held
  (keep transaction open forever)   ← WAL gak akan di-checkpoint
```

Tanpa ini, SQLite akan auto-checkpoint WAL ke main DB file dan reset WAL file — Litestream kehilangan changes yang belum dibaca.

```
Tanpa Litestream:
  App write → WAL file grows → SQLite auto-checkpoint → WAL reset
  (changes hilang dari WAL, sudah merged ke main DB)

Dengan Litestream:
  App write → WAL file grows → Litestream baca → upload →
  Litestream trigger checkpoint → WAL reset
  (Litestream yang kontrol kapan checkpoint terjadi)
```

### WAL format yang Litestream parse

```
WAL File Structure:
┌─────────────────────────────────┐
│ WAL Header (32 bytes)           │
│   magic: 0x377f0682             │
│   format version: 3007000       │
│   page size: 4096               │
│   checkpoint sequence: 0        │
│   salt1: 0xA1B2C3D4             │
│   salt2: 0xE5F6A7B8             │
│   checksum1: 0x12345678         │
│   checksum2: 0x9ABCDEF0         │
├─────────────────────────────────┤
│ Frame 0                         │
│   WALFrameHeader (24 bytes)     │
│     page number: 5              │
│     commit count: 0 (not commit)│
│     salt1, salt2                │
│     checksum1, checksum2        │
│   Page data (4096 bytes)        │
├─────────────────────────────────┤
│ Frame 1                         │
│   WALFrameHeader (24 bytes)     │
│     page number: 12             │
│     commit count: 1 (COMMIT!)   │ ← end of transaction
│     salt1, salt2                │
│     checksum1, checksum2        │
│   Page data (4096 bytes)        │
├─────────────────────────────────┤
│ Frame 2...N                     │
└─────────────────────────────────┘
```

Source: [`wal_reader.go`](https://github.com/benbjohnson/litestream/blob/main/wal_reader.go) — pure Go code, baca byte-by-byte.

### Kenapa Debezium gak pakai approach ini?

| Alasan | Litestream (Go) | Debezium (Java) |
|--------|-----------------|-----------------|
| WAL format | Parse langsung, tahu formatnya | Lebih susah di JVM ecosystem |
| Read lock | Go goroutine pegang connection | Kafka Connect task lifecycle berbeda |
| Checkpoint control | Litestream = sidecar, kontrol penuh | Debezium = connector, gak kontrol DB |
| Design philosophy | Replication tool (ambil alih WAL) | CDC connector (observe, don't control) |

Debezium by design tidak mengambil alih WAL management — mereka cuma observer. Litestream by design mengambil alih WAL management — dia yang kontrol checkpoint.

---

## Tools multi-node SQLite replication

Litestream hanya backup (1 writer, restore manual). Untuk multi-node, ada beberapa pilihan:

### Landscape

```
Litestream    → 1 writer, backup ke S3, restore manual       ← bukan multi-node
LiteFS        → 1 writer, live read replicas, auto-failover  ← multi-node READ
rqlite        → 1 leader, multi-node write via Raft          ← multi-node WRITE (strong)
Marmot        → multi-writer, gossip, eventual consistency   ← multi-node WRITE (eventual)
Turso/libSQL  → 1 primary, embedded replicas, managed        ← multi-node READ (managed)
dqlite        → 1 leader, multi-node write via Raft          ← multi-node WRITE (embedded)
```

### 1. LiteFS — "Litestream tapi multi-node read"

```
                    ┌─ Node A (primary, read+write) ─┐
                    │   app.db (FUSE mount)            │
                    │      ↓ WAL replicate             │
                    ├─ Node B (replica, read-only) ────┤
                    │   app.db (FUSE mount, live copy) │
                    │      ↓ WAL replicate             │
                    └─ Node C (replica, read-only) ────┘
                        app.db (FUSE mount, live copy)
```

| Aspek | Detail |
|-------|--------|
| Cara kerja | FUSE filesystem yang intercept SQLite writes. App tetap pakai `sqlite3_open("app.db")` — zero code change |
| Writer | Single primary. Kalau primary mati, ada election untuk promote replica |
| Read replicas | Live, lag ~ratusan ms. Bisa baca lokal di tiap region |
| Setup | Lebih complex dari Litestream (butuh FUSE + Consul etcd untuk leader election) |
| Maintenance | Fly.io maintainer sudah pelan — "slower maintenance tempo" |
| Cocok untuk | Read-heavy multi-region: primary di US, read replicas di SG, EU |

### 2. rqlite — true distributed SQLite dengan Raft

```
Client → HTTP API → rqlite Node A (leader)
                        │ Raft consensus
                        ├── rqlite Node B (follower)
                        └── rqlite Node C (follower)
                        
Setiap node punya full SQLite copy.
Write: client → leader → Raft majority → commit
Read:  client → any node (configurable consistency)
```

| Aspek | Detail |
|-------|--------|
| Cara kerja | Standalone binary, bukan library. Akses via HTTP API (`POST /db/query`) |
| Writer | Single leader. Automatic failover via Raft election |
| Consistency | Strong (linearizable). Configurable: `none`, `weak`, `strong` |
| Setup | Single binary, 3 node minimum. `rqlited -node http://node1:4001` |
| Overhead | 5-15ms per write (Raft round-trip). Read = local, fast |
| Code change | Ya — gak pakai SQLite C API lagi, pakai HTTP API |
| Cocok untuk | Small distributed system yang butuh strong consistency + HA |

### 3. Marmot — leaderless multi-writer

```
Node A: write user 1 ─┐
Node B: write user 2 ──┼── NATS (gossip) ──→ semua node converge
Node C: write user 3 ─┘
```

| Aspek | Detail |
|-------|--------|
| Cara kerja | Setiap node punya SQLite sendiri. Changes broadcast via NATS gossip protocol |
| Writer | Multi-writer — any node bisa write. No leader |
| Consistency | Eventual. Conflict resolution: last-write-wins atau custom |
| Setup | Single binary + NATS. `marmot -nats NATS_URL -node-id 1` |
| Code change | Tidak — app tetap pakai SQLite normally. Marmot = sidecar |
| Cocok untuk | Edge computing, offline-first, multi-region write tanpa leader |

### 4. Turso / libSQL — managed, embedded replicas

```
Turso Primary (cloud) ── replicate ──→ Embedded replica (app local)
                                         ↑
                                    App baca lokal (fast)
                                    App tulis → forward ke primary
```

| Aspek | Detail |
|-------|--------|
| Cara kerja | libSQL = SQLite fork dengan built-in replication. App pakai libSQL SDK |
| Writer | Single primary (Turso managed). Multi-region primaries di plan enterprise |
| Read replicas | Embedded — replica jalan di proses app sendiri. Zero network untuk read |
| Setup | `turso db create` → dapat URL → `libsql.Client.create(url)` |
| Code change | Ya — ganti `sqlite3` dengan `libsql` client |
| Cocok untuk | Edge apps, local-first, serverless. Paling easy kalau ok dengan managed |

### 5. dqlite — embedded library dengan Raft

| Aspek | Detail |
|-------|--------|
| Cara kerja | C library dengan Go bindings. Raft consensus embedded di library |
| Writer | Single leader. Automatic failover |
| Consistency | Linearizable |
| Code change | Ya — ganti SQLite C API dengan dqlite C API |
| Cocok untuk | Canonical/LXD. Embedded strong consistency tanpa standalone process |

### Comparison matrix

| | Litestream | LiteFS | rqlite | Marmot | Turso | dqlite |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Multi-node | ❌ backup | ✅ read replicas | ✅ full cluster | ✅ full cluster | ✅ embedded | ✅ full cluster |
| Multi-writer | ❌ | ❌ single primary | ❌ single leader | ✅ any node | ❌ single primary | ❌ single leader |
| Code change | ❌ none | ❌ none (FUSE) | ✅ HTTP API | ❌ none (sidecar) | ✅ libSQL SDK | ✅ C API |
| Consistency | — | eventual | strong | eventual | strong | linearizable |
| Failover | manual | auto | auto | N/A (leaderless) | auto (managed) | auto |
| Setup difficulty | ⭐ easiest | ⭐⭐⭐ FUSE+Consul | ⭐⭐ binary | ⭐⭐ binary+NATS | ⭐ easiest (managed) | ⭐⭐⭐ C/Go |
| Self-hosted | ✅ | ✅ | ✅ | ✅ | ❌ managed | ✅ |
| Latency overhead | ~0 (sidecar) | ~ratusan ms (replica lag) | 5-15ms/write (Raft) | ~ms (gossip) | ~0 read, network write | 5-15ms/write (Raft) |

### Rekomendasi berdasarkan kebutuhan

```
"Butuh multi-region READ, zero code change, self-hosted"
  → LiteFS (tapi setup FUSE + Consul)

"Butuh multi-node WRITE, strong consistency, ok HTTP API"
  → rqlite (3 node minimum, Raft consensus)

"Butuh multi-node WRITE, any node write, ok eventual consistency"
  → Marmot (leaderless, gossip, sidecar — paling deket "Litestream experience" tapi multi-writer)

"Butuh paling easy, ok managed/vendor lock-in"
  → Turso (embedded replicas, libSQL, managed primary)

"Butuh embedded library (bukan sidecar/standalone), strong consistency"
  → dqlite (C library, Go bindings, Raft — dipakai Canonical/LXD)
```

### Yang paling "Litestream-like" tapi multi-node

**Marmot** — karena:

1. Sidecar (gak ubah app code, sama seperti Litestream)
2. Multi-writer (any node bisa write, gak ada leader bottleneck)
3. Single binary + NATS
4. Eventual consistency (trade-off untuk multi-writer)

Tapi kalau butuh strong consistency, Marmot gak cocok — pilih rqlite (tapi harus adapt ke HTTP API).

---

## Sources

- [Litestream — How it works](https://litestream.io/how-it-works/)
- [Litestream — SQLITE_INTERNALS.md](https://github.com/benbjohnson/litestream/blob/main/docs/SQLITE_INTERNALS.md)
- [Litestream — wal_reader.go](https://github.com/benbjohnson/litestream/blob/main/wal_reader.go)
- [Debezium SQLite connector](https://github.com/debezium/debezium-connector-sqlite)
- [Debezium DDD-44 design doc](https://github.com/debezium/debezium-design-documents/pull/49)
- [rqlite FAQ](https://rqlite.io/docs/faq/)
- [Marmot docs](https://maxpert.github.io/marmot/)
- [LiteFS vs Litestream vs rqlite vs dqlite on VPS 2025](https://onidel.com/blog/sqlite-replication-vps-2025)
- [Litestream vs LiteFS vs rqlite: VPS Guide 2026](https://cloudhostreview.com/article/litestream-vs-litefs-vs-rqlite-sqlite-replication-vps-2026)
- [Turso / libSQL in production](https://www.nazarboyko.com/articles/sqlite-in-production-with-turso-and-libsql)
