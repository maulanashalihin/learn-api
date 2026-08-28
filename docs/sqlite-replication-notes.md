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
Litestream   → 1 writer, backup ke S3, restore manual        ← bukan multi-node
LiteFS       → 1 writer, live read replicas, auto-failover   ← multi-node READ
rqlite       → 1 leader, multi-node write via Raft           ← multi-node WRITE (strong)
Marmot       → multi-writer, gossip, eventual consistency    ← multi-node WRITE (eventual)
Turso        → 1 primary, embedded replicas, managed         ← multi-node READ (managed)
dqlite       → 1 leader, multi-node write via Raft           ← multi-node WRITE (embedded)
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

---

## Comparison Matrix

| | Litestream | LiteFS | rqlite | Marmot | Turso | dqlite |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Multi-node** | ❌ backup | ✅ read replicas | ✅ full cluster | ✅ full cluster | ✅ embedded | ✅ full cluster |
| **Multi-writer** | ❌ | ❌ | ❌ | ✅ any node | ❌ | ❌ |
| **Code change** | ❌ none | ❌ none (FUSE) | ✅ HTTP API | ❌ none (sidecar) | ✅ libSQL SDK | ✅ C API |
| **Consistency** | — | eventual | strong | eventual | strong | linearizable |
| **Failover** | manual | auto | auto | N/A (leaderless) | auto | auto |
| **Self-hosted** | ✅ | ✅ | ✅ | ✅ | ❌ managed | ✅ |
| **Setup** | ⭐ easiest | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐ easiest | ⭐⭐⭐ |

---

## Decision Guide

```
Butuh backup saja (disaster recovery)?
  → Litestream (easiest, sidecar, stream WAL ke S3)

Butuh multi-region READ, zero code change?
  → LiteFS (FUSE, live read replicas, auto-failover)

Butuh multi-node WRITE, strong consistency?
  → rqlite (Raft, HTTP API, 3 node minimum)

Butuh multi-node WRITE, any node write, ok eventual consistency?
  → Marmot (leaderless, gossip, sidecar, MySQL protocol)

Butuh paling easy, ok managed?
  → Turso (embedded replicas, libSQL, managed primary)

Butuh embedded library, strong consistency, no standalone process?
  → dqlite (C/Go, Raft, dipakai Canonical/LXD)
```

---

## Sources

- [Litestream — How it works](https://litestream.io/how-it-works/)
- [Litestream — SQLITE_INTERNALS.md](https://github.com/benbjohnson/litestream/blob/main/docs/SQLITE_INTERNALS.md)
- [Litestream — wal_reader.go](https://github.com/benbjohnson/litestream/blob/main/wal_reader.go)
- [rqlite FAQ](https://rqlite.io/docs/faq/)
- [Marmot docs](https://maxpert.github.io/marmot/)
- [LiteFS vs Litestream vs rqlite vs dqlite on VPS 2025](https://onidel.com/blog/sqlite-replication-vps-2025)
- [Litestream vs LiteFS vs rqlite: VPS Guide 2026](https://cloudhostreview.com/article/litestream-vs-litefs-vs-rqlite-sqlite-replication-vps-2026)
- [Turso / libSQL in production](https://www.nazarboyko.com/articles/sqlite-in-production-with-turso-and-libsql)
