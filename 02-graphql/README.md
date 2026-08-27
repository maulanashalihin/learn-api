# 02 — GraphQL

## Apa itu GraphQL?

**GraphQL** adalah query language untuk API + runtime yang mengeksekusi query tersebut. Dibuat oleh Facebook (2015), GraphQL lahir untuk solve masalah terbesar REST: **over-fetching** dan **under-fetching**.

### REST vs GraphQL — satu kalimat

- **REST**: server menentukan shape data. Client terima apa adanya.
- **GraphQL**: client menentukan shape data. Server kirim persis yang diminta.

## Konsep Inti

### 1. Single Endpoint

REST punya banyak URL (`/tasks`, `/tasks/:id`, `/users`, dll).
GraphQL punya **satu endpoint**: `POST /graphql`. Client kirim query, server return JSON.

### 2. Schema = Kontrak

Schema mendefinisikan tipe data dan operasi yang tersedia. Ini adalah **single source of truth** — client dan server sepakat berdasarkan schema.

```graphql
type Task {
  id: ID!          # ! = non-nullable (wajib ada)
  title: String!
  done: Boolean!
  createdAt: String!
}
```

### 3. Query vs Mutation

| Operasi | Keyword | Tujuan | Analog REST |
|---------|---------|--------|-------------|
| Baca data | `query` | Fetch data (idempotent) | `GET` |
| Tulis data | `mutation` | Create/Update/Delete | `POST/PUT/PATCH/DELETE` |
| Realtime | `subscription` | Push updates (WebSocket) | N/A di REST |

### 4. Resolver

Setiap field di schema punya **resolver** — function yang return data untuk field tersebut.

```typescript
// Resolver untuk Query.tasks
tasks: (parent, args) => {
  // args.done bisa true/false/undefined
  return [...taskStore.values()].filter(t => t.done === args.done);
}
```

## Contoh Query

### Query: ambil semua task, cuma field `title` dan `done`

```graphql
query {
  tasks {
    title
    done
  }
}
```

Response:

```json
{
  "data": {
    "tasks": [
      { "title": "Belajar REST API", "done": true },
      { "title": "Belajar GraphQL", "done": false }
    ]
  }
}
```

> Perhatikan: client minta `title` dan `done` saja. `id` dan `createdAt` **tidak ikut**. Ini = **no over-fetching**.

### Query: filter task yang belum done

```graphql
query {
  tasks(done: false) {
    id
    title
  }
}
```

### Mutation: buat task baru

```graphql
mutation {
  createTask(input: { title: "Belajar WebSockets" }) {
    id
    title
    done
    createdAt
  }
}
```

### Mutation: update task

```graphql
mutation {
  updateTask(id: "UUID", input: { done: true }) {
    id
    title
    done
  }
}
```

### Mutation: hapus task

```graphql
mutation {
  deleteTask(id: "UUID")
}
```

## Over-fetching vs Under-fetching — conteknyang

### REST (over-fetching)

```bash
# Mau cuma title, tapi dapat SEMUA field
GET /tasks/123
# → { "id": "...", "title": "...", "done": true, "createdAt": "...", "description": "...", "assignee": "..." }
```

### REST (under-fetching)

```bash
# Mau task + data user pembuatnya
GET /tasks/123       # → { id, title, userId: 456 }
GET /users/456       # → { id, name, email }
# 2 round-trip, client harus join manual
```

### GraphQL (solve keduanya)

```graphql
query {
  task(id: "123") {
    title          # cuma yang dibutuhkan
    user {
      name         # nested data dalam 1 request
      email
    }
  }
}
# 1 round-trip, exact fields, no join manual di client
```

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **No over/under-fetching**: client minta persis yang dibutuhkan
- **Single request**: nested data dalam 1 query (no multiple round-trips)
- **Type-safe**: schema = contract, tools bisa generate type untuk client
- **Self-documenting**: introspection — client bisa query schema untuk lihat apa yang tersedia
- **Schema evolution**: bisa tambah field baru tanpa break client lama (deprecated field)

### ❌ Kekurangan

- **Complexity**: server lebih kompleks (resolver, schema, N+1 problem)
- **Caching**: HTTP caching gak trivial (semua POST `/graphql`, URL sama untuk semua query)
- **Performance**: query kompleks bisa berat (deeply nested = banyak resolver call)
- **Learning curve**: developer harus paham schema, resolver, query syntax
- **N+1 problem**: kalau resolver gak optimized, nested query bisa trigger N+1 database call

> N+1 problem di-solve dengan **DataLoader** (batching + caching resolver calls).

## REST vs GraphQL — kapan pakai yang mana?

| Kriteria | Pilih REST | Pilih GraphQL |
|----------|-----------|---------------|
| Simple CRUD | ✅ | Overkill |
| Multiple client dengan kebutuhan beda | ❌ | ✅ |
| Public API (3rd party consume) | ✅ | Tergantung |
| Mobile (bandwidth limited) | ❌ | ✅ (less data) |
| Caching critical | ✅ | Butuh effort extra |
| Nested/relational data complex | ❌ | ✅ |
| Real-time updates | ❌ | ✅ (subscriptions) |

## Cara Coba

```bash
# Start server
npm run graphql

# Query: list semua task
curl -X POST http://localhost:3002/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ tasks { id title done } }"}'

# Query: filter yang belum done
curl -X POST http://localhost:3002/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ tasks(done: false) { title } }"}'

# Mutation: buat task
curl -X POST http://localhost:3002/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { createTask(input: {title: \"Belajar SSE\"}) { id title done } }"}'

# Mutation: update task (ganti UUID)
curl -X POST http://localhost:3002/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { updateTask(id: \"UUID\", input: {done: true}) { title done } }"}'

# Mutation: delete
curl -X POST http://localhost:3002/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { deleteTask(id: \"UUID\") }"}'
```

## Struktur File

```
02-graphql/
  server.ts     → Apollo Server + Express, schema & resolvers
  README.md     → Penjelasan ini
```
