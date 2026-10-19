# Operations guide

Day-2 operations for a running ClawOps stack. All commands assume a deployed stack, run
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

Logs come from the gateway's own `openclaw logs`, which reads its structured log file. Add
`--json` for machine-readable lines. Output is piped to your terminal; press `Ctrl-C` to stop
following.

**clawops tells you which source answered**, because there are two and they carry different
things:

| Source | When | Carries |
|---|---|---|
| `gateway` | normally | the gateway's own structured log, `--json` capable |
| `container` | the gateway is not answering, or you passed `--since` | the container's stdout |

`openclaw logs` reaches the gateway over RPC, so a gateway that is down cannot serve its own
logs, which is exactly when you want them. clawops probes first and falls back to
`docker logs`, saying so rather than leaving you to guess.

`--since` is a container-log filter; the gateway command has no time window, so asking for one
selects the container source. That is reported too.

Before 2.0 both this command and the MCP tool ran `journalctl -u openclaw || docker logs
openclaw`. Only the local provider creates that systemd unit, so on every cloud VM the first
command failed and the fallback answered. The right output for the wrong reason, with nothing
saying which had run.

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
  container means the process started, not that it serves, these are different questions
- **Published:** whether the gateway port is bound to loopback or to every interface
- **Disk:** usage on the state directory, where 2.0's SQLite lives
- **Log rotation**, and **hardening** drift per module

Every check reports `pass`, `fail`, `warn` or `info`. **Exit code is `1` if any check
failed**, `0` otherwise. Warnings do not fail it, so a machine that has not run
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

# Recent activity for one agent
clawops agents logs slack-bot
clawops agents logs slack-bot --limit 100 --json
clawops agents logs slack-bot --cursor <cursor>   # continue a previous page
```

**This is a query, not a stream.** OpenClaw 2.0 removed `agents logs`; agent-scoped records
live in the audit log, and clawops reads them with
`openclaw audit --agent <id> --kind agent_run --json`. It returns a page and a cursor to
continue from, so there is no `--follow`. Presenting a poll loop as one would be a different
thing wearing the old command's name.

`clawops logs` remains gateway-wide. Its envelope carries no agent key, so it cannot be
filtered to one agent without substring-matching a message field.

There is no per-agent restart. OpenClaw 2.0 removed the subcommand, and the only restart
it offers is gateway-wide:

```bash
clawops gateway restart          # interrupts every agent on the host
```

`clawops agents restart` exits with that explanation rather than quietly restarting
everything. The scope difference matters on a host running several agents.

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

## Host agent

A host agent is clawops on the gateway host, serving one OpenClaw agent that only you can reach
([ADR 0014](decisions/0014-host-agent-operator-handoff.md)). It can read everything the read
tools read about its own host. It changes nothing: a destructive call it is allowed returns the
`clawops` command for you to run on your machine.

```bash
# The agent must exist, must not be the default, and must be bound only to your direct messages
docker exec openclaw openclaw agents add ops          # on the host, or with `clawops ssh`
clawops agent install --stack prod --agent ops --operator telegram:12345 \
  --allow clawops_gateway_restart,clawops_config_set

clawops agent uninstall --stack prod                  # --purge also removes its audit log
```

**What install checks, before writing anything** (the disclosure review lists each condition):
- **A dedicated agent.** It is not the default agent, and nothing but your direct-message
  bindings routes to it.
- **Its channel.** `dmPolicy` is set explicitly, to `pairing`, `allowlist` or `disabled`.
- **No reach across agents.** Agent-to-agent access leaves it out, and session visibility is
  `agent` or `self`.

It then adds `clawops__*` to every other agent's `tools.deny`, checks the gateway kept those
entries, and only then installs.

**What lands on the host:**
- **Files.** A pinned Node runtime, checksum-verified on the host, and the operator's own
  clawops build, under `/opt/clawops-agent`. Configuration goes in `/etc/clawops-agent`, with
  the token root-only. State goes in `/var/lib/clawops-agent`.
- **The service.** `clawops-agent.service` listens only on the Docker bridge address, and the
  gateway reaches it as `host.docker.internal`.
- **Firewall.** A ufw rule is added where ufw is active, and `clawops harden` keeps it.

**Requests it leaves you.** A handoff is also recorded on the host, in case the agent drops the
message. `clawops status` reads them over SSH and prints them under the table, ready to copy:

```
prod has 1 request from its agent:
    clawops gateway restart --stack prod
