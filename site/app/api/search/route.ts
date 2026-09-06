import { source } from '@/lib/source'
import { createFromSource } from 'fumadocs-core/search/server'

// Static index: the docs are prerendered, so search is served from a generated
// index rather than a running service.
export const { GET } = createFromSource(source)
export const revalidate = false
