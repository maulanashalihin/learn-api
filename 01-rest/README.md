# 01 — REST API

## Apa itu REST?

**REST** (Representational State Transfer) adalah gaya arsitektur untuk API yang menggunakan HTTP sebagai protokol dasar. REST bukan protokol, bukan library — REST adalah **set of constraints** yang kalau diikuti, API kamu jadi predictable, scalable, dan cacheable.

## 6 Prinsip REST (Fielding Constraints)

| # | Prinsip | Artinya | Contoh di code ini |
|---|---------|---------|-------------------|
| 1 | **Client-Server** | UI dan data terpisah. Client gak peduli server simpan data dimana. | Browser/curl = client, Express = server |
| 2 | **Stateless** | Setiap request berdiri sendiri. Server gak simpan session state. | Tidak ada session/cookie auth di code ini |
| 3 | **Cacheable** | Response harus bisa dibilang cacheable atau tidak. | HTTP header `Cache-Control` (production) |
| 4 | **Uniform Interface** | Interface konsisten: URL = resource, HTTP method = aksi. | `/tasks`, `GET/POST/PUT/PATCH/DELETE` |
| 5 | **Layered System** | Client gak tahu apakah dia bicara langsung ke server atau via proxy/CDN. | Bisa taruh nginx/CDN di depan Express |
| 6 | **Code on Demand** *(optional)* | Server bisa kirim executable code (mis. JS). | Tidak dipakai di sini |

## HTTP Methods = Verbs

```
GET    /tasks        → list semua task        (200 OK)
GET    /tasks/:id    → ambil satu task         (200 OK / 404)
POST   /tasks        → buat task baru          (201 Created / 400)
PUT    /tasks/:id    → replace seluruh resource (200 OK / 404 / 400)
PATCH  /tasks/:id    → partial update          (200 OK / 404)
DELETE /tasks/:id    → hapus task              (204 No Content / 404)
```

### PUT vs PATCH — bedanya apa?

- **PUT** = full replace. Kamu kirim **semua** field. Field yang gak dikirim → di-reset ke default.
- **PATCH** = partial update. Kamu kirim **hanya** field yang berubah. Field lain gak tersentuh.

```bash
# PUT: harus kirim title DAN done
curl -X PUT http://localhost:3001/tasks/UUID \
  -H "Content-Type: application/json" \
  -d '{"title":"Updated","done":true}'

# PATCH: cukup kirim yang berubah
curl -X PATCH http://localhost:3001/tasks/UUID \
  -H "Content-Type: application/json" \
  -d '{"done":true}'
```

## HTTP Status Codes yang penting

| Code | Nama | Kapan dipakai |
|------|------|---------------|
| 200 | OK | Request sukses, ada response body |
| 201 | Created | Resource baru berhasil dibuat |
| 204 | No Content | Sukses tapi tidak ada body (mis. DELETE) |
| 400 | Bad Request | Input invalid / malformed |
| 404 | Not Found | Resource tidak ada |
| 500 | Internal Server Error | Server crash / bug |

## Cara Coba

```bash
# Start server
npm run rest

# List semua task
curl http://localhost:3001/tasks

# Filter: hanya yang belum done
curl http://localhost:3001/tasks?done=false

# Buat task baru
curl -X POST http://localhost:3001/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Belajar SSE"}'

# Ambil task by ID (ganti UUID dengan ID dari response POST)
curl http://localhost:3001/tasks/<UUID>

# Update partial
curl -X PATCH http://localhost:3001/tasks/<UUID> \
  -H "Content-Type: application/json" \
  -d '{"done":true}'

# Hapus
curl -X DELETE http://localhost:3001/tasks/<UUID>
```

## Kelebihan & Kekurangan REST

### ✅ Kelebihan

- **Sederhana**: cuma HTTP + URL, gak perlu library khusus di client
- **Universal**: semua bahasa/platform support HTTP
- **Cacheable**: HTTP caching native (CDN, browser, proxy)
- **Stateless**: mudah scale horizontally (no session affinity)
- **Readable**: URL self-documenting (`/tasks/123` jelas apa maksudnya)

### ❌ Kekurangan

- **Over-fetching**: GET `/tasks` return semua field, padahal client mungkin cuma butuh `title`
- **Under-fetching**: butuh task + author-nya? Harus 2 request (GET `/tasks/123` lalu GET `/users/456`)
- **Multiple round-trips**: untuk relasi kompleks, client harus request berkali-kali
- **No type safety**: response shape gak dijamin, client harus parse manual
- **Versioning pain**: `/v1/tasks` vs `/v2/tasks`, lama-lama berantakan

> Kekurangan over/under-fetching ini yang bikin **GraphQL** lahir. Kita lihat di `02-graphql/`.

## Struktur File

```
01-rest/
  server.ts     → Express server dengan CRUD endpoints
  README.md     → Penjelasan ini
```
