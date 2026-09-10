#!/usr/bin/env bash
# Report when the pinned plugins have fallen behind upstream, and whether the newer builds
# would even install on the supported runtime floor.
#
# Covers both catalogs: spec/models.yaml (model providers, from ClawHub) and
# spec/integrations.yaml (chat channels, from npm). They drift the same way — on 2026-09-08
# every provider plugin moved to a build requiring a newer runtime than the floor, and the
# channel plugins have already done the same.
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

# ── Channel plugins ───────────────────────────────────────────────────────────
#
# Same drift, different registry: channels come from npm as @openclaw/<channelKey>. Measured
# on 2026.9.2, @openclaw/discord@2026.9.3 refuses to install against a 2026.9.2 runtime.

echo
echo "== channel plugin pins vs npm, against runtime ${FLOOR}"

# The bundled set is derived, not hand-maintained: a channel that becomes bundled upstream
# should stop being installed, and one that stops being bundled must start.
CH_BUNDLED=$(docker run --rm --network none "$IMAGE" openclaw channels list --all --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const chat=(JSON.parse(s).chat)||{};
      console.log(Object.entries(chat).filter(([,v])=>v.origin!=="installable").map(([k])=>k).join(" "));
    });' || echo "")

node -e '
const yaml = require("js-yaml"), fs = require("fs");
const catalog = yaml.load(fs.readFileSync("spec/integrations.yaml", "utf8"));
let drift = 0;
for (const c of catalog.integrations) {
  const plugin = c.plugin;
  if (!plugin) { console.log(`  DRIFT  ${c.id}: no plugin block`); drift++; continue; }
  if (plugin.source === "bundled") { console.log(`  ok     ${c.id}: bundled`); continue; }
  if (!plugin.version) { console.log(`  DRIFT  ${c.id}: ${plugin.package} is unpinned`); drift++; continue; }
  console.log(`  ok     ${c.id}: install ${plugin.package}@${plugin.version}`);
}
process.exitCode = drift > 0 ? 1 : 0;
'

echo
echo "-- would a newer channel build install on ${FLOOR}?"
CH_TMP=$(mktemp -d)
printf '%s' '{"meta":{"lastTouchedVersion":"2026.9"},"gateway":{"mode":"local","port":18789,"auth":{"mode":"token"}}}' > "$CH_TMP/openclaw.json"
chmod 777 "$CH_TMP"; chmod 666 "$CH_TMP/openclaw.json"
CH_PKGS=$(node -p "require('js-yaml').load(require('fs').readFileSync('spec/integrations.yaml','utf8')).integrations.filter(c=>c.plugin&&c.plugin.package).map(c=>c.plugin.package).join(' ')")
for pkg in $CH_PKGS; do
  out=$(docker run --rm -v "$CH_TMP":/home/node/.openclaw "$IMAGE" \
        openclaw plugins install "${pkg}" --accept-capabilities 2>&1 | tail -1 || true)
  case "$out" in
    *"requires plugin API"*) echo "  BLOCKED  ${pkg}" ; echo "           ${out}" ;;
    *)                       echo "  ADVANCEABLE  ${pkg}: latest installs on ${FLOOR}" ;;
  esac
done
rm -rf "$CH_TMP"
