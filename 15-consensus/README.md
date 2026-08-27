# 15 — Consensus (Raft)

## Apa itu Consensus?

**Consensus** = proses di mana sekelompok node **sepakat** pada satu nilai/state yang sama, meskipun ada node yang crash atau network yang unreliable.

```
        Client
          │
          │  "SET x=42"
          ▼
     ┌─────────┐
     │ Leader  │  ──── AppendEntries ────→  Follower 1: "OK, x=42"
     │ (n0)    │  ──── AppendEntries ────→  Follower 2: "OK, x=42"
     └─────────┘  ──── AppendEntries ────→  Follower 3: "OK, x=42"
          │
          │  majority ACK (3/5) → COMMIT
          ▼
     "x=42 committed, applied to state machine"
```

Tanpa consensus, kalau 5 node simpan data sendiri-sendiri, bisa terjadi:

- Node A bilang `x=42`, node B bilang `x=99` → **inconsistency**
- Network partition → 2 leader → **split-brain**
- Leader crash → siapa yang jadi leader? → **leader election**

Consensus menyelesaikan ketiganya dengan satu algoritma.

---

## Kenapa Consensus?

| Use Case | Contoh |
|----------|--------|
| **Leader election** | Pilih master node di cluster (etcd, Redis Sentinel) |
| **Log replication** | Replicate write-ahead log ke semua replica (etcd, Consul) |
| **Configuration change** | Update cluster membership tanpa downtime |
| **Distributed lock** | Lock yang valid across nodes (ZooKeeper, etcd lease) |
| **Metadata store** | Service discovery, config (Kubernetes → etcd) |
| **State machine replication** | Replicate state machine via log (semua di atas) |

> **State Machine Replication**: kalau semua node punya log yang sama (urutan command sama), dan command deterministik, maka state machine semua node akan identik. Consensus = cara menjaga log tetap sama.

---

## FLP Impossibility Result

**Fischer, Lynch, Paterson (1985)**: di **asynchronous network** (delay pesan tidak terbatas) dengan **1 node bisa crash**, tidak ada algoritma yang **sekaligus** menjamin:

- **Safety**: tidak pernah memilih nilai yang salah (tidak ada 2 leader di term yang sama)
- **Liveness**: pasti akan ada keputusan (tidak stuck selamanya)

```
Asynchronous + 1 failure → TIDAK BISA safety + liveness sekaligus

  Safety  ───────────────  Liveness
     │                       │
     └─────── FLP ───────────┘
              "pick one"
```

### Raft mengakali FLP bagaimana?

Raft **mengorbankan liveness** dalam kasus ekstrem (bisa stuck kalau timing buruk), tapi **menjamin safety selalu**. Dalam praktik:

- **Randomized election timeout** → kemungkinan 2 candidate timeout persis sama sangat kecil → biasanya ada pemenang
- **Partial synchrony**: di dunia nyata, network tidak benar-benar async (delay terbatas) → liveness tercapai

> **Partial Synchrony** (Dwork, Lynch, Stockmayer): network async tapi "eventually synchronous" — ada periode di mana delay terbatas. Algoritma consensus praktis mengasumsikan ini.

---

## Raft Algorithm

Raft dirancang untuk **understandable** (mudah dipahami). Dibanding Paxos yang lebih dulu ada tapi sulit dipahami, Raft memecah consensus jadi 3 sub-masalah:

```
┌─────────────────────────────────────────────────┐
│                  RAFT                           │
│                                                 │
│  1. Leader Election  — pilih 1 leader           │
│  2. Log Replication  — replicate log ke semua   │
│  3. Safety           — guarantee konsistensi    │
└─────────────────────────────────────────────────┘
```

### Node State

```
  ┌──────────┐    timeout     ┌───────────┐    majority votes    ┌────────┐
  │ FOLLOWER │ ─────────────→ │ CANDIDATE │ ──────────────────→  │ LEADER │
  └──────────┘                └───────────┘                       └────────┘
       ▲                          │                                  │
       │    higher term            │ timeout (no majority)            │ higher term
       └──────────────────────────┘                                  └──────┐
       │                                                                  │
       └──────────────────────────────────────────────────────────────────┘
                          step down (sees higher term)
```

