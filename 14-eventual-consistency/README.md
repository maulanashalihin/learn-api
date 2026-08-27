# 14 — Eventual Consistency

## Apa itu Eventual Consistency?

**Eventual consistency** = model konsistensi di mana, jika tidak ada update baru yang masuk, semua replica **akhirnya akan konvergen ke state yang sama**. Selama proses konvergensi, replica bisa **sementara berbeda** — client mungkin membaca data stale (usang) untuk sesaat.

Ini berlawanan dengan **strong consistency** (linearizability), di mana setiap read selalu melihat write terbaru, tapi minta koordinasi synchronous yang memblokir availability saat partition.

```
STRONG CONSISTENCY:                EVENTUAL CONSISTENCY:

  Write ─→ sync ALL replica          Write ─→ sync 1 replica (fast)
           (block until done)                 (return immediately)
  Read  ─→ always latest             Read  ─→ mungkin stale sesaat
           (but slow under partition)         (tapi available saat partition)

  + Always correct                   + Available saat partition
  - Blocks on partition              - Stale reads possible
  - Higher latency                   - Conflict resolution needed
  Contoh: Spanner, etcd, ZooKeeper   Contoh: Cassandra, DynamoDB, Riak
```

### Kenapa Eventual Consistency?

Berdasarkan **CAP theorem**: saat network partition terjadi, sistem harus pilih antara **Consistency** atau **Availability**. Eventual consistency memilih availability — tetap menerima read/write meski replica tidak bisa saling komunikasi. Setelah partition sembuh, replica sync & konvergen.

Alasan lain:

- **Low latency**: write tidak menunggu quorum replica → response cepat.
- **High availability**: tidak ada single point yang harus online.
- **Scale-out**: ribuan replica tidak perlu koordinasi per write.

> **CAP bukan binary.** PACELC: saat **P**artition → pilih **A** atau **C**; **E**lse (no partition) → pilih **L**atency atau **C**. Cassandra = AP + EL. Spanner = CP + EC.

---

## Teknik Mencapai Eventual Consistency

Demo ini menunjukkan 4 teknik saling melengkapi:

| Teknik | Trigger | Cara kerja | Demo |
|--------|---------|------------|------|
| **Read Repair** | saat read | deteksi replica stale, write-back latest | `read-repair.ts` |
| **Anti-Entropy** | periodic | Merkle tree diff, sync hanya key beda | `anti-entropy.ts` |
| **CRDTs** | saat merge | data structure yang merge tanpa konflik | `crdt.ts` |
| **Vector Clocks** | per write | track causality, deteksi concurrent writes | `vector-clocks.ts` |

---

## 1. Read Repair

### Konsep

**Read repair** = mekanisme "lazy": replica yang stale diperbaiki **saat dibaca**, bukan saat ditulis. Client read dari beberapa replica (quorum), bandingkan version, lalu write-back value terbaru ke replica yang tertinggal.

```
3 Replica: R1, R2, R3. R3 miss write #2 (partition/crash).

BEFORE READ:
  R1: user:42 = "Alice Smith" v2   ← latest
  R2: user:42 = "Alice Smith" v2   ← latest
  R3: user:42 = "Alice" v1         ← STALE

READ (quorum read dari semua):
  Client dapat 3 response, bandingkan version
  → R1 & R2 punya v2, R3 punya v1 → R3 stale

READ REPAIR:
  Client write-back "Alice Smith" v2 → R3

AFTER:
  R1, R2, R3 semua v2 → konsisten
```

### Trade-off

| + | - |
|---|---|
| Write cepat (no sync repair) | Read lebih mahal (quorum + compare + write-back) |
| Self-healing tanpa background process | Stale read sesaat sebelum repair |
| Cocok untuk read-heavy workload | Tidak menangani key yang belum pernah dibaca (butuh anti-entropy) |

