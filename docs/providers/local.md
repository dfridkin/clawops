# Local VM Provider

The local provider deploys OpenClaw onto an existing VM you already control — a home server,
a VPS, a bare-metal box, or any host you can reach via SSH. No cloud account required.

## Quick Start

```bash
# 1. Make sure you can SSH into the target host
ssh -i ~/.clawops/id_ed25519 user@192.0.2.10 echo ok

# 2. Initialize clawops for local
clawops init \
  --provider local \
  --host 192.0.2.10 \
  --ssh-user root \
  --ssh-key ~/.clawops/id_ed25519

# 3. Deploy (bootstrap + start OpenClaw)
clawops up
```

## How It Works

Unlike cloud providers, the local adapter does **not** use Pulumi or provision any cloud resources.
Instead it:

1. SSHs into the target host using `ssh2` (never `/usr/bin/ssh`)
2. Transfers and runs `bootstrap.sh` — an idempotent shell script that installs Docker (if absent),
   creates the `clawops` system user, writes the default `openclaw.json`, and starts the container
   via systemd
3. Stores stack state in `~/.clawops/state/` (local filesystem, not a cloud bucket)

Re-running `clawops up` is safe — the bootstrap script is idempotent.

## Credentials

There are no cloud credentials. The only credential is your SSH private key.

| Config key | Default | Notes |
|---|---|---|
| `ssh.keyPath` | `~/.clawops/id_ed25519` | Ed25519 recommended; RSA supported |
| `ssh.knownHostsPath` | `~/.clawops/known_hosts` | Created on first connect if absent |

```bash
# Generate a dedicated key pair for clawops
ssh-keygen -t ed25519 -f ~/.clawops/id_ed25519 -N ""

# Copy the public key to the target host
ssh-copy-id -i ~/.clawops/id_ed25519.pub user@192.0.2.10
```

### Per the credentials policy (R6)

The private key **path** is stored in `~/.clawops/config.json`. The key contents are never read
into memory outside of the SSH handshake and are never written to audit logs.

## Requirements

The target host must have:

- Linux (Ubuntu 22.04+ or Debian 12+ recommended)
- SSH server accessible from the machine running clawops
- Your SSH public key in `~/.ssh/authorized_keys` on the host
- Outbound internet access (to pull the OpenClaw Docker image)
- `curl` or `wget` available (used by the Docker install script)
- `systemd` (for the OpenClaw service unit)

clawops installs Docker automatically if it is not present.

## Resources Created

The bootstrap script provisions (all on the target host):

- **`clawops` system user** — unprivileged, added to the `docker` group
- **Docker** — installed via the official Docker apt repository if not present
- **OpenClaw container** — `ghcr.io/openclaw/openclaw:<version>`, started by systemd
- **systemd service unit** — `openclaw.service`, enabled and started on boot
- **`/home/clawops/openclaw.json`** — default gateway config (written only if absent)

## State Backend

- **URL pattern**: `file://~/.clawops/state`
- State is stored locally on the machine running clawops
- Back it up manually or via `clawops backup` before making destructive changes

## Instance Type Aliases

The local provider ignores instance type — the alias is accepted for API compatibility but has
no effect. Resources are whatever the host has.

## Region

`region` is always `local`. The `--region` flag is accepted but ignored.

## Firewall Model

The local provider does **not** configure any firewall rules. SSH and gateway port access is
controlled by:

- The OS firewall (`ufw`, `iptables`, `firewalld`) on the host — configure this yourself
- The OpenClaw gateway's built-in auth (`gateway.auth.mode`)

Recommended minimum:

```bash
# On the target host — allow SSH and gateway port from your IP only
ufw allow from <your-ip> to any port 22
ufw allow from <your-ip> to any port 18789
ufw enable
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `SSH key not readable` | `keyPath` points to wrong file | Check `~/.clawops/config.json → ssh.keyPath` |
| SSH timeout on `clawops up` | Host unreachable or firewall blocks port 22 | `ssh -i ~/.clawops/id_ed25519 user@host` to verify |
| `docker: command not found` after bootstrap | Docker install failed | Check `clawops logs --tail 50`; re-run `clawops up` |
| `openclaw.service` failed to start | Bad `openclaw.json` or port conflict | `clawops config validate`, check `clawops logs --tail 50` |
| State lost after re-init | `file://` state is local-only | Backup `~/.clawops/state/` before re-initializing |

```bash
clawops doctor                  # validates SSH key + known_hosts
clawops doctor --stack prod     # remote health (container, disk, log rotation)
clawops status                  # current stack state
clawops config validate         # check openclaw.json for schema errors
clawops logs --tail 100         # recent gateway logs
```

## Known Limitations

- No cloud-managed state — state lives only on the machine running clawops; losing it requires
  manual recovery from `clawops://stacks/<name>/last-run` or re-bootstrapping
- No automatic firewall configuration — you manage host firewall rules yourself
- No Elastic/static IP management — if the host's IP changes, update `~/.clawops/config.json`
  and re-run `clawops up`
- GPU support depends entirely on the host hardware and Docker runtime; not validated by clawops

## See Also

- `src/providers/local/` — adapter + bootstrap template
- `src/providers/local/bootstrap.sh.tmpl` — the idempotent setup script
- `docs/providers/matrix.md` — provider capability comparison
- `docs/backup-restore.md` — state backup procedures
