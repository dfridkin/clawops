'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ShellHero from './ShellHero'
import styles from './HeroIntro.module.css'

/**
 * intro     waiting, shell idle, one line of text
 * revealing tapped: the shell opens and draws the claw, and we let it finish
 * leaving   the sweep is complete; the art flies to its column and the page comes up
 */
type Phase = 'intro' | 'revealing' | 'leaving' | 'done'

/** Long enough for a slow device to finish the sweep, short enough not to strand anyone. */
const SWEEP_TIMEOUT = 6000

/**
 * The shell introduces the page, and the page opens when the shell has finished opening.
 *
 * One canvas, two positions. During the intro the art is fixed and centred; when the reveal has
 * played all the way through, entering measures where the art belongs in the hero column and
 * animates it there before handing it back to normal flow. Rendering a second ShellHero would
 * be simpler and would put two WebGL contexts on the page, which mobile GPUs are not generous
 * about.
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
    // Anyone who asked for less motion, arrived at a section, or has already seen it this
    // session gets the page directly. An intro that replays on every navigation is a toll.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (window.location.hash) return
    try { if (sessionStorage.getItem('clawops-intro') === 'seen') return } catch { /* private mode */ }
    setPhase('intro')
  }, [])

  useEffect(() => {
    if (phase === 'intro' || phase === 'revealing') document.body.dataset['introActive'] = 'true'
    else delete document.body.dataset['introActive']
  }, [phase])

  /** Tap starts the reveal. It does not cut it short. */
  const beginReveal = useCallback(() => {
    if (phase !== 'intro') return
    try { sessionStorage.setItem('clawops-intro', 'seen') } catch { /* private mode */ }
    // A programmatic click arrives with detail 0, which is the path the renderer treats as a
    // deliberate toggle rather than a hover.
    art.current?.querySelector('button')?.click()
    setPhase('revealing')
  }, [phase])

  /* Wait for the whole sweep: panels out, then the claw drawn. The renderer reports both. */
  useEffect(() => {
    if (phase !== 'revealing') return
    const trigger = art.current?.querySelector('button')
    if (!trigger) { setPhase('leaving'); return }

    const done = () => trigger.dataset['state'] === 'open' && trigger.dataset['reveal'] === 'complete'
    if (done()) { setPhase('leaving'); return }

    const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); setPhase('leaving') } })
    observer.observe(trigger, { attributes: true, attributeFilter: ['data-state', 'data-reveal'] })
    // A device that never finishes the sweep should still let the visitor in.
    const bail = setTimeout(() => { observer.disconnect(); setPhase('leaving') }, SWEEP_TIMEOUT)
    return () => { observer.disconnect(); clearTimeout(bail) }
  }, [phase])

  /* The art flies from the middle of the screen to the place it occupies in the hero. */
  useEffect(() => {
    if (phase !== 'leaving') return
    const node = art.current, target = slot.current
    if (!node || !target) { setPhase('done'); return }

    const from = node.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    node.style.transform =
      `translate(${to.left - from.left + (to.width - from.width) / 2}px, ` +
      `${to.top - from.top + (to.height - from.height) / 2}px) scale(${to.width / from.width})`

    const finish = () => { node.style.transform = ''; setPhase('done') }
    const timer = setTimeout(finish, 900)
    node.addEventListener('transitionend', finish, { once: true })
    return () => { clearTimeout(timer); node.removeEventListener('transitionend', finish) }
  }, [phase])

  useEffect(() => {
    if (phase !== 'intro') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') beginReveal() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [phase, beginReveal])

  return (
    <>
      {phase !== 'done' && (
        // One element across all three phases: remounting it would restart the fade from
        // scratch instead of transitioning it.
        <div
          className={styles.scrim}
          data-leaving={phase === 'leaving' ? 'true' : undefined}
          onClick={beginReveal}
          aria-hidden="true"
        />
      )}
      <div ref={slot} className={styles.slot} aria-hidden={phase === 'done' ? undefined : 'true'} />
      <div
        ref={art}
        className={styles.art}
        data-phase={phase}
        onClickCapture={phase === 'intro' ? (e) => { e.stopPropagation(); beginReveal() } : undefined}
      >
        <ShellHero caption={phase === 'done'} />
        {phase === 'intro' && (
          <button type="button" className={styles.enter} onClick={beginReveal}>
            Tap to enter
          </button>
        )}
      </div>
    </>
  )
}
