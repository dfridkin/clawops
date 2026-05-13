# Local VM / VPS Quickstart

Deploy OpenClaw to an existing Linux or macOS machine you can reach by SSH.

## Prerequisites

- A Linux (Ubuntu/Debian, RHEL/Fedora, Alpine) or macOS machine with SSH access
- Docker installed and running on the target machine
  - macOS: Docker Desktop, or `brew install --cask docker`, or Colima
  - Ubuntu: installed automatically by the bootstrap script
- An SSH key pair (ed25519 recommended)
- `clawops` installed: `npm install -g @clawops/cli`

## Option A — Interactive wizard (recommended)

```
clawops setup
```

The wizard will ask:
1. Deployment type → **Local**
2. SSH host, port, user, key path
3. Stack name
4. LLM provider + model
5. Channel integrations (optional)

It writes an `openclaw-<stack>.json` config overlay and prints the exact `init` + `up` commands to run.

## Option B — Manual steps

### 1. Register the stack

```bash
clawops init \
  --provider local \
  --host <HOST_IP_OR_HOSTNAME> \
  --port 22 \
  --user ubuntu \
  --key ~/.ssh/id_ed25519 \
  --stack prod
```

### 2. Bootstrap the host and deploy

```bash
clawops up --stack prod
```

This runs the bootstrap script over SSH: installs Docker if missing, pulls the OpenClaw image, and starts the container as a service.

### 3. Apply a config overlay (LLM credentials, channels)

Write a JSON config overlay (or use one from `examples/configs/`):

```bash
clawops up --stack prod --config examples/configs/openclaw.openai.json
```

The overlay is deep-merged into `/home/clawops/openclaw.json` and the gateway is restarted.

### 4. Verify

```bash
clawops status --stack prod
clawops doctor --stack prod
```

## Useful day-2 commands

```bash
clawops logs -f --stack prod          # tail container logs
clawops ssh --stack prod              # interactive shell
clawops config get --stack prod       # read current openclaw.json
clawops config set --stack prod gateway.auth.mode token
clawops backup --stack prod           # snapshot openclaw.json
```

## macOS target notes

- Docker must already be running (Docker Desktop or Colima). The bootstrap script exits with clear instructions if it is not.
- OpenClaw runs as a `docker run -d` container (no systemd). Restart behaviour depends on Docker's `--restart unless-stopped` policy.
- Config lives at `~/.config/openclaw/config.json` on the SSH user's home directory.
