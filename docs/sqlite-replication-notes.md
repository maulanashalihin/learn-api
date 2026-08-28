# SQLite Replication & Sync

Catatan tentang 3 masalah klasik SQLite: durabilitas, high availability, dan horizontal scaling.

---

## Masalah

SQLite adalah database paling kencang untuk single server. Embedded, zero config, baca langsung dari disk — tidak ada network hop, tidak ada protocol overhead. Tapi kekuatan ini sekaligus membuat 3 masalah bawaan:

1. **Durabilitas** — kalau server mati, data hilang. Bagaimana agar data tidak hilang tanpa pindah ke database lain?
2. **High availability** — kalau server mati, app down. Bagaimana agar app tetap jalan walau 1 node crash?
3. **Horizontal scaling** — single server ada batasnya. Bagaimana agar app tetap kencang walau traffic meningkat, tanpa ganti database? Read scaling bisa dengan read replicas, tapi write scaling susah karena SQLite hanya mengizinkan 1 writer pada satu waktu (database-level lock, bukan row-level).

PostgreSQL/MySQL punya built-in replication untuk masalah ini. SQLite tidak punya. Tidak ada `REPLICATE` command. Jadi butuh tool eksternal.

---

## Approach 1: Litestream (backup, bukan multi-node)

Litestream adalah sidecar yang stream SQLite WAL ke S3/cloud storage. Bukan multi-node — tapi ini fondasi konsep yang dipakai tool lain.

### Cara kerja

```
App → SQLite write → WAL file grows
                          ↓
                    Litestream baca WAL
                          ↓
                    Package jadi LTX file
                          ↓
                    Upload ke S3
```

Litestream baca WAL **langsung sebagai file binary** — bukan lewat SQLite API. Dia parse header (32 bytes), loop baca frames, verify salt + checksum, kumpulkan pages yang berubah.

Kuncinya: Litestream pegang **long-running read transaction** supaya WAL tidak di-checkpoint sebelum dibaca. Tanpa ini, SQLite auto-checkpoint WAL ke main DB dan Litestream kehilangan changes.

```
Tanpa Litestream:  write → WAL grows → auto-checkpoint → WAL reset (changes hilang dari WAL)
Dengan Litestream: write → WAL grows → Litestream baca → upload → Litestream trigger checkpoint
```

### Limitasi

Litestream hanya **backup + disaster recovery**. Restore manual. Tidak ada live read replica. Tidak ada multi-node.

---

## Approach 2: Multi-node replication tools

Litestream hanya backup. Untuk multi-node, ada beberapa tools dengan tradeoff berbeda:

### Landscape

```
── WAL shipping / physical replication ──────────────────────────
Litestream    → 1 writer, stream WAL ke S3, restore manual         ← backup/DR
LiteFS        → 1 writer, FUSE intercept, live read replicas       ← multi-node READ
walsync       → 1 writer, baca WAL file, gRPC ship ke replica      ← multi-node READ (no FUSE)
Mycelite      → 1 writer, VFS extension, page-diff journal         ← multi-node READ
Walrust       → 1 writer, Rust, stream WAL ke S3                   ← backup/DR
replited      → 1 writer, Rust, stream WAL ke S3/GCS/Azure         ← backup/DR
Verneuil      → 1 writer, VFS extension, async replicate ke S3     ← backup/DR
LiteSync      → 1 writer, replace SQLite lib, offline sync         ← multi-node READ

── CDC / logical replication (multi-writer) ─────────────────────
Marmot        → multi-writer, CDC + 2PC, gossip, MySQL protocol    ← multi-node WRITE (eventual)
cr-sqlite     → multi-writer, CRDT extension, changeset API        ← multi-node WRITE (CRDT)
HarmonyLite   → multi-writer, CDC, NATS JetStream                  ← multi-node WRITE (eventual)
HA SQLite     → multi-writer, CDC, NATS JetStream, multi-protocol  ← multi-node WRITE (eventual)
sqlite-sync   → multi-writer, CRDT, offline-first, multi-device    ← multi-node WRITE (CRDT)
replic-sqlite → multi-writer, CRDT, Node.js/Bun, ~800 LOC          ← multi-node WRITE (CRDT)
sqlite-cdc    → multi-writer, trigger-based CDC, LWW               ← multi-node WRITE (eventual)

── Consensus-based (single-leader, strong consistency) ──────────
rqlite        → 1 leader, Raft, HTTP API, single binary            ← multi-node WRITE (strong)
dqlite        → 1 leader, Raft, C library, embedded                ← multi-node WRITE (strong)
zaxonlite     → 1 leader, Paxos, Zig                               ← multi-node WRITE (strong)

── Managed / serverless ─────────────────────────────────────────
Turso         → 1 primary, embedded replicas, managed             ← multi-node READ (managed)
D1            → serverless SQLite di Cloudflare edge               ← serverless
```

