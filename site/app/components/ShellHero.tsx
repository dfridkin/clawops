'use client'

import { useEffect, useRef } from 'react'
import { mountShell } from './shell-pixel'
import styles from './ShellHero.module.css'

/**
 * The hover hint is gone and the pause control is not.
 *
 * mountShell needs all three elements, so the pause button has to exist whether or not it is
 * drawn. It also has to stay reachable: the shell rotates on its own indefinitely, and a page
 * with motion that never stops owes the reader a way to stop it. It is hidden the way a skip
 * link is, which is to say until someone tabs to it.
 */
export default function ShellHero() {
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
      <button ref={pause} type="button" className={styles.pause} aria-pressed={false}>
        Pause animation
      </button>
    </div>
  )
}
