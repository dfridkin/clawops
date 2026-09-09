#!/usr/bin/env bash
# Report when spec/models.yaml's pinned provider plugins have fallen behind ClawHub, and
# whether the newer builds would even install on the supported runtime floor.
#
# Deliberately a report, not a fix. Advancing these pins is a COORDINATED change: the
# newer plugin builds declare a minimum plugin API, and on 2026-09-08 all three moved to
# 2026.9.3 — a version the then-current floor (2026.9.2) did not satisfy. Bumping the pins
# alone would break provisioning; bumping the floor alone would leave the pins stale.
#
#   scripts/openclaw/check-plugin-pins.sh
set -euo pipefail

FLOOR=$(node -p "require('js-yaml').load(require('fs').readFileSync('spec/openclaw-versions.yaml','utf8')).support.recommended")
IMAGE="ghcr.io/openclaw/openclaw:${FLOOR}"
echo "== plugin pins vs ClawHub, against runtime ${FLOOR}"

docker pull -q "$IMAGE" >/dev/null

# The bundled set is derived, never hand-maintained: a provider that becomes bundled
# upstream should stop being installed, and one that stops being bundled must start.
BUNDLED=$(docker run --rm --network none "$IMAGE" openclaw plugins list --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log((JSON.parse(s).plugins||[]).flatMap(p=>p.providerIds||[]).join(" "))});')

node -e '
const yaml = require("js-yaml"), fs = require("fs");
const catalog = yaml.load(fs.readFileSync("spec/models.yaml", "utf8"));
const bundled = new Set(process.argv[1].split(" ").filter(Boolean));
let drift = 0;
for (const p of catalog.providers) {
  const id = (p.configPath || "").split(".").pop() || p.id;
  const isBundled = bundled.has(id);
  if (isBundled && p.plugin) {
    console.log(`  DRIFT  ${p.id}: now bundled upstream, but the catalog still installs ${p.plugin.package}`);
    drift++;
  } else if (!isBundled && !p.plugin) {
    console.log(`  DRIFT  ${p.id}: no longer bundled, and the catalog has no plugin for it`);
    drift++;
  } else {
    console.log(`  ok     ${p.id}: ${p.plugin ? "install " + p.plugin.package + "@" + p.plugin.version : "bundled"}`);
  }
}
process.exitCode = drift > 0 ? 1 : 0;
' "$BUNDLED"

echo
echo "-- would a newer plugin build install on ${FLOOR}?"
TMP=$(mktemp -d)
printf '%s' '{"meta":{"lastTouchedVersion":"2026.9"},"gateway":{"mode":"local","port":18789,"auth":{"mode":"token"}}}' > "$TMP/openclaw.json"
chmod 777 "$TMP"; chmod 666 "$TMP/openclaw.json"
PKGS=$(node -p "require('js-yaml').load(require('fs').readFileSync('spec/models.yaml','utf8')).providers.filter(p=>p.plugin).map(p=>p.plugin.package).join(' ')")
for pkg in $PKGS; do
  # `|| true`: a blocked install exits non-zero, and that is the answer this check wants,
  # not a reason to abort under `set -e`.
  out=$(docker run --rm -v "$TMP":/home/node/.openclaw "$IMAGE" \
        openclaw plugins install "clawhub:${pkg}" 2>&1 | tail -1 || true)
  case "$out" in
    *"requires plugin API"*) echo "  BLOCKED  ${pkg}" ; echo "           ${out}" ;;
    *)                       echo "  ADVANCEABLE  ${pkg}: latest installs on ${FLOOR}" ;;
  esac
done
rm -rf "$TMP"
