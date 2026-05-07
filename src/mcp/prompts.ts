// MCP prompts — per SPEC.md §7.3.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerPrompts(server: McpServer): void {
  // ── deploy-to-aws ───────────────────────────────────────────────────────────
  server.registerPrompt(
    'deploy-to-aws',
    {
      description: 'Step-by-step guide to deploy OpenClaw on AWS',
      argsSchema: {
        region: { type: 'string', description: 'AWS region (e.g. us-east-1)', required: false },
        instanceType: { type: 'string', description: 'EC2 instance type (e.g. t3.medium)', required: false },
      },
    },
    ({ region, instanceType }) => {
      const r = region ?? 'us-east-1'
      const it = instanceType ?? 't3.medium'
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# Deploy OpenClaw on AWS

Follow these steps to provision an OpenClaw instance on AWS in region **${r}** using instance type **${it}**.

## Prerequisites

1. AWS CLI configured: \`aws configure\` or set \`AWS_PROFILE\`.
2. clawops installed: \`npm install -g clawops\`.
3. SSH key pair available locally.

## Steps

### 1. Initialise a stack
\`\`\`
clawops init --provider aws --region ${r} --stack my-stack
\`\`\`

### 2. Preview the deployment (dry run)
\`\`\`
clawops up --stack my-stack --dry-run
\`\`\`
Review the resource plan — it will show EC2 instance, security groups, and IAM role.

### 3. Deploy
Use the MCP tool \`clawops_up\` or the CLI:
\`\`\`
clawops up --stack my-stack
\`\`\`
Or via MCP:
\`\`\`
clawops_up({ stackName: "my-stack", provider: "aws", region: "${r}", instanceType: "${it}" })
\`\`\`

### 4. Verify
\`\`\`
clawops status --stack my-stack
\`\`\`
Confirm \`status: running\` and note the public IP.

### 5. Connect
The stack outputs a \`gatewayUrl\` — open it in your browser to reach the OpenClaw gateway.

## Troubleshooting

- Use \`clawops_workflow_recover\` to collect diagnostic information.
- Logs: \`clawops logs --stack my-stack --tail 100\`
- If deployment fails mid-way, re-run \`clawops up\` — Pulumi is idempotent.
`,
            },
          },
        ],
      }
    },
  )

  // ── recover-failed-stack ────────────────────────────────────────────────────
  server.registerPrompt(
    'recover-failed-stack',
    {
      description: 'Diagnostic playbook for a failed or unhealthy clawops stack',
      argsSchema: {
        stackName: { type: 'string', description: 'Stack name to diagnose', required: false },
      },
    },
    ({ stackName }) => {
      const s = stackName ?? 'default'
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# Recover Failed Stack: ${s}

## Step 1 — Gather diagnostics
Run the recovery workflow:
\`\`\`
clawops_workflow_recover({ stackName: "${s}" })
\`\`\`
This returns current status + last 50 log lines.

## Step 2 — Common failure modes

### Gateway not responding
\`\`\`
clawops_gateway_restart({ stackName: "${s}" })
\`\`\`

### Agents not running
\`\`\`
clawops_agents_list({ stackName: "${s}" })
clawops_agents_restart({ stackName: "${s}" })
\`\`\`

### Bootstrap failed or incomplete
Re-run (Pulumi is idempotent):
\`\`\`
clawops_up({ stackName: "${s}", provider: "aws" })
\`\`\`

### Pulumi state drift
From the CLI:
\`\`\`
clawops refresh --stack ${s}
\`\`\`

### Stack never deployed
\`\`\`
clawops_workflow_deploy_app({ stackName: "${s}", provider: "aws" })
\`\`\`

## Step 3 — Review last run output

Read the full Pulumi output:
\`\`\`
clawops://stacks/${s}/last-run
\`\`\`

## Step 4 — Escalation

If none of the above resolves the issue:
1. Check AWS/GCP/Azure console for resource state.
2. Look for IAM permission errors in logs.
3. Verify SSH key is present and matches the deployed instance.
`,
            },
          },
        ],
      }
    },
  )
}
