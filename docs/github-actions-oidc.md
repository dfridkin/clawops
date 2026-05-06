# GitHub Actions OIDC Deploy

Deploy to AWS or Azure from GitHub Actions without long-lived credentials using
OpenID Connect (OIDC) / Workload Identity Federation.

## Why OIDC?

- No secrets in GitHub repository settings
- Tokens are short-lived (scoped to a single workflow run)
- Auditable via cloud provider IAM logs

## AWS — OIDC Setup

### 1. Create an IAM OIDC Identity Provider

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### 2. Create an IAM Role for GitHub Actions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
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
  ]
}
```

Attach the permissions from `docs/providers/aws.md#required-iam-permissions` to this role.

### 3. GitHub Actions Workflow

```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/clawops-deploy
          aws-region: us-east-1

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Deploy
        run: pnpx clawops up --stack production
        env:
          # accessMode=auto detects the GitHub Actions runner IP at deploy time
          PULUMI_CONFIG_PASSPHRASE: ${{ secrets.PULUMI_CONFIG_PASSPHRASE }}
```

The `aws-actions/configure-aws-credentials` action sets `AWS_ROLE_ARN` and
`AWS_WEB_IDENTITY_TOKEN_FILE` — exactly the env vars that clawops's `validateConfig()`
recognises as valid OIDC credentials.

For `accessMode=auto`, clawops fetches the runner's egress IP from
`https://checkip.amazonaws.com` and opens SSH + gateway ports only to that `/32`.

---

## Azure — OIDC / Federated Credentials Setup

### 1. Register an App in Entra ID (Azure AD)

```bash
az ad app create --display-name clawops-deploy
az ad sp create --id <app-object-id>
```

### 2. Add a Federated Credential

In the Azure Portal → Entra ID → App registrations → your app →
Certificates & secrets → Federated credentials → Add credential:

| Field | Value |
|---|---|
| Federated credential scenario | GitHub Actions deploying Azure resources |
| Organization | `<your-org>` |
| Repository | `<your-repo>` |
| Entity type | Branch |
| Branch | `main` |
| Name | `clawops-main` |

Or via CLI:

```bash
az ad app federated-credential create \
  --id <app-object-id> \
  --parameters '{
    "name": "clawops-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<org>/<repo>:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### 3. Assign RBAC Role

```bash
az role assignment create \
  --assignee <service-principal-object-id> \
  --role Contributor \
  --scope /subscriptions/<SUBSCRIPTION_ID>
```

### 4. GitHub Actions Workflow

```yaml
name: Deploy to Azure

on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Deploy
        run: pnpx clawops up --stack production
        env:
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_FEDERATED_TOKEN_FILE: $AZURE_FEDERATED_TOKEN_PATH
          PULUMI_CONFIG_PASSPHRASE: ${{ secrets.PULUMI_CONFIG_PASSPHRASE }}
```

`azure/login@v2` sets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and
`AZURE_FEDERATED_TOKEN_FILE` as environment variables that clawops reads for OIDC auth.

---

## Shared Best Practices

1. **Use `accessMode=auto`** for MCP-driven and CI deployments. clawops detects the
   runner's egress IP at deploy time and opens only that `/32` — no hardcoded CIDRs needed.

2. **Store `PULUMI_CONFIG_PASSPHRASE`** as a GitHub secret. This is the passphrase for the
   Pulumi stack config file (contains `sshPublicKey` and other non-secret stack values).

3. **Scope the OIDC trust to a branch**, not `repo:*`, to prevent pull requests from
   triggering deploys.

4. **Review `clawops plan` output** in CI before `clawops up` by adding a plan step that
   uploads the plan file as a build artifact.

## See Also

- `docs/providers/aws.md` — AWS provider docs
- `docs/providers/azure.md` — Azure provider docs
- `.github/workflows/example-oidc-deploy.yml` — example workflow
