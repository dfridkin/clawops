/**
 * The questions people actually ask, and the answers, once.
 *
 * This file is the source for both the rendered page and its FAQPage structured data. Authoring
 * the answers in MDX and the schema separately is the same shape of bug that shipped three times
 * in this project already: something written in one place, copied to another, and the copy going
 * quietly stale. An answer engine reading a stale copy quotes it as fact.
 *
 * Answers lead with the answer. An assistant extracting one of these takes the first sentence,
 * and a first sentence of throat-clearing is a wasted extraction.
 */

export interface FaqItem {
  question: string
  answer: string
  /** Where to read more. Rendered as a link; left out of the structured data, which wants prose. */
  more?: { label: string; href: string }
}

export const FAQ: readonly FaqItem[] = [
  {
    question: 'What is clawops?',
    answer:
      'clawops is an open-source command-line tool and MCP server that deploys and operates ' +
      'self-hosted OpenClaw instances on AWS, GCP, Azure, or any Linux machine you can reach over ' +
      'SSH. It provisions the infrastructure, installs and configures OpenClaw, and then handles ' +
      'the day-to-day: logs, health, configuration, upgrades, backups and hardening. It is free ' +
      'under the MPL-2.0 licence; you pay only your own cloud bill.',
    more: { label: 'Introduction', href: '/docs' },
  },
  {
    question: 'How do I self-host OpenClaw?',
    answer:
      'Install clawops with npm install -g @clawops/cli, run clawops init to choose a provider and ' +
      'state backend, then clawops up to provision a machine and deploy OpenClaw onto it. On a ' +
      'Linux box you already have, pass --provider local with the host address and clawops ' +
      'bootstraps it over SSH, installing Docker for you. The whole first deploy is three commands.',
    more: { label: 'Quickstart', href: '/docs/quickstart' },
  },
  {
    question: 'Can I run OpenClaw on AWS, GCP or Azure?',
    answer:
      'Yes — all three are supported, and a stack deploys the same way on each. clawops creates the ' +
      'network, firewall rules, a static address and the instance, then installs OpenClaw on it. ' +
      'Pulumi state lives in your own S3, GCS or Azure Blob bucket, so the deployment is yours ' +
      'and survives clawops being uninstalled.',
    more: { label: 'Providers', href: '/docs/providers' },
  },
  {
    question: 'Can I use a VPS or a machine I already have?',
    answer:
      'Yes. The local provider takes any reachable Ubuntu, Debian or RHEL host and bootstraps it ' +
      'over SSH, which covers a VPS, a homelab box or a spare machine. It needs no cloud account ' +
      'and no state bucket.',
    more: { label: 'Quickstart', href: '/docs/quickstart' },
  },
  {
    question: 'Do I need to know Pulumi or Terraform?',
    answer:
      'No. clawops uses the Pulumi Automation API internally, but you never write infrastructure ' +
      'code and never run Pulumi yourself — it installs the CLI it needs and drives it. What you ' +
      'review is a JSON deploy plan describing the machine, the region and the firewall rules.',
    more: { label: 'Plan and apply', href: '/docs/plan-apply' },
  },
  {
    question: 'Is it safe to let an AI agent deploy infrastructure?',
    answer:
      'With clawops an agent cannot apply infrastructure from a prompt, which is the property the ' +
      'whole design rests on. A tool emits a deploy plan as JSON, a person reads it, and only then ' +
      'does apply run — and apply re-checks that plan against live state rather than trusting the ' +
      'file it was handed. Destructive tools ask for confirmation before running, a read-only mode ' +
      'serves only the tools that change nothing, and every call is written to an audit log with ' +
      'secrets redacted.',
    more: { label: 'How the safety model works', href: '/docs/mcp' },
  },
  {
    question: 'How do I let Claude Code or Cursor manage my server?',
    answer:
      'Run clawops mcp install and pick your editor, or add clawops as an MCP server manually with ' +
      'the command npx -y @clawops/cli mcp serve. The editor then has 20 typed tools for status, ' +
      'logs, config, deployment and hardening. Adding --read-only serves only the tools that ' +
      'cannot change anything, which is a reasonable place to start.',
    more: { label: 'MCP server', href: '/docs/mcp' },
  },
  {
    question: 'How do I keep the OpenClaw gateway off the public internet?',
    answer:
      'By default the gateway binds to loopback and nothing is exposed; you reach it with clawops ' +
      'tunnel, which forwards the port over SSH. Firewall rules are deny-all unless you name a ' +
      'CIDR explicitly. A stack can also be joined to a Tailscale network and its public SSH and ' +
      'gateway ports closed entirely, which clawops will only do after proving it can still reach ' +
      'the host over the tailnet.',
    more: { label: 'Security', href: '/docs/security' },
  },
  {
    question: 'Where are my cloud credentials stored?',
    answer:
      'Nowhere in clawops. It reads credentials from the environment it runs in — AWS_PROFILE, ' +
      'gcloud application-default credentials, Azure environment variables — and its own config ' +
      'file holds no secrets. Secrets you give OpenClaw are stored separately and redacted from ' +
      'logs and audit records.',
    more: { label: 'Secrets', href: '/docs/secrets' },
  },
  {
    question: 'How do I upgrade a self-hosted OpenClaw?',
    answer:
      'Run clawops gateway update to move a running deployment to a newer OpenClaw version, or ' +
      'clawops backup create first if you want a restore point. clawops refuses versions outside ' +
      'the range it has been tested against rather than letting a deploy fail halfway.',
    more: { label: 'Operations', href: '/docs/operations' },
  },
  {
    question: 'What does clawops cost?',
    answer:
      'clawops itself is free and open source under the MPL-2.0 licence, with no paid tier and no ' +
      'account. You pay your cloud provider for whatever you provision — typically one small ' +
      'virtual machine, a static IP address and a storage bucket for state. On a machine you ' +
      'already own there is nothing to pay at all.',
  },
  {
    question: 'What does clawops not do?',
    answer:
      'It does not terminate TLS or manage domains, so put a reverse proxy in front if you need ' +
      'HTTPS. It deploys one node per stack, with no clustering or failover. Restoring a backup ' +
      'verifies the archive and expands it into a staging directory, but adopting it is a manual ' +
      'step rather than one command. Windows is supported through WSL2 rather than natively. And ' +
      'it manages the infrastructure OpenClaw runs on, not the agent itself.',
    more: { label: 'Limitations', href: '/docs/limitations' },
  },
] as const