> **Cassandra & DynamoDB** pakai read repair. Cassandra juga punya `read_repair_chance` — probabilistic read repair untuk read yang tidak pakai full quorum.

### Code Walkthrough (`read-repair.ts`)

```typescript
// Replica menyimpan key → {value, version, writtenAt}
class Replica { ... write(key, value, version) ... read(key) }

// Read dari semua replica, cari version tertinggi
function readFromAll(replicas, key): { responses, latest }

// Repair: tulis latest ke replica yang version-nya lebih rendah
function readRepair(replicas, key, latest): RepairAction[] {
  for (const r of replicas) {
    const current = r.read(key);
    if (!current || current.version < latest.version) {
      r.write(key, latest.value, latest.version);  // write-back
    }
  }
}
```

---

## 2. Anti-Entropy (Merkle Trees)

### Konsep

**Anti-entropy** = proactive sync antar replica, dijalankan periodik (bukan saat read). Tantangan: bagaimana tahu key mana yang beda **tanpa transfer semua data** (O(n))?

**Merkle tree** = hash tree. Setiap leaf = hash dari satu key:value. Parent = hash dari gabungan children. Bandingkan root: kalau sama → tidak ada diff (O(1)). Kalau beda → turun ke children untuk temukan subtree yang berbeda, sampai leaf = key spesifik.

```
Replica A (6 keys) → Merkle Tree A:        Replica B (6 keys) → Merkle Tree B:

         root: 3d559c                              root: 937905  ← BEDA
        /             \                           /             \
    564a01           5eb112                    8e54f5           075ddf
    /     \          /    \                    /     \          /    \
 0567d8  33c1a1  464bd5  3c4247             117c5d  33c1a1  3c4247  72ad6f
  /  \    /  \    (Eve)  (Frank)             /  \    /  \    (Frank) (Grace)
42c72a fc6175 5a5752 7be6c0              42c72a 10c0bc 5a5752 7be6c0
(Alice)(Bob)(Charlie)(Diana)             (Alice)(BOB!)(Charlie)(Diana)

Bandingkan root → beda. Turun:
  - Subtree kiri: beda → turun → user:2 beda (Bob vs BOB-UPDATED)
  - Subtree kanan: beda → turun → user:5 hanya di A, user:7 hanya di B
Sync HANYA 3 key, bukan 6. Untuk 1M key dengan 1 beda: ~20 node dibandingkan.
```

### Penting: Tree over Fixed Key Universe

Tree dibangun over **key universe** (sorted union semua key di semua replica). Key yang tidak ada → leaf sentinel `∅`. Dengan struktur tree **identik** di semua replica, perbandingan leaf-by-leaf exact — tidak ada false-positive akibat key shift. Inilah cara **Cassandra**: Merkle tree over fixed token range.

```
Replica A: {1,2,3,4,5,6}      Replica B: {1,2,3,4,6,7}
Key universe (union): {1,2,3,4,5,6,7}  ← tree dibangun over ini

Tree A: leaf user:7 = ∅ (sentinel)     Tree B: leaf user:5 = ∅ (sentinel)
        → struktur IDENTIK → comparison exact
```

### Efisiensi

| Jumlah key | Key beda | Node dibandingkan | Full scan |
|-----------|----------|-------------------|-----------|
| 1,000 | 1 | ~10 | 1,000 |
| 1,000,000 | 1 | ~20 | 1,000,000 |
| 1,000,000 | 1,000 | ~20,000 | 1,000,000 |

> **Hinted handoff** = teknik pelengkap: kalau replica target down saat write, write disimpan di replica "hint" lain. Saat target up, hint di-replay. Cassandra & Dynamo pakai ini.

### Code Walkthrough (`anti-entropy.ts`)

