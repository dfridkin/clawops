# Manual Smoke Testing Guide — Provider Integrations

This guide covers manual end-to-end verification of each provider adapter. Run these
checks before cutting a release or after a significant change to `src/providers/`,
`src/transport/`, or `src/plan/`.

Unit tests cover the logic; smoke tests cover the integration surface: cloud API
auth, real Pulumi execution, SSH reachability, and OpenClaw health.

---

## Prerequisites (all providers)

```bash
node --version    # must be >= 22
pnpm build        # build dist/ from current src/
pnpm dev doctor   # verify clawops sees a valid config
```

Run `clawops doctor` and confirm all sections pass (Runtime, Config, SSH, Credentials)
before starting any provider test.

---

## AWS

### Prerequisites

| Item | How to set up |
|---|---|
| AWS credentials | `AWS_PROFILE=<profile>` pointing to a profile in `~/.aws/credentials`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| IAM permissions | EC2 full, VPC full, IAM (CreateRole, AttachRolePolicy, CreateInstanceProfile, PassRole), Elastic IP |
| S3 state bucket | Must pre-exist. Example: `aws s3 mb s3://clawops-smoke-test --region us-east-1` |
| SSH key | `~/.clawops/id_ed25519` (created by `clawops init`) |

### Config (`~/.clawops/config.json` stacks entry)

```json
{
  "provider": "aws",
  "region": "us-east-1",
  "stateUrl": "s3://clawops-smoke-test"
}
```

### Test plan

**1. Validate credentials**
```bash
clawops doctor
# Expect: Credentials → ✓ AWS (profile: <name>)
```

**2. Dry-run preview (no resources created)**
```bash
clawops up --provider aws --dry-run
# Expect: prints resource diff table; exits 0; no EC2 instance created
```

**3. Provision**
```bash
clawops plan --provider aws --stack smoke --out /tmp/aws-plan.json
cat /tmp/aws-plan.json | jq .diff
# Review: VPC, Subnet, IGW, SG, IAM role+profile, EC2 instance (t3.micro), EIP
# All operations should be "create"

clawops apply /tmp/aws-plan.json --yes
# Expect: spinner shows "Provisioning…"; completes in ~2–3 min
# Stack outputs: publicIp, gatewayUrl, sshUser=ubuntu, region
```

**4. Status**
```bash
clawops status --stack smoke
# Expect: table with publicIp (non-empty), gatewayUrl https://..., region us-east-1

clawops status --stack smoke --json | jq .publicIp
```

**5. SSH connectivity**
```bash
clawops ssh --stack smoke --command "docker ps"
# Expect: openclaw container running (status Up)

clawops ssh --stack smoke --command "systemctl status docker"
# Expect: active (running)
```

**6. OpenClaw health**
```bash
IP=$(clawops status --stack smoke --json | jq -r .publicIp)
curl -s "https://$IP:18789/health"
# Note: self-signed cert; use -k if needed
# Expect: {"status":"ok"} or similar health JSON
```

**7. Log streaming**
```bash
clawops logs --stack smoke --tail 20
# Expect: last 20 lines of OpenClaw container logs

# Ctrl-C after a few seconds:
clawops logs --stack smoke -f
```

**8. Remote config**
```bash
clawops config get maxAgents --stack smoke
clawops config set maxAgents 4 --stack smoke
clawops config get maxAgents --stack smoke
# Expect: 4

# Dry-run:
clawops config set maxAgents 8 --stack smoke --dry-run
# Expect: prints "Would write:" JSON; does not apply
```

**9. Agents**
```bash
clawops agents --stack smoke
# Expect: table listing running agents (or "no agents running")
```

**10. Tunnel**
```bash
clawops tunnel --stack smoke --local-port 18789
# In another terminal: curl -s http://localhost:18789/health
# Expect: health response; Ctrl-C to close tunnel
```

**11. Plan → dry-run apply**
```bash
# Re-run plan (no-op since stack already up)
clawops plan --provider aws --stack smoke --out /tmp/aws-plan2.json
clawops apply /tmp/aws-plan2.json --dry-run
# Expect: prints diff (likely 0 changes); exits 0; no apply
```

