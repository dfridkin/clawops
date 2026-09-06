import './docs.css'
import { RootProvider } from 'fumadocs-ui/provider/next'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { source } from '@/lib/source'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsLayout
        tree={source.pageTree}
        nav={{
          // The wordmark links home. Without an explicit title element Fumadocs shows
          // plain text that does not read as a way back to the site.
          title: (
            <span style={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
              claw<span style={{ color: 'var(--color-fd-primary)' }}>ops</span>
            </span>
          ),
          url: '/',
        }}
        githubUrl="https://github.com/dfridkin/clawops"
        links={[
          // An explicit link back to the marketing site: the wordmark alone is a
          // convention people miss, and there is otherwise no route out of /docs.
          { text: 'Home', url: '/', active: 'none' },
          { text: 'npm', url: 'https://www.npmjs.com/package/@clawops/cli', active: 'none' },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  )
}
