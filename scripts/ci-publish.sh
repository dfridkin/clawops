#!/usr/bin/env bash
# Temporarily hide pnpm detection signals so @changesets/cli uses npm for publishing.
# npm 11.5.1+ performs the OIDC automated token exchange (trusted publishing);
# pnpm publish does not. This script is only run in CI (GitHub Actions release workflow).
#
# Usage: ci-publish.sh [branch]
#
# The dist-tags are decided by scripts/lib/dist-tag-plan.mjs, not by the caller. The 1.x
# line publishes under `legacy` so a maintenance patch cannot take `latest` back from 2.x —
# but that only holds once 2.x has shipped. Before it has, `latest` is itself a 1.x version,
# and publishing under `legacy` alone leaves `npm install -g @clawops/cli` serving the
# PREVIOUS release. That happened to 1.7.8: `legacy` moved, `latest` stayed on 1.7.7, and
# the release that added authentication to the MCP HTTP server was not what a fresh install
# got.
#
# `legacy` rather than the obvious `v1`: npm rejects a dist-tag that parses as a
# SemVer range, and `v1` parses as `>=1.0.0 <2.0.0-0`. So do `v1.x` and `1.x`.
set -euo pipefail

BRANCH="${1:-}"
PKG_NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")

# What the registry serves as `latest` right now. A failure here is not fatal: the plan
# treats an unreadable value as "leave `latest` alone", which is the recoverable mistake.
CURRENT_LATEST=$(curl -sf --max-time 10 "https://registry.npmjs.org/-/package/${PKG_NAME}/dist-tags" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).latest??'')}catch{process.stdout.write('')}})" || echo "")

PLAN=$(node -e "
  import('./scripts/lib/dist-tag-plan.mjs').then(({ planDistTags }) => {
    const p = planDistTags({
      branch: process.argv[1], version: process.argv[2], currentLatest: process.argv[3] || undefined,
    })
    process.stdout.write(JSON.stringify(p))
  })
" "$BRANCH" "$VERSION" "$CURRENT_LATEST")

DIST_TAG=$(node -p "JSON.parse(process.argv[1]).publishTag ?? ''" "$PLAN")
ALSO_TAG=$(node -p "JSON.parse(process.argv[1]).alsoTag.join(' ')" "$PLAN")
REASON=$(node -p "JSON.parse(process.argv[1]).reason" "$PLAN")

echo "dist-tag plan for ${PKG_NAME}@${VERSION} on '${BRANCH}' (registry latest: ${CURRENT_LATEST:-unknown})"
echo "  publish tag: ${DIST_TAG:-<changesets default>}"
echo "  also tag:    ${ALSO_TAG:-<none>}"
echo "  because:     ${REASON}"

PKG_JSON="package.json"
LOCK_FILE="pnpm-lock.yaml"
LOCK_BACKUP=".pnpm-lock.yaml.ci-bak"

# Read current packageManager value so we can restore it
PM_VALUE=$(node -p "require('./${PKG_JSON}').packageManager || ''")

cleanup() {
  # Restore lock file
  if [[ -f "$LOCK_BACKUP" ]]; then
    mv "$LOCK_BACKUP" "$LOCK_FILE"
  fi
  # Restore packageManager field
  if [[ -n "$PM_VALUE" ]]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('${PKG_JSON}', 'utf8'));
      p.packageManager = '${PM_VALUE}';
      fs.writeFileSync('${PKG_JSON}', JSON.stringify(p, null, 2) + '\n');
    "
  fi
}
trap cleanup EXIT

# Strip packageManager field
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('${PKG_JSON}', 'utf8'));
  delete p.packageManager;
  fs.writeFileSync('${PKG_JSON}', JSON.stringify(p, null, 2) + '\n');
"

# Hide the pnpm lock file so package-manager-detector returns npm
mv "$LOCK_FILE" "$LOCK_BACKUP"

# Run changeset publish — it now detects npm and calls `npm publish`,
# which performs the GitHub Actions OIDC automated token exchange.
if [[ -n "$DIST_TAG" ]]; then
  echo "Publishing under dist-tag: ${DIST_TAG}"
  npx --no changeset publish --tag "$DIST_TAG"
else
  npx --no changeset publish
fi

# Any additional tags this release should own. Only reached when the version was actually
# published — `changeset publish` exits non-zero otherwise and `set -e` stops us here.
#
# This fails the job if it cannot set the tag. A release that publishes but leaves `latest`
# on the previous version is worse than a red build: it looks shipped, and every fresh
# install keeps getting the old one. If npm's OIDC credentials do not survive past the
# publish call, this is where that shows up, loudly, rather than in a user's install.
for tag in $ALSO_TAG; do
  echo "Moving dist-tag '${tag}' to ${VERSION}"
  npm dist-tag add "${PKG_NAME}@${VERSION}" "$tag"
done
