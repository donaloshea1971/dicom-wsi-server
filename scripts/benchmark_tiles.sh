#!/bin/bash
# Tile Serving Benchmark Script
# Usage: ./benchmark_tiles.sh [BASE_URL] [STUDY_ID]

BASE="${1:-http://localhost:8042}"
AUTH="admin:orthanc"

echo "=========================================="
echo "  Orthanc WSI Tile Benchmark"
echo "=========================================="
echo "Base URL: $BASE"
echo ""

# Get first study if not provided
if [ -z "$2" ]; then
    STUDY=$(curl -s -u "$AUTH" "$BASE/studies" | jq -r '.[0]')
    echo "Auto-detected study: $STUDY"
else
    STUDY="$2"
fi

# Get series for this study
SERIES=$(curl -s -u "$AUTH" "$BASE/studies/$STUDY" | jq -r '.Series[0]')
echo "Using series: $SERIES"
echo ""

echo "=== 1. Single Tile Latency (10 requests) ==="
total=0
for i in {1..10}; do
    time=$(curl -s -o /dev/null -w "%{time_total}" -u "$AUTH" \
        "$BASE/wsi/pyramids/$SERIES/0/0/0" 2>/dev/null)
    echo "  Request $i: ${time}s"
    total=$(echo "$total + $time" | bc)
done
avg=$(echo "scale=3; $total / 10" | bc)
echo "  Average: ${avg}s"
echo ""

echo "=== 2. Concurrent Tile Throughput ==="
echo "  Fetching 50 tiles with 10 parallel connections..."
start=$(date +%s.%N)
seq 0 49 | xargs -n1 -P10 -I{} \
    curl -s -o /dev/null -u "$AUTH" \
    "$BASE/wsi/pyramids/$SERIES/0/$(({}%8))/$(({}%8))" 2>/dev/null
end=$(date +%s.%N)
duration=$(echo "$end - $start" | bc)
rate=$(echo "scale=1; 50 / $duration" | bc)
echo "  Time: ${duration}s for 50 tiles"
echo "  Rate: ${rate} tiles/sec"
echo ""

echo "=== 3. Pyramid Level Scan ==="
for level in 0 1 2 3; do
    start=$(date +%s.%N)
    for x in 0 1 2 3; do
        for y in 0 1 2 3; do
            curl -s -o /dev/null -u "$AUTH" \
                "$BASE/wsi/pyramids/$SERIES/$level/$x/$y" 2>/dev/null
        done
    done
    end=$(date +%s.%N)
    duration=$(echo "$end - $start" | bc)
    echo "  Level $level (16 tiles): ${duration}s"
done
echo ""

echo "=== 4. System Statistics ==="
curl -s -u "$AUTH" "$BASE/statistics" | jq '{
    CountPatients,
    CountStudies,
    CountSeries,
    CountInstances,
    TotalDiskSize,
    TotalUncompressedSize
}'

echo ""
echo "Benchmark complete!"
