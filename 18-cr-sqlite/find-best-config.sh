#!/bin/bash
#
# find-best-config.sh — cari config terbaik cr-sqlite sync
#
# Test matrix: HTTP/1.1 vs HTTP/3 × 5 intervals (2000/500/100/50/10ms)
# Method: 50 writes rapid-fire to Node 1 (OVH), poll Node 2 (Underconst)
#         until all 50 appear. Measure batch propagation latency.
#
# Key: write + poll scripts run ON the server (not via SSH per op)
#      to eliminate SSH overhead from measurements.

set +e

OVH="ubuntu@ovh.maulanabuilds.com"
UNDERCONST="maulana@maulana.underconst.com"
PORT=3001
BUN_OVH="/home/ubuntu/.bun/bin/bun"
BUN_UNDERCONST="/home/maulana/.bun/bin/bun"
REMOTE_DIR="/tmp/crsql-config-test"
EXTENSION="/tmp/crsql-test/crsqlite.so"
NUM_WRITES=50

INTERVALS=("2000" "500" "100" "50" "10")
PROTOCOLS=("http1" "http3")

RESULTS="/tmp/crsql-config-results.csv"
echo "protocol,interval,batch_latency_ms,records_converged,write_ms" > "$RESULTS"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  cr-sqlite Config Finder — HTTP/1.1 vs HTTP/3 x 5 intervals ║"
echo "║  $NUM_WRITES writes per config, batch propagation latency   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# --- Deploy ---
echo "── Deploying code ──"
for HOST in "$OVH" "$UNDERCONST"; do
  ssh -n "$HOST" "mkdir -p $REMOTE_DIR"
  scp /Volumes/data/Project/learn-api/18-cr-sqlite/db.ts \
      /Volumes/data/Project/learn-api/18-cr-sqlite/sync.ts \
      /Volumes/data/Project/learn-api/18-cr-sqlite/node.ts \
      "$HOST:$REMOTE_DIR/" 2>/dev/null
done

# Deploy helper scripts
scp /Volumes/data/Project/learn-api/18-cr-sqlite/writer.sh "$OVH:$REMOTE_DIR/" 2>/dev/null
scp /Volumes/data/Project/learn-api/18-cr-sqlite/poller.sh "$UNDERCONST:$REMOTE_DIR/" 2>/dev/null

# Generate certs
for HOST in "$OVH" "$UNDERCONST"; do
  ssh -n "$HOST" "openssl req -x509 -newkey rsa:2048 -keyout $REMOTE_DIR/key.pem -out $REMOTE_DIR/cert.pem -days 1 -nodes -subj '/CN=localhost' 2>/dev/null"
done
echo "  ✓ Deployed + scripts + certs"
echo ""

kill_nodes() {
  for HOST in "$OVH" "$UNDERCONST"; do
    ssh -n "$HOST" "screen -ls 2>/dev/null | grep -oP '\d+\.' | tr -d '.' | xargs -I{} screen -X -S {} quit 2>/dev/null; fuser -k ${PORT}/tcp 2>/dev/null; fuser -k ${PORT}/udp 2>/dev/null; true"
  done
  sleep 1
}

start_nodes() {
  local protocol=$1 interval=$2
  local cert_args="- -" peer_scheme="http" env_flag=""

  if [ "$protocol" = "http3" ]; then
    cert_args="$REMOTE_DIR/cert.pem $REMOTE_DIR/key.pem"
    peer_scheme="https"
    env_flag="BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1"
  fi

  ssh -n "$OVH" "screen -d -m bash -c 'cd $REMOTE_DIR && rm -f node1.db node1.db-wal node1.db-shm && \
    SYNC_INTERVAL=$interval $env_flag \
    $BUN_OVH run node.ts 1 $PORT $REMOTE_DIR/node1.db $EXTENSION \
    $cert_args ${peer_scheme}://maulana.underconst.com:$PORT \
    > $REMOTE_DIR/node1.log 2>&1'"

  ssh -n "$UNDERCONST" "screen -d -m bash -c 'cd $REMOTE_DIR && rm -f node2.db node2.db-wal node2.db-shm && \
    SYNC_INTERVAL=$interval $env_flag \
    $BUN_UNDERCONST run node.ts 2 $PORT $REMOTE_DIR/node2.db $EXTENSION \
    $cert_args ${peer_scheme}://ovh.maulanabuilds.com:$PORT \
    > $REMOTE_DIR/node2.log 2>&1'"

  sleep 3
  echo $peer_scheme
}