| State | Tugas | Term |
|-------|-------|------|
| **Follower** | Terima RPC dari leader, vote untuk candidate | Pasif |
| **Candidate** | Minta vote, campaign untuk jadi leader | Increment term |
| **Leader** | Terima client command, replicate log, kirim heartbeat | Aktif |

### Term

**Term** = logical clock monotonik. Setiap election increment term. Term dibagi jama periode:

```
Term 1:  |══════════════════════════════════════════════════════|
         n0 elected leader → n0 crash → election
Term 2:  |══════════════════════════════════════════════════════|
         n1 elected leader → ...
Term 3:  |══════════════════════════════════════════════════════|
```

- Term naik hanya saat election baru
- Node menolak RPC dengan term lebih rendah (stale)
- Node step down kalau lihat term lebih tinggi

> Term = "epoch". Leader di term lama tidak boleh memerintah di term baru.

### 1. Leader Election

```
  n0 (follower)         n1, n2, n3, n4 (followers)
  election timeout!
       │
       ▼
  ┌──────────┐
  │ CANDIDATE│  term: 0 → 1
  │  vote=n0 │
  └──────────┘
       │
       │  RequestVote(term=1, lastLogIndex=0, lastLogTerm=0)
       ├──────────────→ n1: "vote granted" (log up-to-date, belum vote)
       ├──────────────→ n2: "vote granted"
       ├──────────────→ n3: "vote granted"
       └──────────────→ n4: "vote granted"

  votes = 5/5 ≥ majority(3) → LEADER!
       │
       │  heartbeat (AppendEntries kosong)
       ├──────────────→ n1: reset election timer
       ├──────────────→ n2: reset election timer
       └─ ...          → followers know leader is alive
```

**Randomized election timeout** = kunci anti-split-vote:

- Setiap node punya timeout random (mis. 150–300ms)
- Node dengan timeout terkecil timeout duluan → jadi candidate duluan
- Kemungkinan 2 node timeout persis bersamaan = kecil

**RequestVote RPC**:

```
Request:  { term, candidateId, lastLogIndex, lastLogTerm }
Response: { term, voteGranted }

Grant vote IF:
  1. req.term >= currentTerm (candidate tidak stale)
  2. Belum vote di term ini (atau sudah vote untuk candidate ini)
  3. Candidate's log at least as up-to-date (election restriction)
```

### 2. Log Replication

```
  Client                Leader (n0)              Followers (n1–n4)
    │                       │                          │
    │  "SET x=42"           │                          │
    ├──────────────────────→│                          │
    │                       │ append to log (#1, t1)   │
    │                       │                          │
    │                       │  AppendEntries(#1)       │
    │                       ├─────────────────────────→│ append to log
    │                       │←───────── ACK ──────────┤
    │                       │                          │
    │                       │ majority ACK (3/5)       │
    │                       │ → commit #1              │
    │                       │ → apply to state machine │
    │  "OK, committed"      │                          │
    │←──────────────────────┤                          │
    │                       │  next heartbeat:         │
    │                       │  leaderCommit=1          │
    │                       ├─────────────────────────→│ commit + apply
```

**AppendEntries RPC**:

```
Request:  { term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommit }
Response: { term, success, matchIndex }

Success IF:
  1. req.term >= currentTerm (leader valid)
  2. prevLogIndex match (log consistency check)
     → entry at prevLogIndex exists AND term == prevLogTerm

On success:
  - Append entries (overwrite conflict)
  - If leaderCommit > commitIndex → commitIndex = min(leaderCommit, lastNewIndex)
  - Apply committed entries to state machine
```

**Commit rule**: leader commit entry kalau **majority** node ACK entry tersebut. Leader piggyback `commitIndex` di AppendEntries berikutnya → followers ikut commit.

### 3. Safety: Election Restriction

**Candidate's log harus at least as up-to-date** sebagai voter. Mencegah node dengan log lama jadi leader.

```
"Up-to-date" comparison:
  1. lastLogTerm lebih besar → lebih up-to-date
  2. lastLogTerm sama → lastLogIndex lebih besar → lebih up-to-date

  Candidate A: log = [#1(t1), #2(t1), #3(t2)]  → lastLogTerm=2, lastLogIndex=3
  Candidate B: log = [#1(t1), #2(t1)]          → lastLogTerm=1, lastLogIndex=2

  A lebih up-to-date (lastLogTerm 2 > 1) → voter pilih A, bukan B
```