```typescript
// Bangun Merkle tree over keyUniverse (missing key → sentinel ∅)
function buildMerkleTree(data: KV, keyUniverse?: string[]): MerkleNode {
  // leaf = hash(key:value), parent = hash(left.hash + right.hash)
}

// Bandingkan: root sama → skip subtree (efisiensi). Beda → turun.
function compareMerkle(a, b): DiffResult {
  // walk: if hash sama → return (prune). Leaf → bandingkan present/value.
}

// Sync bidirectional: keysOnlyInA → A→B, keysOnlyInB → B→A,
// keysDifferent → A wins (policy; bisa LWW/CRDT/app-level)
function syncBidirectional(a, b, diff): ops[]
```

---

## 3. CRDTs (Conflict-free Replicated Data Types)

### Konsep

**CRDT** = struktur data yang **merge tanpa konflik**. Setiap node operasi independen; merge selalu konvergen ke state yang sama — **Strong Eventual Consistency** (SEC). Tidak butuh koordinasi/lock saat write, tidak butuh conflict resolution.

Rahasia di balik CRDT: operasi merge memenuhi 3 sifat matematika:

- **Commutative**: `A ⊕ B = B ⊕ A` (urutan merge tidak penting)
- **Associative**: `(A ⊕ B) ⊕ C = A ⊕ (B ⊕ C)` (grouping tidak penting)
- **Idempotent**: `A ⊕ A = A` (merge ulang tidak ubah hasil)

→ Akibatnya: semua node, urutan merge apapun, konvergen ke state sama.

### Dua Family

| Family | Cara | Syarat | Contoh |
|--------|------|--------|--------|
| **State-based (CvRDT)** | kirim state penuh, merge = LUB (least upper bound) | merge commutative+associative+idempotent | G-Counter, G-Set, OR-Set |
| **Operation-based (CmRDT)** | kirim op, apply di receiver | reliable delivery + causal order | RGA, LWW-Register (op variant) |

> CvRDT lebih simple (cukup kirim state), tapi boros bandwidth. CmRDT efisien (kirim op saja), tapi butuh middleware yang guarantee delivery & ordering. Demo ini pakai **state-based**.

### CRDT Types (yang diimplementasi)

#### G-Counter (Grow-only Counter)

Setiap node punya counter sendiri. Merge = **element-wise max**. Value = **sum** semua node.

```
Node A: {A:5}          Node B: {B:4}          Node C: {C:7}
Merge: {A:5, B:4, C:7} → value = 5+4+7 = 16

Tidak ada double-counting: setiap node hanya count sendiri,
merge ambil max (bukan add) → idempotent.
```

#### PN-Counter (Positive-Negative Counter)

Dua G-Counter: **P** (increments) & **N** (decrements). Value = **P − N**. Mendukung decrement.

```
Node A: P={A:5} N={A:2} → 3
Node B: P={B:4} N={B:2} → 2
Merge: P={A:5,B:4} N={A:2,B:2} → (5+4)−(2+2) = 5
```

#### G-Set (Grow-only Set)

Element hanya bisa **add** (tidak bisa remove). Merge = **union**.

```
Node A: {apple, banana}    Node B: {banana, cherry}
Merge: {apple, banana, cherry}
```

#### 2P-Set (Two-Phase Set)

Dua G-Set: **adds** + **removes**. Element ada jika di adds **DAN tidak** di removes. Mendukung remove, **TAPI** setelah di-remove, tidak bisa di-add lagi (**tombstone problem**).

```
add("x"), add("y"), remove("x") → {y}
add("x") lagi → TIDAK BISA! "x" permanen hilang (tombstone di removes-set)
```

#### OR-Set (Observed-Remove Set)

Setiap **add** punya **unique tag**. Remove hanya hapus tag yang **di-observe** (ada saat remove dilakukan). Concurrent add+remove → **add menang** (remove tidak lihat tag add yang concurrent).

```
Node A: add("item", tag=t1)
Node B: remove("item")        ← B belum observe t1 (tidak punya "item")
Node A: add("item", tag=t2)   ← concurrent dengan remove B
Merge: t1 & t2 masih ada → "item" MASIH ADA. Add wins. ✓

Skenario observe: add("temp",u1) lalu remove("temp") (observe u1)
  → "temp" benar-benar hilang (semua tag di-remove).
```