run_benchmark() {
  local protocol=$1 interval=$2 scheme=$3

  # Start poller on Underconst (non-blocking, writes result to file)
  ssh -n "$UNDERCONST" "chmod +x $REMOTE_DIR/poller.sh && \
    START_MS=\$(date +%s%N) && START_MS=\$((START_MS / 1000000)) && \
    nohup $REMOTE_DIR/poller.sh $NUM_WRITES $scheme \$START_MS > $REMOTE_DIR/poll_result.txt 2>&1 &"

  # Small delay to ensure poller is running
  sleep 0.5

  # Write 50 records on OVH (runs locally on server)
  echo "  Writing $NUM_WRITES records to OVH..."
  WRITE_RESULT=$(ssh -n "$OVH" "chmod +x $REMOTE_DIR/writer.sh && $REMOTE_DIR/writer.sh $NUM_WRITES $scheme" 2>/dev/null)
  WRITE_MS=$(echo "$WRITE_RESULT" | grep -o '[0-9]*' | tail -1)
  echo "  Write phase: ${WRITE_MS}ms"

  # Wait for poller result
  echo "  Waiting for convergence on Underconst..."
  for wait in $(seq 1 120); do
    if ssh -n "$UNDERCONST" "test -s $REMOTE_DIR/poll_result.txt" 2>/dev/null; then
      POLL_RESULT=$(ssh -n "$UNDERCONST" "cat $REMOTE_DIR/poll_result.txt" 2>/dev/null)
      if [ -n "$POLL_RESULT" ]; then
        break
      fi
    fi
    sleep 0.5
  done

  # Parse result: "CONVERGED <count> <latency>" or "TIMEOUT <count> <latency>"
  STATUS=$(echo "$POLL_RESULT" | awk '{print $1}')
  CONV_COUNT=$(echo "$POLL_RESULT" | awk '{print $2}')
  BATCH_LAT=$(echo "$POLL_RESULT" | awk '{print $3}')

  if [ "$STATUS" = "CONVERGED" ]; then
    echo "  ✓ All $CONV_COUNT records converged in ${BATCH_LAT}ms"
  else
    echo "  ✗ Timeout: $CONV_COUNT/$NUM_WRITES converged in ${BATCH_LAT}ms"
  fi

  echo "$protocol,$interval,${BATCH_LAT:-0},${CONV_COUNT:-0},${WRITE_MS:-0}" >> "$RESULTS"
}

# --- Run test matrix ---
for protocol in "${PROTOCOLS[@]}"; do
  for interval in "${INTERVALS[@]}"; do
    PROTO_UPPER=$(echo $protocol | tr 'a-z' 'A-Z')
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Protocol: $PROTO_UPPER  |  Interval: ${interval}ms"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    kill_nodes
    SCHEME=$(start_nodes "$protocol" "$interval")

    # Verify health
    OVH_H=$(ssh -n "$OVH" "curl -sk ${SCHEME}://localhost:$PORT/health" 2>/dev/null)
    UC_H=$(ssh -n "$UNDERCONST" "curl -sk ${SCHEME}://localhost:$PORT/health" 2>/dev/null)
    if echo "$OVH_H" | grep -q "node" && echo "$UC_H" | grep -q "node"; then
      echo "  ✓ Both nodes healthy"
      # Clear poll result file
      ssh -n "$UNDERCONST" "rm -f $REMOTE_DIR/poll_result.txt"
      run_benchmark "$protocol" "$interval" "$SCHEME"
    else
      echo "  ✗ Nodes failed — skipping"
      echo "    OVH: $OVH_H"
      echo "    UC:  $UC_H"
      ssh -n "$OVH" "tail -5 $REMOTE_DIR/node1.log 2>/dev/null"
      ssh -n "$UNDERCONST" "tail -5 $REMOTE_DIR/node2.log 2>/dev/null"
      echo "$protocol,$interval,FAIL,0,0" >> "$RESULTS"
    fi

    kill_nodes
  done
done

kill_nodes

# --- Summary ---
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Results                                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

python3 << 'PYEOF'
import csv
rows = []
with open("/tmp/crsql-config-results.csv") as f:
    for r in csv.DictReader(f):
        rows.append(r)

print("{:<10} {:<10} {:<14} {:<12} {:<10}".format("Protocol", "Interval", "Batch Lat(ms)", "Converged", "Write(ms)"))
print("-" * 68)
for r in sorted(rows, key=lambda x: (x["protocol"], int(x["interval"]))):
    print("{:<10} {}ms        {:<14} {:<12} {:<10}".format(
        r["protocol"], r["interval"], r["batch_latency_ms"], r["records_converged"], r["write_ms"]))
PYEOF

echo ""
echo "Results: /tmp/crsql-config-results.csv"
