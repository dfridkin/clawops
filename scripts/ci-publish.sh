#!/usr/bin/env bash
# Temporarily hide pnpm detection signals so @changesets/cli uses npm for publishing.
# npm supports GitHub Actions OIDC automated token exchange; pnpm does not.
# This script is only run in CI (GitHub Actions release workflow).
set -euo pipefail

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

# Diagnostics: print what npm sees (auth-redacted)
echo "--- ci-publish diagnostics ---"
echo "npm version: $(npm --version)"
echo "GITHUB_ACTIONS: ${GITHUB_ACTIONS:-unset}"
echo "ACTIONS_ID_TOKEN_REQUEST_URL: ${ACTIONS_ID_TOKEN_REQUEST_URL:+set}"
echo "ACTIONS_ID_TOKEN_REQUEST_TOKEN: ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:+set}"
echo "NPM_CONFIG_PROVENANCE: ${NPM_CONFIG_PROVENANCE:-unset}"
echo "NODE_AUTH_TOKEN: ${NODE_AUTH_TOKEN:+set}"
echo ".npmrc files:"
for f in "$HOME/.npmrc" ".npmrc" "$(npm config get userconfig)"; do
  [[ -f "$f" ]] && echo "  $f: $(cat "$f" | sed 's/=.*/=***/')" || echo "  $f: absent"
done
echo "--- end diagnostics ---"

# Run changeset publish — it now detects npm and calls `npm publish`,
# which performs the GitHub Actions OIDC automated token exchange.
npx --no changeset publish
