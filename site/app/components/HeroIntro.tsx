'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ShellHero from './ShellHero'
import styles from './HeroIntro.module.css'

type Phase = 'intro' | 'leaving' | 'done'

/**
 * The shell opens the page, and the page opens when you click it.
 *
 * One canvas, two positions. During the intro the art is fixed and centred; entering measures
 * where it belongs in the hero column and animates it there, then hands it back to normal flow.
 * Rendering a second ShellHero for the intro would be simpler and would put two WebGL contexts
 * on the page, which mobile GPUs are not generous about.
 *
 * The intro is added by JavaScript on top of a page that is already complete. Nothing here
 * hides content from a crawler, a reader, or a browser where the script failed: if this
 * component never mounts, the page is the page.
 */
export default function HeroIntro() {
  const [phase, setPhase] = useState<Phase>('done')
  const art = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Anyone who asked for less motion, arrived at a section, or has already seen it today
    // gets the page directly. An intro that replays on every navigation is a toll, not a hello.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (window.location.hash) return
    try { if (sessionStorage.getItem('clawops-intro') === 'seen') return } catch { /* private mode */ }
    setPhase('intro')
  }, [])

  useEffect(() => {
    if (phase === 'intro') document.body.dataset['introActive'] = 'true'
    else delete document.body.dataset['introActive']
  }, [phase])

  const enter = useCallback(() => {
    if (phase !== 'intro') return
    try { sessionStorage.setItem('clawops-intro', 'seen') } catch { /* private mode */ }

    const node = art.current, target = slot.current
    if (!node || !target) { setPhase('done'); return }

    // Measure both, then move the fixed element onto the slot before releasing it into flow.
    const from = node.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    const scale = to.width / from.width
    node.style.transform =
      `translate(${to.left - from.left + (to.width - from.width) / 2}px, ` +
      `${to.top - from.top + (to.height - from.height) / 2}px) scale(${scale})`
    setPhase('leaving')
  }, [phase])

  useEffect(() => {
    if (phase !== 'leaving') return
    const node = art.current
    const finish = () => { if (node) node.style.transform = ''; setPhase('done') }
    const timer = setTimeout(finish, 900)
    node?.addEventListener('transitionend', finish, { once: true })
    return () => { clearTimeout(timer); node?.removeEventListener('transitionend', finish) }
  }, [phase])

  useEffect(() => {
    if (phase !== 'intro') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') enter() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [phase, enter])

  return (
    <>
      {phase !== 'done' && (
        <div
          className={styles.scrim}
          data-leaving={phase === 'leaving' ? 'true' : undefined}
          onClick={enter}
          aria-hidden="true"
        />
      )}
      <div ref={slot} className={styles.slot} aria-hidden={phase === 'done' ? undefined : 'true'} />
      <div
        ref={art}
        className={styles.art}
        data-phase={phase}
        onClickCapture={phase === 'intro' ? (e) => { e.stopPropagation(); enter() } : undefined}
      >
        <ShellHero />
        {phase === 'intro' && (
          <button type="button" className={styles.enter} onClick={enter}>
            Enter
          </button>
        )}
      </div>
    </>
  )
}
