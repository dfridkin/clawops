// Shared startup script factory for cloud provider VMs.
// All three providers (AWS, GCP, Azure) use this to ensure consistent
// Docker installation, user setup, and OpenClaw container launch.

import {
  gatewayRunCommand, STATE_DIR_HOST_LINUX, CONFIG_FILENAME, CONTAINER_UID,
} from '../openclaw/runtime.js'

export interface StartupScriptOpts {
  openclawVersion: string
  /** OS family — controls which Docker apt source is used. */
  os: 'ubuntu' | 'debian'
  /**
   * When true, injects AWS_DEFAULT_REGION into the docker run command using
   * an IMDSv2-compliant two-step curl. Only meaningful on AWS EC2.
   */
  bedrockEnabled?: boolean
  /**
   * Interface the gateway publishes on. Defaults to loopback.
   *
   * Deliberately NOT derived from `allowedGatewayCidrs`. The wizard populates that field
   * from the CIDR the user gave for SSH, so inferring exposure from it would open a
   * plaintext HTTP dashboard to whatever network someone chose for shell access. A
   * firewall rule says who may connect; this says whether the port listens at all.
   */
  publishGateway?: 'loopback' | 'all'
}

/**
 * Render an idempotent bash startup script that:
 *  1. Creates the 'clawops' OS user with a properly-owned ~/.ssh directory.
 *  2. Installs Docker CE (docker-ce, docker-ce-cli, containerd.io,
 *     docker-buildx-plugin, docker-compose-plugin) if not already present.
 *  3. Adds 'clawops' to the 'docker' group.
 *  4. Pulls the OpenClaw image.
 *  5. Writes a minimal default openclaw.json if absent.
 *  6. Starts the OpenClaw container (stopping any previous instance first).
 *
 * IMDSv2 note: when bedrockEnabled is true the AWS_DEFAULT_REGION env var is
 * resolved using the two-step IMDSv2 token flow (PUT → GET) so the script
 * works on instances with httpTokens=required.
 */
