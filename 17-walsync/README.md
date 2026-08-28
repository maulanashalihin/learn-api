# 17 — Scaling SQLite with walsync

> **Level:** Production
> **Prerequisite:** Modul 13-16 (distributed systems, consistency, consensus, transactions)
> **Tool:** [walsync](https://github.com/maulanashalihin/walsync) — live SQLite WAL shipping replication

## Konsep

SQLite itu cepat (348K read QPS, 84K write QPS di VPS 6 vCPU). Tapi single-node: satu file, satu server. Bagaimana kalau butuh:

- **Read scaling** — banyak reader, satu writer
- **Geographic distribution** — reader dekat user, writer di pusat
- **High availability** — kalau primary down, replica bisa baca

Jawaban tradisional: PostgreSQL dengan streaming replication. Tapi itu berat — TCP server, connection pool, WAL parser, failover manager.

**walsync** approach: app tetap pakai embedded SQLite (zero overhead), background process ship WAL ke replica via HTTP.

```
┌─────────────────────────────┐       ┌─────────────────────────────┐
│  Primary (Node 1)           │       │  Replica (Node 2)           │
│                             │       │                             │
│  App ──→ SQLite (embedded)  │       │  App ──→ SQLite (embedded)  │
│         │                   │       │         ▲                   │
│         ▼                   │       │         │                   │
│    app.db + app.db-wal      │       │    replica.db + .db-wal     │
│         │                   │       │         ▲                   │
│    ┌────┴────┐              │       │    ┌────┴────┐              │
│    │ walsync │ ── HTTP ─────┼───────┼───→│ walsync │              │
│    │ primary │  WAL ship    │       │    │ replica │              │
│    └─────────┘              │       │    └─────────┘              │
└─────────────────────────────┘       └─────────────────────────────┘
```

## Kenapa walsync, bukan tool lain?

| Tool | Read QPS | Write QPS | Model | Catch |
|------|--------:|--------:|-------|-------|
| **walsync** | **348K** | **84K** | Embedded + async WAL ship | Single-writer, eventual consistency |
| Native SQLite | 348K | 84K | Embedded | No replication |
| LiteFS | 220K | 6K | FUSE + LTX | FUSE intercepts every write (fsync) |
| Marmot | 16K | 17K | TCP server (CDC) | 14x slower read (TCP overhead) |
| rqlite | ~10K | ~5K | TCP + Raft | Consensus overhead per write |
| PostgreSQL | 10K | 4K | TCP server | Full DB server, connection pool |

walsync menang karena:

1. **App pakai embedded SQLite langsung** — no FUSE, no TCP, no interceptor
2. **walsync = background process** — zero overhead di app path
3. **WAL shipping async** — write return immediately, sync di background
4. **HTTP transport (Fiber/fasthttp)** — persistent connections, gzip compressed

## Tradeoffs

| Aspek | walsync | PostgreSQL streaming |
|-------|---------|---------------------|
| Read speed | 348K QPS (embedded) | 10K QPS (TCP) |
| Write speed | 84K QPS (embedded) | 4K QPS (TCP) |
| Multi-writer | ❌ Single-writer only | ✅ Via logical replication |
| Failover | Manual (no consensus) | Automatic (with Patroni) |
| Consistency | Eventual (~100ms) | Near-sync (streaming) |
| Setup | 1 binary, no deps | Full DB server + config |
| Binary size | 7.7MB | ~150MB |

walsync cocok untuk: **read-heavy workload, single geographic writer, multiple read replicas**. Tidak cocok untuk: multi-writer, strong consistency, automatic failover.

## Quick Start

### 1. Download walsync binary

```bash
# macOS Apple Silicon
curl -L https://github.com/maulanashalihin/walsync/releases/latest/download/walsync-darwin-arm64 -o ./walsync
chmod +x ./walsync

# Linux x86_64
curl -L https://github.com/maulanashalihin/walsync/releases/latest/download/walsync-linux-amd64 -o ./walsync
chmod +x ./walsync
```

### 2. Run demo

```bash
npx tsx 17-walsync/demo.ts
```

1. Start walsync replica (background, port 9193)
2. Start writer app (creates DB + table, port 9189)
3. Start walsync primary (ships initial snapshot + WAL to replica)
4. Start reader app (reads from replica DB, port 9188)
5. Write 3 tasks via writer → verify replicated ke reader

### 3. Manual setup (2 terminal windows)

```bash
# Terminal 1: walsync replica + reader app
./walsync -mode replica -db /tmp/walsync-demo-replica.db -listen :9193 &
DB_PATH=/tmp/walsync-demo-replica.db npx tsx 17-walsync/reader.ts

# Terminal 2: walsync primary + writer app
./walsync -mode primary -db /tmp/walsync-demo-primary.db -replicas 127.0.0.1:9193 &
DB_PATH=/tmp/walsync-demo-primary.db npx tsx 17-walsync/writer.ts
```

> **Note:** `-replicas` expects `host:port` (e.g., `127.0.0.1:9193`), NOT `http://host:port`. walsync prepends `http://` internally.

### 4. Test replication

```bash
# Write to primary
curl -X POST http://localhost:9189/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Belajar walsync"}'

# Read from replica (should appear after ~100ms)
curl http://localhost:9188/api/tasks
```

## Files

| File | Deskripsi |
|------|-----------|
| `writer.ts` | Express app (primary) — CRUD tasks, write ke embedded SQLite |
| `reader.ts` | Express app (replica) — read dari embedded SQLite (readonly), auto-reconnect on snapshot |
| `demo.ts` | Orchestration script — start walsync + apps, write, verify replication |

## App Patterns

### Primary (writer.ts)

```typescript
// Persistent connection — zero overhead
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0"); // walsync handles checkpoint
```

### Replica (reader.ts)

```typescript
// Readonly persistent connection
let readDb = new DatabaseSync(DB_PATH, { readOnly: true });

// Auto-reconnect on snapshot (primary checkpoint replaces DB file)
function readQuery(sql, ...params) {
  try {
    return readDb.prepare(sql).all(...params);
  } catch (err) {
    if (err.code === "SQLITE_IOERR" || err.code === "SQLITE_NOTADB") {
      readDb = null; // stale connection
      return readQuery(sql, ...params); // retry
    }
    throw err;
  }
}
```

## walsync Internal Architecture

### WAL Shipping Flow

1. App writes → SQLite append ke WAL file (`app.db-wal`)
2. walsync watches WAL file (fsnotify + polling fallback)
3. walsync reads new WAL frames → gzip compress → HTTP POST ke replica
4. Replica receives → decompress → write ke local WAL file
5. Replica app reads → SQLite scan WAL → return data

### Checkpoint Handling

Saat WAL tumbuh terlalu besar, SQLite checkpoint: WAL → DB file. walsync deteksi ini dan ship **full snapshot** (bukan WAL incremental). Replica replace DB file atomically.

### -shm Corruption Fix (v0.8.0)

SQLite pakai `-shm` (shared memory) untuk WAL index. walsync write WAL bytes langsung tanpa SQLite C API → `-shm` tidak ter-update → persistent connections tidak lihat data baru.

Fix: setelah write WAL, walsync **corrupt `-shm` in-place** (flip first byte, same inode). SQLite deteksi invalid checksum → rebuild dari WAL scan → update same file. Persistent connections lihat update via mmap `MAP_SHARED` coherence.

## Benchmark

OVH VPS (6 vCPU Intel Haswell, 11GB RAM, HDD, Ubuntu 26.04, Bun 1.4.0):

| Query | QPS |
|-------|---:|
| `SELECT COUNT(*) FROM users` | 331K |
| `SELECT * FROM users WHERE id = 1` | 348K |
| `SELECT * FROM users ORDER BY id DESC LIMIT 50` | 28K |
| `INSERT INTO users(4 cols) VALUES(?,?,?,?)` | 84K |

walsync = native SQLite speed. App reads/writes langsung ke embedded SQLite. walsync tidak intercept app I/O.

Sync delay: ~100ms median (33-210ms range, 2 Singapore VPS, ~20ms latency).

## Production Checklist

- [ ] WAL mode enabled (`PRAGMA journal_mode = WAL`)
- [ ] Auto-checkpoint disabled (`PRAGMA wal_autocheckpoint = 0`)
- [ ] Persistent DB connection (no CLI tools between writes)
- [ ] Firewall (walsync has no auth — restrict to replica IPs)
- [ ] systemd service (auto-restart on crash)
- [ ] Monitor WAL growth via `/health` endpoint
- [ ] Manual checkpoint procedure documented
- [ ] Replica app handles snapshot stale (auto-reconnect)

## Further Reading

- **walsync repo**: <https://github.com/maulanashalihin/walsync>
- **SQLite WAL mode**: <https://www.sqlite.org/wal.html>
- **SQLite replication comparison**: `docs/sqlite-replication-notes.md` (20+ tools)
- **App patterns**: <https://github.com/maulanashalihin/walsync/tree/main/examples/app-patterns>
