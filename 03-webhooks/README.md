# 03 — Webhooks

## Apa itu Webhook?

**Webhook** adalah pattern di mana server mengirim HTTP POST ke URL yang terdaftar ketika suatu event terjadi. Disebut juga "reverse API" atau "HTTP callback".

### Analogi

- **REST/GraphQL**: Client minta data → Server jawab. (Pull)
- **Webhook**: Event terjadi → Server push data ke client. (Push)

### Contoh nyata

| Service | Event | Webhook untuk apa |
|---------|-------|-------------------|
| Stripe | `payment.succeeded` | Update order status di e-commerce |
| GitHub | `push` | Trigger CI/CD pipeline |
| Slack | `message.posted` | Bot auto-reply |
| WhatsApp | `message.received` | Auto-reply chatbot |

## Cara Kerja

```
    ┌─────────┐    1. Subscribe URL     ┌─────────┐
    │Receiver │ ──────────────────────→ │  Sender  │
    │(port    │                         │ (port    │
    │ 3010)   │                         │  3003)   │
    └─────────┘                         └────┬─────┘
         ↑                                   │
         │  2. POST event (when triggered)   │
         │  with HMAC signature              │
         └───────────────────────────────────┘
```

1. **Receiver** mendaftarkan URL-nya ke Sender (`POST /subscribe`)
2. Ketika event terjadi di Sender, Sender POST ke URL Receiver
3. Receiver verifikasi signature, process payload, return 200

## Konsep Penting

### 1. Subscription

Receiver mendaftarkan URL-nya ke sender. Sender menyimpan URL dan akan POST ke sana setiap kali event terjadi.

```bash
# Receiver subscribe ke sender
curl -X POST http://localhost:3003/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3010/webhook"}'
```

### 2. HMAC Signature

Sender menandatangani payload dengan secret key. Receiver verifikasi signature ini untuk memastikan webhook benar dari sender (bukan attacker).

```
Sender:   HMAC-SHA256(payload, "shared-secret-key") → signature
Receiver: compute ulang HMAC, compare dengan signature di header
```

Tanpa signature, siapapun bisa POST ke URL receiver dan memalsukan event. **Wajib di production.**

### 3. Idempotency

Webhook bisa dikirim berkali-kali (retry, network glitch). Receiver harus **idempotent** — process event yang sama hanya 1x.

Cara: setiap webhook punya unique `id`. Receiver track ID yang sudah diproses.

### 4. Retry

Kalau receiver down atau return non-2xx, sender harus retry. Strategy umum:

- Exponential backoff: 1s, 5s, 30s, 5m, 1h, 6h, 24h
- Max retry: 5-10x
- Dead letter queue: kalau semua retry gagal, simpan untuk investigasi

> Di code ini, retry belum diimplementasi (hanya log error). Production: gunakan Redis + BullMQ, SQS DLQ, dll.

### 5. Respond Fast

Receiver harus return 200 **cepat** (dalam beberapa detik). Kalau processing lama:

- Return 200 dulu
- Queue event ke background worker
- Process asynchronously

Kalau receiver lambat, sender timeout dan retry → event diproses 2x.

## Webhook vs Polling

| Aspek | Polling | Webhook |
|-------|---------|---------|
| Direction | Client → Server (pull) | Server → Client (push) |
| Latency | Tergantung interval poll | Real-time (instant) |
| Efficiency | Banyak request kosong | 1 request per event |
| Complexity | Simple client, no server setup | Receiver butuh reachable URL |
| Firewall | Client initiate, no inbound | Receiver butuh public URL |

## Kelebihan & Kekurangan

### ✅ Kelebihan

- **Real-time**: event push instant, no polling delay
- **Efficient**: 1 HTTP call per event, no empty polling
- **Simple protocol**: cuma HTTP POST, no special library
- **Decoupled**: sender gak peduli receiver siapa, cukup POST ke URL

### ❌ Kekurangan

- **Receiver butuh public URL**: gak bisa di belakang firewall/NAT tanpa tunnel
- **No guaranteed delivery**: kalau receiver down, event bisa hilang (tanpa retry queue)
- **Debugging susah**: webhook terjadi async, sulit trace
- **Security**: harus verify signature, rate-limit, prevent replay attack
- **Ordering**: webhook bisa datang out-of-order (network latency berbeda)

## Cara Coba

Butuh **2 terminal** — receiver dan sender jalan bersamaan.

```bash
# Terminal 1: Start receiver
npm run webhook:receiver

# Terminal 2: Start sender
npm run webhook:sender

# Terminal 3: Test flow
# 1. Subscribe receiver ke sender
curl -X POST http://localhost:3003/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3010/webhook"}'

# 2. Create task → trigger task.created webhook
curl -X POST http://localhost:3003/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Test webhook flow"}'

# 3. Complete task → trigger task.completed webhook
curl -X PATCH http://localhost:3003/tasks/<UUID> \
  -H 'Content-Type: application/json' \
  -d '{"done":true}'

# 4. Check receiver log — webhook diterima!
# 5. Check received webhooks
curl http://localhost:3010/webhooks
```

## Struktur File

```
03-webhooks/
  sender.ts     → Service dengan events + webhook dispatch
  receiver.ts   → Server yang terima webhook + verify signature
  README.md     → Penjelasan ini
```
