# 13 — Distributed Systems

## Apa itu Distributed System?

**Distributed system** = sistem di mana multiple node (komputer) bekerja sama via **network** untuk mencapai tujuan tunggal, seolah-olah mereka adalah satu sistem. Setiap node punya memori sendiri, tidak ada shared memory global — komunikasi hanya via pesan lewat network.

```
SINGLE NODE:                          DISTRIBUTED SYSTEM:

  ┌──────────────┐                     ┌──────┐  ┌──────┐  ┌──────┐
  │  One Process │                     │Node A│←→│Node B│←→│Node C│
  │  One Memory  │                     │store │  │store │  │store │
  │  One Clock   │                     └──────┘  └──────┘  └──────┘
  └──────────────┘                          ↕         ↕         ↕
                                        network connects all nodes
  + Simple, predictable                  + Scale horizontally (add nodes)
  + No network failure                   + Fault tolerance (1 node down ≠ system down)
  - Single point of failure              - PARTIAL FAILURE (some nodes up, some down)
  - Limited by 1 machine                 - No global clock (time is tricky)
                                         - Network is unreliable (messages drop, delay)
                                         - State diverges (replicas can disagree)
```

Tiga sumber masalah utama di distributed systems:

1. **Network** — pesan bisa hilang, delay, atau out-of-order
2. **Clocks** — tidak ada global clock; setiap node punya waktu sendiri
3. **Partial failure** — beberapa node down, beberapa up (beda dengan crash total)

> **Fallacy**: "Distributed system = multiple computers working together." Tapi sebenarnya, distributed system adalah sistem di mana **hal-hal yang bisa gagal secara independen** membuat pekerjaan jadi sulit. Kompleksitas datang dari *partial failure*, bukan dari jumlah node.

---

## CAP Theorem

**CAP theorem** (Brewer, 2000): distributed data store bisa memberikan **2 dari 3** guarantee berikut:

| Guarantee | Arti |
|-----------|------|
| **C** — Consistency | Setiap read return latest write atau error (semua node lihat data sama) |
| **A** — Availability | Setiap request non-failing node return response (tidak error, tidak timeout) |
| **P** — Partition tolerance | Sistem tetap jalan walau network partition (pesan drop antar grup) |

```
                    C
                   ╱ ╲
                  ╱   ╲
                 ╱     ╲
                ╱       ╲
               CP ────── AP
                ╲       ╱
                 ╲     ╱
                  ╲   ╱
                   ╲ ╱
                    P
                    │
                    │  (P tidak opsional di distributed system —
                    │   network WILL partition, mau tidak mau)
                    │
                   CA  ← hanya mungkin kalau tidak ada network
                         (single node, atau synchronous replication
                          yang berhenti saat partition)
```

### Kenapa Tidak Bisa Ketiga-Tiganya?

Karena **network partition** bisa terjadi (P tidak opsional). Saat partition, cluster terbelah jadi 2 grup yang tidak bisa berkomunikasi. Mau tidak mau harus pilih:

- **Pilih C** → salah satu grup harus **reject** write (kalau accept, data akan divergen → inconsistent). Berarti **sacrifice A** (grup yang reject = tidak available).
- **Pilih A** → kedua grup **accept** write. Tapi data jadi divergen → **sacrifice C** (read bisa stale).

### CAP Clarification (Penting!)

> **CAP bukan "pilih 2 dari 3 selamanya".** CAP bicara tentang **saat partition terjadi**. Di **normal operation** (tidak ada partition), sistem bisa punya **ketiganya** (C + A + P).

```
NORMAL OPERATION (no partition):        DURING PARTITION:

  ┌──────┐ ←→ ┌──────┐ ←→ ┌──────┐       ┌──────┐ ⟘ ┌──────┐ ⟘ ┌──────┐
  │  A   │   │  B   │   │  C   │       │  A   │   │  B   │   │  C   │
  └──────┘   └──────┘   └──────┘       └──────┘   └──────┘   └──────┘
   C ✓        A ✓        P ✓            Harus pilih: C atau A?
   (semua konsisten, semua available)   (tidak bisa keduanya)
```

Jadi CAP sebenarnya: **"If Partition, choose Consistency or Availability."** Sistem modern tidak statis di satu titik CAP — mereka **configurable** per operation (DynamoDB, Cassandra).

### Tiga Mode di Demo Ini