export function makeStartupScript(opts: StartupScriptOpts): string {
  const { openclawVersion, os, bedrockEnabled = false, publishGateway = 'loopback' } = opts
  const dockerDistro = os === 'ubuntu' ? 'ubuntu' : 'debian'
  const bedrockEnvBlock = bedrockEnabled ? makeBedrockEnvBlock() : ''

  return `#!/bin/bash
set -euo pipefail

# ── User setup ───────────────────────────────────────────────────────────────
id -u clawops &>/dev/null || useradd -m -s /bin/bash clawops
mkdir -p /home/clawops/.ssh
chmod 700 /home/clawops/.ssh
chown clawops:clawops /home/clawops/.ssh

# ── Docker installation ──────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/${dockerDistro}/gpg \\
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \\
    https://download.docker.com/linux/${dockerDistro} $(lsb_release -cs) stable" \\
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q \\
    docker-ce \\
    docker-ce-cli \\
    containerd.io \\
    docker-buildx-plugin \\
    docker-compose-plugin
  systemctl enable --now docker
fi

usermod -aG docker clawops

# ── OpenClaw image ───────────────────────────────────────────────────────────
OPENCLAW_VERSION="${openclawVersion}"
docker pull ghcr.io/openclaw/openclaw:\${OPENCLAW_VERSION}

# ── Gateway auth token ───────────────────────────────────────────────────────
# OpenClaw refuses a non-loopback bind without auth, and in a container it always
# binds 0.0.0.0. Without a token the gateway exits 78 and restart-loops.
OPENCLAW_ENV_FILE=/home/clawops/openclaw.env
if [ ! -s "\${OPENCLAW_ENV_FILE}" ]; then
  OPENCLAW_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')
  printf 'OPENCLAW_GATEWAY_TOKEN=%s\\n' "\${OPENCLAW_TOKEN}" > "\${OPENCLAW_ENV_FILE}"
  chmod 600 "\${OPENCLAW_ENV_FILE}"
  chown clawops:clawops "\${OPENCLAW_ENV_FILE}"
fi

# ── State directory ──────────────────────────────────────────────────────────
# One directory holds config, the SQLite state and any plugins installed below.
# Owned NUMERICALLY by the uid the container runs as: useradd clawops gets 1001 on
# Ubuntu 24.04 (the ubuntu user already holds 1000), and a 1001-owned state dir makes the
# gateway exit 1 with EACCES on its own SQLite WAL. There is no degraded mode.
OPENCLAW_STATE_DIR=${STATE_DIR_HOST_LINUX}
OPENCLAW_CONFIG="\${OPENCLAW_STATE_DIR}/${CONFIG_FILENAME}"
mkdir -p "\${OPENCLAW_STATE_DIR}"

# Migrate a pre-2.0 deployment: the config used to be a bare file in the service user's
# home. Without this an in-place upgrade comes up with no configuration at all. Guarded on
# the target being absent, so re-running provisioning never clobbers a later edit.
OPENCLAW_LEGACY_CONFIG=/home/clawops/openclaw.json
if [ -f "\${OPENCLAW_LEGACY_CONFIG}" ] && [ ! -f "\${OPENCLAW_CONFIG}" ]; then
  cp -p "\${OPENCLAW_LEGACY_CONFIG}" "\${OPENCLAW_CONFIG}"
  mv "\${OPENCLAW_LEGACY_CONFIG}" "\${OPENCLAW_LEGACY_CONFIG}.migrated"
  echo "clawops: migrated config from \${OPENCLAW_LEGACY_CONFIG}"
  OPENCLAW_MIGRATED=1
fi

# ── Default config (apply.ts will overwrite with plan overlay) ───────────────
if [ ! -f "\${OPENCLAW_CONFIG}" ]; then
  cat > "\${OPENCLAW_CONFIG}" <<'OPENCLAWJSON'
{"meta":{"lastTouchedVersion":"2026.9"},"gateway":{"mode":"local","port":18789,"auth":{"mode":"token"}},"models":{},"channels":{}}
OPENCLAWJSON
fi

# Numeric, and last, so it covers the config and anything migrated above.
chown -R ${CONTAINER_UID}:${CONTAINER_UID} "\${OPENCLAW_STATE_DIR}"

# A 1.x config has no gateway.mode, and clawops no longer passes --allow-unconfigured —
# so a migrated deployment would exit 78 with "existing config is missing gateway.mode".
# Normalised with OpenClaw's own tooling rather than by editing JSON in shell: it is
# schema-aware, writes atomically, and applies OpenClaw's internal config migrations at the
# same time. Runs after the chown so the container can write.
if [ "\${OPENCLAW_MIGRATED:-0}" = "1" ]; then
  docker run --rm -v "\${OPENCLAW_STATE_DIR}":/home/node/.openclaw \\
    ghcr.io/openclaw/openclaw:\${OPENCLAW_VERSION} \\
    openclaw config set gateway.mode local || \\
    echo "clawops: WARNING could not set gateway.mode; gateway may refuse to start" >&2
fi

# ── Start OpenClaw container ─────────────────────────────────────────────────
# Built by src/openclaw/runtime.ts, so this cannot drift from the restart paths.
${gatewayRunCommand({
  image: 'ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}',
  stateDir: '"${OPENCLAW_STATE_DIR}"',
  envFilePath: '"${OPENCLAW_ENV_FILE}"',
  extraArgs: bedrockEnvBlock.trim(),
  publish: publishGateway,
})}
`
}

/**
 * IMDSv2-compliant block that resolves AWS_DEFAULT_REGION at container start.
 * Uses the two-step token flow required when httpTokens=required on EC2.
 * The trailing backslash + newline is intentional (continues the docker run command).
 */
function makeBedrockEnvBlock(): string {
  return (
    '  -e AWS_DEFAULT_REGION=$( \\\n' +
    '      IMDS_TOKEN=$(curl -sf -X PUT \\\n' +
    '        "http://169.254.169.254/latest/api/token" \\\n' +
    '        -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && \\\n' +
    '      curl -sf \\\n' +
    '        -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" \\\n' +
    '        "http://169.254.169.254/latest/meta-data/placement/region" \\\n' +
    '      || echo us-east-1) \\\n'
  )
}
