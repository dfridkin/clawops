import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { IBM_Plex_Sans, IBM_Plex_Mono, Silkscreen } from 'next/font/google'
import './globals.css'

const body = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
})

/*
 * The hero headline only. A bitmap face carries the period register where it is doing the
 * shouting; everywhere else the page stays on a readable grotesque, which is the call made
 * when the treatment was reviewed.
 */
const pixel = Silkscreen({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-pixel',
  display: 'swap',
})

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
})

const DESCRIPTION =
  'Deploy and manage self-hosted OpenClaw across AWS, GCP, Azure and local VMs. ' +
  'Reviewable plans, an embedded Pulumi engine, and typed MCP tools so coding agents can drive ' +
  'deployments deterministically.'

export const metadata: Metadata = {
  metadataBase: new URL('https://clawops.fyi'),
  title: {
    default: 'clawops — self-hosted OpenClaw, deployed properly',
    template: '%s · clawops',
  },
  description: DESCRIPTION,
  openGraph: {
    title: 'clawops — self-hosted OpenClaw, deployed properly',
    description: DESCRIPTION,
    url: 'https://clawops.fyi',
    siteName: 'clawops',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'clawops', description: DESCRIPTION },
  robots: { index: true, follow: true },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${mono.variable} ${pixel.variable}`}
      // Fumadocs' RootProvider (next-themes) writes `class` and `color-scheme` onto
      // <html> before React hydrates, so the server markup cannot match by design.
      // This is the documented fix, and it suppresses only this element's attributes
      // — mismatches in children are still reported.
      suppressHydrationWarning
      // globals.css sets `scroll-behavior: smooth`; Next needs this marker to disable
      // it during route transitions rather than animating a page change.
      data-scroll-behavior="smooth"
    >
      <body>
        {children}
        {/* Cookieless and aggregate-only — no personal data, so no consent banner.

            Both are client components that inject their script from a useEffect, so
            neither appears in server-rendered HTML. Verifying with `curl | grep` will
            always come up empty; check the client chunk, or the network tab for
            /_vercel/insights/script.js. Off Vercel that request 404s harmlessly. */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
