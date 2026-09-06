# Upgrade and rollback

ClawOps supports two upgrade paths for OpenClaw. Choose based on the scope of the change:

| Path | Command | Downtime | Use when |
|---|---|---|---|
| Gateway-only | `clawops gateway update` | ~60s | OpenClaw patch/minor version bump, no infra changes |
| Plan/apply | `clawops plan` + `clawops apply` | ~5–15 min | New infra requirements, env vars, port changes, or first upgrade to a version listed in `spec/openclaw-versions.yaml` |

When in doubt, use plan/apply — it is safer and leaves an auditable trail.

## Pre-upgrade checklist

Before any upgrade:

1. **Take a backup:**
   ```bash
   clawops backup create --out /backups/openclaw-pre-upgrade-$(date +%Y%m%d).tar.gz
   ```
2. **Note the current image tag** (you will need this for rollback):
   ```bash
   clawops gateway status
   # Image: ghcr.io/openclaw/openclaw:2026.4.5
   ```
3. **Check agent state** — confirm agents are healthy before you start:
   ```bash
   clawops agents list
   ```

## Gateway-only upgrade

Pulls the new Docker image and replaces the running container. Config is preserved — the container
mounts `/home/clawops/openclaw.json` read-only and is not modified by the upgrade.

```bash
# Upgrade to stable (latest stable release)
clawops gateway update

# Upgrade to a specific version
clawops gateway update 2026.5.0

# Upgrade to dev channel
clawops gateway update --channel dev
```

Sequence executed on the remote host:
1. `docker pull ghcr.io/openclaw/openclaw:<version>`
2. `docker stop openclaw && docker rm openclaw`
3. `docker run -d --name openclaw --restart unless-stopped -p 18789:18789 -v /home/clawops/openclaw.json:/app/config.json:ro ghcr.io/openclaw/openclaw:<version>`

Expect ~60 seconds of gateway unavailability between steps 2 and 3. Agents reconnect
automatically when the gateway comes back up.

### Verify after gateway upgrade

```bash
clawops gateway status                # confirm 'running' with the new image
clawops agents list                   # confirm agents reconnected
clawops logs --tail 50                # check for errors in the first minute
```

## Plan/apply upgrade

Use this path when the new OpenClaw version has infrastructure requirements — new environment
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
The drift warning will fire if the stack was touched since you ran `plan` — review and confirm.

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
clawops gateway update 2026.4.5      # the version you noted in the pre-upgrade checklist
```

This takes the same ~60s as a forward upgrade.

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

Data rollback is manual on the clawops 1.x line — OpenClaw `2026.7.1-2` ships no `backup restore`
subcommand. Follow [Recovering from an archive](backup-restore.md#recovering-from-an-archive),
which stops the gateway, unpacks the archive and restarts:

```bash
# 1. Roll back the software (gateway or plan/apply as above)
# 2. Recover data — see backup-restore.md#recovering-from-an-archive
# 3. Restart gateway to pick up restored state
clawops gateway restart
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