Tanpa election restriction, node yang ketinggalan log bisa jadi leader → entry yang sudah committed bisa hilang → **violate safety**.

### Safety: Commit dari Term Sendiri

Leader hanya boleh commit entry dari **currentTerm** dengan menghitung majority matchIndex. Entry dari term lama di-commit tidak langsung, tapi indirectly saat entry term baru di-commit setelahnya.

```
  Leader tidak boleh commit entry term lama berdasarkan majority matchIndex saja.
  Kenapa? Entry term lama mungkin sudah di-replace di node yang tidak terlihat.

  Aman: commit entry #N (currentTerm) → entry #1..#N-1 ikut committed.
```

### Membership Changes

Cluster bisa ganti membership (tambah/hapus node) tanpa downtime. Dua fase:

```
1. Joint consensus: old + new config overlap
   - Entry di-replicate ke BOTH old dan new nodes
   - Majority butuh dari old AND new

2. New config only:
   - Setelah joint consensus committed → switch ke new config only
   - Old nodes yang tidak di new config → retired
```

> Di demo ini tidak diimplementasikan (fokus election + replication). etcd/Consul mendukung ini.

---

## Paxos (Brief)

Paxos (Lamport, 1998) = consensus algorithm yang lebih tua dari Raft. Lebih general tapi **sulit dipahami**.

### Paxos Protocol

```
Phase 1: Prepare / Promise
  Proposer → Acceptors: "Prepare(n)"     (n = proposal number)
  Acceptor → Proposer: "Promise(n)"      (janji tidak accept proposal < n,
                                           + kirim value yang sudah accepted sebelumnya)

Phase 2: Accept / Ack
  Proposer → Acceptors: "Accept(n, value)"  (value = value dengan proposal number tertinggi
                                              yang diterima di Phase 1)
  Acceptor → Proposer: "Ack(n)"          (accept kalau n >= highest promised)
```

```
Proposer          Acceptor 1    Acceptor 2    Acceptor 3
   │                  │            │            │
   │  Prepare(5)      │            │            │
   ├─────────────────→│            │            │
   ├──────────────────────────────→│            │
   ├───────────────────────────────────────────→│
   │←── Promise(5) ───│            │            │
   │←── Promise(5) ────────────────│            │
   │                  │            │            │
   │  Accept(5, v)    │            │            │
   ├─────────────────→│            │            │
   ├──────────────────────────────→│            │
   │←── Ack(5) ───────│            │            │
   │←── Ack(5) ────────────────────│            │
   │  majority ack → chosen!       │
```

### Raft vs Paxos

| Aspek | Raft | Paxos |
|-------|------|-------|
| **Understandability** | Dirancang untuk mudah dipahami | Sulit, banyak nuansa |
| **Leader** | Strong leader (semua via leader) | Proposer (bisa multiple) |
| **Log** | Ordered log, state machine replication | Single value (Multi-Paxos = extension) |
| **Election** | Built-in leader election | Tidak spesifik (implementasi terpisah) |
| **Membership change** | Joint consensus (spec) | Tidak di spec asli |
| **Implementasi** | etcd, Consul, CockroachDB | Chubby (Google), Spanner (Paxos-like) |
| **Populer** | Sangat populer (2014+) | Lebih tua, foundational |

> **Kenapa Raft lebih populer?** Bukan karena lebih powerful, tapi karena **lebih mudah diimplementasi dengan benar**. Bug di consensus = disaster. Paxos punya banyak edge case yang mudah salah. Raft spec jelas, ada thesis Ongaro yang detail.

---

## Byzantine Fault Tolerance (BFT)

Raft dan Paxos mengasumsikan **crash-stop failure**: node crash atau healthy, tidak boong. Tapi di sistem di mana node bisa **boong** (Byzantine failure) — mis. blockchain, sistem adversarial — butuh algoritma berbeda.

### Crash-Stop vs Byzantine

