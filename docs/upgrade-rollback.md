# Upgrade and rollback

ClawOps supports two upgrade paths for OpenClaw. Choose based on the scope of the change:

| Path | Command | Downtime | Use when |
|---|---|---|---|
| Gateway-only | `clawops gateway update <version>` | a restart (the image is pulled first) | A 2.x version change, no infra changes |
| Plan/apply | `clawops plan` + `clawops apply` | ~5–15 min | New infra requirements, env vars, port changes, or first upgrade to a version listed in `spec/openclaw-versions.yaml` |

When in doubt, use plan/apply. It is safer and leaves an auditable trail.

## Pre-upgrade checklist

Before any upgrade:

1. **Take a backup:**
   ```bash
   clawops backup create --out /backups/openclaw-pre-upgrade-$(date +%Y%m%d).tar.gz
   ```
2. **Note the current image tag** (you will need this for rollback):
   ```bash
   clawops gateway status
   # Image: ghcr.io/openclaw/openclaw:2026.9.2
   ```
3. **Check agent state**. Confirm agents are healthy before you start:
   ```bash
   clawops agents list
   ```

## Gateway-only upgrade

Moves the gateway to another 2.x release. The container is replaced; the state is not. It lives
in the bind-mounted state directory `/var/lib/clawops/openclaw`, which holds the config, the
SQLite database and installed plugins.

```bash
# The release this clawops recommends
clawops gateway update

# A specific release
clawops gateway update 2026.9.3
```

Moving tags (`latest`, `stable`, `dev`) are refused: an upgrade you cannot name is one you cannot
roll back to. Over MCP the same operation is `clawops_gateway_update`, which asks before it runs.

What runs on the host, in order:

1. `docker pull` the target image, while the current gateway keeps serving
2. **Snapshot the state database** with the *current* release, into
   `/var/lib/clawops/openclaw/snapshots/<id>` on the host
3. **Preflight the snapshot with the *target* release**, which says whether it understands the
   database. If it does not, the update is refused here, and nothing has been replaced
4. Replace the gateway with the target image, keeping its publish scope (loopback, or every
   interface if the stack was deployed that way). On a local-provider host this goes through the
   `openclaw` systemd unit, see [the local provider](providers/local.md)
5. Wait for `/startupz` to report `started`
6. If it does not, run OpenClaw's one-shot repair and wait again; if that fails, **put the
   previous release back** and say so. If even that does not start, the message names the
   snapshot from step 2

The downtime is the restart in step 4: the image is already on the host by then.

### Verify after gateway upgrade

```bash
clawops gateway status                # confirm 'running' with the new image
clawops agents list                   # confirm agents reconnected
clawops logs --tail 50                # check for errors in the first minute
```

## Plan/apply upgrade

Use this path when the new OpenClaw version has infrastructure requirements, new environment
variables, changed ports, updated IAM policies, or when `spec/openclaw-versions.yaml` notes a
breaking change for the target version.

```bash
# 1. Generate a plan with the new version
clawops plan \
  --provider aws \
  --stack prod \
  --openclaw-version 2026.5.0 \
  --out /tmp/upgrade-plan.json

# 2. Review the plan
cat /tmp/upgrade-plan.json | jq .diff

# 3. Apply
clawops apply /tmp/upgrade-plan.json
```

`clawops apply` will display the resource diff and prompt for confirmation before executing.
The drift warning will fire if the stack was touched since you ran `plan`, review and confirm.

Pulumi reconciles only what changed. If the new version requires a new IAM policy, Pulumi adds
it. The EC2 instance or VM is not replaced unless the instance type changed.

### Verify after plan/apply upgrade

```bash
clawops status                        # confirm stack outputs are healthy
clawops gateway status                # confirm container is running with new image
clawops agents list                   # confirm agents are up
clawops logs --tail 100               # check for startup errors
```

## Rollback

ClawOps does not have a dedicated rollback command. Rollback is a targeted re-deploy to the
previous version.

### Gateway rollback (fast)

If the upgrade was gateway-only, roll back by specifying the previous image tag:

```bash
clawops gateway update 2026.9.2      # the version you noted in the pre-upgrade checklist
```

This runs the same checks as a forward upgrade. A failed upgrade usually needs no rollback at
all: step 6 above already put the previous release back.

### Plan/apply rollback

If you used plan/apply, generate a new plan with the previous version and apply it:

```bash
clawops plan \
  --provider aws \
  --stack prod \
  --openclaw-version 2026.4.5 \
  --out /tmp/rollback-plan.json

clawops apply /tmp/rollback-plan.json
```

### Restore from backup (data rollback)

If the upgrade corrupted application data, restore from the pre-upgrade backup after rolling
back the software:

Data rollback uses `clawops backup restore`, which delegates to OpenClaw 2.0's own restore:
it verifies the archive and expands it into a fresh staging directory, never in place. Adding
`--activate` then puts the restored state in place — keeping the state it replaces — and
restarts the gateway on it. See
[Adopting the restored state](backup-restore.md#adopting-the-restored-state):

```bash
# 1. Roll back the software (gateway or plan/apply as above)
# 2. Recover data
clawops backup restore --file /backups/openclaw-pre-upgrade.tar.gz --activate
# 3. Reinstall provider plugins (not carried in the archive)
clawops apply <plan>.json
# 4. Verify
clawops agents list
```

See [`docs/backup-restore.md`](backup-restore.md) for the full restore procedure.

## Version compatibility

`spec/openclaw-versions.yaml` lists breaking changes by OpenClaw version and the corresponding
ClawOps adapter requirements. Always check it before upgrading across a major version boundary.

Notable compatibility notes (see `spec/openclaw-versions.yaml` for the full list):

- **OpenClaw ≥ 2026.4.5** requires `AWS_PROFILE` in the systemd `EnvironmentFile`, not
  `auth: "aws-sdk"` in `openclaw.json`. The AWS provider emits both for compatibility.
