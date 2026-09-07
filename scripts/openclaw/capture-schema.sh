#!/usr/bin/env bash
# Re-capture spec/openclaw-2.0.config.schema.json from a pinned OpenClaw image.
#
#   scripts/openclaw/capture-schema.sh [version]
#
# Deliberately manual. The image is ~3.2 GB, so pulling it on every PR to check for
# drift would cost more than the drift is worth; .github/workflows/schema-drift.yml
# runs this on a schedule and opens an issue when the captured schema moves.
set -euo pipefail

VERSION="${1:-$(node -p "require('js-yaml').load(require('fs').readFileSync('spec/openclaw-versions.yaml','utf8')).support.recommended")}"
IMAGE="ghcr.io/openclaw/openclaw:${VERSION}"
OUT="spec/openclaw-2.0.config.schema.json"
RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

echo "Capturing config schema from ${IMAGE}"
docker pull -q "$IMAGE" >/dev/null
docker run --rm "$IMAGE" openclaw config schema > "$RAW"

echo "Raw: $(wc -c < "$RAW") bytes"
node scripts/openclaw/normalise-schema.mjs "$RAW" "$OUT"
echo "Wrote ${OUT} ($(wc -c < "$OUT") bytes) from ${VERSION}"
