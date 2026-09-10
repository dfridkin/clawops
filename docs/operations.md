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
`docker logs openclaw`. Output is piped directly to your terminal; press `Ctrl-C` to stop
following.

**Which of the two you get depends on the provider, and clawops does not tell you.** Only the
local provider creates a systemd unit named `openclaw`; on AWS, GCP and Azure the container is
started directly, so `journalctl -u openclaw` finds nothing and the fallback produces the
output — the right answer for the wrong reason. The two differ: the systemd journal carries the
unit's own start/stop records, `docker logs` carries only the container's stdout. Worth knowing
when a log line you expect is missing.

### Run a health check

```bash
clawops doctor                    # the local machine
clawops doctor --stack prod       # and the deployment
clawops doctor --stack prod --json
```

Without `--stack` it checks only the local machine and makes no SSH connection:

- **Runtime:** Node.js version (≥22 required), Pulumi home directory writability
- **Config:** presence and readability of `~/.clawops/config.json`
- **SSH:** SSH key file readable, known_hosts file present
- **Credentials:** `validateConfig()` for each cloud provider used across your stacks
- **OpenClaw:** the version range this clawops line supports

With `--stack` it also connects to the host:

- **Container:** whether the `openclaw` container is running
- **Deployed:** which OpenClaw version the gateway is *actually* running, and whether this
  clawops line supports it. An unsupported one points at `clawops migrate`
- **Gateway:** a real probe of `/startupz` whose response body is checked. A running
  container means the process started, not that it serves — these are different questions
- **Published:** whether the gateway port is bound to loopback or to every interface
- **Disk:** usage on the state directory, where 2.0's SQLite lives
- **Log rotation**, and **hardening** drift per module

Every check reports `pass`, `fail`, `warn` or `info`. **Exit code is `1` if any check
failed**, `0` otherwise — warnings do not fail it, so a machine that has not run
`clawops init` yet is not reported as broken. `--json` emits the whole report, including the
`counts` and the `ok` flag, for scripting.

The same report is available to agents as the `clawops_doctor` MCP tool, with
`failuresOnly` to skip what passed.

## Agent management

OpenClaw agents are long-running processes managed inside the OpenClaw container.

```bash
# List running agents
clawops agents list
clawops agents list --json            # machine-readable

# Stream logs for a specific agent (Ctrl-C to stop)
clawops agents logs slack-bot
```

There is no per-agent restart. OpenClaw 2.0 removed the subcommand, and the only restart
it offers is gateway-wide:

```bash
clawops gateway restart          # interrupts every agent on the host
```

`clawops agents restart` exits with that explanation rather than quietly restarting
everything — the scope difference matters on a host running several agents.

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
│ Image   │ ghcr.io/openclaw/openclaw:2026.9.2                   │
└─────────┴──────────────────────────────────────────────────────┘
```

`Status` reflects the Docker container state (`running`, `exited`, `not running`).

### Restart the gateway

```bash
clawops gateway restart
```

Restarts the container using the currently running image tag. Config is preserved — the container
bind-mounts the state directory `/var/lib/clawops/openclaw`, so the config, the SQLite
database and any installed plugins all survive the restart. Before 2.0 nothing was mounted
and a restart discarded every session.

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

`clawops backup restore` works on this line. OpenClaw 2.0 ships a real restore and clawops
delegates to it: the archive is verified upstream and expanded into a **fresh staging
directory**, never in place. Adopting the restored state is a deliberate manual step — see
[backup-restore.md](backup-restore.md).

On the clawops 1.x line the command is unavailable, because `2026.7.1-2` has no restore
subcommand at all.

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