### CRDT lain (tidak di-demo, tapi penting)

| CRDT | Apa | Contoh produk |
|------|-----|---------------|
| **LWW-Register** | Last-Writer-Wins register (timestamp per write) | Riak, DynamoDB |
| **RGA (Replicated Growable Array)** | Ordered list/text CRDT untuk collaborative editing | Yjs, Automerge |
| **MV-Register** | Multi-Value Register (simpan semua concurrent values) | Riak (siblings) |
| **LWW-Map / OR-Map** | Map dengan CRDT values | Redis CRDT |
| **Sequence CRDT** | Text editing (RGA, LSEQ, Logoot) | Figma, Google Docs (OT) |

> **Figma** pakai CRDT untuk multiplayer collaboration. **Automerge** & **Yjs** = library CRDT untuk collaborative editing. **Riak** = database dengan CRDT data types built-in.

### Code Walkthrough (`crdt.ts`)

```typescript
class GCounter {
  inc(nodeId, by)        // hanya increment komponen sendiri
  merge(other)           // element-wise max → new GCounter
  value()                // sum semua komponen
}

class PNCounter { p: GCounter; n: GCounter; value() = p.value() - n.value() }

class GSet<T> { add(el); merge = union }

class TwoPSet<T> { adds: GSet; removes: GSet; has = adds.has && !removes.has }

class ORSet<T> {
  // element → Set<tag>. remove hapus tag yang observe. tombstones prevent re-add.
  add(el, tag); remove(el); merge = union tags minus tombstones
}
```

---

## 4. Vector Clocks

### Konsep

**Vector clock** = array `[c1, c2, ..., cn]`, satu counter per node. Track **causality** antar event di sistem terdistribusi **tanpa wall-clock** (yang unreliable karena clock skew).

Aturan:

- **Local event**: increment komponen sendiri → `[.., c_i+1, ..]`
- **Send message**: attach vector clock saat ini
- **Receive message**: increment komponen sendiri, lalu **element-wise max** dengan clock pesan

```
Node N1: write x=1     → [1,0,0]  (e1)
  N1 ──msg──→ N2 (attach [1,0,0])
Node N2: recv, write x=2 → [1,1,0]  (e2)  ← causal after e1

Node N3: write x=99    → [0,0,1]  (e3)  ← ISOLATED, tidak tahu e1/e2
  N2 ──msg──→ N3 (attach [1,1,0])
Node N3: recv from N2  → [1,1,2]  (e4)
Node N3: write x=3     → [1,1,3]  (e5)  ← causal after e1,e2
```

### Deteksi Relasi (happens-before)

Dua clock A & B:

- **A == B**: event sama (vector equal)
- **A → B** (happened-before): semua `A[i] ≤ B[i]` DAN minimal satu `<` → **causal**
- **A ‖ B** (concurrent): tidak ada `→` maupun `←` → **KONFLIK**

```
e1 [1,0,0] vs e2 [1,1,0]  → e1 → e2  (causal) ✓
e1 [1,0,0] vs e3 [0,0,1]  → e1 ‖ e3  (CONCURRENT) ← KONFLIK
e2 [1,1,0] vs e3 [0,0,1]  → e2 ‖ e3  (CONCURRENT) ← KONFLIK (dua write ke "x" tanpa causal)
e3 [0,0,1] vs e4 [1,1,2]  → e3 → e4  (causal) ✓
```

Konflik e2 ‖ e3: dua write ke `x` tanpa causal relationship → sistem tidak tahu mana "terbaru". Butuh **conflict resolution**: LWW (wall-clock), CRDT (merge otomatis), atau application-level.

### Kenapa Bukan Wall-Clock (Timestamp Biasa)?

