#!/usr/bin/env bash
# Temporarily hide pnpm detection signals so @changesets/cli uses npm for publishing.
# npm 11.5.1+ performs the OIDC automated token exchange (trusted publishing);
# pnpm publish does not. This script is only run in CI (GitHub Actions release workflow).
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

# Run changeset publish — it now detects npm and calls `npm publish`,
# which performs the GitHub Actions OIDC automated token exchange.
npx --no changeset publish
