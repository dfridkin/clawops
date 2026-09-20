'use client'

import { useEffect, useRef } from 'react'
import { mountShell } from './shell-pixel'
import styles from './ShellHero.module.css'

/**
 * The shell, and nothing else.
 *
 * There is no pause control. The shell's idle rotation is decorative and it is the only motion
 * in the hero, and anyone who has asked for less of it gets a still shell: every renderer path
 * checks prefers-reduced-motion, and the intro does not run at all under it.
 */
export default function ShellHero() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (canvas.current && trigger.current) {
      return mountShell(canvas.current, trigger.current)
    }
  }, [])
  return (
    <div className={styles.shell}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label="Reveal OpenClaw inside its compute, network, and storage shell"
        aria-expanded={false}
      >
        <canvas ref={canvas} className={styles.canvas} aria-hidden="true" width={520} height={520} />
      </button>
    </div>
  )
}