```
CP (Consistency + Partition):          AP (Availability + Partition):
  Partition [A,B] ⟘ [C,D,E]            Partition [A,B] ⟘ [C,D]
  Mayoritas (C,D,E) accept write       KEDUA sisi accept write
  Minoritas (A,B) REJECT write          Read bisa stale (divergen)
  Read selalu latest                    Setelah heal: reconcile (LWW)

  [A] ✗ reject     [C] ✓ accept         [A] ✓ "200"    [C] ✓ "300"
  [B] ✗ reject     [D] ✓ accept         [B] ✓ "200"    [D] ✓ "300"
                   [E] ✓ accept         → divergen → heal → converge

CA (Consistency + Availability):
  NO partition tolerance
  Synchronous replication ke SEMUA node
  Kalau partition → sistem STOP (reject semua write)
  → tidak available, tapi tidak inconsistent
```

---

## PACELC Theorem (Extension)

**PACELC** (Abadi, 2012): perluas CAP untuk kondisi **normal** (tidak hanya saat partition).

> **If Partition (P): choose Availability or Consistency (ELse: choose Latency or Consistency).**

```
                    Partition?
                   ╱          ╲
                 ya            tidak
                 ╱              ╲
            PA atau PC       EL atau EC
            (sama CAP)     (latency vs consistency)

  PACELC:  PA/EL  — partition→Availability, normal→Latency        (Cassandra)
           PA/EC  — partition→Availability, normal→Consistency     (DynamoDB)
           PC/EC  — partition→Consistency, normal→Consistency      (Spanner, MongoDB)
           PC/EL  — partition→Consistency, normal→Latency          (rare)
```

| System | Partition | Else (normal) | PACELC |
|--------|-----------|---------------|--------|
| **Cassandra** | Availability | Latency | PA/EL |
| **DynamoDB** | Availability (default) | Configurable | PA/EL or PA/EC |
| **MongoDB** | Consistency (majority) | Consistency | PC/EC |
| **Spanner** | Consistency | Consistency | PC/EC |
| **etcd/ZooKeeper** | Consistency | Consistency | PC/EC |

> **Inti PACELC**: bahkan tanpa partition, ada trade-off antara **latency** dan **consistency**. Strong consistency butuh synchronous replication = write lambat (tunggu ACK semua replica). Eventual consistency = write cepat (async), tapi read bisa stale.

---

## Consistency Models (Spectrum)

Consistency model = aturan tentang **urutan operasi** yang dilihat client. Dari paling kuat ke paling lemah:

```
STRONG ←────────────────────────────────────────────→ WEAK

Linearizable > Sequential > Causal > Eventual > Weak
    │            │           │          │          │
    │            │           │          │          └─ no guarantee
    │            │           │          └─ converge eventually, bisa stale
    │            │           └─ causal order preserved, concurrent boleh beda
    │            └─ same order as issued (single client view)
    └─ real-time order, read always latest (strongest)
```

| Model | Garansi | Contoh |
|-------|---------|--------|
| **Linearizable** | Read selalu latest write; urutan = real-time | etcd, ZooKeeper, Spanner |
| **Sequential** | Urutan operasi konsisten, tapi tidak harus real-time | ZooKeeper (opsional) |
| **Causal** | Operasi causally-related terurut sama; concurrent boleh beda | COPS, Cassandra (LIGHTWEIGHT tx) |
| **Eventual** | Read bisa stale, tapi converge | Cassandra, DynamoDB, S3 |
| **Weak** | Tidak ada garansi urutan | Cache, CDN edge |

### 1. Strong / Linearizable

```
Timeline (real-time order):

  t1: write("alice") ─────┐
  t2:                     ├─ read → "alice" (HARUS latest)
  t3: write("bob") ───────┤
  t4:                     └─ read → "bob" (HARUS latest)

  Setiap read return value dari write terakhir (by real-time).
  Implementasi: coordinator + synchronous replication (tunggu ACK semua replica).
  Trade-off: write lambat, tidak available saat partition (CP).
```

### 2. Eventual Consistency

```
Timeline (async replication, ada lag):

  t1: write("alice") → coordinator updated, replica PENDING
  t2: read(R2) → "null" (STALE — belum propagate)
  t3: tick → 1 propagation sampai
  t4: read(R2) → "null" (masih STALE)
  t5: converge → semua replica up-to-date
  t6: read(R2) → "alice" (converged)

  Window stale = replication lag. Trade-off: write cepat, available saat partition (AP).
```

### 3. Causal Consistency (Vector Clocks)

