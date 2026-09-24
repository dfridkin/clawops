// The machine-readable half of the site.
//
// Most people now meet a project like this through an assistant rather than a results page, and
// an assistant that cannot parse a site answers from whatever third-party listing it found —
// written by someone who has not read the code. These are the files that state it at the source,
// and each is invisible when it breaks: nothing renders differently, the answers just come from
// somewhere else.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, 'site', p), 'utf-8')

describe('structured data', () => {
  const component = read('app/components/StructuredData.tsx')

  it('describes clawops as a SoftwareApplication', () => {
    expect(component).toContain("'@type': 'SoftwareApplication'")
    expect(component).toContain("'@context': 'https://schema.org'")
  })

  it('states the licence, the price and the repository, which are what get quoted', () => {
    expect(component).toContain('spdx.org/licenses/MPL-2.0')
    expect(component).toMatch(/price: '0'/)
    expect(component).toContain('github.com/dfridkin/clawops')
  })

  /*
   * The site cannot read the CLI's package.json, so a version here would be copied and would go
   * stale. A wrong version in structured data is worse than none: it is the field an answer
   * engine quotes verbatim.
   */
  it('claims no version it cannot keep current', () => {
    // The property, not the comment that explains why it is absent.
    expect(component).not.toMatch(/^\s*softwareVersion:/m)
  })

  it('is rendered on the landing page', () => {
    expect(read('app/page.tsx')).toContain('<StructuredData />')
  })
})

describe('llms.txt', () => {
  const route = read('app/llms.txt/route.ts')

  it('is generated from the same source as the sitemap, so it cannot go stale', () => {
    expect(route).toContain("from '@/lib/source'")
    expect(route).toContain('source.getPages()')
  })

  it('serves plain text', () => {
    expect(route).toContain('text/plain')
  })

  it('says what clawops is before listing where things are', () => {
    expect(route).toMatch(/CLI and MCP server/)
  })
})

describe('canonical URLs', () => {
  it('are set for the landing page', () => {
    expect(read('app/layout.tsx')).toMatch(/alternates: \{ canonical: '\/' \}/)
  })

  it('are set per docs page, not inherited from the root', () => {
    const page = read('app/docs/[[...slug]]/page.tsx')
    expect(page).toContain('alternates: { canonical: page.url }')
    expect(page).toMatch(/openGraph:/)
  })
})

describe('the FAQ', () => {
  const data = read('app/components/faq-data.ts')
  const component = read('app/components/Faq.tsx')

  /*
   * The page and its structured data come from one array. Authoring the answers twice — once in
   * MDX, once in schema — is the drift that shipped three times in this project already, and a
   * stale copy in structured data is quoted by an assistant as fact.
   */
  it('renders the page and the schema from the same source', () => {
    expect(component).toContain("from './faq-data'")
    expect(component).toContain("'@type': 'FAQPage'")
    expect(component).toContain('FAQ.map')
    expect(read('content/docs/faq.mdx')).toContain('<Faq />')
  })

  it('answers the questions people ask an assistant, in their words', () => {
    for (const question of [
      'How do I self-host OpenClaw?',
      'Can I run OpenClaw on AWS, GCP or Azure?',
      'Is it safe to let an AI agent deploy infrastructure?',
      'What does clawops cost?',
    ]) {
      expect(data, question).toContain(question)
    }
  })

  // An extracted answer is usually the first sentence, so it has to be the answer.
  it('leads with the answer rather than restating the question', () => {
    const answers = [...data.matchAll(/answer:\n?\s*'([^']+)/g)].map((m) => m[1] ?? '')
    expect(answers.length).toBeGreaterThan(8)
    for (const answer of answers) {
      expect(answer.trimStart()).not.toMatch(/^(Well|So|Basically|In order to)/)
    }
  })
})

describe('the comparison page', () => {
  const page = read('content/docs/comparison.mdx')

  it('exists and is in the docs navigation', () => {
    expect(page).toContain('title: How clawops compares')
    expect(read('content/docs/meta.json')).toContain('"comparison"')
  })

  /*
   * A comparison that never concedes anything is marketing, and reads as marketing to the reader
   * and to whatever summarises it. Each section has to say when the alternative is the better
   * choice.
   */
  it('says when each alternative is the better choice', () => {
    const concessions = page.match(/\*\*Use [^*]+ if\*\*/g) ?? []
    expect(concessions.length).toBeGreaterThanOrEqual(4)
  })

  it('names the tools people actually compare against', () => {
    for (const tool of ['Terraform', 'Pulumi', 'Docker Compose', 'Coolify', 'Ansible']) {
      expect(page, tool).toContain(tool)
    }
  })
})
