import type { MetadataRoute } from 'next'
import { source } from '@/lib/source'

const BASE = 'https://clawops.fyi'

/**
 * Sitemap covering the landing page and every docs page.
 *
 * Docs URLs come from the Fumadocs source rather than a hand-maintained list, so a
 * new page in `content/docs/` is indexed without anyone remembering to add it here.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()

  const docs = source.getPages().map((page) => ({
    url: `${BASE}${page.url}`,
    lastModified: now,
    changeFrequency: 'weekly' as const,
    // The docs index outranks individual pages; everything else is equal.
    priority: page.url === '/docs' ? 0.8 : 0.7,
  }))

  return [
    {
      url: BASE,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...docs,
  ]
}