```
CRASH-STOP:                    BYZANTINE:
  Node crash → mati              Node bisa:
  Node healthy → jujur           - crash
  Tidak ada node jahat           - kirim pesan salah
                                 - kirim pesan beda ke node berbeda
                                 - berpura-pura jadi node lain

  Toleransi: f < n/2             Toleransi: f < n/3
  Quorum: n/2 + 1 (majority)     Quorum: 2f + 1
```

### PBFT (Practical Byzantine Fault Tolerance)

PBFT (Castro, Liskov, 1999) = algoritma BFT praktis. 3 fase:

```
1. Pre-prepare:  primary → replicas: "here's the request"
2. Prepare:      replicas saling broadcast: "I saw this pre-prepare"
3. Commit:       replicas saling broadcast: "I saw 2f+1 prepares"
                 → execute request, reply to client
```

- Toleransi: **f < n/3** (butuh 3f+1 node untuk tolerate f Byzantine)
- Setiap fase butuh **2f+1** quorum
- Primary bisa di-ganti kalau Byzantine (view change)

### Nakamoto Consensus (Bitcoin)

Bitcoin pakai approach berbeda — **Nakamoto consensus**:

```
Proof-of-Work:  siapa yang paling banyak hash power → dia bikin block
Longest chain:  chain terpanjang = chain valid (most work)
Fork resolve:  kalau ada 2 chain, yang lebih panjang menang
               (chain pendek = "orphan", diabaikan)

  Block 1 ←── Block 2 ←── Block 3 ←── Block 4a  ← (orphan, shorter)
                    └── Block 4b ←── Block 5   ← (main chain, longest)
```

- Toleransi: attacker butuh **>50% hash power** (bukan node count)
- Probabilistic finality: block "confirmed" setelah N block di atasnya (N=6 di Bitcoin)
- Bukan BFT klasik, tapi "eventual consensus" via economic incentives

| Algorithm | Failure Model | Tolerance | Quorum | Finality |
|-----------|---------------|-----------|--------|----------|
| **Raft** | Crash-stop | f < n/2 | n/2+1 | Immediate (commit) |
| **Paxos** | Crash-stop | f < n/2 | n/2+1 | Immediate (chosen) |
| **PBFT** | Byzantine | f < n/3 | 2f+1 | Immediate (commit) |
| **Nakamoto** | Byzantine | <50% hash | N/A | Probabilistic (N confirmations) |

---

## Quorum

**Quorum** = jumlah node yang harus agree untuk keputusan valid.

```
Crash-stop (Raft, Paxos):
  Quorum = ⌊n/2⌋ + 1  (majority)
  Toleransi = f < n/2  (tolerate f crash)

  n=3 → quorum=2, tolerate 1 failure
  n=5 → quorum=3, tolerate 2 failures
  n=7 → quorum=4, tolerate 3 failures

Byzantine (PBFT):
  Quorum = 2f + 1  (dari 3f+1 node)
  Toleransi = f < n/3  (tolerate f Byzantine)

  n=4  → tolerate 1 Byzantine, quorum=3
  n=7  → tolerate 2 Byzantine, quorum=5
  n=10 → tolerate 3 Byzantine, quorum=7
```

### Kenapa majority (n/2+1) untuk crash-stop?

```
  2 majority di partition berbeda TIDAK mungkin overlap:

  n=5, majority=3
  Partition A: {n0, n1, n2}  → majority (3)
  Partition B: {n3, n4}      → NOT majority (2, < 3)

  Hanya 1 partition yang punya majority → 1 leader → no split-brain.
  Kalau 2 partition sama-sama majority → harus overlap ≥ 1 node
  → node yang overlap tidak bisa di 2 tempat → impossible.
```

### Kenapa 2f+1 (dari 3f+1) untuk Byzantine?

```
  Byzantine node bisa kirim pesan beda ke node berbeda.
  Quorum 2f+1 dari 3f+1 → 2 quorum overlap ≥ f+1 node.
  f+1 overlap → minimal 1 honest node (karena max f Byzantine).
  Honest node memastikan 2 quorum agree → consistency.
```

---

## Real-World Implementations