**12. Destroy**
```bash
clawops destroy --stack smoke --dry-run
# Expect: shows current outputs table; prints "Would destroy…"; no destroy

clawops destroy --stack smoke --yes
# Expect: all resources deleted; exits 0
# Verify: aws ec2 describe-instances shows instance terminated
```

### Known quirks

- **Bedrock**: If `bedrockEnabled=true` is set in config, the IAM role gains
  `AmazonBedrockReadOnly` and `/etc/openclaw.env` contains `AWS_PROFILE=default`.
  Verify with `clawops ssh --command "cat /etc/openclaw.env"`.
- **AMI region lock**: The Ubuntu 22.04 AMI (`ami-*`) is region-specific. If you
  test in a non-`us-east-1` region, confirm the AMI resolves (Pulumi will error
  with "InvalidAMIID" if not).
- **State bucket region**: S3 bucket must be in the same region as the stack to
  avoid cross-region latency issues with Pulumi state writes.

---

## GCP

### Prerequisites

| Item | How to set up |
|---|---|
| GCP credentials | `gcloud auth application-default login` (sets `~/.config/gcloud/application_default_credentials.json`) or `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` |
| GCP permissions | Compute Engine Admin, Service Account Admin, Storage Admin |
| GCS state bucket | Must pre-exist: `gsutil mb -l us-central1 gs://clawops-smoke-test` |
| Project | `GOOGLE_CLOUD_PROJECT=<project-id>` or set in `gcloud config` |

### Config

```json
{
  "provider": "gcp",
  "region": "us-central1",
  "stateUrl": "gs://clawops-smoke-test"
}
```

### Test plan

**1. Validate credentials**
```bash
clawops doctor
# Expect: Credentials → ✓ GCP (application-default credentials found)
```

**2. Provision**
```bash
clawops plan --provider gcp --stack smoke-gcp --out /tmp/gcp-plan.json
# Review: Network, Subnet, Firewall rule, Static IP, VM (e2-micro, Debian 12)

clawops apply /tmp/gcp-plan.json --yes
# Expect: completes in ~2–4 min
# Stack outputs: publicIp, gatewayUrl, sshUser=clawops
```

**3. SSH + Docker**
```bash
clawops ssh --stack smoke-gcp --command "docker ps"
# Expect: openclaw container running

clawops ssh --stack smoke-gcp --command "docker logs openclaw --tail 10"
```

**4. OpenClaw health**
```bash
IP=$(clawops status --stack smoke-gcp --json | jq -r .publicIp)
curl -sk "https://$IP:18789/health"
```

**5. Logs + config (same as AWS steps 7–9)**

**6. Destroy**
```bash
clawops destroy --stack smoke-gcp --yes
# Verify: gcloud compute instances list shows no clawops instances
```

### Known quirks

- **Firewall is open by default**: GCP provider does not yet implement `accessMode`.
  The firewall rule allows `0.0.0.0/0` on ports 22 and 18789. This is a known gap
  (see `src/providers/gcp/program.ts`). Restrict at the VPC firewall level manually
  for production.
- **GPU instances**: `n1-standard-4` alias is mapped but accelerator config is not
  implemented (TODO). Do not smoke-test the `gpu` alias on GCP.
- **Zone suffix**: Zone defaults to `<region>-a`. If that zone has insufficient capacity,
  set `zone` explicitly in the stack config.

---

## Azure

### Prerequisites

| Item | How to set up |
|---|---|
| Azure credentials | `az login` (interactive) or service principal: `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` + `AZURE_CLIENT_SECRET` |
| Azure permissions | Contributor on the subscription, or: VM Contributor + Network Contributor + Key Vault Contributor |
| Azure Blob state container | Must pre-exist. Create storage account + container: `az storage container create -n clawops-state --account-name <account>` |
| Subscription | `AZURE_SUBSCRIPTION_ID=<sub-id>` |

### Config

```json
{
  "provider": "azure",
  "region": "eastus",
  "stateUrl": "azblob://clawops-state"
}
```

### Test plan

