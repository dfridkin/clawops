# Operations guide

Day-2 operations for a running ClawOps stack. All commands assume a deployed stack — run
`clawops up` or `clawops apply` first if the stack has not been provisioned.

## Monitoring

### Check stack status

```bash
clawops status                        # human table
clawops status --json                 # machine-readable
clawops status --stack prod           # specific stack
```

Output (cloud provider):

```
┌─────────────┬──────────────────────────────────┐
│ Field       │ Value                            │
├─────────────┼──────────────────────────────────┤
│ Stack       │ prod                             │
│ Provider    │ aws                              │
│ Region      │ us-east-1                        │
│ Public IP   │ 203.0.113.5                      │
│ Gateway URL │ https://gw.example.com           │
│ SSH         │ ubuntu@203.0.113.5:22            │
│ Provisioned │ 2026-05-08T14:00:00.000Z         │
└─────────────┴──────────────────────────────────┘
```

For local provider stacks, `status` shows `Host`, `SSH`, `Gateway URL`, and `Bootstrapped` time.
If the stack has not been deployed it prints `not bootstrapped (run clawops up)`.

### Stream logs

```bash
clawops logs                          # last 100 lines
clawops logs --tail 500               # last 500 lines
clawops logs --follow                 # tail -f equivalent
clawops logs --since 1h               # logs from the last hour
clawops logs --since 30m --follow     # combined
clawops logs --stack prod             # specific stack
```

Logs are read from `journalctl -u openclaw` on the remote host, falling back to
`docker logs openclaw` if journalctl is unavailable. Output is piped directly to your terminal.
Press `Ctrl-C` to stop following.

### Run a health check

```bash
clawops doctor
```

Checks and reports on:

- **Runtime:** Node.js version (≥22 required), Pulumi home directory writability
- **Config:** presence and readability of `~/.clawops/config.json`
- **SSH:** SSH key file readable, known_hosts file present
- **Credentials:** `validateConfig()` for each cloud provider used across your stacks

Exit code is `0` if all checks pass, `1` if any hard failure is found (missing Node version).
Warnings (e.g. missing known_hosts) do not fail the exit code.

## Agent management

OpenClaw agents are long-running processes managed inside the OpenClaw container.

```bash
# List running agents
clawops agents list
clawops agents list --json            # machine-readable

# Restart all agents
clawops agents restart

# Restart a specific agent
clawops agents restart slack-bot

# Stream logs for a specific agent (Ctrl-C to stop)
clawops agents logs slack-bot
```

`agents list` output:

```
┌───────────┬─────────┐
│ Name      │ Status  │
├───────────┼─────────┤
│ slack-bot │ running │
│ discord   │ running │
└───────────┴─────────┘
```

If no agents are running, `clawops agents list` prints `No agents running.`

## Gateway management

The OpenClaw gateway is a Docker container (`openclaw`) running on the remote host.

### Check gateway status

```bash
clawops gateway status
clawops gateway status --json
```

Output:

```
┌─────────┬──────────────────────────────────────────────────────┐
│ Field   │ Value                                                │
├─────────┼──────────────────────────────────────────────────────┤
│ Status  │ running                                              │
│ Started │ 2026-05-08T14:01:23.456Z                            │
│ Image   │ ghcr.io/openclaw/openclaw:stable                     │
└─────────┴──────────────────────────────────────────────────────┘
```

`Status` reflects the Docker container state (`running`, `exited`, `not running`).

### Restart the gateway

```bash
clawops gateway restart
```

Restarts the container using the currently running image tag. Config is preserved — the container
mounts `/home/clawops/openclaw.json` read-only, so no config is lost on restart.

### Update the gateway

```bash
clawops gateway update                # pull and restart with 'stable' tag
clawops gateway update 2026.4.5       # specific version
clawops gateway update --channel dev  # dev channel
```

Update sequence:
1. `docker pull ghcr.io/openclaw/openclaw:<version>`
2. `docker stop openclaw && docker rm openclaw`
3. `docker run` with the new image, same port and config mount

Expect ~60 seconds of downtime during the container swap. See
[`docs/upgrade-rollback.md`](upgrade-rollback.md) for the full upgrade procedure including
pre-upgrade checklist and rollback steps.

## SSH access

```bash
clawops ssh                           # open an interactive shell
clawops ssh --stack prod              # specific stack
```

Opens an SSH session to the remote host using the key and known_hosts path from
`~/.clawops/config.json`. The session uses the `ssh2` library directly — no `ssh` binary required.

## Port forwarding

```bash
clawops tunnel --local-port 8080 --remote-port 18789
clawops tunnel --local-port 8080 --remote-port 18789 --stack prod
```

Forwards a local port to a port on the remote host over SSH. Useful for accessing the gateway
locally without exposing it publicly, or for debugging internal services. Press `Ctrl-C` to close
the tunnel.

## Backup and restore

See [`docs/backup-restore.md`](backup-restore.md) for the full procedure.

Quick reference:

```bash
clawops backup create --out /backups/openclaw-$(date +%Y%m%d).tar.gz
```

`clawops backup restore` is not available on the 1.x line — OpenClaw `2026.7.1-2` has no restore
subcommand. Recovery is a manual, documented procedure; the command returns in clawops 2.x.

## Config management

```bash
clawops config get                    # show all config values
clawops config get ssh.keyPath        # specific key
clawops config set defaults.stack prod
clawops config unset defaults.stack
```

Config is stored at `~/.clawops/config.json`. Secrets are never stored in config — see
[`docs/security/redaction.md`](security/redaction.md).

## Routine maintenance

### Recommended backup schedule

Take a backup before any upgrade and on a regular schedule for production stacks:

```bash
# Daily cron — adjust path as needed
0 2 * * * clawops backup create --stack prod \
  --out /backups/openclaw-prod-$(date +\%Y\%m\%d).tar.gz
```

Keep at least 7 daily backups. Test restores periodically on a staging stack.

### Log rotation

OpenClaw writes logs to journald (or Docker's log driver). Journald rotates automatically
based on `/etc/systemd/journald.conf` (`SystemMaxUse`, default ~10% of disk). For Docker-only
setups without journald, configure Docker's `json-file` log driver:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  }
}
```

Add to `/etc/docker/daemon.json` on the remote host and restart Docker. For disk safety on
small instances (`micro` / `small`), set `max-size` to `50m`.

### Disk usage check

```bash
clawops ssh
df -h /                               # overall disk usage
du -sh /var/lib/docker                # Docker image and container storage
journalctl --disk-usage               # journald log storage
```

Alert if disk usage exceeds 80%. The `small` instance type (20 GB root volume) typically uses
~6 GB for the OS + Docker images, leaving ~14 GB for logs and data.
