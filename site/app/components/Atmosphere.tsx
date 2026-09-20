'use client'

import { useEffect, useRef } from 'react'
import { mountAtmosphere, type AtmosphereKind } from './atmosphere-fx'

/**
 * One pixelated atmosphere layer. Decorative, so it is hidden from assistive technology and
 * carries no focusable content; the copy it sits behind says everything it says.
 */
export default function Atmosphere({
  kind,
  flip = false,
  className,
}: {
  kind: AtmosphereKind
  flip?: boolean
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return mountAtmosphere(ref.current, kind, flip)
  }, [kind, flip])
  return <canvas ref={ref} className={className} aria-hidden="true" />
}