**1. Validate credentials**
```bash
clawops doctor
# Expect: Credentials → ✓ Azure (service principal / az login)
```

**2. Provision**
```bash
clawops plan --provider azure --stack smoke-az --out /tmp/az-plan.json
# Review: Resource Group, VNet, Subnet, NSG, Public IP, NIC, VM (Standard_B1s, Ubuntu 22.04)
# NSG should show restricted ingress (no 0.0.0.0/0 by default)

clawops apply /tmp/az-plan.json --yes
# Note: Azure VM provisioning takes ~3–5 min
# Stack outputs: publicIp, gatewayUrl, sshUser=clawops
```

**3. Verify NSG (accessMode=restricted)**

With the default `accessMode: restricted`, the NSG allows no inbound SSH unless
`allowedCidrs` is set. To allow your IP for smoke testing:

```bash
# Add your IP to allowedCidrs in config before running plan:
clawops config set accessMode auto --stack smoke-az
# (or set accessMode: "auto" in ~/.clawops/config.json stacks entry)
# Then re-plan and apply; the NSG rule will use your detected egress IP
```

**4. SSH + Docker**
```bash
clawops ssh --stack smoke-az --command "docker ps"
# Expect: openclaw container running

clawops ssh --stack smoke-az --command "systemctl status openclaw"
# Note: Azure uses Docker directly (not systemd service); may show "not found"
```

**5. OpenClaw health**
```bash
IP=$(clawops status --stack smoke-az --json | jq -r .publicIp)
curl -sk "https://$IP:18789/health"
```

**6. Key Vault (optional)**

If `keyVaultEnabled=true` in the stack config:
```bash
clawops apply /tmp/az-plan.json --yes
# Expect: Key Vault resource in diff; placeholder secret "gateway-token"
clawops ssh --stack smoke-az --command "cat /etc/openclaw.env"
# Expect: OPENCLAW_KEY_VAULT_URL=https://<vault>.vault.azure.net/
```

**7. Logs, config, agents (same as AWS steps 7–9)**

**8. Destroy**
```bash
clawops destroy --stack smoke-az --yes
# Verify: az resource list --resource-group clawops-smoke-az returns empty
```

### Known quirks

- **Static IP assignment delay**: Azure public IPs take ~30 seconds after VM creation.
  If `clawops status` shows no IP immediately after apply, wait and retry.
- **Key Vault naming**: Name is derived from `clawops-<stackName>-kv` truncated to
  24 characters. Stack names longer than ~15 characters will collide. Use short stack
  names for smoke tests.
- **Resource Group naming**: Default is `clawops-<stackName>`. Override with
  `resourceGroupName` in the stack config if needed.

---

## Local VM

### Prerequisites

| Item | How to set up |
|---|---|
| Target host | Any Linux machine reachable via SSH (Ubuntu/Debian recommended) |
| SSH access | Key-based auth; `sudo` without password for the SSH user |
| Docker | Not required pre-installed; bootstrap script installs it |
| Port access | TCP 22 (SSH) and 18789 (OpenClaw gateway) reachable from your machine |

### Config

```json
{
  "stacks": {
    "local-smoke": {
      "provider": "local",
      "localOpts": {
        "host": "192.168.1.100",
        "sshPort": 22,
        "sshUser": "ubuntu",
        "sshKeyPath": "~/.clawops/id_ed25519"
      },
      "stateUrl": "file://~/.clawops/state"
    }
  }
}
```

### Test plan

**1. Validate SSH connectivity**
```bash
clawops doctor
# Expect: SSH key → ✓ readable; config valid

# Manual SSH test:
ssh -i ~/.clawops/id_ed25519 ubuntu@192.168.1.100 "echo ok"
# Expect: ok
```

**2. Bootstrap (up)**
```bash
clawops up --stack local-smoke
# Bootstrap delivers script over SSH and runs it with sudo
# Watch output: Docker install, clawops user creation, openclaw container start
# Expect: "Bootstrap complete"; health poll succeeds within 120s
```