### LiteFS — multi-region read replicas

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

FUSE filesystem yang intercept SQLite writes. App tetap pakai `sqlite3_open("app.db")` — **zero code change**. Single primary, replica lag ~ratusan ms. Kalau primary mati, election promote replica.

Setup lebih complex: butuh FUSE + Consul untuk leader election. Cocok untuk read-heavy multi-region (primary di US, read replicas di SG, EU).

### rqlite — distributed SQLite dengan Raft

```
Client → HTTP API → rqlite Node A (leader)
                        │ Raft consensus
                        ├── Node B (follower)
                        └── Node C (follower)
```

Standalone binary, akses via **HTTP API** (bukan SQLite C API). Single leader, automatic failover via Raft. Consistency configurable: `none`, `weak`, `strong`.

Overhead 5-15ms per write (Raft round-trip). Cocok untuk small distributed system yang butuh strong consistency + HA.

### Marmot — leaderless multi-writer

```
Node A: write user 1 ─┐
Node B: write user 2 ──┼── SWIM gossip + 2PC ──→ semua node converge
Node C: write user 3 ─┘
```

Setiap node punya SQLite sendiri, semua bisa write. Sync via 3 layer:

1. **CDC** — SQLite preupdate hook capture row-level changes, encode jadi msgpack bytes (bukan SQL replay)
2. **2PC (Percolator-style)** — coordinator broadcast row bytes ke semua node, PREPARE → quorum ACK → COMMIT. Consistency configurable: `ONE`, `QUORUM`, `ALL`
3. **SWIM gossip + anti-entropy** — cluster membership & failure detection. Background repair untuk catch-up node yang tertinggal

Conflict resolution: last-write-wins dengan HLC timestamp. Tie-breaker: node ID lebih tinggi menang.

Unik: akses via **MySQL protocol** — pakai mysql CLI, DBeaver, dll. Marmot transpile MySQL → SQLite di belakang. App pikir connect ke MySQL, padahal SQLite yang ter-replicate.

Sidecar — **zero code change**. Cocok untuk edge computing, multi-region write tanpa leader.

### Turso / libSQL — managed embedded replicas

```
Turso Primary (cloud) ── replicate ──→ Embedded replica (app local)
                                         ↑
                                    App baca lokal (fast, zero network)
                                    App tulis → forward ke primary
```

libSQL = SQLite fork dengan built-in replication. Replica jalan **di proses app sendiri** — zero network untuk read. Setup paling easy: `turso db create` → dapat URL → connect.

Tapi managed (vendor lock-in). Code change: ganti `sqlite3` dengan `libsql` client. Cocok untuk edge apps, local-first, serverless.

### dqlite — embedded library dengan Raft

C library dengan Go bindings. Raft consensus embedded di library, bukan standalone process. Single leader, linearizable consistency.

Code change: ganti SQLite C API dengan dqlite C API. Dipakai Canonical/LXD. Cocok untuk embedded strong consistency tanpa standalone process.

### cr-sqlite — CRDT extension untuk multi-master

