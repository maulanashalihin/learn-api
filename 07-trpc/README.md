# 07 — tRPC

## Apa itu tRPC?

**tRPC** = TypeScript RPC. Framework untuk membangun type-safe API tanpa codegen, tanpa schema definition file (.proto, .graphql), tanpa OpenAPI spec. Cukup pakai TypeScript types — server dan client share types langsung.

### Perbedaan dengan yang sudah kita pelajari

| Aspek | REST | GraphQL | gRPC | tRPC |
|-------|------|---------|------|------|
| Schema | Optional | .graphql | .proto | **TypeScript types** |
| Serialization | JSON | JSON | Protobuf | JSON |
| Type safety | Manual | Codegen | Codegen | **Native TS** |
| Codegen needed | No | Yes | Yes | **No** |
| Language | Any | Any | Any | **TS only** |
| Browser support | ✅ | ✅ | ❌ | ✅ |
| Validation | Manual | Schema | Protobuf | **Zod** |

## Konsep Inti

### 1. Router = Kumpulan Procedures

```typescript
const appRouter = t.router({
  tasks: t.router({
    list: t.procedure.input(...).query(...),    // GET equivalent
    getById: t.procedure.input(...).query(...),  // GET equivalent
  }),
  create: t.procedure.input(...).mutation(...),  // POST equivalent
  update: t.procedure.input(...).mutation(...),  // PUT/PATCH equivalent
  delete: t.procedure.input(...).mutation(...),  // DELETE equivalent
});
```

### 2. Procedure Types

| Type | Keyword | Analog REST | Use case |
|------|---------|-------------|----------|
| Query | `.query()` | GET | Read data (idempotent) |
| Mutation | `.mutation()` | POST/PUT/DELETE | Write data |
| Subscription | `.subscription()` | WebSocket/SSE | Real-time stream |

### 3. Input Validation dengan Zod

```typescript
create: t.procedure
  .input(z.object({
    title: z.string().min(1, "Title is required"),
  }))
  .mutation(({ input }) => {
    // input.title: string — TypeScript tahu dari Zod schema
    // Tidak perlu manual validation!
    return createTask(input.title);
  }),
```

Zod = TypeScript-first schema validation. Satu definisi → runtime validation + TypeScript types. No duplicate type definitions.

### 4. End-to-End Type Safety (The Magic)

```
Server side:
  export const appRouter = t.router({ ... });
  export type AppRouter = typeof appRouter;  ← export TYPE only

Client side:
  import type { AppRouter } from "./router";
  const client = createTRPCClient<AppRouter>({ ... });

  // TypeScript auto-infer dari AppRouter:
  client.tasks.list.query()         → Task[]     ✅ autocomplete
  client.create.mutate({ title: "" }) → Zod error  ✅ type-safe input
  client.tasks.list.query({ done: "yes" }) → TYPE ERROR  ✅ wrong type
```

**Tidak ada codegen step.** Client import `AppRouter` type, TypeScript infer semua procedure signatures. Kalau server tambah procedure baru, client langsung dapat autocomplete — no rebuild, no codegen.

### 5. Batching

`httpBatchLink` otomatis batch multiple tRPC calls ke 1 HTTP request:

```typescript
// 3 tRPC calls → 1 HTTP POST
const [tasks, users, stats] = await Promise.all([
  client.tasks.list.query(),
  client.users.list.query(),
  client.stats.get.query(),
]);
// HTTP: POST /trpc/tasks.list,users.list,stats.get
```

## Wire Protocol

tRPC pakai HTTP + JSON. Setiap procedure = URL path:

```
Query:    GET  /trpc/tasks.list?input={"done":false}
          POST /trpc/tasks.list  body: {"done":false}

Mutation: POST /trpc/create  body: {"title":"Belajar tRPC"}

Batch:    POST /trpc/tasks.list,tasks.getById,create
          body: {"0":{"done":false}, "1":{"id":"123"}, "2":{"title":"..."}}
```

> Karena HTTP + JSON, tRPC compatible dengan semua HTTP infrastructure (CDN, proxy, curl). Tapi tidak secepat gRPC (protobuf binary).

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Zero codegen**: TypeScript types flow langsung, no build step
- **End-to-end type safety**: server types → client, compile-time catch bugs
- **Developer experience**: autocomplete, refactoring, go-to-definition semuanya work
- **Validation built-in**: Zod schema = runtime validation + TS types dalam satu definisi
- **Simple protocol**: HTTP + JSON, no special infrastructure
- **Batching**: automatic request batching untuk performance
- **Browser native**: no gRPC-Web proxy needed

### ❌ Kekurangan

- **TypeScript only**: client harus TypeScript. Gak bisa dipakai dari Python, Go, Java, dll
- **No language-agnostic schema**: gak ada .proto / .graphql untuk generate client di bahasa lain
- **Tight coupling**: client & server share types → harus di monorepo atau shared package
- **No GraphQL flexibility**: client gak bisa pilih field subset (always full object)
- **Less ecosystem**: lebih kecil dari REST/GraphQL, fewer tools, fewer tutorials
- **Versioning**: kalau type berubah, client lama bisa break (no schema evolution strategy seperti GraphQL)

## tRPC vs GraphQL vs gRPC — kapan pakai yang mana?

| Kriteria | REST | GraphQL | gRPC | tRPC |
|----------|------|---------|------|------|
| Full-stack TypeScript monorepo | ✅ | ✅ | ❌ | **✅✅** |
| Multi-language clients | ✅ | ✅ | ✅ | ❌ |
| Type safety priority | ❌ | Codegen | Codegen | **Native** |
| Microservice internal | ❌ | ❌ | **✅✅** | ✅ |
| Public API (3rd party) | ✅ | ✅ | ❌ | ❌ |
| Rapid prototyping TS | ✅ | ✅ | ❌ | **✅✅** |
| Performance critical | ❌ | ❌ | **✅✅** | ✅ |

> **Pattern umum**: tRPC untuk full-stack TypeScript app (Next.js + tRPC server). gRPC untuk microservice internal. REST/GraphQL untuk public API.

## Cara Coba

```bash
# Terminal 1: Start tRPC server
npm run trpc

# Terminal 2: Run client demo (type-safe calls)
npm run trpc:client
```

Output client:

```
┌─────────────────────────────────────────────┐
│     tRPC Client Demo — Type-safe calls      │
└─────────────────────────────────────────────┘

📋 tasks.list (query):
   ⬜ [a1b2c3d4] Belajar tRPC
   ⬜ [e5f6g7h8] Belajar API Gateway
   ⬜ [i9j0k1l2] Belajar WebSockets

➕ create (mutation):
   ✅ Created: [m3n4o5p6] Belajar tRPC type safety

🔍 tasks.getById (query):
   Found: Belajar tRPC type safety

📝 update (mutation):
   Updated: done=true

🗑️  delete (mutation):
   Deleted: true

✅ Demo complete!

💡 Key takeaway: every call above was type-checked by TypeScript.
   No codegen, no .proto file — just shared types.
```

## Struktur File

```
07-trpc/
  router.ts     → tRPC router definition (procedures + Zod validation)
  server.ts     → Express + tRPC middleware adapter
  client.ts     → tRPC client with AppRouter type import
  README.md     → Penjelasan ini
```
