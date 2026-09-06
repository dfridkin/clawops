import type { Metadata } from 'next'
import { Newsreader, Public_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const display = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-display',
  display: 'swap',
})

const body = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
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
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      // Fumadocs' RootProvider (next-themes) writes `class` and `color-scheme` onto
      // <html> before React hydrates, so the server markup cannot match by design.
      // This is the documented fix, and it suppresses only this element's attributes
      // — mismatches in children are still reported.
      suppressHydrationWarning
      // globals.css sets `scroll-behavior: smooth`; Next needs this marker to disable
      // it during route transitions rather than animating a page change.
      data-scroll-behavior="smooth"
    >
      <body>{children}</body>
    </html>
  )
}