Each one clears when you run it, or after 7 days.
```

A request clears when you run that exact command (secret values aside, which the request leaves
as `<value>`), from the CLI or through your own agent's tools. `status --json` and
`clawops_status` report them as `pendingHandoffs`. A host that cannot be asked gets a note
rather than silence, and `status` waits up to 10 seconds for it. The agent can write the file,
so it could forge a request; the banner shows the full command, so you still decide.

**If it starts refusing.** The host agent re-reads `openclaw.json` on every call and refuses
while any condition fails, for example after an agent is added without the deny, or a group is
bound to it. The refusal lists what to fix. It serves again once the configuration is fixed;
there is nothing to reinstall.

**Other agents in the gateway container.** On a default deployment every agent can run commands
and read files there, so it can read the host agent's token and transcripts. Install lists those
agents. Give them `tools.profile: "messaging"` or a `tools.allow` list, or install with
`--strict` to refuse while any remain.

**Fleet membership (2.5, in progress).** `--serve-peers <tag>` and `--peer <stack>=<tailnet
name>` make the host a fleet member ([ADR 0015](decisions/0015-host-agent-fleet.md),
[WO-67](fleet-plan.md)). Install refuses unless the host is on the tailnet and, for
`--serve-peers`, carries the tag; `--peer` also needs `--strict`. On a fleet member install
loads the nftables table `inet clawops_peer` and reads it back. The table keeps containers and
other users off port 18800 on the tailnet, and `clawops-peer-fw.service` loads it again at
every boot, before Docker. Install adds `nftables` if the host lacks it, and the `clawops-peer`
user. `agent uninstall` removes all of it. Nothing serves or queries peers yet: that is WO-67
parts C and D.

### Fleet status

```bash
clawops fleet status              # every stack in ~/.clawops/config.json
clawops fleet status --stack us,eu
```

Reads each stack's host over SSH, four at a time, and lists its host agent: whether one is
installed, whether its service runs, which OpenClaw agent it serves and whether it was installed
with `--strict`. On a fleet member it adds the tag it serves, its peers, whether the firewall
table is exactly the one install loaded, whether the boot unit will load it again, and the host's
tailnet state and name. Nothing on any host changes.

It then checks the hosts against each other, and reports each problem on the host that names the
peer: a peer with no host agent, one installed without `--serve-peers`, one that answers a tag the
caller does not carry, and one reached by a name it does not have on the tailnet. A peer that is
not in your config, or did not answer, is not judged.

A stack with nothing deployed, because it was never brought up or was torn down, is listed as
"not deployed" and is not a problem. A host that does not answer within 30 s, or whose state
backend cannot be read, is reported as unreachable, and the rest are still read.
Reading needs passwordless sudo for the SSH user, as install does. The command exits 1 when any
host has a problem or did not answer, so a script can tell. Agents get the same reading from
`clawops_stacks_list` with `fleet: true`; a host agent refuses it, since it reads only its own host.

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

Restarts the container using the currently running image tag. Config is preserved, the container
bind-mounts the state directory `/var/lib/clawops/openclaw`, so the config, the SQLite
database and any installed plugins all survive the restart. Before 2.0 nothing was mounted
and a restart discarded every session.

### Update the gateway

```bash
clawops gateway update                # the release this clawops recommends
clawops gateway update 2026.9.3       # a specific 2.x release
```

Moving tags (`latest`, `stable`, `dev`) are refused. The update pulls the image first, snapshots
the state database and asks the target release whether it understands it, then replaces the
gateway, waits for it to start, and puts the previous release back if it does not. See
[upgrade-rollback.md](upgrade-rollback.md#gateway-only-upgrade) for each step.

Expect ~60 seconds of downtime during the container swap. See
[`docs/upgrade-rollback.md`](upgrade-rollback.md) for the full upgrade procedure including
pre-upgrade checklist and rollback steps.

## SSH access

```bash
clawops ssh                           # open an interactive shell
clawops ssh --stack prod              # specific stack
```

Opens an SSH session to the remote host using the key and known_hosts path from
`~/.clawops/config.json`. The session uses the `ssh2` library directly, no `ssh` binary required.

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
directory**, never in place. `--activate` puts it into service: it swaps the state in (keeping the state it
replaces), restarts the gateway on it, and rolls back if the gateway does not answer.
See [backup-restore.md](backup-restore.md).

On the clawops 1.x line the command is unavailable, because `2026.7.1-2` has no restore
subcommand at all.

## Config management

```bash
clawops config get                    # show all config values
clawops config get ssh.keyPath        # specific key
clawops config set defaults.stack prod
clawops config unset defaults.stack
```

Config is stored at `~/.clawops/config.json`. Secrets are never stored in config, see
[`docs/security/redaction.md`](security/redaction.md).

## Routine maintenance

### Recommended backup schedule

Take a backup before any upgrade and on a regular schedule for production stacks:

```bash
# Daily cron: adjust path as needed
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