| System | Algorithm | Use Case | Notes |
|--------|-----------|----------|-------|
| **etcd** | Raft | Kubernetes metadata store | CNCF, key-value, gRPC API |
| **Consul** | Raft | Service discovery + config | HashiCorp, health checks |
| **ZooKeeper** | Zab (Paxos-like) | Coordination, distributed locks | Apache, hierarchical tree |
| **TiKV** | Raft | Distributed KV (TiDB storage) | Multi-Raft (1 Raft group per region) |
| **CockroachDB** | Raft | Distributed SQL | Multi-Raft, geo-replication |
| **Chubby** | Paxos | Distributed lock (Google) | Internal Google, Paxos-based |
| **Spanner** | Paxos | Global DB (Google) | Paxos group per shard |
| **Bitcoin** | Nakamoto | Cryptocurrency | PoW, longest chain |
| **Ethereum** | Casper/Ghost | Cryptocurrency | PoS (post-merge), BFT-inspired |

### Multi-Raft

Sistem besar (TiKV, CockroachDB) tidak pakai 1 Raft group, tapi **Multi-Raft**:

```
  Data di-split jama "regions" (range of keys)
  Setiap region = 1 Raft group (3-5 replicas)

  Region A: keys [1-100)   → Raft group {n0, n1, n2}
  Region B: keys [100-200) → Raft group {n1, n2, n3}
  Region C: keys [200-300) → Raft group {n2, n3, n4}

  Setiap node ikut multiple Raft group → spread load
  Leader per-region → parallel throughput
```

---

## Code Walkthrough

### `raft.ts` — Core Algorithm

```
RaftNode
  ├── State: role, currentTerm, votedFor, log[], commitIndex, lastApplied
  ├── Leader state: nextIndex[], matchIndex[]
  ├── startElection()        → Candidate, increment term, RequestVote
  ├── handleRequestVote()    → Grant/deny vote (election restriction)
  ├── handleAppendEntries()  → Append log, consistency check, commit
  ├── propose()              → Leader: append + replicate
  ├── broadcastAppendEntries() → Send to all peers, update matchIndex
  └── updateCommitIndex()    → Majority matchIndex → commit

RaftCluster
  ├── nodes (Map<id, RaftNode>)
  ├── tick()                 → Advance clock, trigger timeouts, heartbeats
  ├── crashNode() / restartNode() → Failure simulation
  ├── setPartition() / healPartition() → Network partition simulation
  └── peersOf()              → Reachable peers (partition-aware)
```

### Simulation Model

```
Tick-based discrete event loop (bukan real-time):

  tick 0:  cluster start, all followers
  tick 5:  n0 election timeout → startElection → leader
  tick 6:  n0 heartbeat → followers reset timer
  tick 8:  client → n0: "SET x=42" → append → replicate → commit
  tick 10: n0 crash → followers stop getting heartbeat
  tick 20: n1 election timeout → new leader (term 2)
  ...
```

- `now` = logical clock (integer ticks)
- `electionDeadline` = tick saat node timeout
- Randomized jitter mencegah split vote
- Network call sinkron, partition-aware (`peersOf` filter)

### Key Implementation Details

**Election restriction** (`handleRequestVote`):

```typescript
const upToDate =
  req.lastLogTerm > this.lastLogTerm ||
  (req.lastLogTerm === this.lastLogTerm &&
   req.lastLogIndex >= this.lastLogIndex);
```

**Log consistency check** (`handleAppendEntries`):

```typescript
if (req.prevLogIndex > 0) {
  const prevEntry = this.log.find((e) => e.index === req.prevLogIndex);
  if (!prevEntry || prevEntry.term !== req.prevLogTerm) {
    return { success: false, ... };  // reject → leader decrement nextIndex
  }
}
```

**Commit rule** (`updateCommitIndex`):

```typescript
// Find highest N where majority matchIndex >= N AND log[N].term == currentTerm
for (let n = majorityMatched; n > this.commitIndex; n--) {
  const entry = this.log.find((e) => e.index === n);
  if (entry && entry.term === this.currentTerm) {
    this.commitIndex = n;
    this.applyCommitted();
    break;
  }
}
```

**Step down on stale term** (`stepDownIfStale`):

```typescript
if (term > this.currentTerm) {
  this.currentTerm = term;
  this.role = "follower";
  this.votedFor = null;
}
```

### `demo.ts` — Scenarios

```
Phase 1: Normal — leader election, log replication, commit
Phase 2: Leader crash → re-election
Phase 3: Network partition → split-brain prevention
Phase 4: Partition heal → catch up
Phase 5: Old leader returns → step down on higher term
```

