#!/bin/bash
#
# cross-server-http3-benchmark.sh
# Test cr-sqlite sync dengan HTTP/3 (QUIC) antar server:
#   Node 1: ovh.maulanabuilds.com (51.79.159.231)
#   Node 2: maulana.underconst.com (185.111.159.99)
#
# Mengukur:
#   1. Sync propagation latency (write → appear di peer)
#   2. Convergence verification
BUN_OVH="/home/ubuntu/.bun/bin/bun"
BUN_UNDERCONST="/home/maulana/.bun/bin/bun"
#
# Bandingkan dengan hasil HTTP/1.1 sebelumnya.
set +e  # don't exit on error — we handle errors per-step

OVH="ubuntu@ovh.maulanabuilds.com"
UNDERCONST="maulana@maulana.underconst.com"
PORT=3001
BUN="$HOME/.bun/bin/bun"
REMOTE_DIR="/tmp/crsql-http3-test"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  cr-sqlite HTTP/3 Cross-Server Benchmark                    ║"
echo "║  OVH Singapore ↔ Underconst Bandung                         ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# --- Step 1: Deploy updated code to both servers ---
echo "── Step 1: Deploy code to both servers ──"
for HOST in "$OVH" "$UNDERCONST"; do
  echo "  → $HOST"
  ssh "$HOST" "mkdir -p $REMOTE_DIR"
  scp /Volumes/data/Project/learn-api/18-cr-sqlite/db.ts "$HOST:$REMOTE_DIR/"
  scp /Volumes/data/Project/learn-api/18-cr-sqlite/sync.ts "$HOST:$REMOTE_DIR/"
  scp /Volumes/data/Project/learn-api/18-cr-sqlite/node.ts "$HOST:$REMOTE_DIR/"
done
echo "  ✓ Code deployed"
echo ""

# --- Step 2: Generate self-signed certs on both servers ---
echo "── Step 2: Generate self-signed certs ──"
for HOST in "$OVH" "$UNDERCONST"; do
  echo "  → $HOST"
  ssh "$HOST" "openssl req -x509 -newkey rsa:2048 -keyout $REMOTE_DIR/key.pem -out $REMOTE_DIR/cert.pem -days 1 -nodes -subj '/CN=localhost' 2>/dev/null"
done
echo "  ✓ Certs generated"
echo ""

# --- Step 3: Kill any existing processes on port ---
echo "── Step 3: Kill existing processes ──"
for HOST in "$OVH" "$UNDERCONST"; do
  ssh -n "$HOST" "screen -ls 2>/dev/null | grep -oP '\d+\.' | tr -d '.' | xargs -I{} screen -X -S {} quit 2>/dev/null; fuser -k ${PORT}/tcp 2>/dev/null; fuser -k ${PORT}/udp 2>/dev/null; true"
done
echo "  ✓ Ports cleared"
echo ""

# --- Step 4: Start Node 1 on OVH ---
echo "── Step 4: Start Node 1 on OVH (HTTP/3) ──"
ssh -n "$OVH" "screen -d -m bash -c 'cd $REMOTE_DIR && rm -f node1.db node1.db-wal node1.db-shm && \
  BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1 \
  $BUN_OVH run node.ts 1 $PORT $REMOTE_DIR/node1.db /tmp/crsql-test/crsqlite.so \
  $REMOTE_DIR/cert.pem $REMOTE_DIR/key.pem \
  https://maulana.underconst.com:$PORT \
  > $REMOTE_DIR/node1.log 2>&1'"
sleep 2
ssh "$OVH" "cat $REMOTE_DIR/node1.log"
echo ""

# --- Step 5: Start Node 2 on Underconst ---
ssh -n "$UNDERCONST" "screen -d -m bash -c 'cd $REMOTE_DIR && rm -f node2.db node2.db-wal node2.db-shm && \
  BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1 \
  $BUN_UNDERCONST run node.ts 2 $PORT $REMOTE_DIR/node2.db /tmp/crsql-test/crsqlite.so \
  $REMOTE_DIR/cert.pem $REMOTE_DIR/key.pem \
  https://ovh.maulanabuilds.com:$PORT \
  > $REMOTE_DIR/node2.log 2>&1'"
