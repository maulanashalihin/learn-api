# 08 — API Gateway

## Apa itu API Gateway?

**API Gateway** adalah pattern di mana ada satu server yang menjadi **single entry point** untuk semua backend services. Client hanya bicara dengan gateway. Gateway yang route request ke service yang tepat, handle cross-cutting concerns, dan aggregate responses.

### Tanpa Gateway vs Dengan Gateway

```
TANPA GATEWAY:                          DENGAN GATEWAY:

  Client                                 Client
   ├──→ user-service:3011                 │
   ├──→ order-service:3012                └──→ API Gateway:3007
   └──→ payment-service:3013                   ├──→ user-service:3011
                                               ├──→ order-service:3012
  Client tahu semua service URLs               └──→ payment-service:3013
  Auth di tiap service (duplikasi)
  CORS, rate limit di tiap service           Client tahu 1 URL saja
                                             Auth, rate limit, logging di 1 tempat
```

## Tanggung Jawab API Gateway

| # | Responsibility | Contoh di code ini |
|---|---------------|-------------------|
| 1 | **Routing** | `/api/users/*` → user-service, `/api/orders/*` → order-service |
| 2 | **Authentication** | Validasi `X-Api-Key` header |
| 3 | **Rate Limiting** | 30 requests per 10 seconds per client |
| 4 | **Logging** | Log setiap request: method, path, status, duration |
| 5 | **Aggregation** | `/api/dashboard` → gabungkan users + orders dari 2 services |
| 6 | **Protocol Translation** | REST → gRPC, SOAP → REST (tidak di demo) |
| 7 | **Load Balancing** | Distribute ke multiple instances (tidak di demo) |
| 8 | **Circuit Breaking** | Stop calling service yang down (tidak di demo) |
| 9 | **Caching** | Cache response untuk reduce backend load (tidak di demo) |

## Konsep Penting

### 1. Routing

Gateway route request berdasarkan path prefix:

```
/api/users/*     → forward ke http://localhost:3011/*
/api/orders/*    → forward ke http://localhost:3012/*
/api/dashboard   → aggregate dari multiple services
/api/health      → gateway sendiri (no backend call)
```

### 2. Authentication (Cross-cutting Concern)

Auth dilakukan **sekali** di gateway. Backend services tidak perlu validasi auth lagi — mereka trust gateway (internal network).

```
Client → [X-Api-Key: demo-key-123] → Gateway (validate) → User Service (trust, no auth)
```

> Di production: gateway validasi JWT/OAuth2, lalu pass user identity ke service via internal header.

### 3. Rate Limiting

Batasi request per client untuk protect backend services dari overload.

```
Headers:
  X-RateLimit-Limit: 30
  X-RateLimit-Remaining: 27
  X-RateLimit-Reset: 1724767800

429 Too Many Requests:
  { "error": "Rate limit exceeded", "retryAfter": 7 }
```

### 4. Aggregation (API Composition)

Client butuh data dari multiple services? Daripada client call 2 endpoints, gateway aggregate dalam 1 response:

```
GET /api/dashboard → Gateway call:
  → user-service /users    (parallel)
  → order-service /orders  (parallel)
  → Gabungkan: users + their orders + total spent
  → Return 1 response
```

### 5. Backend for Frontend (BFF)

API Gateway sering diimplementasikan sebagai **BFF** — satu gateway per client type:

```
Web App     → Web BFF Gateway     → Services
Mobile App  → Mobile BFF Gateway  → Services (different response shapes)
```

Mobile mungkin butuh response lebih kecil (less data) daripada web. BFF per client type = optimal response shape.

## Gateway Patterns

### Pattern 1: Reverse Proxy (yang kita pakai)

Gateway forward request apa adanya ke backend. Simple, transparent.

```
Client: GET /api/users/u1
Gateway: GET http://user-service:3011/users/u1
Gateway: ← { id: "u1", name: "Alice", ... }
Client: ← { id: "u1", name: "Alice", ... }
```

### Pattern 2: Aggregation / Composition

Gateway call multiple services, gabungkan response.

```
Client: GET /api/dashboard
Gateway: GET user-service/users + order-service/orders (parallel)
Gateway: merge → { users: [...with orders...], totalRevenue: ... }
Client: ← aggregated response
```

### Pattern 3: Protocol Translation

Gateway translate protocol antara client dan service.

```
Client (REST): GET /api/users/u1
Gateway: gRPC call user-service.GetUser(id: "u1")
Gateway: translate protobuf → JSON
Client: ← JSON response
```

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Single entry point**: client tahu 1 URL, tidak perlu tahu backend topology
- **Centralized concerns**: auth, rate limit, logging, CORS di 1 tempat (no duplication)
- **Decoupling**: client gak terpengaruh kalau service pindah port/server
- **Aggregation**: 1 request = data dari multiple services (reduce client round-trips)
- **Security**: backend services tidak exposed langsung ke internet
- **Observability**: semua traffic melalui gateway = centralized metrics & logs

### ❌ Kekurangan

- **Single point of failure**: kalau gateway down, semua service tidak accessible
- **Latency**: extra hop = extra latency (biasanya ~1-5ms)
- **Complexity**: gateway sendiri adalah service yang harus di-deploy, scale, monitor
- **Over-engineering**: untuk 1-2 services, gateway mungkin overkill
- **Bottleneck**: kalau gak di-scale, gateway bisa jadi bottleneck

## Real-world API Gateways

| Product | Type | Notes |
|---------|------|-------|
| **Kong** | Open-source / Enterprise | Plugin-based, Lua/Nginx |
| **AWS API Gateway** | Cloud service | Managed, pay-per-request |
| **Nginx** | Reverse proxy | Config-based, lightweight |
| **Envoy** | Service proxy | gRPC support, Istio data plane |
| **Tyk** | Open-source | Go-based, REST API |
| **Spring Cloud Gateway** | Java framework | Spring ecosystem |
| **Traefik** | Reverse proxy | Auto-discovery, Docker-friendly |

## Cara Coba

Gateway otomatis start user-service dan order-service sebagai child processes. Cukup 1 command:

```bash
# Start gateway (auto-starts backend services too)
npm run gateway

# Test dengan API key
# Health check (no auth needed)
curl http://localhost:3007/api/health

# List users (auth required)
curl -H "X-Api-Key: demo-key-123" http://localhost:3007/api/users

# Get specific user
curl -H "X-Api-Key: demo-key-123" http://localhost:3007/api/users/u1

# List orders
curl -H "X-Api-Key: demo-key-123" http://localhost:3007/api/orders

# Dashboard (aggregated from 2 services)
curl -H "X-Api-Key: demo-key-123" http://localhost:3007/api/dashboard | jq .

# No API key → 401
curl http://localhost:3007/api/users

# Check rate limit headers
curl -I -H "X-Api-Key: demo-key-123" http://localhost:3007/api/users
```

## Struktur File

```
08-api-gateway/
  gateway.ts       → API Gateway (routing, auth, rate limit, aggregation)
  user-service.ts  → Backend microservice (users)
  order-service.ts → Backend microservice (orders)
  README.md        → Penjelasan ini
```
