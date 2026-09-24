import { OPENCLAW_SUPPORTED } from '../constants'

/**
 * Schema.org description of what this is, for the machines that answer questions about it.
 *
 * An answer engine asked "what is clawops" reads the page and infers. Left to infer, it gets the
 * licence, the price and the platforms from whatever third-party listing it found — and those
 * listings are written by people who have not read the code. This states them at the source.
 *
 * SoftwareApplication is the type that carries the fields those answers actually need: what it
 * costs (nothing), what it runs on, what licence it is under, and where the source is.
 */
/*
 * No softwareVersion. The site is its own package and cannot read the CLI's, so the number would
 * have to be copied here and would go stale on the next release — and a confidently wrong version
 * in structured data is worse than none, because it is exactly the field an answer engine quotes.
 */
export function StructuredData(): React.ReactElement {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'clawops',
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'Infrastructure deployment and operations',
    operatingSystem: 'macOS, Linux, Windows (WSL2)',
    url: 'https://clawops.fyi',
    downloadUrl: 'https://www.npmjs.com/package/@clawops/cli',
    codeRepository: 'https://github.com/dfridkin/clawops',
    license: 'https://spdx.org/licenses/MPL-2.0.html',
    description:
      'A CLI and MCP server that deploys and operates self-hosted OpenClaw instances on AWS, ' +
      'GCP, Azure, or any Linux machine reachable over SSH. Infrastructure changes go through a ' +
      'deploy plan a human reviews before anything is applied, including when an AI agent is ' +
      'driving it.',
    // Free, and said in the vocabulary a price comparison reads, so nobody has to infer it.
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    softwareRequirements: `Node.js 20 or newer; a cloud account for AWS, GCP or Azure, or a Linux host; OpenClaw ${OPENCLAW_SUPPORTED} or newer`,
    featureList: [
      'Provision OpenClaw on AWS, GCP, Azure or an existing Linux VM',
      'Reviewable JSON deploy plans applied only after a human reads them',
      'MCP server with 20 typed tools, a read-only mode and confirmation on destructive actions',
      'Day-two operations: logs, health, config validation, upgrades, backups and secrets',
      'Security hardening modules and per-cloud posture checks',
      'Private networking over Tailscale, including closing public ports entirely',
    ],
    author: { '@type': 'Person', name: 'Dmitriy Fridkin', url: 'https://github.com/dfridkin' },
    isAccessibleForFree: true,
  }

  return (
    <script
      type="application/ld+json"
      // The content is a literal this file builds; nothing here comes from user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}
