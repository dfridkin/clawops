# CI Integration Guide

This guide covers running clawops deployments inside GitHub Actions workflows.

---

## Overview

CI deployments suit three patterns:

| Pattern | Trigger | Command |
|---|---|---|
| **Plan on PR** | PR opened / updated | `clawops plan --out plan.json` |
| **Apply on merge** | Push to main / release branch | `clawops apply plan.json --yes` |
| **Scheduled deploy** | `schedule:` cron | `clawops up --yes` |

The plan → apply split lets reviewers inspect the diff before infrastructure changes land. The plan artifact is uploaded as a workflow artifact and downloaded by the apply job.

---

## Prerequisites

1. **clawops installed** in the CI image. Either `npm install -g clawops` in a step or add it as a `devDependency`.
2. **Config file present.** Never use `clawops init` in CI — it is interactive. Write `~/.clawops/config.json` from environment variables instead (see [Writing config from env vars](#writing-config-from-env-vars)).
3. **SSH key pair.** Generate locally (`clawops init`), then store the private key in a repository secret. Restore it in CI.
4. **Cloud credentials.** Provided via OIDC (preferred) or long-lived secrets. See provider sections below.

---

## Writing config from env vars

`clawops init` is interactive and must not run in CI. Write the config file directly:

```yaml
- name: Write clawops config
  run: |
    mkdir -p ~/.clawops
    cat > ~/.clawops/config.json <<EOF
    {
      "version": 1,
      "defaults": { "provider": "${{ vars.CLAWOPS_PROVIDER }}", "stack": "default" },
      "stacks": {
        "default": {
          "provider": "${{ vars.CLAWOPS_PROVIDER }}",
          "region": "${{ vars.CLAWOPS_REGION }}",
          "stateUrl": "${{ vars.CLAWOPS_STATE_URL }}"
        }
      },
      "ssh": {
        "keyPath": "~/.clawops/id_ed25519",
        "knownHostsPath": "~/.clawops/known_hosts"
      }
    }
    EOF

- name: Restore SSH key
  run: |
    mkdir -p ~/.clawops
    echo "${{ secrets.CLAWOPS_SSH_PRIVATE_KEY }}" > ~/.clawops/id_ed25519
    chmod 600 ~/.clawops/id_ed25519
    echo "${{ secrets.CLAWOPS_KNOWN_HOSTS }}" > ~/.clawops/known_hosts
```

---

## GitHub Actions — AWS (OIDC)

OIDC is strongly preferred over long-lived `AWS_ACCESS_KEY_ID` secrets.

### 1. Trust policy

In your AWS account, create an OIDC provider for `token.actions.githubusercontent.com` and attach a role that trusts your repository:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<ACCOUNT>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:*"
    }
  }
}
```

### 2. Workflow

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write   # required for OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT>:role/clawops-deploy
          aws-region: ${{ vars.CLAWOPS_REGION }}

      - name: Install clawops
        run: npm install -g clawops

      - name: Write config + SSH key
        run: |
          # (same steps as shown in Prerequisites section)

      - name: Generate plan
        run: clawops plan --out /tmp/plan.json

      - name: Apply plan
        run: clawops apply /tmp/plan.json --yes
```

---

## GitHub Actions — GCP (Workload Identity Federation)

### 1. Create Workload Identity Pool

```bash
gcloud iam workload-identity-pools create "github" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc "github" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github" \
  --display-name="GitHub provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

Bind a service account:

```bash
gcloud iam service-accounts add-iam-policy-binding "clawops@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/<org>/<repo>"
```

### 2. Workflow

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: projects/${{ vars.GCP_PROJECT_NUMBER }}/locations/global/workloadIdentityPools/github/providers/github
      service_account: clawops@${{ vars.GCP_PROJECT_ID }}.iam.gserviceaccount.com

  - name: Install clawops
    run: npm install -g clawops

  # Write config, SSH key, then:
  - run: clawops apply /tmp/plan.json --yes
    env:
      GOOGLE_CLOUD_PROJECT: ${{ vars.GCP_PROJECT_ID }}
```

---

## Environment variables reference

### AWS

| Variable | Required | Notes |
|---|---|---|
| `AWS_PROFILE` | If not using OIDC | Local credentials profile |
| `AWS_ACCESS_KEY_ID` | If not using OIDC | Long-lived key (avoid if possible) |
| `AWS_SECRET_ACCESS_KEY` | If not using OIDC | Long-lived secret |
| `AWS_REGION` | Optional | Overrides config default |

OIDC via `configure-aws-credentials` sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` automatically.

### GCP

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | If not using WIF | Path to service account JSON |
| `GOOGLE_CLOUD_PROJECT` | Recommended | Avoids project-detection overhead |

`google-github-actions/auth` writes ADC automatically; clawops picks it up via the Pulumi GCP provider.

### Azure

| Variable | Required | Notes |
|---|---|---|
| `AZURE_CLIENT_ID` | Yes (OIDC or SP) | Application/client ID |
| `AZURE_TENANT_ID` | Yes | Azure AD tenant |
| `AZURE_SUBSCRIPTION_ID` | Yes | Target subscription |
| `AZURE_CLIENT_SECRET` | If not using OIDC | Service principal secret |
| `AZURE_FEDERATED_TOKEN_FILE` | If using OIDC | Set by `azure/login` action |

---

## Plan → apply in CI

For production deployments, generate the plan on PR, upload it as an artifact, and apply it after the PR merges.

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      # ... configure credentials, write config ...
      - run: clawops plan --out plan.json
      - uses: actions/upload-artifact@v4
        with:
          name: deploy-plan
          path: plan.json

  apply:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      # ... configure credentials, write config ...
      - uses: actions/download-artifact@v4
        with:
          name: deploy-plan
      - run: clawops apply plan.json --yes
```

Note: plans are generated at PR time and applied on merge. The plan's `metadata.generatedAt` timestamp is informational — `clawops apply` re-validates the plan schema but does not enforce a freshness TTL.

---

## Dry-run for CI validation

All mutating commands support `--dry-run`. Use it in branch checks to validate config without touching infrastructure:

```yaml
- run: clawops plan --out /tmp/plan.json
- run: clawops apply /tmp/plan.json --dry-run   # validates schema + prints diff, no apply
- run: clawops up --dry-run                     # pulumi preview only
```

`clawops doctor` is also useful as a preflight step:

```bash
clawops doctor   # checks Node version, config validity, SSH key, provider credentials
```

---

## Do not use `clawops init` in CI

`clawops init` is an interactive wizard. In CI:

- It prompts for provider selection, region, and state URL — there is no TTY.
- It generates an SSH key pair to disk — you should use a key stored in secrets.
- It writes `~/.clawops/config.json` — write this yourself (see [Writing config from env vars](#writing-config-from-env-vars)).

Per R6, **cloud credentials are never stored in `~/.clawops/config.json`**. Always provide them via environment variables or OIDC. The config file stores only non-secret settings: provider name, region, state URL, and SSH key path.