**3. Status**
```bash
clawops status --stack local-smoke
# Expect: host=192.168.1.100, gatewayUrl=http://192.168.1.100:18789
# Note: HTTP (not HTTPS) for local provider
```

**4. OpenClaw health**
```bash
curl -s http://192.168.1.100:18789/health
# Expect: {"status":"ok"}
```

**5. SSH command**
```bash
clawops ssh --stack local-smoke --command "docker ps"
# Expect: openclaw container running

clawops ssh --stack local-smoke --command "id clawops"
# Expect: uid=... (clawops user exists)
```

**6. Bootstrap idempotency**
```bash
clawops up --stack local-smoke
# Re-run bootstrap on already-provisioned host
# Expect: script runs again; docker re-installed skipped (already present);
#         openclaw container restarted or already running; health check passes
```

**7. Logs + config (same as cloud steps)**

**8. Down (not destroy)**
```bash
clawops down --stack local-smoke --dry-run
# Expect: shows current outputs; prints "Would destroy local stack"; no action

clawops down --stack local-smoke --yes
# Removes local state file; does NOT touch the remote host
# Verify: ~/.clawops/state/local-smoke.json deleted
```

**9. Verify destroy is blocked**
```bash
clawops destroy --stack local-smoke --yes
# Expect: UsageError — "local provider does not support destroy; use clawops down"
```

### Known quirks

- **`sudo` requirement**: The bootstrap script runs as the SSH user and calls `sudo`
  for Docker install, user creation, and systemd. The SSH user must have passwordless
  `sudo` or `sudo` within `NOPASSWD` for the specific commands.
- **Health timeout**: Bootstrap polls `http://<host>:18789/health` for up to 120
  seconds. On slow machines (e.g., Raspberry Pi), increase this or pass `--no-wait`
  and check manually.
- **No Pulumi state**: Local provider uses `file://~/.clawops/state`. State is local
  to your machine; if you switch machines, re-run `clawops up` to re-bootstrap.
- **OpenClaw image pull**: First bootstrap takes longer (pulls Docker image from ghcr.io).
  Subsequent bootstraps are faster since Docker caches layers.

---

## MCP Server Smoke Test

After verifying a provider, smoke-test the MCP surface:

```bash
# Start stdio server in background:
clawops mcp serve &
MCP_PID=$!

# Use the MCP inspector or any MCP client to:
#   1. Call clawops_status (read toolset) — verify stack outputs returned
#   2. Call clawops_logs_tail (read toolset, lines: 5) — verify log lines returned
#   3. Call clawops_config_get (read toolset, key: "maxAgents") — verify value
#   4. Call clawops_plan (cli toolset) — verify plan JSON returned
#   5. Call clawops_destroy (cli toolset, without yes: true) — verify elicitation prompt

kill $MCP_PID

# HTTP mode:
clawops mcp serve --http --port 3333 --bind 127.0.0.1 &
curl -s http://127.0.0.1:3333/   # should return MCP endpoint info
kill %1
```

Key things to verify:
- No output to stdout in stdio mode (only to stderr) — any stdout breaks the protocol
- Tool results are ≤ 8KB (Pulumi output trimmed)
- Destructive tools (`clawops_destroy`) require `yes: true` or return an elicitation prompt

---

## Checklist summary

| Test | AWS | GCP | Azure | Local |
|---|---|---|---|---|
| `doctor` credentials | ✓ | ✓ | ✓ | ✓ |
| `plan` dry-run | ✓ | ✓ | ✓ | n/a |
| `up` / `apply` | ✓ | ✓ | ✓ | ✓ |
| `status` outputs | ✓ | ✓ | ✓ | ✓ |
| SSH `docker ps` | ✓ | ✓ | ✓ | ✓ |
| Gateway `/health` | ✓ | ✓ | ✓ | ✓ |
| `logs --tail` | ✓ | ✓ | ✓ | ✓ |
| `config get/set` | ✓ | ✓ | ✓ | ✓ |
| `tunnel` | ✓ | ✓ | ✓ | n/a |
| `destroy` / `down` | ✓ | ✓ | ✓ | ✓ |
| `destroy` blocked on local | — | — | — | ✓ |