**Causal consistency**: kalau operasi A "menyebabkan" operasi B (B tahu tentang A), maka semua node harus lihat A sebelum B. Operasi **concurrent** (tidak saling tahu) boleh dilihat dalam urutan berbeda.

**Vector clock** = struktur `{nodeId: count}` untuk track causality. Aturan:

- Setiap write: increment komponen node sendiri
- Setiap receive: merge clock pengirim ke clock sendiri
- Compare: A < B jika semua komponen A ≤ B dan minimal satu <. Concurrent jika tidak ≤.

```
Skenario:

  N1: write post="hello"     vc={N1:1, N2:0, N3:0}
       │ propagate
       ▼
  N2: lihat post, write reply="hi"   vc={N1:1, N2:1, N3:0}  (depends on post)

  N1: write like="👍"        vc={N1:2, N2:0, N3:0}  ┐
                                                    ├─ CONCURRENT
  N3: write like="❤️"       vc={N1:0, N2:0, N3:1}  ┘
       (belum saling tahu)

  Aturan causal:
  • Node yang lihat reply PASTI sudah lihat post (reply depends on post)
  • like@N1 vs like@N3: concurrent → node boleh pilih urutan mana pun
```

### 4. Read-Your-Writes Consistency

**Client-centric**: client selalu lihat write-nya sendiri, bahkan sebelum replikasi selesai. Bukan global consistency — client lain mungkin belum lihat.

```
  client-A write "alice" → R1 (session cache updated)
  client-A read dari R2  → "alice" (via session cache, walau R2 belum propagate) ✓
  client-B read dari R2  → "null"  (client-B tidak punya session cache) ✗

  Implementasi: sticky session, session token, atau client-side cache.
  Penting untuk UX: user yang baru edit profile harus langsung lihat edit-nya.
```

---

## Consistency vs Consensus

Sering dibingungkan — **related tapi berbeda**:

| | Consistency | Consensus |
|---|-------------|-----------|
| **Apa** | Aturan urutan operasi yang dilihat client | Proses node sepakat **satu nilai** |
| **Pertanyaan** | "Urutan operasi seperti apa yang valid?" | "Node sepakat nilai apa?" |
| **Fokus** | Client-facing guarantee | Node-facing agreement |
| **Contoh** | Linearizable, eventual | Paxos, Raft, PBFT |
| **Hubungan** | Consensus dipakai untuk **implement** strong consistency | Consensus tidak peduli client-facing model |

```
Consensus: "Node A, B, C harus sepakat: nilai X atau Y?"
           → Raft/Paxos → semua commit ke X

Consistency: "Setelah commit, read dari node mana pun return X?"
             → linearizable (butuh consensus di belakangnya)
```

> **Linearizability membutuhkan consensus** (untuk decide urutan write). Tapi consensus tidak butuh linearizability — consensus adalah building block.

---

## Network Partitions

**Network partition** = network terbelah sehingga sebagian node tidak bisa berkomunikasi dengan sebagian lain. Bisa karena switch gagal, kabel putus, misconfig firewall, atau network congestion ekstrem.

### Split-Brain

```
SPLIT-BRAIN (tanpa fencing):

  Partition: [A,B] ⟘ [C,D]
  Kedua sisi pikir sisi lain down →
  Kedua sisi pilih leader sendiri →

  [A,B]: "saya leader, accept write X"
  [C,D]: "saya leader, accept write Y"

  Heal → DUA leader, data divergen → KORUPSI
```

### Quorum (Majority)

Solusi split-brain: **quorum** — hanya grup dengan **mayoritas** (>50%) yang boleh accept write. Grup minoritas **stand down**.

```
5 node, partition [A,B] ⟘ [C,D,E]:

  [A,B] = 2 node = MINORITY → reject write (stand down)
  [C,D,E] = 3 node = MAJORITY → accept write (jaga consistency)

  Kalau 2 grup sama-sama 2 node (4 total) → DEADLOCK, tidak ada majority
  → sistem unavailable sampai heal (sacrifice A for C)
```

### Fencing

**Fencing** = mencegah node yang "kira" dia leader tapi sebenarnya sudah di-depose untuk melakukan write. **Fencing token** = angka monoton yang naik setiap leader change.

```
  Node A (leader lama, partition) → coba write ke storage
  Storage: "token kamu 5, tapi leader sekarang token 6 → REJECT"
  → A tidak bisa korup storage walau dia pikir dia leader
```

