import { ImageResponse } from 'next/og'
import { OPENCLAW_SUPPORTED } from './constants'

// The metadata declares a `summary_large_image` Twitter card. Without an image that renders as
// a broken card, so this generates one at build time.
export const alt =
  'clawops: self-hosted OpenClaw on AWS, GCP, Azure or any Linux box, with plans you read before they run'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/* The chrome zone's palette, pinned the same way the page pins it. */
const FACE = '#dde4e8'
const GROUND = '#f4f6f7'
const INK = '#141d24'
const INK_MID = '#465562'
const ACCENT = '#0d6b6b'
const WELL = '#ffffff'
const BEV_HI = '#ffffff'
const BEV_SH = '#aab5bc'
const BEV_DK = '#8a969d'
const EDGE = '#7d8990'
const SCREEN = '#0e141a'
const SCREEN_TEAL = '#4fb5ae'

/** Raised and sunken, drawn as four explicit sides: Satori does not take the 4-value shorthand. */
const raised = {
  borderTop: `2px solid ${BEV_HI}`,
  borderLeft: `2px solid ${BEV_HI}`,
  borderBottom: `2px solid ${BEV_DK}`,
  borderRight: `2px solid ${BEV_DK}`,
}
const sunken = {
  borderTop: `2px solid ${BEV_DK}`,
  borderLeft: `2px solid ${BEV_DK}`,
  borderBottom: `2px solid ${BEV_HI}`,
  borderRight: `2px solid ${BEV_HI}`,
}

/**
 * Satori renders from font binaries, and takes ttf/otf/woff but not woff2. Asking the Google
 * Fonts CSS API with an old user agent is what gets a ttf back rather than a woff2.
 *
 * A build should not fail because a font server had a bad minute, so this returns null on any
 * problem and the card falls back to the bundled sans. The layout and the palette carry the
 * alignment on their own; the bitmap face is the part that is nice to have.
 */
async function loadFont(family: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const api = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`
    const css = await fetch(api, { headers: { 'User-Agent': 'Mozilla/4.0' } }).then((r) => r.text())
    const url = /src:\s*url\(([^)]+)\)/.exec(css)?.[1]
    if (!url) return null
    return await fetch(url).then((r) => r.arrayBuffer())
  } catch {
    return null
  }
}

/*
 * The page's aura, rendered statically.
 *
 * Same construction: a radial density compared against an ordered 4x4 Bayer value, so what
 * varies across the field is how many cells light rather than how bright each one is. Three
 * bars of different heights read as a chart, which is the wrong thing entirely to say about an
 * infrastructure CLI; a dithered field says the same thing the hero says.
 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const AURA_CELLS = 15
const AURA_CELL_PX = 18

function Aura() {
  const mid = (AURA_CELLS - 1) / 2
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: AURA_CELLS }, (_, y) => (
        <div key={y} style={{ display: 'flex' }}>
          {Array.from({ length: AURA_CELLS }, (_, x) => {
            const dist = Math.sqrt((x - mid) ** 2 + (y - mid) ** 2) / (mid + 0.6)
            // Clamped above 1 so the core is solid and only the falloff dithers. The floor
            // drops cells whose density is under a sixteenth, which is the only place an
            // ordered matrix can still light one: without it the rim keeps stray specks.
            const density = Math.min(1, Math.pow(Math.max(0, 1 - dist), 1.1) * 1.45)
            const lit = density > 0.1 && (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 < density
            return (
              <div
                key={x}
                style={{
                  width: AURA_CELL_PX,
                  height: AURA_CELL_PX,
                  background: lit ? SCREEN_TEAL : SCREEN,
                }}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** One status-bar cell, the same sunken panel the page's footer is built from. */
function Cell({ children }: { children: string }) {
  return (
    <div
      style={{
        ...sunken,
        display: 'flex',
        padding: '6px 14px',
        fontFamily: 'Mono',
        fontSize: 19,
        color: INK,
      }}
    >
      {children}
    </div>
  )
}

export default async function OpengraphImage() {
  const [pixel, mono] = await Promise.all([
    loadFont('Silkscreen', 700),
    loadFont('IBM+Plex+Mono', 500),
  ])

  const fonts = [
    ...(pixel ? [{ name: 'Pixel', data: pixel, weight: 700 as const, style: 'normal' as const }] : []),
    ...(mono ? [{ name: 'Mono', data: mono, weight: 500 as const, style: 'normal' as const }] : []),
  ]
  // Without the bitmap face the headline still has to be legible, so it falls back to the mono.
  const headlineFamily = pixel ? 'Pixel' : mono ? 'Mono' : 'sans-serif'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: FACE,
          fontFamily: mono ? 'Mono' : 'sans-serif',
        }}
      >
        {/* The announcement strip, the page's one teal band. */}
        <div
          style={{
            display: 'flex',
            background: ACCENT,
            color: GROUND,
            padding: '14px 40px',
            fontSize: 21,
          }}
        >
          OpenClaw 2.0 support is live in clawops 2.0
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 56,
            padding: '0 56px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <div style={{ display: 'flex', fontSize: 26, marginBottom: 28 }}>
              <span style={{ color: INK }}>claw</span>
              <span style={{ color: ACCENT }}>ops</span>
            </div>

            <div
              style={{
                display: 'flex',
                fontFamily: headlineFamily,
                fontSize: 42,
                lineHeight: 1.34,
                color: INK,
                maxWidth: 620,
              }}
            >
              Your agent, on your own infrastructure.
            </div>

            <div
              style={{
                display: 'flex',
                fontSize: 23,
                lineHeight: 1.45,
                color: INK_MID,
                maxWidth: 600,
                marginTop: 26,
              }}
            >
              Self-hosted OpenClaw on AWS, GCP, Azure or any Linux box, with plans you read
              before they run.
            </div>

            {/* The install line, in the same sunken well the hero uses. */}
            <div
              style={{
                ...sunken,
                display: 'flex',
                background: WELL,
                padding: '14px 18px',
                marginTop: 34,
                fontSize: 22,
                color: INK,
              }}
            >
              <span style={{ color: EDGE, marginRight: 10 }}>$</span>
              <span>npm install -g @clawops/cli</span>
            </div>
          </div>

          {/*
            * The shell's screen: dark in both themes on the page, and inset into the chrome the
            * same way. The claw itself is the page's job; here it is the lit screen that reads.
            */}
          <div
            style={{
              ...sunken,
              width: 300,
              height: 300,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: SCREEN,
            }}
          >
            <Aura />
          </div>
        </div>

        {/* The status bar, cells and all. */}
        <div
          style={{
            ...raised,
            display: 'flex',
            gap: 4,
            padding: 4,
            margin: '0 0 0 0',
            background: FACE,
          }}
        >
          <Cell>@clawops/cli</Cell>
          <Cell>latest · legacy</Cell>
          <Cell>{`OpenClaw >= ${OPENCLAW_SUPPORTED}`}</Cell>
          <Cell>MPL-2.0</Cell>
          <div style={{ ...sunken, display: 'flex', flex: 1 }} />
          <Cell>clawops.fyi</Cell>
        </div>
      </div>
    ),
    { ...size, fonts },
  )
}