Runtime loadable extension (C) untuk SQLite/libSQL. Upgrade tabel jadi "conflict-free replicated relations" (CRR) via `crsql_as_crr('table')`. Sync via `crsql_changes` virtual table — export/import changesets antar database.

Conflict resolution: **CRDT per column** — LWW (default), fractional index (ordered list), observe-remove (set). Berbeda dengan LWW-only tools: cr-sqlite bisa merge non-conflicting column updates tanpa data loss. Counter CRDT dan multi-value register sedang dikembangkan.

Code change: load extension + `crsql_as_crr()` per tabel. Tidak ganti SQLite API. Transport agnostic — user define sendiri sync mechanism (HTTP, WebSocket, dll). ~3.7K stars. Dipakai Turso/libSQL.

### HarmonyLite — Marmot v1 continuation dengan NATS

Leaderless, multi-writer, eventually consistent. CDC capture row-level changes, ship via **NATS JetStream**. LWW conflict resolution. DDL replication didukung.

Fork/continuation dari Marmot v1 (sebelum v2 rewrite). Beda dengan Marmot v2: pakai NATS JetStream bukan SWIM gossip. Cocok untuk yang sudah pakai NATS infrastructure.

### HA SQLite Cluster — multi-protocol dengan NATS

Highly available SQLite cluster powered by embedded NATS JetStream. Multi-protocol access: HTTP, gRPC, Go database/sql, JDBC, MySQL wire, PostgreSQL wire. Multi-writer dengan CDC, LWW.

Unik: bisa **proxy MySQL/PostgreSQL** ke SQLite cache lokal. Cocok untuk edge: baca lokal (fast), write proxy ke remote DB. Cross-database query tanpa ATTACH.

### sqlite-sync — CRDT offline-first sync

CRDT-based, offline-first sync untuk SQLite. Sync ke SQLite Cloud, PostgreSQL, atau Supabase tanpa backend. Block/line-level merge untuk text/markdown columns. Row-level security.

Platform: Linux, macOS, Windows, iOS, Android, WASM. ~550 stars. Cocok untuk mobile/local-first apps yang butuh multi-device sync.

### replic-sqlite — CRDT untuk Node.js/Bun

Node.js/Bun module, CRDT-based, ~800 LOC. Embedded langsung di app — no central server. Multi-writer, eventual consistency, selective replication (tabel dengan `_patches` suffix).

Cocok untuk Node.js apps yang butuh multi-writer SQLite tanpa external process. Sangat lightweight.

### sqlite-cdc — trigger-based CDC

Trigger-based CDC engine untuk SQLite. Install triggers di target tabel, capture changes, ship ke destination. Hampir identis dengan approach walsync CDC research (trigger + LWW).

### walsync — WAL shipping via gRPC (project kita)

```
Primary node                          Replica node
┌──────────┐                          ┌──────────┐
│  App     │                          │  App     │
│  SQLite  │                          │  SQLite  │
│  embedded│                          │  embedded│
│  (zero   │                          │  (read   │
│  overhead│                          │  only)   │
└────┬─────┘                          └────┬─────┘
     │ WAL file grows                      │
     ↓                                     │
┌──────────┐     gRPC ShipWal       ┌──────────┐
│ walsync  │ ──────────────────────→│ walsync  │
│ primary  │  gzip + keepalive      │ replica  │
│ baca WAL │  reconnect + salt      │ write WAL│
└──────────┘                        └──────────┘
```

Background process yang baca WAL file langsung, ship via gRPC ke replica. Single Go binary, zero CGo, no FUSE, no VFS extension, no schema change. App pakai standard SQLite embedded — zero overhead.

v0.5.0 fitur: gRPC persistent HTTP/2, gzip compression (95% bandwidth reduction), keepalive (15s failure detection), reconnect (retry on ship error), WAL salt detection (snapshot on salt change), config file (TOML), Prometheus metrics.

