import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Nothing to hide — the search index route is generated output, not content,
      // and indexing it wastes crawl budget on JSON.
      disallow: '/api/',
    },
    sitemap: 'https://clawops.fyi/sitemap.xml',
    host: 'https://clawops.fyi',
  }
}
