# Provider Capability Matrix

This matrix shows which operations and features are supported for each provider. It reflects the
current implementation — not aspirational claims.

**Legend:** ✓ supported · Partial = limited support · Planned = tracked in roadmap · — = not applicable or not supported

## Core lifecycle

| Capability | AWS | GCP | Azure | Local VM |
|---|---|---|---|---|
| Provision (`clawops up` / `clawops apply`) | ✓ | ✓ | ✓ | ✓ (SSH bootstrap) |
| Destroy (`clawops destroy` / `clawops down`) | ✓ | ✓ | ✓ | ✓ |
| Idempotent re-apply | ✓ | ✓ | ✓ | ✓ |
| `clawops plan` / `clawops apply` | ✓ | ✓ | ✓ | — (use `clawops up`) |
| `--dry-run` preview | ✓ | ✓ | ✓ | ✓ |

## Networking

| Capability | AWS | GCP | Azure | Local VM |
|---|---|---|---|---|
| Static / persistent public IP | ✓ (EIP) | ✓ (`compute.Address`) | ✓ (Public IP resource) | — (host has fixed IP) |
| Firewall / security group | ✓ (Security Group, deny-all default) | ✓ (Firewall rule, deny-all default) | ✓ (NSG, deny-all default) | — (manage on host) |
| SSH port CIDR restriction | ✓ | ✓ | ✓ | — |
| Gateway port CIDR restriction | ✓ | ✓ | ✓ | — |
| TLS termination | Planned | Planned | Planned | Planned |
| Tailscale integration | Planned | Planned | Planned | Planned |

## Day-to-day operations

| Capability | AWS | GCP | Azure | Local VM |
|---|---|---|---|---|
| `clawops status` | ✓ | ✓ | ✓ | ✓ |
| `clawops logs` / `logs -f` | ✓ | ✓ | ✓ | ✓ |
| `clawops ssh` | ✓ | ✓ | ✓ | ✓ |
| `clawops tunnel` | ✓ | ✓ | ✓ | ✓ |
| `clawops config get/set` | ✓ | ✓ | ✓ | ✓ |
| `clawops agents list/restart` | ✓ | ✓ | ✓ | ✓ |
| `clawops gateway restart` | ✓ | ✓ | ✓ | ✓ |
| `clawops backup create` | ✓ | ✓ | ✓ | ✓ |
| `clawops backup restore` | ✓ | ✓ | ✓ | ✓ |
| `clawops doctor` | ✓ | ✓ | ✓ | ✓ |

## Secrets and credentials

| Capability | AWS | GCP | Azure | Local VM |
|---|---|---|---|---|
| Credential source | `AWS_PROFILE` / AWS credential chain | `GOOGLE_APPLICATION_CREDENTIALS` / gcloud ADC | `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` / `az login` | SSH key via config |
| Gateway token storage | Partial (IAM policy enables SSM access; token not managed by Pulumi) | — | ✓ (Key Vault secret) | — |
| Secret store integration | Partial | — | ✓ | — |
| Credentials stored in clawops config | — | — | — | — |

The `—` row for credentials-in-config is intentional: no provider stores credentials in
`~/.clawops/config.json`. This is a design invariant (R6).

## State backend

| Provider | State backend | Format |
|---|---|---|
| AWS | `s3://bucket/clawops` | Pulumi JSON state in S3 |
| GCP | `gs://bucket/clawops` | Pulumi JSON state in GCS |
| Azure | `azblob://container/clawops` | Pulumi JSON state in Azure Blob |
| Local VM | `file://~/.clawops/state/<stack>.json` | Local JSON file |

The local provider's file-based state is not replicated or backed up automatically. For resilience,
back up `~/.clawops/state/` alongside your stack backups.

## Observability

| Capability | AWS | GCP | Azure | Local VM |
|---|---|---|---|---|
| Log streaming (docker logs) | ✓ | ✓ | ✓ | ✓ |
| Health check (container status) | ✓ | ✓ | ✓ | ✓ |
| Deeper health checks (disk, memory, gateway endpoint) | Planned | Planned | Planned | Planned |
| Monitoring hooks (Prometheus, alerts) | Planned | Planned | Planned | Planned |
| Cost estimate output | Planned | Planned | Planned | — |

## Provider-specific notes

### AWS

- Elastic IP is always allocated — the public IP is stable across instance stops and restarts.
- IAM instance profile gives the VM SSM-ready permissions, but the gateway token is currently
  configured via bootstrap script rather than being managed as an SSM Parameter.
- Bedrock model provider requires `AWS_PROFILE` in the systemd `EnvironmentFile` (not
  `auth: "aws-sdk"` in openclaw.json) on OpenClaw 2026.4.5+. The adapter handles both for
  compatibility. See `spec/openclaw-versions.yaml`.

### GCP

- Uses `gcp.compute.Address` (regional static external IP), not a global IP — ensure the address
  and VM are in the same region.
- No built-in secret management in the current implementation. The gateway token is set via the
  bootstrap script.

### Azure

- NSG rules are deny-all by default. SSH and gateway port rules require explicit allowed CIDRs in
  the deploy plan.
- Key Vault is provisioned with the stack and stores the gateway token as a secret. Access is
  granted to the VM's Managed Identity.
- Azure's Public IP resource may take a few seconds to propagate after provisioning — `clawops
  status` will retry until the IP is available.

### Local VM

- No cloud infrastructure is provisioned. clawops SSHes to the target host and runs an idempotent
  bootstrap script (installs Docker, Node.js 22, OpenClaw, configures systemd unit).
- The host must be reachable over SSH and have `sudo` access for the bootstrap user.
- No firewall rules are managed by clawops — configure host-level rules (`ufw`, `firewalld`) before
  running `clawops up`.
- State is a local JSON file. The host's OpenClaw state is separate from clawops's record of the
  deployment.

## Supported instance types

Each provider maps the abstract size aliases to native instance types:

| Alias | AWS | GCP | Azure | Local VM |
|---|---|---|---|---|
| `micro` | `t3.micro` | `e2-micro` | `Standard_B1s` | — |
| `small` | `t3.small` | `e2-standard-2` | `Standard_B2s` | — |
| `medium` | `t3.medium` | `e2-standard-4` | `Standard_B4ms` | — |
| `large` | `t3.large` | `e2-standard-8` | `Standard_B8ms` | — |
| `gpu` | `g4dn.xlarge` | `n1-standard-4` + T4 | `Standard_NC6s_v3` | — |

For Local VM, instance type is determined by the host hardware — the `--instance-type` flag is
ignored.
