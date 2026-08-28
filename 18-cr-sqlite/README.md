# 18. cr-sqlite — CRDT Multi-Writer Replication

> **Write di mana saja, converge di mana saja.** CRDT-based SQLite replication — tidak ada leader, tidak ada conflict yang hilang, tidak ada infrastructure.

Berbeda dengan [17-walsync](../17-walsync/) (single-writer WAL shipping), cr-sqlite memungkinkan **setiap node write secara independen** dan dijamin converge secara matematis via CRDT (Conflict-free Replicated Data Type).

## Konsep

### Single-writer vs Multi-writer

```
walsync (module 17):              cr-sqlite (module 18):
  1 primary, N replicas             N nodes, semua bisa write
  replica = read-only               tidak ada leader
  WAL page shipping                 CRDT changeset exchange
  eventual consistency              mathematical convergence guarantee
```

### CRDT (Conflict-free Replicated Data Type)

CRDT adalah struktur data yang dijamin converge tanpa koordinasi. Setiap node bisa operasi independen, dan saat changesets di-exchange, **pasti converge** — bukan "semoga converge", tapi terbukti secara matematis.

cr-sqlite mengimplementasikan CRDT di level SQLite column:

- **LWW (Last-Write-Wins)** — default, per-column timestamp tie-break
- **Fractional index** — untuk ordered list
- **Observe-remove** — untuk set

Bedanya dengan LWW-only tools (Marmot, HarmonyLite, HA SQLite): cr-sqlite bisa **merge non-conflicting column updates tanpa data loss**. Kalau node A update `city` dan node B update `name` di row yang sama, **keduanya menang**. LWW tools akan overwrite salah satu.

### Cara kerja

```
Node A (Singapore)           Node B (Jakarta)
  App + SQLite                 App + SQLite
  + crsqlite.so                + crsqlite.so
      ↓                            ↓
  CRR tables                   CRR tables
  crsql_changes                crsql_changes
  (changeset log)              (changeset log)
      ↓                            ↓
  HTTP /sync ←── exchange ──→ HTTP /sync
  (background loop, 2s)        (background loop, 2s)
```

1. **Write** — app write ke SQLite seperti biasa. cr-sqlite trigger capture per-column metadata (col_version, db_version, site_id).
2. **Export** — background loop query `crsql_changes` (virtual table) untuk dapat changesets sejak sync terakhir.
3. **Exchange** — POST changesets ke peer via HTTP. Binary blobs (pk, site_id) di-serialize ke `number[]` untuk JSON transport.
4. **Apply** — peer `INSERT INTO crsql_changes` dengan changeset. cr-sqlite apply + resolve conflict (LWW per column).
5. **Converge** — kedua node punya data yang sama. Guaranteed.

## Quick Start

### 1. Download crsqlite extension

```bash
# Linux x86_64
wget https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-linux-x86_64.zip
unzip crsqlite-linux-x86_64.zip

# macOS aarch64 (Apple Silicon)
curl -fsSL https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-darwin-aarch64.zip -o crsqlite.zip
unzip crsqlite.zip
```

### 2. Run demo (2 node di 1 machine)

```bash
bun run 18-cr-sqlite/demo.ts
```

Demo otomatis: start 2 node → write di kedua node → verify convergence → test conflict → cleanup.

### 3. Run manual (2 node terpisah)

```bash
# Node 1
bun run 18-cr-sqlite/node.ts 1 3001 /tmp/node1.db ./crsqlite.so http://localhost:3002

# Node 2 (terminal berbeda)
bun run 18-cr-sqlite/node.ts 2 3002 /tmp/node2.db ./crsqlite.so http://localhost:3001
```

### 4. Write + verify

```bash
# Write ke Node 1 (demo endpoint di port+10000)
curl -X POST http://localhost:13001/write \
  -H 'Content-Type: application/json' \
  -d '{"id":1,"name":"Alice","city":"Singapore"}'

# Write ke Node 2
curl -X POST http://localhost:13002/write \
  -H 'Content-Type: application/json' \
  -d '{"id":2,"name":"Bob","city":"Jakarta"}'

# Tunggu ~4 detik, cek kedua node
curl http://localhost:3001/users
curl http://localhost:3002/users
# Kedua node punya Alice + Bob (converged)
```

### 5. Pakai di app kamu (production)

```typescript
import { openDB } from "./db.ts";
import { startSync } from "./sync.ts";

const { db } = openDB({
  dbPath: "app.db",
  extensionPath: "./crsqlite.so",
  schema: `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY NOT NULL, name TEXT, city TEXT)`,
  tables: ["users"],
});

startSync(db, { nodeId: 1, port: 3001, peers: ["http://peer:3002"] });

// Write NORMAL — tidak lewat HTTP, CRDT metadata auto-tracked
db.query("INSERT INTO users VALUES (?, ?, ?)").run(1, "Alice", "Singapore");
```

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Node status: `{ node, users, peers }` |
| `/write` | POST | Insert/update user: `{ id, name, city }` |
| `/users` | GET | List all users: `{ node, users: [...] }` |
| `/sync` | POST | Receive changesets from peer (internal) |

## CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--node-id` | `1` | Node identifier |
| `--port` | `3001` | HTTP server port |
| `--db` | `/tmp/crsql-node{N}.db` | SQLite database path |
| `--extension` | `./crsqlite.so` | Path to crsqlite extension |
| `--peer` | (none) | Peer URL, can be repeated |
| `--table` | (none) | Table to mark as CRR, can be repeated |

## Tested: 2-Server Cross-Server Replication

Tested dengan Bun 1.4.0 di 2 server fisik berbeda:

| Node | Server | Location |
|---|---|---|
| Node 1 | OVH VPS (51.79.159.231) | Singapore |
| Node 2 | Underconst VPS (185.111.159.99) | Bandung |

### Results

| Test | Result |
|---|---|
| Write di kedua node → converge | ✅ ~4 detik (2s sync interval + RTT) |
| Conflict (Tokyo vs Paris) → converge | ✅ Paris (LWW, later db_version wins) |
| `bun:sqlite` `loadExtension()` | ✅ Works |
| Cross-server HTTP sync | ✅ OVH ↔ Underconst via public internet |

### Benchmark (Bun 1.4.0, OVH 6 vCPU, HDD, SQLite 3.46)

| Metric | cr-sqlite (CRR) | Plain SQLite | Overhead |
|---|---:|---:|---|
| Read QPS | 337K | 328K | ~0% (sama) |
| Write QPS | 25K | 105K | -76% (4.2x slower) |

Read = native SQLite speed (CRDT metadata zero read overhead). Write 4.2x slower karena CRDT trigger + metadata per row per column.

## Gotchas

### 1. Binary blobs di crsql_changes

`pk` dan `site_id` columns adalah `Uint8Array`. `JSON.stringify` serialize sebagai `{"0":1,"1":9}` → broken saat di-parse. Solusi:

```typescript
// Encode: Uint8Array → number[] sebelum JSON.stringify
Array.from(uint8array)

// Decode: number[] → Uint8Array saat apply
new Uint8Array(numberArray)
```

### 2. `crsql_finalize()` wajib sebelum close

```typescript
process.on("SIGTERM", () => {
  db.exec("SELECT crsql_finalize()");
  db.close();
});
```

Tanpa ini: `sqlite3_close()` error "unable to close due to unfinalized statements".

### 3. PK harus `NOT NULL`

```sql
-- ❌ Ditolak cr-sqlite: "primary key is nullable"
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);

-- ✅ Benar
CREATE TABLE users(id INTEGER PRIMARY KEY NOT NULL, name TEXT);
```

### 4. Transport tidak included

cr-sqlite tidak punya built-in transport. Module ini implement HTTP changeset exchange (~50 LOC). Bisa diganti dengan WebSocket, gRPC, atau apa saja — tinggal serialize `crsql_changes` → kirim → `INSERT INTO crsql_changes` di tujuan.

## Perbandingan: walsync vs cr-sqlite

| | walsync (Module 17) | cr-sqlite (Module 18) |
|---|---|---|
| **Writer** | 1 primary, N read-only replicas | N nodes, semua write |
| **Method** | WAL page shipping | CRDT changeset exchange |
| **Conflict** | tidak ada (single writer) | CRDT per-column (LWW, merge non-conflicting) |
| **Transport** | gRPC (built-in Go binary) | HTTP (app-defined, ~50 LOC) |
| **Infrastructure** | walsync binary (sidecar) | crsqlite.so extension (in-app) |
| **Code change** | zero (app tetap pakai SQLite) | load extension + `crsql_as_crr()` |
| **Read QPS** | 348K (native SQLite) | 337K (native SQLite) |
| **Write QPS** | 84K (native SQLite) | 25K (4.2x CRDT overhead) |
| **Consistency** | eventual (~1-2s) | eventual (~4s, 2s interval) |
| **Convergence** | N/A (single writer) | mathematical (CRDT guarantee) |
| **Best for** | read-heavy, single-region write | multi-region write, edge, offline-first |

## Files

| File | Description |
|---|---|
| `db.ts` | Library: `openDB()` — load extension, create schema, mark CRR tables |
| `sync.ts` | Library: `startSync()` — background push loop + `/sync` receive endpoint |
| `node.ts` | Node app: imports db.ts + sync.ts, write via `db.query()`, demo `/write` endpoint |
| `demo.ts` | 2-node local demo orchestration |

## Further Reading

- [cr-sqlite GitHub](https://github.com/vlcn-io/cr-sqlite) — C extension, CRDT per-column
- [cr-sqlite docs](https://vlcn.io/docs/cr-sqlite/intro) — CRR concept, changeset API
- [SQLite replication notes](../docs/sqlite-replication-notes.md) — full landscape + benchmarks
