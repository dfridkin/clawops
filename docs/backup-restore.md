# Backup and restore

ClawOps provides `clawops backup create` to capture point-in-time snapshots of your OpenClaw
application data over SSH.

> **The archive is a credential.** It contains the state database, whose tables include
> `mcp_oauth_stores`, `secret_store_entries`, `worker_environment_credentials` and
> `device_auth_tokens`. Unencrypted. clawops writes it `0600`; keep it that way, and
> encrypt it at rest for anything you would not hand over.

## What gets backed up

`clawops backup create` runs `openclaw backup create --output <path> --verify` inside the running
OpenClaw container, then streams the resulting archive to your local machine. The archive
contains:

- OpenClaw conversation history and memory
- Agent configuration and state
- Model and channel configuration (as stored in the running instance)
- Any application-level data written by OpenClaw to its data directory

## What is NOT backed up

| Item | Where it lives | How to protect it |
|---|---|---|
| Pulumi stack state | Your state backend (S3, GCS, Azure Blob) | Back up the state backend bucket |
| SSH private key | `~/.clawops/config.json → ssh.keyPath` (local) | Include in your machine backup |
| `~/.clawops/config.json` | Local machine | Include in your machine backup |
| Cloud infra (EC2, VMs, etc.) | Pulumi-managed; recreatable via `clawops apply` | Re-apply the plan |
| `openclaw.json` on the host | `/var/lib/clawops/openclaw/openclaw.json` | Committed to your config repo, or backed up separately |

Pulumi state is authoritative for infrastructure. If you lose it, you may need to use
`pulumi import` to re-adopt existing resources. Keep your state backend durable (versioning
enabled on S3, for example).

## Creating a backup

```bash
# Auto-named (openclaw-backup-<ISO timestamp>.tar.gz in current directory)
clawops backup create

# Explicit output path
clawops backup create --out /backups/openclaw-prod-20260508.tar.gz

# Specific stack
clawops backup create --stack prod --out /backups/openclaw-prod-20260508.tar.gz
```

The command:
1. Opens an SSH session to the remote host
2. Runs `openclaw backup create --output /tmp/clawops-backup.tar.gz --verify --json` in the
   container. `--verify` makes OpenClaw check the archive it just wrote
3. Streams the archive out with `docker exec openclaw cat`, then removes the temporary copy
4. Reports the local output path on success

OpenClaw has no stdout mode for backups; `--output` takes a path, not `-`. The temporary file
inside the container is why the host needs a little free space in `/tmp` during a backup.

Backups are plain `.tar.gz` archives. No encryption is applied by ClawOps, encrypt at rest
using your storage layer (S3 SSE, GPG, etc.) for sensitive deployments.

## Validating a backup

Before relying on a backup for disaster recovery, verify it:

```bash
# Check the archive is not corrupt
tar -tzf /backups/openclaw-prod-20260508.tar.gz | head -20

# Check file size is plausible (should not be near 0 bytes)
ls -lh /backups/openclaw-prod-20260508.tar.gz
```

For production stacks, rehearse recovery against a staging stack at least monthly (see
[Adopting the restored state](#adopting-the-restored-state) below). An archive nobody has ever
restored is a guess, not a backup.

## Restoring

```bash
clawops backup restore --file /backups/openclaw-prod-20260908.tar.gz
```

clawops does not extract the archive itself. It uploads it and calls
`openclaw backup restore`, which verifies the archive and expands it into a **fresh staging
directory**, refusing a non-empty target. clawops then copies the result out of the container
to the host, beside the state directory it would replace. Nothing is activated unless you ask:

```
✓ Archive verified and expanded to /var/lib/clawops/.clawops-restored-1757... on the host.
  10 entries restored.
⚠ Restoring an archive is time travel: every restored state surface rolls back to the
  archive timestamp.
⚠ Messaging-channel credentials with ratchet state, especially WhatsApp, may desynchronize
  after rollback and require relinking.
⚠ Approvals and delivery/dedupe state also roll back; review pending approvals before
  resuming the Gateway.
⚠ Plugin node_modules are not archived.
```

Those warnings come from OpenClaw and are printed verbatim. They describe consequences
clawops cannot judge for you, and summarising them would lose the detail that matters.

### Adopting the restored state

The quick way:

```bash
clawops backup restore --file /backups/openclaw-prod-20260908.tar.gz --activate
clawops apply <plan>.json     # reinstalls provider plugins
```

`--activate` stops the gateway, moves the current state aside — it is kept, never deleted —
puts the restored state in place, restarts, and waits for the gateway to answer. If it does
not answer within three minutes, clawops puts the previous state back, restarts again, and
keeps the state that would not run under `.failed-restore-<timestamp>`.

By hand, if you would rather see each step:

```bash
clawops ssh --command 'sudo docker stop openclaw'
# replace the CONTENTS of the state directory with the contents of
#   <staging>/<archiveRoot>/payload/posix/home/node/.openclaw
# and chown them to uid 1000, the user the gateway runs as
clawops gateway restart
clawops apply <plan>.json     # reinstalls provider plugins
```

**Note the path.** What OpenClaw expands is a bundle, not a drop-in state directory: a
`manifest.json` beside a `payload/posix/` tree that mirrors the state directory's original
absolute path. Moving the bundle itself into place leaves the gateway looking at a manifest
where its config should be, and it will not start. clawops reads the manifest to find the
right subtree, and refuses any `schemaVersion` it has not been tested against rather than
guessing at a layout that has changed.

The last step is not optional if you use a provider whose plugin is not bundled, the
archive does not carry plugin `node_modules`, so the gateway would start without its model
providers and look healthy while doing it.

Restoring in place is deliberately not offered. Writing an archive over a live state
directory is how a backup becomes corruption, and OpenClaw refuses it too.

## Automation

### Daily cron backup

```bash
# /etc/cron.d/clawops-backup  (or crontab -e)
0 2 * * * clawops backup create --stack prod \
  --out /backups/openclaw-prod-$(date +\%Y\%m\%d).tar.gz \
  >> /var/log/clawops-backup.log 2>&1
```

Keep at least 7 days of backups. Delete older ones:

```bash
# Retain last 7 backups
find /backups -name "openclaw-prod-*.tar.gz" -mtime +7 -delete
```

### Upload to S3

```bash
clawops backup create --out /tmp/openclaw-latest.tar.gz && \
  aws s3 cp /tmp/openclaw-latest.tar.gz \
    s3://your-backup-bucket/openclaw/$(date +%Y/%m/%d)/openclaw.tar.gz \
    --sse AES256
```

Use S3 Lifecycle rules to transition backups to Glacier after 30 days and expire after 365.

## Disaster recovery checklist

1. **Provision a new stack** if the host is lost:
   ```bash
   clawops apply /path/to/last-reviewed-plan.json --yes
   ```
2. **Wait for the stack to be healthy:**
   ```bash
   clawops gateway status
   ```
3. **Recover the most recent backup** — see
   [Adopting the restored state](#adopting-the-restored-state):
   ```bash
   clawops backup restore --file /backups/openclaw-prod-<date>.tar.gz --activate
   ```
   `--activate` restarts the gateway itself and puts the previous state back if it does not
   come up, so step 4 is only needed if you adopted the state by hand.
4. **Restart the gateway** (if you did not use `--activate`):
   ```bash
   clawops gateway restart
   ```
5. **Verify agents are running:**
   ```bash
   clawops agents list
   ```
