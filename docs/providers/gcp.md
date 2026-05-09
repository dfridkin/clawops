# GCP Provider

## Quick Start

```bash
# 1. Configure credentials — pick one method:

# Option A: Application Default Credentials via gcloud (recommended for local dev)
gcloud auth application-default login

# Option B: Service account key file
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# Option C: Workload Identity / GCE metadata (automatic when running on GCP)
# No env var needed — detected automatically

# 2. Set your GCP project
export CLOUDSDK_CORE_PROJECT=my-project-id   # or: gcloud config set project my-project-id

# 3. Initialize clawops for GCP
clawops init --provider gcp --region us-central1 --state gs://my-bucket/clawops

# 4. Deploy
clawops up
```

## Credentials

clawops uses the GCP [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) chain:

| Source | How to configure | Notes |
|---|---|---|
| gcloud ADC | `gcloud auth application-default login` | Recommended for local dev |
| Service account key | `GOOGLE_APPLICATION_CREDENTIALS=/path/key.json` | CI / non-interactive |
| GCE instance metadata | *(auto-detected)* | When running on a GCP VM |
| `CLOUDSDK_AUTH_ACCESS_TOKEN` | Set directly | Short-lived; expires |

`clawops doctor` validates which credential path will be used before attempting a deploy.

### Per the credentials policy (R6)

Credentials NEVER appear in `~/.clawops/config.json`, CLI flags, MCP tool arguments,
or audit logs. Only a `credentialsRef: { source: "env", envVars: ["GOOGLE_APPLICATION_CREDENTIALS"] }`
reference is stored in config.

## Required IAM Permissions

Minimum permissions for `clawops up` / `clawops destroy` — bind these to a dedicated service account:

| API | Role / Permission | Notes |
|---|---|---|
| Compute Engine | `roles/compute.instanceAdmin.v1` | VM lifecycle |
| Compute Engine | `roles/compute.networkAdmin` | VPC, subnet, firewall, static IP |
| Cloud Storage | `roles/storage.objectAdmin` on state bucket | State backend |

Recommended: create a dedicated service account and grant only these roles in the target project.

```bash
gcloud iam service-accounts create clawops-deploy \
  --display-name "clawops deploy SA"

gcloud projects add-iam-policy-binding $PROJECT \
  --member serviceAccount:clawops-deploy@$PROJECT.iam.gserviceaccount.com \
  --role roles/compute.instanceAdmin.v1

gcloud projects add-iam-policy-binding $PROJECT \
  --member serviceAccount:clawops-deploy@$PROJECT.iam.gserviceaccount.com \
  --role roles/compute.networkAdmin
```

## Resources Created

When you run `clawops up`, the GCP adapter provisions:

- **VPC Network** — custom mode (`autoCreateSubnetworks: false`)
- **Subnetwork** — `10.0.0.0/24` in the configured region
- **Firewall rule** — ingress TCP on port 22 (SSH) and 18789 (gateway); tagged `clawops`
- **Static external IP** (regional)
- **Compute Engine VM** — Debian 12, tagged `clawops`, running OpenClaw via Docker
- Startup script creates a `clawops` system user and installs Docker if absent

The exact resource graph is visible via `clawops plan`.

## Instance Type Aliases

| Alias | Native Type | vCPU | Memory |
|---|---|---|---|
| `micro` | `e2-micro` | 2 (shared) | 1 GB |
| `small` | `e2-standard-2` | 2 | 8 GB |
| `medium` | `e2-standard-4` | 4 | 16 GB |
| `large` | `e2-standard-8` | 8 | 32 GB |
| `gpu` | `n1-standard-4` | 4 | 15 GB |

> GPU acceleration on `n1-standard-4` requires attaching an accelerator via `pulumi config set acceleratorType nvidia-tesla-t4`. This is not wired automatically in the current release — see `docs/limitations.md`.

## Region Defaults

- **Default**: `us-central1`
- **Zone**: `<region>-a` by default; override with `pulumi config set zone us-central1-b`
- **Override**: `clawops init --provider gcp --region europe-west1`

## State Backend

- **URL pattern**: `gs://<bucket>/clawops`
- **Bucket must exist** before first `clawops up`; clawops does not create it
- **Permissions**: the deploying identity needs `roles/storage.objectAdmin` on the bucket
- **Versioning**: enable bucket versioning for state history (`gsutil versioning set on gs://<bucket>`)

## Firewall Model

The current GCP adapter opens SSH (22) and gateway (18789) to `0.0.0.0/0` on the `clawops` network tag. Per-CIDR restriction is on the roadmap (tracked in `docs/limitations.md`).

In the interim, restrict access at the OS level using the OpenClaw gateway's auth mode:

```bash
# Lock gateway to token auth (default)
clawops config set gateway.auth.mode token
clawops config set gateway.auth.token "$(openssl rand -hex 32)" --restart
```

## OpenClaw Version Compatibility

See `spec/openclaw-versions.yaml`. No GCP-specific quirks in current releases.

## Cost Estimate

Approximate monthly cost (us-central1, always-on):

| Instance | On-Demand | Notes |
|---|---|---|
| `micro` (e2-micro) | ~$6/month | Free tier eligible (1 per account) |
| `small` (e2-standard-2) | ~$49/month | Recommended minimum |
| `medium` (e2-standard-4) | ~$97/month | |
| `large` (e2-standard-8) | ~$194/month | |

Plus static IP (~$7/month if instance is stopped), Cloud Storage state storage (< $1/month).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `No GCP credentials found` | No ADC, no key file, not on GCE | Run `gcloud auth application-default login` |
| `PERMISSION_DENIED` on compute | Missing IAM role | See [Required IAM](#required-iam-permissions) |
| `QUOTA_EXCEEDED` | Project quota | Request increase in Cloud Console |
| SSH timeout after deploy | Firewall not yet active / IP not propagated | Wait 30s and retry; check firewall rules in Cloud Console |
| `startup-script` failed | Docker install failed | Check `clawops logs --tail 100`; re-run `clawops up` (idempotent) |

```bash
clawops doctor               # validates credentials + config
clawops plan                 # preview resources before deploying
clawops status               # current stack state
clawops doctor --stack prod  # remote health (container, disk, log rotation)
```

## See Also

- `src/providers/gcp/` — adapter + Pulumi program
- `tests/providers/gcp/` — adapter + program tests
- `docs/providers/matrix.md` — provider capability comparison
- ADR 0004 — credential policy (R6)
