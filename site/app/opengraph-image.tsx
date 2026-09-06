import { ImageResponse } from 'next/og'

// The metadata declares a `summary_large_image` Twitter card. Without an image that
// renders as a broken card, so this generates one at build time.
export const alt = 'clawops — deploy and manage self-hosted OpenClaw'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0E141A',
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: '#161F27',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#4FB5AE',
              fontSize: 34,
              fontWeight: 700,
            }}
          >
            {'>'}
          </div>
          {/* Satori requires an explicit display on any element with >1 child, so the
              two-tone wordmark is a flex row of two spans rather than mixed content. */}
          <div
            style={{
              display: 'flex',
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: -0.5,
            }}
          >
            <span style={{ color: '#E4EAEE' }}>claw</span>
            <span style={{ color: '#4FB5AE' }}>ops</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div
            style={{
              fontSize: 68,
              color: '#E4EAEE',
              lineHeight: 1.1,
              letterSpacing: -2,
              maxWidth: 900,
            }}
          >
            Your agent, on your own infrastructure.
          </div>
          <div style={{ fontSize: 30, color: '#A6B4BF', maxWidth: 820, lineHeight: 1.4 }}>
            Self-hosted OpenClaw on AWS, GCP, Azure or any Linux box — with plans you read
            before they run.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 26,
            color: '#7E8E9B',
          }}
        >
          <span style={{ color: '#4FB5AE' }}>$</span>
          <span>npm install -g @clawops/cli</span>
        </div>
      </div>
    ),
    size,
  )
}
