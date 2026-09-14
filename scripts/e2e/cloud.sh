#!/usr/bin/env bash
# End-to-end deploy against a real cloud, then destroy it.
#
#   scripts/e2e/cloud.sh gcp|azure [--keep]
#
# Deliberately manual and deliberately noisy about money. It provisions a VM, proves the 2.0
# runtime contract on it, and destroys everything. Not wired into CI: a run costs real money,
# and a recurring job that provisions infrastructure is a bill nobody reads until it arrives.
#
# The teardown is a trap, not a final line. An assertion that fails mid-run must still destroy
# the stack — the failure mode this guards is not a wrong answer, it is a VM nobody remembers
# leaving on.
set -uo pipefail

PROVIDER="${1:-}"
KEEP="${2:-}"
STACK="e2e-$(date +%Y%m%d-%H%M%S)"
FLOOR=$(node -p "require('js-yaml').load(require('fs').readFileSync('spec/openclaw-versions.yaml','utf8')).support.recommended")

case "$PROVIDER" in
  gcp|azure) ;;
  *) echo "usage: $0 gcp|azure [--keep]" >&2; exit 2 ;;
esac

fail() { echo "  ✗ $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ✓ $*"; }
FAILURES=0
DESTROYED=no
# Whether anything could exist yet. A destroy that fails because nothing was ever created is
# not the failure the loud banner is for, and crying wolf about a bill teaches people to
# ignore it.
CREATED=no
REGISTERED=no

cleanup() {
  local code=$?
  if [ "$KEEP" = "--keep" ]; then
    echo
    echo "⚠  --keep was passed. Stack '${STACK}' is STILL RUNNING and still costing money."
    echo "   Destroy it with: pnpm dev destroy --stack ${STACK} --yes"
    exit "$code"
  fi
  if [ "$DESTROYED" = "no" ] && [ "$CREATED" = "no" ]; then
    echo
    echo "Nothing was provisioned — no resources to destroy."
    DESTROYED=yes
  fi

  if [ "$DESTROYED" = "no" ]; then
    echo
    echo "── Destroying ${STACK} ─────────────────────────────────────────"
    # Retried once: a destroy that races a still-settling resource is common enough that one
    # retry is worth more than a clean exit code here.
    pnpm dev destroy --stack "$STACK" --yes || {
      echo "   first destroy failed; retrying once"
      sleep 20
      pnpm dev destroy --stack "$STACK" --yes || {
        echo
        echo "✗✗ DESTROY FAILED for ${STACK}. Resources may still exist and still cost money."
        echo "   Check your provider console before walking away."
        exit 1
      }
    }
    DESTROYED=yes
  fi

  # The stack entry outlives its resources otherwise, and every run would leave one behind.
  if [ "$REGISTERED" = "yes" ]; then
    pnpm dev stacks delete "$STACK" --yes --force >/dev/null 2>&1 ||
      echo "   note: could not remove ${STACK} from ~/.clawops/config.json"
  fi

  echo
  if [ "$FAILURES" -gt 0 ]; then echo "✗ ${FAILURES} assertion(s) failed"; exit 1; fi
  echo "✓ all assertions passed, stack destroyed"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "── Preflight ───────────────────────────────────────────────────"
# Credentials first: finding out after provisioning is the expensive order to discover this.
pnpm dev doctor 2>&1 | grep -iE "credential|${PROVIDER}" | head -5 || true
if ! pnpm dev doctor >/dev/null 2>&1; then
  echo "doctor reports a failure — fix that before spending money on a deploy." >&2
  DESTROYED=yes   # nothing was created
  exit 1
fi

echo
echo "── Deploying ${STACK} on ${PROVIDER} (OpenClaw ${FLOOR}) ───────"
# apply resolves the stack's state backend from ~/.clawops/config.json, so a stack name that
# has never been registered cannot be applied. Register this run's throwaway name against the
# same bucket and region as the configured default stack.
STATE_URL=$(node -e "const c=require(require('os').homedir()+'/.clawops/config.json');const s=c.stacks[c.defaults.stack];process.stdout.write(s.stateUrl)")
REGION=$(node -e "const c=require(require('os').homedir()+'/.clawops/config.json');const s=c.stacks[c.defaults.stack];process.stdout.write(s.region??'')")
echo "Registering ${STACK} → ${STATE_URL} (${REGION})"
pnpm dev init --provider "$PROVIDER" --stack "$STACK" --state "$STATE_URL" \
  ${REGION:+--region "$REGION"} --non-interactive || exit 1
REGISTERED=yes

# --ssh-cidr auto: every assertion below runs over SSH, so a plan with no ingress fails all
# of them for a reason that has nothing to do with the runtime contract being tested.
pnpm dev plan --provider "$PROVIDER" --stack "$STACK" --openclaw-version "$FLOOR" \
  --ssh-cidr auto --out "/tmp/${STACK}.plan.json" || exit 1
CREATED=yes
pnpm dev apply "/tmp/${STACK}.plan.json" --yes || exit 1

echo
echo "── Asserting the 2.0 runtime contract ──────────────────────────"

# `doctor --stack` exits 1 on any failed check, so it is the single strongest assertion here:
# container running, the deployed version in range, the gateway answering /startupz with a
# JSON body, the port on loopback, disk, log rotation.
if pnpm dev doctor --stack "$STACK"; then pass "doctor --stack passed"; else fail "doctor --stack reported failures"; fi

# State must survive a container replacement. Before 2.0 nothing was mounted and this is
# exactly what was lost, so it is the assertion the whole release turns on.
BEFORE=$(pnpm dev ssh --stack "$STACK" --command \
  'sudo sha256sum /var/lib/clawops/openclaw/openclaw.json 2>/dev/null | cut -d" " -f1' 2>/dev/null | tail -1)
pnpm dev gateway restart --stack "$STACK" >/dev/null 2>&1 || fail "gateway restart failed"
sleep 15
AFTER=$(pnpm dev ssh --stack "$STACK" --command \
  'sudo sha256sum /var/lib/clawops/openclaw/openclaw.json 2>/dev/null | cut -d" " -f1' 2>/dev/null | tail -1)
if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ]; then
  pass "config survived a gateway restart"
else
  fail "config did not survive a gateway restart (before=${BEFORE:-none} after=${AFTER:-none})"
fi

# The gateway must not be reachable from the network: 2.0 publishes on loopback, and a
# security group that admits the port is not the same as a port that is listening.
if pnpm dev ssh --stack "$STACK" --command \
     "sudo docker inspect openclaw --format '{{json .HostConfig.PortBindings}}'" 2>/dev/null \
     | grep -q '127.0.0.1'; then
  pass "gateway published on loopback only"
else
  fail "gateway is not published on loopback"
fi

# Logs must come from the gateway itself, not the journalctl fallback.
if pnpm dev logs --stack "$STACK" --tail 5 2>&1 | grep -q "source: gateway"; then
  pass "logs read from the gateway"
else
  fail "logs did not come from the gateway"
fi
