# Plan → Apply workflow

clawops uses a review-before-apply discipline for cloud provider deployments. This document explains
exactly what each step does, what guarantees it provides, and what it does not.

## Plan output

When you run `clawops plan`, the plan JSON is written to stdout (or `--out <path>`) and a human-readable summary is written to stderr:

```
Plan: prod-stack  (aws / us-east-1)
  Instance:  small
  OpenClaw:  latest
  SSH CIDRs: 203.0.113.5/32
  Gateway:   203.0.113.5/32

Changes: 1 to create, 0 to update, 0 to delete (1 total)
┌────┬──────────────────────────────┬────────┐
│ Op │ Resource Type                │ Name   │
├────┼──────────────────────────────┼────────┤
│ +  │ aws:ec2/instance:Instance    │ server │
└────┴──────────────────────────────┴────────┘

Plan written to /tmp/plan.json
```

The summary writes to stderr so that `--out`-less stdout JSON piping (`clawops plan | jq .diff`) remains clean.

## What `clawops plan` produces

`clawops plan` runs `pulumi preview` against your stack and wraps the result in a JSON artifact
that conforms to `spec/deploy-plan.schema.json`:

```json
{
  "apiVersion": "clawops.dev/v1",
  "kind": "DeployPlan",
  "metadata": {
    "name": "default",
    "generatedAt": "2026-05-07T14:23:00.000Z",
    "generator": "clawops",
    "generatorVersion": "1.0.0"
  },
  "spec": {
    "provider": "aws",
    "region": "us-east-1",
    "stackName": "default",
    "instanceType": "small",
    "openclaw": { "version": "latest" },
    "network": { "allowedSshCidrs": ["203.0.113.5/32"], "allowedGatewayCidrs": ["203.0.113.5/32"] }
  },
  "diff": {
    "create": [{ "urn": "...", "type": "aws:ec2/instance:Instance", "name": "server" }],
    "update": [],
    "delete": [],
    "totalChanges": 1
  }
}
```

The `diff` field is populated from `pulumi preview` output at plan-generation time. It is intended
for human review — you can inspect it to understand what will change before committing.

If the preview cannot run (missing credentials, no existing stack state), `plan` still succeeds and
emits the structural JSON without a `diff` field. `apply` will still work; it just cannot show you
the projected diff.

## What `clawops apply` does

`clawops apply <plan.json>`:

1. Reads and parses the plan file.
2. Validates it against `spec/deploy-plan.schema.json` (AJV). Exits with an error if invalid.
3. Sets Pulumi stack config from the plan's `spec` fields (`instanceType`, `region`, `openclawVersion`).
4. Calls `pulumi up` via the Pulumi Automation API.
5. Reports the actual result: outputs, change summary, duration.

**`apply` does not replay a locked, provider-level execution plan.** It re-runs infrastructure
reconciliation using the plan's parameters against the current live state. Pulumi will compute a
new diff at apply time and converge toward the desired state.

## What the plan guarantees

| Guarantee | What it means |
|---|---|
| Schema validity | The plan file is structurally valid and all required fields are present. |
| Intent capture | The parameters you reviewed (provider, region, instance type, CIDR ranges) are what `apply` uses. |
| No direct execution from natural language | Infrastructure changes always go through `generatePlan` → human review → `applyPlan`. |

## What the plan does not guarantee

| Not guaranteed | Why |
|---|---|
| Identical diff at apply time | Pulumi recomputes the diff against live state at apply time. If state changed since plan, the diff may differ. |
| Immutable execution artifact | There is no locked provider-level plan that `apply` replays (unlike `terraform apply <planfile>`). |
| Idempotent preview | A second `plan` run after unrelated cloud changes may show a different diff. |

## Drift between plan and apply

Drift can happen when:

- Another team member (or an agent) modified cloud resources between your `plan` and `apply`.
- You manually changed resources in the cloud console.
- Significant time passed between planning and applying.
- Your local clawops config changed between runs.

**Recommendation:** review and apply in the same session. If you are using plan files as CI
artifacts (see below), keep the plan-to-apply time short and check the diff table that `apply`
prints before confirming.

### Drift warning

`clawops plan` records the current Pulumi stack version in `metadata.stackVersion`. When you run
`clawops apply`, it checks this against the live stack version before executing. If they differ,
it prints a warning and prompts for confirmation:

```
Warning: stack "prod-stack" has changed since this plan was generated (plan version: 5, current: 7).
The diff you reviewed may no longer reflect what will be applied.

Stack has drifted. Continue anyway? (y/N)
```

To suppress the prompt in automation, pass `--yes`:

```bash
clawops apply /tmp/plan.json --yes   # skips both the confirmation and the drift prompt
```

The warning is non-blocking — you can proceed after confirming. It is a signal to re-run
`clawops plan` and review the new diff before applying if the change is unexpected.

New stacks (no prior deploys) have no version history; the drift check is skipped silently.

## Inspecting the plan JSON

```bash
# Show projected changes
cat /tmp/plan.json | jq .diff

# Count adds / updates / deletes
cat /tmp/plan.json | jq '.diff | {add: (.create | length), update: (.update | length), delete: (.delete | length)}'

# List resources that will be deleted (highest risk)
cat /tmp/plan.json | jq '.diff.delete[] | .type + " " + .name'

# Show plan metadata
cat /tmp/plan.json | jq .metadata
```

## Reviewing destructive changes

If `diff.delete` is non-empty, read the full resource list before confirming apply:

```bash
cat /tmp/plan.json | jq '.diff.delete'
```

`apply` prints the same diff table to stdout before prompting. If you see unexpected deletes, abort
(`Ctrl-C` or answer `N`) and investigate with `clawops status --json`.

## Safe automation pattern (CI)

```yaml
# CI job 1 — plan
- run: clawops plan --provider aws --stack $STACK --out $PLAN_PATH
- uses: actions/upload-artifact@v4
  with: { name: deploy-plan, path: $PLAN_PATH }

# CI job 2 — apply (requires manual approval gate in GitHub Actions)
- uses: actions/download-artifact@v4
  with: { name: deploy-plan }
- run: clawops apply $PLAN_PATH --yes
```

Use GitHub Actions [environment protection rules](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)
to require a human reviewer to approve job 2 before it runs. This gives you the review step even
in fully automated pipelines.

See [`docs/ci.md`](ci.md) for the full CI integration guide including OIDC credential setup.

## Local provider

`clawops plan` and `clawops apply` are not supported for the local provider. Use `clawops up`
directly — the local provider bootstraps over SSH without a Pulumi state backend.

```bash
# For local VMs:
clawops up --provider local   # no plan file needed
```

## Related commands

```bash
clawops plan --provider aws --stack default --out /tmp/plan.json
clawops plan --provider gcp --instance-type medium --out /tmp/plan.json

clawops apply /tmp/plan.json             # interactive confirm
clawops apply /tmp/plan.json --dry-run   # validate + show diff, no apply
clawops apply /tmp/plan.json --yes       # skip confirm (CI)
```