| Masalah | Penjelasan |
|---------|------------|
| **Clock skew** | Clock node bisa beda puluhan ms–detik. N3 clock 10:00:01.500, N1 clock 10:00:01.400 — padahal N3 write terjadi **sebelum** N1 secara causal. LWW akan salah pilih. |
| **Non-monotonic** | NTP/sntp bisa **adjust clock mundur** → timestamp tidak monoton → LWW bisa overwrite data baru dengan lama. |
| **No causality** | Dua write di node berbeda di waktu hampir sama → wall-clock tidak bisa tentukan urutan causal. |

> **Hybrid Logical Clocks (HLC)** = gabungan wall-clock + logical clock: pakai wall-clock untuk "kapan" (human-readable), logical component untuk ordering & causality. Dipakai CockroachDB, Spanner (TrueTime).

### Version Skew vs Clock Skew

- **Version skew**: replica punya version berbeda untuk key sama (stale replica). Diselesaikan oleh read repair / anti-entropy.
- **Clock skew**: clock fisik node berbeda. Diselesaikan oleh NTP, TrueTime (Spanner), atau vector clocks (logical).

### Code Walkthrough (`vector-clocks.ts`)

```typescript
class VectorClockNode {
  clock: { N1, N2, N3 }
  local(desc)     // increment komponen sendiri
  receive(from, desc)  // increment sendiri + element-wise max dengan clock pesan
}

function relate(a, b): "equal" | "happened-before" | "concurrent"
  // equal: vector sama
  // happened-before: semua A[i] ≤ B[i] dan A ≠ B
  // concurrent: tidak ada → maupun ← → KONFLIK
```

---

## Real-World Systems

| System | Teknik | Detail |
|--------|--------|--------|
| **Cassandra** | Read repair + anti-entropy (Merkle) + hinted handoff | Read repair saat quorum read; Merkle tree antar node untuk periodic repair |
| **DynamoDB** | Read repair + vector clocks (dulu) | Sekarang LWW + conflict resolution di application layer |
| **Riak** | Vector clocks + CRDTs (Bucket Types) | CRDT built-in: counters, sets, maps, registers |
| **Voldemort** | Read repair + vector clocks | Inspired by Amazon Dynamo |
| **Figma** | CRDTs | Multiplayer collaborative design editing |
| **Automerge / Yjs** | CRDTs (RGA, sequence CRDT) | Library untuk collaborative text/JSON editing |
| **Google Docs** | Operational Transformation (OT) | Bukan CRDT — OT transform op agar konvergen. Lebih kompleks, butuh central server. |
| **Spanner** | TrueTime + Paxos (strong, bukan eventual) | Mention sebagai kontras: strong consistency via GPS atomic clocks |

---

## Kapan Pakai Eventual Consistency?

**Pakai eventual consistency ketika:**

- High availability lebih penting daripada always-correct reads (social feed, like count, shopping cart)
- Sistem perlu scale ke banyak replica geographically distributed
- Stale reads sesaat dapat ditoleransi (cache, search index, analytics)
- Collaborative editing (CRDTs) — multiple user edit bersamaan tanpa lock
- Workload read-heavy dengan toleransi conflict

**JANGAN pakai eventual consistency ketika:**

- Financial transaction (saldo bank harus strong — pakai 2PC/Paxos)
- Inventory/stock reservation (oversell = masalah)
- Unique constraint enforcement (username, email — butuh strong)
- Sistem yang tidak bisa tolerate stale reads (medical records, authorization)

> **Rule of thumb**: kalau "user bisa melihat data lama sesaat" tidak menyebabkan kerugian → eventual consistency aman. Kalau menyebabkan double-spend, oversell, atau safety issue → strong consistency.

---

## Kelebihan & Kekurangan

### Kelebihan