Limitasi: single-writer only, replicas read-only, eventual consistency (~1-2s). Multi-write tidak didukung — WAL page-level tidak bisa merge dari node berbeda (riset di [RESEARCH.md](https://github.com/maulanashalihin/walsync/blob/main/RESEARCH.md)).

### Mycelite — VFS extension page-diff

SQLite VFS extension yang intercept page writes, generate binary diffs, store di journal. Diffs bisa di-stream over network ke replica. Physical single-writer replication.

Bedanya dengan walsync: Mycelite = VFS extension (C level, intercept di page write), walsync = background process (baca WAL file dari luar). Mycelite lebih tight integration tapi butuh C compilation.

### LiteSync — replace SQLite library

Ganti SQLite library dengan modified version yang punya LiteSync code. Pakai native SQLite3 interface (tidak ada API baru). Centralized (star) topology — primary node distribusi fresh copy, lalu node exchange transactions online/offline.

Unik: **offline sync** — node bisa offline, transaction log disimpan lokal, exchange saat online lagi. Tapi: AUTOINCREMENT tidak didukung, non-deterministic functions (random(), date('now')) dilarang. Hanya 1 app per DB instance.

### Verneuil — VFS extension async S3

Linux-only VFS extension (Rust) dari Backtrace. Async streaming replication ke S3-compatible blob stores. Intercept changes di VFS level, create spooling snapshots, upload async.

Bedanya dengan Litestream: Verneuil = VFS extension (intercept di kernel level), Litestream = background process (baca WAL file). Verneuil lebih tight tapi Linux-only.

### Walrust — Rust WAL shipping ke S3

Lightweight Rust tool untuk SQLite WAL shipping ke S3-compatible storage (S3, MinIO, R2, Tigris). Bisa jalan sebagai sidecar atau embedded library.

Mirip Litestream tapi Rust. Memory-efficient. Cocok untuk Rust ecosystem.

### replited — Rust WAL replication multi-backend

Rust daemon, SQLite WAL replication ke S3, GCS, Azure Blob, filesystem. Live streaming. Multi-backend support.

### zaxonlite — Paxos-based distributed SQLite

Distributed SQL database built on SQLite. Single elected leader, Paxos-based consensus (paxos-zig). Strong replication guarantees. Zig implementation.

### Cloudflare D1 — serverless SQLite di edge

SQLite di Cloudflare edge network. Akses via Worker binding (internal) atau HTTP API (external). Bukan replication — serverless database. Query ~11ms per request bahkan dengan Worker binding. Cocok untuk low-QPS serverless apps, bukan high-throughput.

---

## Comparison Matrix

### WAL Shipping / Physical Replication

| | Litestream | LiteFS | walsync | Mycelite | LiteSync | Verneuil | Walrust | replited |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Multi-node** | ❌ S3 | ✅ live | ✅ live | ✅ live | ✅ live | ❌ S3 | ❌ S3 | ❌ S3/GCS |
| **Multi-writer** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Code change** | ❌ | ❌ FUSE | ❌ none | ❌ VFS ext | ❌ replace lib | ❌ VFS ext | ❌ | ❌ |
| **Transport** | S3 | HTTP | gRPC | network | TCP | S3 | S3 | S3/GCS/Azure |
| **Compression** | ✅ | ✅ LTX | ✅ gzip | ✅ binary | ✅ | ✅ | ✅ | ✅ |
| **Self-hosted** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Language** | Go | Go | Go | C | C | Rust | Rust | Rust |
| **Stars** | ~11K | ~4K | — | ~? | — | ~? | ~? | ~? |

### CDC / Logical Replication (Multi-Writer)

| | Marmot | cr-sqlite | HarmonyLite | HA SQLite | sqlite-sync | replic-sqlite | sqlite-cdc |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Multi-writer** | ✅ any node | ✅ multi-master | ✅ any node | ✅ any node | ✅ multi-device | ✅ multi-master | ✅ any node |
| **Conflict resolution** | 2PC + LWW (HLC) | CRDT (LWW, counter, MV-reg) | LWW | LWW | CRDT | CRDT | LWW |
| **CDC method** | preupdate hook | C extension | trigger/hook | CDC | CRDT engine | CRDT (~800 LOC) | triggers |
| **Transport** | gRPC + SWIM | app-defined | NATS JetStream | NATS JetStream | built-in | app-defined | app-defined |
| **Code change** | ❌ sidecar | ✅ load ext | ❌ sidecar | ❌ sidecar/driver | ✅ SDK | ✅ Node module | ❌ triggers |
| **DDL replication** | ✅ | ✅ | ✅ | ✅ (v0.0.7+) | ✅ | ✅ | ❌ |
| **Self-hosted** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Language** | Go | C (extension) | Go | Go | C | JS/TS | Python |
| **Stars** | ~3.5K | ~3.7K | ~? | ~? | ~550 | ~? | ~? |

### Consensus-Based (Single-Leader, Strong)

| | rqlite | dqlite | zaxonlite |
|---|:---:|:---:|:---:|
| **Multi-writer** | ❌ leader | ❌ leader | ❌ leader |
| **Consensus** | Raft | Raft | Paxos |
| **Consistency** | strong | linearizable | strong |
| **Failover** | auto | auto | auto |
| **Code change** | ✅ HTTP API | ✅ C API | ✅ |
| **Self-hosted** | ✅ | ✅ | ✅ |
| **Language** | Go | C | Zig |
| **Stars** | ~15K | ~4K | ~? |

### Managed / Serverless

| | Turso | D1 |
|---|:---:|:---:|
| **Multi-writer** | ❌ primary | ❌ |
| **Self-hosted** | ❌ managed | ❌ managed |
| **Code change** | ✅ libSQL SDK | ✅ Worker binding |
| **Consistency** | strong | strong |
| **Setup** | ⭐ easiest | ⭐ easiest |
| **Stars** | — | — |
---

## Decision Guide

```
── Backup / Disaster Recovery ──────────────────────────────────
Butuh backup saja (disaster recovery)?
  → Litestream (easiest, sidecar, stream WAL ke S3, ~11K stars)
  → Walrust (Rust alternative, S3/MinIO/R2/Tigris)
  → replited (multi-backend: S3/GCS/Azure/filesystem)
  → Verneuil (Linux-only, VFS extension, async S3)

── Multi-node READ (single-writer) ─────────────────────────────
Butuh multi-region READ, ok dengan FUSE?
  → LiteFS (FUSE, live read replicas, auto-failover, ~4K stars)

Butuh multi-region READ, NO FUSE, zero code change?
  → walsync (gRPC WAL shipping, single Go binary, no FUSE)

Butuh multi-region READ, ok replace SQLite library?
  → LiteSync (offline sync, star topology, modified SQLite lib)

── Multi-node WRITE, strong consistency ────────────────────────
Butuh multi-node WRITE, strong consistency?
  → rqlite (Raft, HTTP API, single binary, ~15K stars)
  → dqlite (C library, Raft, embedded, dipakai Canonical/LXD)
  → zaxonlite (Paxos, Zig)

── Multi-node WRITE, eventual consistency ──────────────────────
Butuh multi-node WRITE, any node write, ok eventual consistency?
  → Marmot (leaderless, CDC+2PC, gossip, MySQL protocol, ~3.5K stars)
  → HarmonyLite (NATS JetStream, Marmot v1 continuation)
  → HA SQLite (NATS, multi-protocol: HTTP/gRPC/MySQL/PG)
  → sqlite-cdc (trigger-based CDC, LWW, simplest)

Butuh multi-master dengan CRDT (no data loss on conflict)?
  → cr-sqlite (C extension, column-level CRDT, ~3.7K stars, dipakai libSQL)
  → sqlite-sync (offline-first, multi-device, ~550 stars)
  → replic-sqlite (Node.js/Bun, ~800 LOC, embedded)

── Managed / Serverless ────────────────────────────────────────
Butuh paling easy, ok managed?
  → Turso (embedded replicas, libSQL, managed primary)
  → D1 (serverless SQLite di Cloudflare edge, low-QPS only)
```

---

## Benchmark Results (Ubuntu VPS, 6 vCPU x86_64)

|Tool|Read QPS|Write QPS|Model|Notes|
|---|---:|---:|---|---|
|Native SQLite (WAL)|221K|94K|Embedded|Baseline, zero overhead|
|LiteFS (FUSE host)|220K|6K|FUSE + LTX|Read = kernel page cache, write overhead dari LTX fsync|
|LiteFS (Docker)|10K|427|FUSE + LTX|Docker overlay2 break page cache|
|Turso embedded|74K|7|Embedded + remote write|Read lokal, write forward ke Tokyo remote|
|pgrust (socket)|19K|14K|Server (Rust)|PostgreSQL rewritten in Rust, pipelined fsync|
|pgrust (TCP)|15K|11K|Server (Rust)|TCP overhead minimal|
|Marmot (TCP)|16K|17K|Server (CDC)|MySQL protocol, CDC overhead|
|PostgreSQL 18 (socket)|15K|4K|Server|Unix socket, standard PG|
|PostgreSQL 18 (TCP)|10K|4K|Server|TCP overhead ~35%|
|D1 internal|91|94|Serverless|Worker binding, ~11ms per query|
|D1 external|43|38|Serverless HTTP|HTTP API, ~25ms per query|
|Turso remote|7|7|Serverless HTTP|Mac → Tokyo, network latency dominant|

### Key takeaways dari benchmark

- **Embedded SQLite (221K read, 94K write)** tidak terkalahkan. Semua tool lain punya overhead.
- **LiteFS read = native SQLite** (220K) karena FUSE pakai kernel page cache. Tapi write hanya 6K (LTX fsync per write).
- **Docker break LiteFS** — overlay2 mengganggu page cache. Read turun 22x (220K → 10K).
- **pgrust 3.3x faster write vs PostgreSQL** — pipelined fsync. Tapi beta (v0.2).
- **Marmot write (17K) > PostgreSQL (4K)** — CDC + MySQL protocol lebih efisien dari PG TCP.
- **D1/Turso remote tidak untuk high-QPS** — network latency dominant. Cocok untuk serverless/edge low-traffic.

### walsync A/B test results

| Version | Change | CPU | Bandwidth | Result |
|---------|--------|-----|-----------|--------|
| v0.1.0 | HTTP WAL shipping | baseline | baseline | works |
| v0.2.0 | gRPC persistent HTTP/2 | — | — | sub-second sync |
| v0.3.0 | + gzip + keepalive | -20% CPU | 95% reduction | no regression |
| v0.4.0 | + reconnect + salt detection | — | — | kill replica → restart → recovers |
| v0.5.0 | + config file + metrics | <10ms overhead | — | zero measurable CPU overhead |

---

## walsync Multi-Write Research

### Riset: apakah walsync bisa support multi-writer?

**Hasil: WAL page-level shipping TIDAK BISA multi-write. CDC trigger BISA tapi bukan arsitektur walsync.**

#### Approach 1: Bi-directional WAL shipping — GAGAL

Test: kedua node jalan sebagai primary+replica, ship WAL ke each other. Hasil: saling overwrite DB file, data loss. WAL = page-level, tidak bisa merge dari node berbeda.

#### Approach 2: Trigger-based CDC + LWW — BERHASIL (tapi arsitektur berbeda)

Test: SQLite triggers capture row-level changes → ship via gRPC → apply dengan LWW (timestamp compare). Sync flag prevents trigger loop.

| Skenario | Hasil |
|----------|-------|
| Bi-directional INSERT (UUID PKs) | ✅ Converged |
| Same row, beda timestamp (LWW) | ✅ Newer wins |
| UPDATE + INSERT concurrent | ✅ Both applied |
| Continuous sync round 2 | ✅ No loop, converged |

**Tapi ini arsitektur yang berbeda total dari WAL shipping.** Bukan evolusi, tapi model replication berbeda yang kebetulan share gRPC transport.

#### Trigger overhead benchmark

| Variant | Write ops/sec | Overhead | DB size |
|---------|-------------|----------|---------|
| No trigger (1KB row) | 10,235 | baseline | 14MB |
| Trigger full row JSON (1KB) | 8,071 | -21% | 40MB (2.9x) |
| Trigger full row JSON (10KB) | 5,525 | -49% | 20MB (2x) |
| Trigger metadata only (10KB) | 9,259 | -14% | 11MB (1.1x) |

#### Kesimpulan

walsync tetap WAL shipping single-writer. Multi-write CDC sudah di-solve oleh Marmot, cr-sqlite, HarmonyLite, HA SQLite, sqlite-cdc, replic-sqlite, sqlite-sync. Market crowded. Detail riset di [walsync RESEARCH.md](https://github.com/maulanashalihin/walsync/blob/main/RESEARCH.md#v060-research-multi-writer-support).

## Sources

- [Litestream — How it works](https://litestream.io/how-it-works/)
- [Litestream — SQLITE_INTERNALS.md](https://github.com/benbjohnson/litestream/blob/main/docs/SQLITE_INTERNALS.md)
- [Litestream — wal_reader.go](https://github.com/benbjohnson/litestream/blob/main/wal_reader.go)
- [rqlite FAQ](https://rqlite.io/docs/faq/)
- [Marmot docs](https://maxpert.github.io/marmot/)
- [LiteFS vs Litestream vs rqlite vs dqlite on VPS 2025](https://onidel.com/blog/sqlite-replication-vps-2025)
- [Litestream vs LiteFS vs rqlite: VPS Guide 2026](https://cloudhostreview.com/article/litestream-vs-litefs-vs-rqlite-sqlite-replication-vps-2026)
- [Turso / libSQL in production](https://www.nazarboyko.com/articles/sqlite-in-production-with-turso-and-libsql)
- [cr-sqlite — vlcn.io](https://github.com/vlcn-io/cr-sqlite)
- [cr-sqlite docs](https://vlcn.io/docs/cr-sqlite/intro)
- [HarmonyLite — NATS JetStream replication](https://github.com/wongfei2009/harmonylite)
- [HA SQLite Cluster](https://github.com/litesql/ha)
- [sqlite-sync — CRDT offline-first](https://github.com/sqliteai/sqlite-sync)
- [replic-sqlite — Node.js CRDT](https://github.com/carboneio/replic-sqlite)
- [sqlite-cdc — trigger-based CDC](https://github.com/kevinconway/sqlite-cdc)
- [Mycelite — VFS page-diff replication](https://github.com/mycelial/mycelite)
- [LiteSync — offline sync](https://litesync.io/en/sqlite-synchronization.html)
- [Verneuil — async S3 replication](https://github.com/backtrace-labs/verneuil)
- [Walrust — Rust WAL shipping](https://github.com/russellromney/walrust)
- [replited — Rust WAL multi-backend](https://github.com/mrchypark/replited)
- [zaxonlite — Paxos distributed SQLite](https://github.com/insanai/zaxonlite)
- [dqlite — Canonical distributed SQLite](https://github.com/CanonicalLtd/dqlite)
- [rqlite — Raft distributed SQLite](https://github.com/rqlite/rqlite)
- [walsync — gRPC WAL shipping](https://github.com/maulanashalihin/walsync)
- [walsync RESEARCH.md — multi-write research](https://github.com/maulanashalihin/walsync/blob/main/RESEARCH.md)
- [Cloudflare D1 docs](https://developers.cloudflare.com/d1/)
- [pgrust — PostgreSQL in Rust](https://github.com/malisper/pgrust)