sleep 2
ssh "$UNDERCONST" "cat $REMOTE_DIR/node2.log"
echo ""

# --- Step 6: Verify HTTP/3 is active ---
echo "── Step 6: Verify servers are up ──"
echo "  → OVH health check:"
ssh "$OVH" "curl -sk https://localhost:$PORT/health" 2>/dev/null || echo "  FAILED"
echo ""
echo "  → Underconst health check:"
ssh "$UNDERCONST" "curl -sk https://localhost:$PORT/health" 2>/dev/null || echo "  FAILED"
echo ""

# --- Step 7: Write to Node 1, measure propagation to Node 2 ---
echo "── Step 7: Write to Node 1 (OVH), measure propagation to Node 2 (Underconst) ──"
START=$(date +%s%N)
ssh "$OVH" "curl -sk -X POST https://localhost:$PORT/write \
  -H 'Content-Type: application/json' \
  -d '{\"id\": 1, \"name\": \"Alice\", \"city\": \"Singapore\"}'"
echo "  ✓ Written Alice to OVH"

# Poll Node 2 for Alice
echo "  Polling Underconst for Alice..."
for i in $(seq 1 30); do
  RESULT=$(ssh "$UNDERCONST" "curl -sk https://localhost:$PORT/users" 2>/dev/null)
  if echo "$RESULT" | grep -q "Alice"; then
    END=$(date +%s%N)
    ELAPSED=$(( (END - START) / 1000000 ))
    echo "  ✓ Alice appeared on Underconst after ${ELAPSED}ms"
    break
  fi
  sleep 0.5
  echo -n "."
done
echo ""
echo ""

# --- Step 8: Write to Node 2, measure propagation to Node 1 ---
echo "── Step 8: Write to Node 2 (Underconst), measure propagation to Node 1 (OVH) ──"
START=$(date +%s%N)
ssh "$UNDERCONST" "curl -sk -X POST https://localhost:$PORT/write \
  -H 'Content-Type: application/json' \
  -d '{\"id\": 2, \"name\": \"Bob\", \"city\": \"Bandung\"}'"
echo "  ✓ Written Bob to Underconst"

# Poll Node 1 for Bob
echo "  Polling OVH for Bob..."
for i in $(seq 1 30); do
  RESULT=$(ssh "$OVH" "curl -sk https://localhost:$PORT/users" 2>/dev/null)
  if echo "$RESULT" | grep -q "Bob"; then
    END=$(date +%s%N)
    ELAPSED=$(( (END - START) / 1000000 ))
    echo "  ✓ Bob appeared on OVH after ${ELAPSED}ms"
    break
  fi
  sleep 0.5
  echo -n "."
done
echo ""
echo ""

# --- Step 9: Verify convergence ---
echo "── Step 9: Verify convergence ──"
echo "  → OVH users:"
ssh "$OVH" "curl -sk https://localhost:$PORT/users" 2>/dev/null
echo ""
echo "  → Underconst users:"
ssh "$UNDERCONST" "curl -sk https://localhost:$PORT/users" 2>/dev/null
echo ""
echo ""

# --- Step 10: Check logs for HTTP/3 status ---
echo "── Step 10: Check node logs ──"
echo "  → OVH log:"
ssh "$OVH" "cat $REMOTE_DIR/node1.log"
echo ""
echo "  → Underconst log:"
ssh "$UNDERCONST" "cat $REMOTE_DIR/node2.log"
echo ""

# --- Step 11: Cleanup ---
echo "── Step 11: Cleanup ──"
for HOST in "$OVH" "$UNDERCONST"; do
  ssh -n "$HOST" "screen -ls 2>/dev/null | grep -oP '\d+\.' | tr -d '.' | xargs -I{} screen -X -S {} quit 2>/dev/null; fuser -k ${PORT}/tcp 2>/dev/null; fuser -k ${PORT}/udp 2>/dev/null; true"
done
echo "  ✓ Servers stopped"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Benchmark complete — check propagation times above         ║"
echo "║  Compare with HTTP/1.1 baseline from previous test          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