---

## How to Run

```bash
# Run the full demo (all 5 phases)
npx tsx 15-consensus/demo.ts

# Atau (setelah parent agent add script):
# npm run consensus
```

Output menunjukkan:

- Node states (Follower/Candidate/Leader/Crashed)
- Term numbers
- Vote counts
- Log entries (index, term, command)
- Commit index & applied index
- State machine (key=value)

---

## Comparison: Consensus Algorithms

| Algorithm | Failure Model | Tolerance | Leader | Complexity | Populer |
|-----------|---------------|-----------|--------|------------|---------|
| **Raft** | Crash-stop | f < n/2 | Strong leader | Medium (understandable) | ★★★★★ |
| **Paxos** | Crash-stop | f < n/2 | Proposer (optional) | High (subtle) | ★★★ |
| **PBFT** | Byzantine | f < n/3 | Primary | High (3-phase) | ★★★ |
| **Zab** | Crash-stop | f < n/2 | Leader | Medium | ★★★ |
| **Nakamoto** | Byzantine | <50% hash | N/A (no leader) | Low (but PoW) | ★★★★★ |

---

## Kapan Pakai Consensus Algorithms?

**Pakai kalau:**

- Butuh strong consistency across multiple nodes (metadata, config)
- Butuh leader election otomatis (failover)
- Butuh distributed lock / coordination
- Membangun distributed database / storage

**JANGAN pakai kalau:**

- Single node cukup (consensus = overhead, latency)
- Eventual consistency OK (pakai replication + conflict resolution, lebih simple)
- High throughput > strong consistency (AP system, Dynamo-style)
- Tidak butuh linearizability (CRDT, last-write-wins)

> **CAP Theorem**: Consensus = CP (consistency + partition tolerance). Sacrifice availability saat partition (minority tidak bisa serve). Kalau butuh AP, pakai Dynamo/Cassandra-style (eventual consistency, always available).

---

## Kelebihan & Kekurangan

### Kelebihan

| # | Kelebihan | Detail |
|---|-----------|--------|
| 1 | **Strong consistency** | Linearizability — semua client lihat state yang sama, urutan sama |
| 2 | **Fault tolerant** | Tolerate f crash (n=2f+1). Leader crash → auto re-election |
| 3 | **Split-brain prevention** | Majority quorum = hanya 1 leader valid saat partition |
| 4 | **Understandable (Raft)** | Dirancang untuk mudah dipahami & diimplementasi |
| 5 | **No data loss** | Committed entry tidak hilang (replicated to majority) |
| 6 | **Auto recovery** | Node crash → restart → catch up via AppendEntries |
| 7 | **Mature ecosystem** | etcd, Consul, ZooKeeper — production-proven |

### Kekurangan

| # | Kekurangan | Detail |
|---|------------|--------|
| 1 | **Latency** | Setiap write butuh majority ACK (RTT ke slowest majority) |
| 2 | **Availability trade-off** | Minority partition tidak bisa serve (CP, bukan AP) |
| 3 | **Write throughput** | Semua write via leader → leader = bottleneck |
| 4 | **Cluster size limit** | 3-7 node typical. 100 node = election storm, heartbeat overhead |
| 5 | **Crash-stop only** | Tidak tolerate Byzantine (node boong). Butuh PBFT untuk itu |
| 6 | **Complexity** | Lebih simple dari Paxos, tapi tetap kompleks vs single-node |
| 7 | **FLP limitation** | Tidak guarantee liveness di pure async network (praktik OK) |

---

## Further Reading

- **Raft paper**: "In Search of an Understandable Consensus Algorithm" (Ongaro, Ousterhout, 2014)
- **Raft thesis**: Diego Ongaro PhD thesis (2015) — complete spec + reasoning
- **Paxos paper**: "The Part-Time Parliament" (Lamport, 1998)
- **FLP result**: "Impossibility of Distributed Consensus with One Faulty Process" (Fischer, Lynch, Paterson, 1985)
- **PBFT**: "Practical Byzantine Fault Tolerance" (Castro, Liskov, 1999)
- **Visualizations**: raft.github.io (Raft visualization), Paxos visualizations
- **etcd docs**: etcd.io — production Raft implementation