| + | Penjelasan |
|---|------------|
| **High availability** | Tetap menerima read/write saat partition (CAP: pilih A) |
| **Low latency** | Write tidak tunggu quorum sync → response cepat |
| **Scale-out** | Ribuan replica tanpa koordinasi per write |
| **No single point of failure** | Replica down ≠ sistem down |
| **Self-healing** | Read repair + anti-entropy auto-fix divergence |
| **Conflict-free (CRDTs)** | Merge otomatis tanpa intervention |

### Kekurangan

| - | Penjelasan |
|---|------------|
| **Stale reads** | Client bisa baca data lama sesaat (sebelum konvergen) |
| **Conflict resolution complex** | Concurrent writes butuh policy (LWW/CRDT/app-level) |
| **Read repair overhead** | Read lebih mahal (quorum + compare + write-back) |
| **Metadata cost** | Vector clocks O(n), CRDT tags, tombstones → memory |
| **Tombstone accumulation** | 2P-Set, OR-Set tombstones tumbuh → butuh GC |
| **Not intuitive** | Programmer harus paham causality, conflict, convergence |
| **Hard to debug** | "Kenapa data saya berbeda di 2 replica?" → butuh tracing causality |

---

## Cara Menjalankan

```bash
# Jalankan semua demo (read repair, Merkle tree, CRDTs, vector clocks)
npx tsx 14-eventual-consistency/demo.ts

# Atau jalankan masing-masing file (export function, butuh demo.ts orchestrator)
# demo.ts sudah import & jalankan keempatnya berurutan.
```

### Output yang Diharapkan

```
╔══════════════════════════════════════════════════════════════╗
║  14 — EVENTUAL CONSISTENCY                                   ║
║  All replicas converge eventually, may diverge temporarily   ║
╚══════════════════════════════════════════════════════════════╝

  DEMO 1 — READ REPAIR
  3 replica, R3 stale. Read → detect → write-back → konsisten.

  DEMO 2 — ANTI-ENTROPY (MERKLE TREE)
  2 replica divergen. Merkle tree diff → sync hanya 3 key (bukan 7).

  DEMO 3 — CRDTs
  G-Counter, PN-Counter, G-Set, 2P-Set (tombstone problem), OR-Set (add wins).

  DEMO 4 — VECTOR CLOCKS
  3 node, timeline event, deteksi concurrent writes = konflik.
```

---

## Struktur File

```
14-eventual-consistency/
├── demo.ts            # Orchestrator — jalankan semua demo berurutan
├── read-repair.ts     # Demo 1: read repair (detect stale, write-back)
├── anti-entropy.ts    # Demo 2: Merkle tree comparison + bidirectional sync
├── crdt.ts            # Demo 3: G-Counter, PN-Counter, G-Set, 2P-Set, OR-Set
├── vector-clocks.ts   # Demo 4: vector clocks, happens-before, concurrent detection
└── README.md          # Konsep & penjelasan (file ini)
```

---

## Ringkasan

Eventual consistency = **trade-off**: relaksasi konsistensi saat ini demi availability & latency, dengan jaminan konvergensi nanti. Empat teknik di demo ini saling melengkapi:

1. **Read repair** — fix stale replica saat dibaca (reactive, lazy)
2. **Anti-entropy (Merkle)** — proactive periodic sync, efficient O(log n) diff
3. **CRDTs** — data structure yang merge tanpa konflik (Strong Eventual Consistency)
4. **Vector clocks** — track causality, deteksi concurrent writes yang butuh resolution

Tidak ada teknik "terbaik" — pilih berdasarkan workload:

- Read-heavy, toleransi stale → **read repair**
- Banyak key, sync periodic → **anti-entropy (Merkle)**
- Collaborative, banyak concurrent write → **CRDTs**
- Butuh detect conflict → **vector clocks** (+ CRDT/LWW untuk resolve)

> **Strong Eventual Consistency (SEC)** = jaminan CRDT: semua replica yang menerima set operasi sama akan konvergen ke state identik, tanpa koordinasi. Lebih kuat dari eventual consistency biasa karena **tidak ada conflict**.