| Mekanisme | Cara | Contoh |
|-----------|------|--------|
| **Quorum** | Hanya majority accept write | Raft, Paxos, MongoDB replica set |
| **Fencing token** | Storage reject write dari leader lama | ZooKeeper, GFS chubby |
| **Lease** | Leader punya lease berwaktu; expire → tidak bisa write | etcd, CockroachDB |

---

## Failure Models

Bagaimana node bisa gagal? Dari yang paling "jinak" ke paling "jahat":

| Model | Perilaku | Tolerate dengan |
|-------|----------|-----------------|
| **Crash-stop** | Node gagal, tidak pernah recover | Replication (replica lain ambil alih) |
| **Crash-recovery** | Node gagal, restart, harus catch-up | Log replay, anti-entropy, snapshot |
| **Omission** | Node drop pesan (network gagal untuk node tertentu) | Retry, timeout, ack-based |
| **Byzantine** | Node jahat/bug — kirim pesan konflik, berbohong | BFT consensus (3f+1 node) |

### Crash-Stop

```
  Node A crash → tidak pernah balik
  Sistem: A hilang permanen. Data A hilang kalau tidak ada replica.
  Solusi: replication factor ≥ 3 (data ada di A, B, C — A down masih ada B,C)
```

### Crash-Recovery

```
  Node A crash → restart → data lokal hilang (volatile memory)
  Saat down, missed writes (v2, v3)
  Solusi: catch-up via:
    • Log replay (kalau ada durable log)
    • Anti-entropy (compare state dengan peer, sync yang beda)
    • Snapshot + log (restore dari snapshot, replay log setelahnya)
```

### Byzantine

```
  Node A (byzantine) kirim value BERBEDA ke B dan C:
    A → B: "value = X"
    A → C: "value = Y"  (berbohong!)

  Tanpa BFT: B dan C tidak tahu mana yang benar → divergen
  Solusi: Byzantine consensus — butuh ≥ 3f+1 node untuk tolerate f byzantine
    (jadi dengan 4 node, tolerate 1 byzantine; 7 node, tolerate 2)

  Contoh: blockchain (PoW/PoS), PBFT, Tendermint, Hyperledger Fabric
```

> **Crash failure** = node hanya bisa gagal dengan cara "berhenti" (fail-stop). **Byzantine failure** = node bisa berperilaku **apa pun** (berbohong, konflik, collude). Byzantine jauh lebih sulit — butuh consensus yang mahal (3f+1, bukan 2f+1).

---

## Fallacies of Distributed Computing

8 asumsi salah yang sering dibuat programmer distributed system (Peter Deutsch, Sun Microsystems):

| # | Fallacy | Realita |
|---|---------|---------|
| 1 | **Network reliable** | Network drop, partition, congestion — selalu |
| 2 | **Latency is zero** | Setiap network hop = ms, bukan μs |
| 3 | **Bandwidth is infinite** | Bandwidth terbatas, besar data = lambat |
| 4 | **Network is secure** | Man-in-the-middle, DDoS, eavesdrop |
| 5 | **Topology doesn't change** | Node join/leave, IP berubah |
| 6 | **There is one administrator** | Banyak admin, misconfig, policy beda |
| 7 | **Transport cost is zero** | Serialize/deserialize, TLS, compression = CPU |
| 8 | **Network is homogeneous** | Protocol beda, version beda, vendor beda |

> **Konsekuensi**: setiap asumsi yang salah = bug di production. "Network reliable" → tidak handle retry → transient error = user-facing failure. "Latency zero" → synchronous call chain → timeout cascade.

---

## Real-World Systems

| System | CAP | Consistency | Notes |
|--------|-----|-------------|-------|
| **Cassandra** | AP | Eventual (tunable) | Last-write-wins, hinted handoff, read-repair. Tunable consistency per query (`ONE`, `QUORUM`, `ALL`) |
| **MongoDB** | CP | Strong (with `majority`) | Replica set, leader election via Raft. `w:majority` untuk strong, `w:1` untuk fast |
| **Spanner** | CA (P→stop) | Linearizable | Synchronous replication + TrueTime (atomic clock). Global strong consistency |
| **DynamoDB** | AP (configurable) | Eventual / Strong (per request) | `ConsistentRead=true` → strong; default eventual. R + W > N untuk strong |
| **etcd / ZooKeeper** | CP | Linearizable | Raft/Zab consensus. Always consistent, sacrifice availability saat partition |
| **Redis (cluster)** | AP (gossip) | Eventual | Async replication to replicas. Sentinel/Cluster for failover |
| **Kafka** | AP (per partition) | Eventual (offset) | Leader per partition, ISR (in-sync replicas). `acks=all` → CP-ish |
| **S3** | AP | Read-after-write-strong (per key) | Strong consistency for new writes since Dec 2020; eventual for overwrite |

