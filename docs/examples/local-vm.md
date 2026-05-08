# Local VM / VPS Quickstart

This guide walks through deploying OpenClaw to any Linux host you can reach over SSH — a local VM
(UTM, VirtualBox, Multipass, Proxmox), a cheap VPS (Hetzner, DigitalOcean, Linode), or bare metal.
No cloud account required.

## Prerequisites

### On your local machine

- **Node.js 22+** — check with `node --version`; install via [nvm](https://github.com/nvm-sh/nvm)
- **clawops** — `npm install -g @clawops/cli`
- **An SSH key pair** — clawops will generate one for you if you don't have one, or use `--key-path` to bring your own

### On the target host

- **Ubuntu 22.04 or 24.04** (or Debian 12) — the bootstrap script uses `apt-get` and the Docker Ubuntu repository
- **`sudo` access** for your SSH user — bootstrap installs Docker and writes a systemd unit as root
- **Internet access** — the host needs to pull the OpenClaw Docker image from `ghcr.io`

### Firewall / inbound ports

Open these ports on the target host before running `clawops up`:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH (clawops transport) |
| 18789 | TCP | OpenClaw gateway (your client only; keep this off the public internet) |

For `ufw` (Ubuntu):
```bash
sudo ufw allow from YOUR_CLIENT_IP to any port 22 proto tcp
sudo ufw allow from YOUR_CLIENT_IP to any port 18789 proto tcp
sudo ufw --force enable
```

Do **not** open port 18789 to `0.0.0.0/0`. The gateway runs without TLS in v1 — scope it to
your IP or use `clawops tunnel` to access it over an SSH port-forward.

---

## Step-by-step

### 1. Check prerequisites

```bash
clawops doctor
```

Expected output: Node version ✓, config directory ✓, SSH key path (will be generated in step 2).

If `doctor` reports a missing provider credential — that's for cloud providers, not local. Ignore it
for a local deployment.

### 2. Configure clawops for your host

```bash
clawops init \
  --provider local \
  --host 192.168.1.50 \
  --ssh-user ubuntu \
  --ssh-port 22 \
  --key-path ~/.ssh/id_ed25519
```

If you don't have an SSH key yet, omit `--key-path` — clawops will generate one at
`~/.clawops/id_ed25519` and print the public key. Add it to `~/.ssh/authorized_keys` on the
target host before continuing.

`init` writes `~/.clawops/config.json` with your host's connection details. It does **not** test
connectivity yet — that happens in `doctor` (step 1) and `up` (step 3).

### 3. Verify SSH connectivity

```bash
clawops doctor
```

Re-run after `init` to confirm the SSH key is found and the config is valid. If `doctor` reports
an SSH error, fix connectivity before proceeding.

You can also test manually:
```bash
ssh -i ~/.clawops/id_ed25519 -p 22 ubuntu@192.168.1.50 "echo ok"
```

### 4. Bootstrap OpenClaw

```bash
clawops up
```

What happens:
1. clawops renders the bootstrap script with your chosen OpenClaw version.
2. Connects to the host over SSH.
3. Transfers the script (base64-encoded over SSH exec — no SCP required).
4. Runs it as root via `sudo bash`.
5. The script: creates a `clawops` system user, installs Docker, pulls the OpenClaw image, writes
   a default `openclaw.json`, and configures a systemd service unit.
6. Polls `http://192.168.1.50:18789/health` until the gateway is healthy (up to 120 seconds).

Expected output:
```
✓ Bootstrap complete
✓ Gateway healthy at http://192.168.1.50:18789
```

The bootstrap script is **idempotent** — safe to re-run if something fails partway through.

### 5. Verify the deployment

```bash
clawops status
```

Expected:
```
Stack:       default
Provider:    local
Host:        192.168.1.50
Gateway URL: http://192.168.1.50:18789
SSH user:    ubuntu
Provisioned: 2026-05-07T14:23:00.000Z
```

```bash
clawops logs --tail 20
```

You should see OpenClaw startup logs. If the gateway isn't responding, check the systemd unit:

```bash
clawops ssh --command "systemctl status openclaw"
```

---

## Accessing the gateway

**Option A — Direct access** (if you opened port 18789 to your IP):
```
http://192.168.1.50:18789
```

**Option B — SSH tunnel** (recommended; no firewall change needed):
```bash
clawops tunnel
# Forwards localhost:18789 → host:18789 over SSH
# Opens http://localhost:18789 in your browser
```

---

## Configure a model and channel

After deployment, OpenClaw runs with an empty config — no model or channel is active. Use
`clawops config set` to configure it remotely, or see [`docs/configuration.md`](../configuration.md)
for example configs and the full reference.

Minimal example — set a gateway auth token:
```bash
clawops config set gateway.auth.token "$(openssl rand -hex 32)"
clawops gateway restart
```

---

## Troubleshooting

### SSH connection refused

```
Error: ECONNREFUSED 192.168.1.50:22
```

- Is the host running?
- Is port 22 open in the host's firewall?
- Did you specify the right `--host` and `--ssh-port`?

Verify: `ssh -v -i ~/.clawops/id_ed25519 ubuntu@192.168.1.50`

### Authentication failure

```
Error: Authentication failed
```

- Is your public key in `~/.ssh/authorized_keys` on the host?
- Is the key path correct? Check: `cat ~/.clawops/id_ed25519.pub`
- Add to host: `ssh-copy-id -i ~/.clawops/id_ed25519.pub ubuntu@192.168.1.50`

### Host key mismatch

```
Error: Host key verification failed
```

The host's SSH fingerprint changed — likely a VM rebuild. Remove the stale entry:
```bash
ssh-keygen -R 192.168.1.50 -f ~/.clawops/known_hosts
```
Then re-run `clawops up` to re-establish TOFU (trust on first use).

### Bootstrap script failed

```
Error: Bootstrap script failed (exit 1): ...
```

- Does the SSH user have passwordless `sudo`? Check: `sudo -n true && echo ok`
- Is the host Debian/Ubuntu? The bootstrap script uses `apt-get` — it does not support RHEL, Alpine,
  or other distros in v1.
- Does the host have internet access to `ghcr.io`? Check: `curl -I https://ghcr.io`

The bootstrap is idempotent — fix the issue and re-run `clawops up`.

### Gateway not healthy after 120 seconds

```
Error: Gateway at http://192.168.1.50:18789/health did not become healthy within 120s
```

SSH in and check Docker:
```bash
clawops ssh --command "docker ps -a"
clawops ssh --command "journalctl -u openclaw -n 50"
```

Common causes: Docker image pull failed (no internet), port 18789 blocked by host firewall,
`openclaw.json` syntax error.

### `clawops up` on an already-bootstrapped host

`clawops up` is idempotent. Re-running it re-renders and re-executes the bootstrap script, which
will:
- Skip Docker installation if already installed
- Pull the OpenClaw image again (update if a newer tag is available)
- Overwrite the systemd unit (safe — picks up any template changes)
- Restart the OpenClaw service

It will **not** overwrite `openclaw.json` if it already exists on the host.

---

## Upgrading OpenClaw

To update to a newer OpenClaw version:

```bash
clawops up --openclaw-version 2026.4.6
```

This re-runs bootstrap with the new version tag, pulls the new image, and restarts the service.
Back up your config first:

```bash
clawops backup create --out /tmp/openclaw-backup-$(date +%Y%m%d).tar.gz
clawops up --openclaw-version 2026.4.6
```

---

## Clean up

To remove OpenClaw from the host and delete the local state record:

```bash
clawops down --yes
```

This removes the systemd unit and stops the container. It does **not** uninstall Docker or remove
the `clawops` user from the host — those require manual cleanup if desired.

---

## Next steps

- [Configure models and channels](../configuration.md)
- [Day-to-day operations](../operations.md)
- [Connect Claude Code via MCP](../../README.md#connect-claude-code)
- [Backup and restore](../backup-restore.md)
