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