### Tunable Consistency (Cassandra/DynamoDB)

```
  N = replication factor (mis. 3 — data ada di 3 node)
  W = write consistency level (berapa ACK yang ditunggu)
  R = read consistency level (berapa response yang dibaca)

  R + W > N  → strong consistency (overlap guaranteed → latest)
  R + W ≤ N  → eventual consistency (bisa no overlap → stale)

  Contoh N=3:
    W=1, R=1 → fast, eventual (1+1=2 ≤ 3)
    W=2, R=2 → strong (2+2=4 > 3)
    W=3, R=3 → strongest, slowest (tunggu semua)
```

---

## When to Use Which Consistency Model

| Use case | Model | Kenapa |
|----------|-------|-------|
| **Banking / payment** | Linearizable | Tidak boleh double-spend, saldo harus akurat |
| **Inventory / stock** | Linearizable / sequential | Oversell = masuk penjara |
| **Leader election** | Linearizable (consensus) | Tidak boleh 2 leader |
| **Social media feed** | Eventual | Stale 5 detik tidak masalah, availability penting |
| **Shopping cart** | Read-your-writes | User harus lihat item yang baru ditambah |
| **CDN / cache** | Weak / eventual | Performance > consistency |
| **Collaborative doc** | Causal | Urutan edit harus masuk akal (causal), concurrent boleh beda |
| **Counter (views, likes)** | Eventual | Exact count tidak kritis, eventual converge cukup |
| **Configuration / lock** | Linearizable | Lock harus mutual exclusion |

> **Aturan praktis**: mulai dari yang paling lemah yang masih acceptable. Strong consistency mahal (latency, unavailable saat partition). Naikkan ke strong hanya kalau business requirement demand.

---

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Horizontal scalability** — tambah node untuk scale, bukan upgrade mesin
- **Fault tolerance** — 1 node down ≠ sistem down (dengan replication)
- **Geographic distribution** — data dekat dengan user (low latency regional)
- **No single point of failure** — tidak bergantung 1 mesin
- **Elasticity** — scale up/down sesuai load
- **Independent upgrade** — rolling upgrade node per node

### ❌ Kekurangan

- **Partial failure** — beberapa node up, beberapa down (sulit debug)
- **No global clock** — time-based logic jadi tricky (NTP drift, clock skew)
- **Network unreliable** — partition, latency, drop (CAP trade-off)
- **Consistency vs availability** — tidak bisa kedua-duanya saat partition
- **Complex debugging** — "apa yang terjadi di node C saat t=3?" (distributed tracing)
- **Operational overhead** — monitoring, deployment, config management per node
- **Data divergence** — replica bisa disagree, perlu reconciliation
- **Security surface** — network communication = attack surface (mTLS, auth)

---

## Cara Coba

```bash
# Run semua demo (CAP + consistency + failures) dalam 1 run
npx tsx 13-distributed-systems/demo.ts

# Demo menunjukkan 3 part:
# Part 1: CAP Theorem
#   - CP: partition → minoritas reject, mayoritas serve, read latest
#   - AP: partition → kedua sisi accept, divergen, heal → reconcile
#   - CA: partition → sistem STOP (no partition tolerance)
#
# Part 2: Consistency Models
#   - Strong (linearizable): read selalu latest
#   - Eventual: stale window → converge
#   - Causal: vector clocks, concurrent boleh beda urutan
#   - Read-your-writes: session cache, client lihat write sendiri
#
# Part 3: Node Failures
#   - Crash-stop: node down permanen, replica ambil alih
#   - Crash-recovery: node restart, catch-up missed writes
#   - Byzantine: node kirim pesan konflik, divergen tanpa BFT
```

## Struktur File

```
13-distributed-systems/
  cap-theorem.ts          → CAP cluster simulator (CP/AP/CA, partition, reconcile)
  consistency-models.ts   → Strong, eventual, causal (vector clocks), read-your-writes
  demo.ts                 → Orchestrator: 3-part demo (CAP, consistency, failures)
  README.md               → Penjelasan ini
```
