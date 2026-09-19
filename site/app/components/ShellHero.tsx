'use client'

import { useEffect, useRef } from 'react'
import { mountShell } from './shell-pixel'
import styles from './ShellHero.module.css'

/**
 * `caption` carries the hover hint and the pause control. The intro hides it: on a bare screen
 * those are two more instructions competing with the one that matters.
 */
export default function ShellHero({ caption = true }: { caption?: boolean } = {}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pause = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (canvas.current && trigger.current && pause.current) {
      return mountShell(canvas.current, trigger.current, pause.current)
    }
  }, [])
  return (
    <div className={styles.shell}>
      <button ref={trigger} type="button" className={styles.trigger} aria-label="Reveal OpenClaw inside its compute, network, and storage shell" aria-expanded={false}>
        <canvas ref={canvas} className={styles.canvas} aria-hidden="true" width={520} height={520} />
      </button>
      {caption && <div className={styles.caption}>
        <span className={styles.hint}>Hover to explore · tap to open</span>
        <button ref={pause} type="button" className={styles.pause} aria-pressed={false}>Pause animation</button>
      </div>}
    </div>
  )
}
