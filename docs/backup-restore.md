# Backup and restore

ClawOps provides `clawops backup create` to capture point-in-time snapshots of your OpenClaw
application data over SSH.

> **Restore is not available on the clawops 1.x line.** OpenClaw up to `2026.7.1-2` ships
> `backup create` and `backup verify` only — there is no `restore` subcommand to call. Earlier
> clawops releases advertised `backup restore`, but it invoked a binary that does not exist in the
> image and never ran. `clawops backup restore` now fails with an explanation rather than pretending
> to work. See [Recovering from an archive](#recovering-from-an-archive) for what you can do today,
> and [OpenClaw 2.0](#openclaw-20) for what is coming.

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
2. Runs `openclaw backup create --output /tmp/clawops-backup.tar.gz --verify --json` in the
   container — `--verify` makes OpenClaw check the archive it just wrote
3. Streams the archive out with `docker exec openclaw cat`, then removes the temporary copy
4. Reports the local output path on success

OpenClaw has no stdout mode for backups; `--output` takes a path, not `-`. The temporary file
inside the container is why the host needs a little free space in `/tmp` during a backup.

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

For production stacks, rehearse recovery against a staging stack at least monthly (see
[Recovering from an archive](#recovering-from-an-archive) below). Because recovery is manual on
this line, the rehearsal matters more, not less.

## Recovering from an archive

There is no `clawops backup restore` on this release line, and no `restore` subcommand inside
OpenClaw `2026.7.1-2` for it to call. Recovery today is a manual procedure, and it is deliberately
not automated: writing an archive into a live state directory without the application's cooperation
is how a bad backup becomes a corrupt deployment.

The archive is an ordinary `.tar.gz`. To recover:

```bash
# 1. Inspect what you are about to write
tar -tzf /backups/openclaw-prod-20260508.tar.gz

# 2. Stop the gateway so nothing is writing to the state directory
clawops ssh --command 'sudo docker stop openclaw'

# 3. Copy the archive to the host and unpack it into the data directory
#    Confirm the path against your own deployment before running this.
scp /backups/openclaw-prod-20260508.tar.gz ec2-user@<host>:/tmp/
clawops ssh --command 'sudo tar -xzf /tmp/openclaw-restore.tar.gz -C /home/clawops/'

# 4. Bring the gateway back
clawops gateway restart
clawops agents list
```

Treat this as a break-glass procedure. Validate it against a staging stack before you need it in
anger, and record the data directory your deployment actually uses — it is not identical across
providers.

## OpenClaw 2.0

OpenClaw 2.0 adds a real `backup restore` subcommand that understands the SQLite state layout it
introduced. `clawops backup restore` returns as a supported command in the clawops 2.x line, built
on that, rather than on an untar this project would be guessing at.

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
3. **Recover the most recent backup** using the manual procedure in
   [Recovering from an archive](#recovering-from-an-archive). Budget real time for this step and
   rehearse it before an outage — it is not a one-liner on this release line.
4. **Restart the gateway:**
   ```bash
   clawops gateway restart
   ```
5. **Verify agents are running:**
   ```bash
   clawops agents list
   ```
