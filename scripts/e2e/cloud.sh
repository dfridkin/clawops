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
# Whether the run got as far as checking anything.
ASSERTED=no

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
  # A run that stopped at preflight has no failed assertions and no passed ones. Reporting
  # "all assertions passed" for it is worse than reporting nothing: the line this script exists
  # to print is the one that says the cloud is empty again, and it has to be true.
  if [ "$ASSERTED" = "no" ]; then
    echo "✗ stopped before the assertions ran — nothing was verified"
    exit "$code"
  fi
  echo "✓ all assertions passed, stack destroyed"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "── Preflight ───────────────────────────────────────────────────"
# Credentials first: finding out after provisioning is the expensive order to discover this.
#
# --provider, not the default stack. `stacks delete` on this script's throwaway stack hands the
# default to whichever stack is left, so the second Azure run preflighted GCP, passed, and
# deployed without a single Azure check having run.
PREFLIGHT_ARGS=(--provider "$PROVIDER")
if [ -n "${E2E_INSTANCE_TYPE:-}" ]; then
  # Otherwise the size check asks about the provider's default, which this run is deliberately
  # not using, and reports a healthy deployment as broken.
  PREFLIGHT_ARGS+=(--instance-type "$E2E_INSTANCE_TYPE")
fi
pnpm dev doctor "${PREFLIGHT_ARGS[@]}" 2>&1 | grep -iE "credential|${PROVIDER}|available in" | head -6 || true
if ! pnpm dev doctor "${PREFLIGHT_ARGS[@]}" >/dev/null 2>&1; then
  echo "doctor reports a failure for ${PROVIDER} — fix that before spending money on a deploy." >&2
  DESTROYED=yes   # nothing was created
  exit 1
fi

echo
echo "── Deploying ${STACK} on ${PROVIDER} (OpenClaw ${FLOOR}) ───────"
# apply resolves the stack's state backend from ~/.clawops/config.json, so a stack name that
# has never been registered cannot be applied. Register this run's throwaway name against the
# same bucket and region as the configured default stack.
# From a stack of the SAME provider, not from whichever stack happens to be the default: the
# state backends are not interchangeable. Taking the default's would have registered an Azure
# stack against a `gs://` bucket.
STACK_INFO=$(node -e "
const c = require(require('os').homedir() + '/.clawops/config.json')
const match = Object.values(c.stacks).find((s) => s.provider === process.argv[1])
if (!match) {
  console.error('No ' + process.argv[1] + ' stack in ~/.clawops/config.json to borrow a state backend from.')
  console.error('Register one first: clawops init --provider ' + process.argv[1] + ' --state <url>')
  process.exit(1)
}
process.stdout.write(match.stateUrl + ' ' + (match.region ?? ''))
" "$PROVIDER") || exit 1
read -r STATE_URL REGION <<<"$STACK_INFO"
if [ -z "$STATE_URL" ]; then
  echo "Could not resolve a state backend for ${PROVIDER}." >&2
  exit 1
fi
echo "Registering ${STACK} → ${STATE_URL} (${REGION})"
pnpm dev init --provider "$PROVIDER" --stack "$STACK" --state "$STATE_URL" \
  ${REGION:+--region "$REGION"} --non-interactive || exit 1
REGISTERED=yes

# --ssh-cidr auto: every assertion below runs over SSH, so a plan with no ingress fails all
# of them for a reason that has nothing to do with the runtime contract being tested.
# E2E_INSTANCE_TYPE overrides the size. Azure offers SKU families per subscription and region,
# and the subscription this was first run against was offered none of the B-series sizes
# clawops names — so there is no size the script can hardcode that works everywhere.
SIZE_ARG=()
if [ -n "${E2E_INSTANCE_TYPE:-}" ]; then
  SIZE_ARG=(--instance-type "$E2E_INSTANCE_TYPE")
  echo "Using instance type ${E2E_INSTANCE_TYPE}"
fi

pnpm dev plan --provider "$PROVIDER" --stack "$STACK" --openclaw-version "$FLOOR" \
  --ssh-cidr auto "${SIZE_ARG[@]}" --out "/tmp/${STACK}.plan.json" || exit 1
CREATED=yes
pnpm dev apply "/tmp/${STACK}.plan.json" --yes || exit 1

echo
echo "── Asserting the 2.0 runtime contract ──────────────────────────"
ASSERTED=yes

# `doctor --stack` exits 1 on any failed check, so it is the single strongest assertion here:
# container running, the deployed version in range, the gateway answering /startupz with a
# JSON body, the port on loopback, disk, log rotation.
DOCTOR_ARGS=(--stack "$STACK")
if [ -n "${E2E_INSTANCE_TYPE:-}" ]; then DOCTOR_ARGS+=(--instance-type "$E2E_INSTANCE_TYPE"); fi
if pnpm dev doctor "${DOCTOR_ARGS[@]}"; then pass "doctor --stack passed"; else fail "doctor --stack reported failures"; fi

# State must survive a container replacement. Before 2.0 nothing was mounted and this is
# exactly what was lost, so it is the assertion the whole release turns on.
BEFORE=$(pnpm dev ssh --stack "$STACK" --command \
  'sudo sha256sum /var/lib/clawops/openclaw/openclaw.json 2>/dev/null | cut -d" " -f1' 2>/dev/null | tail -1)
RESTARTED=yes
pnpm dev gateway restart --stack "$STACK" >/dev/null 2>&1 || { fail "gateway restart failed"; RESTARTED=no; }
sleep 15
AFTER=$(pnpm dev ssh --stack "$STACK" --command \
  'sudo sha256sum /var/lib/clawops/openclaw/openclaw.json 2>/dev/null | cut -d" " -f1' 2>/dev/null | tail -1)

# Both halves have to be real. When `ssh` fails, both captures are the same error text, and
# comparing them passes — the survival check reported success for a run where the restart had
# already failed and nothing was read. A digest is 64 hex characters; an error message is not.
if ! printf '%s' "$BEFORE" | grep -qE '^[0-9a-f]{64}$'; then
  fail "could not read the config digest before restarting (got: ${BEFORE:-nothing})"
elif [ "$RESTARTED" = "no" ]; then
  fail "skipped the state-survival check — the gateway never restarted"
elif [ "$BEFORE" = "$AFTER" ]; then
  pass "config survived a gateway restart"
else
  fail "config did not survive a gateway restart (before=${BEFORE} after=${AFTER:-none})"
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

# Logs must come from the gateway itself, not the container fallback. `clawops logs` announces
# which one it used and why:
#
#   Logs: gateway — read from the gateway over RPC
#
# This grepped for "source: gateway", a string the command has never printed, so the assertion
# could only ever fail. A fixture that does not match the real command tests nothing — and the
# failure said "logs did not come from the gateway", which was a claim about clawops rather
# than about this script. The line it actually saw is now part of the failure.
LOG_OUT=$(pnpm dev logs --stack "$STACK" --tail 5 2>&1)
LOG_SOURCE=$(printf '%s\n' "$LOG_OUT" | grep -o 'Logs: [a-z]*' | head -1)
if [ "$LOG_SOURCE" = "Logs: gateway" ]; then
  pass "logs read from the gateway"
else
  fail "logs did not come from the gateway (saw: ${LOG_SOURCE:-no source line at all})"
fi
