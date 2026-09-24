import { source } from '@/lib/source'

/**
 * /llms.txt — a plain-text map of this site for language models.
 *
 * The convention (llmstxt.org) is a single Markdown file an LLM crawler can read instead of
 * rendering the site: what this project is, and where each page lives. Search increasingly
 * happens through assistants rather than a results page, and an assistant that cannot parse a
 * site guesses from whatever it found elsewhere — which for a young project is a directory
 * listing someone else wrote.
 *
 * Generated from the same source as the sitemap, so a new page in content/docs/ appears here
 * without anyone remembering.
 */

const BASE = 'https://clawops.fyi'

export const dynamic = 'force-static'

export function GET(): Response {
  const pages = source.getPages()

  const body = [
    '# clawops',
    '',
    '> A CLI and MCP server that deploys and operates self-hosted OpenClaw instances on AWS, GCP,',
    '> Azure, or any Linux machine reachable over SSH. Infrastructure changes go through a deploy',
    '> plan a human reads before anything is applied — including when an AI agent is driving.',
    '',
    'clawops is open source (MPL-2.0), installed with `npm install -g @clawops/cli`, and needs',
    'your own cloud account: it reads credentials from the environment and never stores them.',
    '',
    '## Docs',
    '',
    ...pages.map((page) => {
      const description = page.data.description ? `: ${page.data.description}` : ''
      return `- [${page.data.title}](${BASE}${page.url})${description}`
    }),
    '',
    '## Elsewhere',
    '',
    '- [Source](https://github.com/dfridkin/clawops): the repository, issues, and release notes',
    '- [npm](https://www.npmjs.com/package/@clawops/cli): the published package',
    '- [MCP registry](https://registry.modelcontextprotocol.io): listed as io.github.dfridkin/clawops',
    '',
  ].join('\n')

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  })
}
