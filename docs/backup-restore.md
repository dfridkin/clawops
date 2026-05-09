# Backup and restore

ClawOps provides `clawops backup` to create and restore point-in-time snapshots of your OpenClaw
application data over SSH.

## What gets backed up

`clawops backup create` runs `openclaw-ctl backup create --stdout` inside the running OpenClaw
container and streams the resulting archive to your local machine. The archive contains:

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
| `openclaw.json` on the host | `/home/clawops/openclaw.json` | Committed to your config repo, or backed up separately |

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
2. Streams `docker exec openclaw openclaw-ctl backup create --stdout` to a local file
3. Reports the output path on success

Backups are plain `.tar.gz` archives. No encryption is applied by ClawOps — encrypt at rest
using your storage layer (S3 SSE, GPG, etc.) for sensitive deployments.

## Validating a backup

Before relying on a backup for disaster recovery, verify it:

```bash
# Check the archive is not corrupt
tar -tzf /backups/openclaw-prod-20260508.tar.gz | head -20

# Check file size is plausible (should not be near 0 bytes)
ls -lh /backups/openclaw-prod-20260508.tar.gz
```

For production stacks, perform a test restore to a staging stack at least monthly (see
[Restore procedure](#restore-procedure) below).

## Restore procedure

```bash
# Interactive (prompts for confirmation)
clawops backup restore --file /backups/openclaw-prod-20260508.tar.gz

# Specific stack
clawops backup restore --stack prod --file /backups/openclaw-prod-20260508.tar.gz

# Skip confirmation (CI / automation)
clawops backup restore --file /backups/openclaw-prod-20260508.tar.gz --yes
```

The command:
1. Prompts for confirmation (unless `--yes`)
2. Opens an SSH session to the remote host
3. Streams the local archive into `docker exec -i openclaw openclaw-ctl backup restore --stdin`

**The restore overwrites existing application data.** The OpenClaw container does not need to be
stopped first — `openclaw-ctl` handles the restore safely while the container is running.

After a restore, restart the gateway to pick up the restored state:

```bash
clawops gateway restart
```

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
3. **Restore the most recent backup:**
   ```bash
   clawops backup restore --file /backups/openclaw-prod-latest.tar.gz --yes
   ```
4. **Restart the gateway:**
   ```bash
   clawops gateway restart
   ```
5. **Verify agents are running:**
   ```bash
   clawops agents list
   ```
