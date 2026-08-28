#!/bin/bash
# poller.sh — poll localhost until N users appear, report latency
TARGET=$1
SCHEME=$2
PORT=3001
START_MS=$3
for i in $(seq 1 600); do
  COUNT=$(curl -sk ${SCHEME}://localhost:${PORT}/health 2>/dev/null | grep -o '"users":[0-9]*' | grep -o '[0-9]*')
  if [ "$COUNT" -ge "$TARGET" ] 2>/dev/null; then
    END_MS=$(date +%s%N)
    END_MS=$((END_MS / 1000000))
    echo "CONVERGED $COUNT $((END_MS - START_MS))"
    exit 0
  fi
  sleep 0.1
done
COUNT=$(curl -sk ${SCHEME}://localhost:${PORT}/health 2>/dev/null | grep -o '"users":[0-9]*' | grep -o '[0-9]*')
END_MS=$(date +%s%N)
END_MS=$((END_MS / 1000000))
echo "TIMEOUT ${COUNT:-0} $((END_MS - START_MS))"
