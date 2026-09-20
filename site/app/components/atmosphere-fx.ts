/**
 * Pixelated atmosphere: drifting smoke behind the hero, and a dithered field bleeding in from
 * the edge of a section.
 *
 * Everything is drawn into an ImageData at one canvas pixel per CSS pixel and composited with
 * `image-rendering: pixelated`, so on a 2x display each one is a square 2x2 block. The quantiser
 * is the same ordered 4x4 Bayer matrix the hero shell uses for its hologram stipple, which is
 * what makes the two read as one piece rather than as a canvas effect next to a WebGL one.
 *
 * The aura is deliberately absent. The shell renders its own, and a second one behind it would
 * sit underneath the stipple as a halo the fixed ten-colour palette never produced.
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const dither = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

function hash(x: number, y: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

function fbm(x: number, y: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  for (let i = 0; i < 4; i++) {
    sum += amp * vnoise(x * freq, y * freq)
    freq *= 2
    amp *= 0.5
  }
  return sum / 0.9375
}

/*
 * The density field is smooth. The stipple must not be. Those are separate resolutions, and
 * evaluating both per pixel is what makes 1px blocks expensive: four octaves of fBm on every
 * one of roughly a million pixels a frame, measured at 43ms against a 83ms budget. So the fBm
 * runs on a coarse lattice and is bilinearly interpolated while the Bayer threshold still runs
 * at full resolution. The grain is identical; only the noise gets cheaper, by STRIDE squared.
 */
const STRIDE_FINE = 3
/*
 * The page field's base octave is 0.006 per pixel, a third of the smoke's, so its finest octave
 * still spans about 21 pixels and a coarser lattice samples it several times over. Halving the
 * lattice quarters the noise evaluations, which is what pays for running it at the shell's rate.
 */
const STRIDE_COARSE = 6

type Grid = { gw: number; gh: number; buf: Float32Array }
const grids = new Map<number, Grid>()

function gridFor(w: number, h: number, stride: number): Grid {
  const gw = Math.ceil(w / stride) + 2
  const gh = Math.ceil(h / stride) + 2
  const key = (gw * 65536 + gh) * 16 + stride
  let g = grids.get(key)
  if (!g) {
    g = { gw, gh, buf: new Float32Array(gw * gh) }
    grids.set(key, g)
  }
  return g
}

type Rgb = readonly [number, number, number]

/**
 * Fills the colour channels. The per-frame pass then writes only alpha, which is three of every
 * four byte writes saved on a full-viewport layer, and the colour is a token that changes about
 * as often as the theme does.
 */
export function primeRgb(data: Uint8ClampedArray, rgb: Rgb): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
  }
}

/** `steps` of 1 gives a one-bit stipple; above that the alpha terraces into that many levels. */
function stipple(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  alpha: number,
  steps: number,
  stride: number,
  densityAt: (x: number, y: number) => number,
): void {
  const g = gridFor(w, h, stride)
  const gw = g.gw
  const buf = g.buf
  for (let gy = 0; gy < g.gh; gy++) {
    for (let gx = 0; gx < gw; gx++) buf[gy * gw + gx] = densityAt(gx * stride, gy * stride)
  }

  for (let y = 0; y < h; y++) {
    const fy = y / stride
    const iy = fy | 0
    const ty = fy - iy
    const row = iy * gw
    for (let x = 0; x < w; x++) {
      const fx = x / stride
      const ix = fx | 0
      const tx = fx - ix
      const top = buf[row + ix] + (buf[row + ix + 1] - buf[row + ix]) * tx
      const bot = buf[row + gw + ix] + (buf[row + gw + ix + 1] - buf[row + gw + ix]) * tx
      const dens = top + (bot - top) * ty
      const bay = dither(x, y)
      data[(y * w + x) * 4 + 3] =
        steps === 1
          ? bay < dens
            ? alpha
            : 0
          : Math.round(Math.min(1, Math.floor(dens * steps + bay) / steps) * alpha)
    }
  }
}

/**
 * Smoke banks at the top of the hero and thins downward, terraced into four alpha steps so the
 * falloff breaks into visible bands rather than resolving into a smooth gradient.
 */
export function drawSmoke(data: Uint8ClampedArray, w: number, h: number, t: number): void {
  stipple(data, w, h, 235, 4, STRIDE_FINE, (x, y) => {
    const fall = Math.pow(Math.max(0, 1 - y / h), 1.9)
    const n = fbm(x * 0.01375, y * 0.01875 - t * 0.5)
    return Math.max(0, Math.min(1, (n * 1.5 - 0.56) * fall * 2.5))
  })
}

/**
 * The page's ambient field: one broad wash behind the whole dark part of the page rather than a
 * band per section.
 *
 * It is viewport-fixed, which is what makes it affordable. Sized to the document it would be
 * several million pixels to redraw every frame; sized to the viewport it is bounded by the
 * screen no matter how long the page grows, and an ambient field has no anchor in the content
 * that scrolling away would break.
 *
 * Thinnest through the middle, where the column of copy sits, so it never competes with text.
 */
export function drawField(data: Uint8ClampedArray, w: number, h: number, t: number): void {
  stipple(data, w, h, 190, 1, STRIDE_COARSE, (x, y) => {
    const nx = (x / w - 0.5) * 2
    const ny = (y / h - 0.5) * 2
    const vignette = Math.min(1, nx * nx * 0.62 + ny * ny * 0.3)
    const n = fbm(x * 0.006 + t * 0.3, y * 0.006 - t * 0.45)
    return (0.02 + 0.5 * n) * (0.18 + 0.95 * vignette)
  })
}

export type AtmosphereKind = 'smoke' | 'field'

type Layer = {
  el: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  kind: AtmosphereKind
  img: ImageData | null
  fx: Rgb
  visible: boolean
  last: number
  primed: boolean
}

/*
 * 1000/12, the rate the WebGL shell draws its own aura at, so every moving thing on the page
 * steps together. The field covers the whole viewport and is the expensive one; it affords this
 * rate by sampling its noise on a coarser lattice, not by drawing less often.
 */
const INTERVAL: Record<AtmosphereKind, number> = { smoke: 83, field: 83 }

const layers = new Set<Layer>()
let frame = 0

const FALLBACK_FX: Rgb = [13, 107, 107]

/** --fx is per-zone: the pinned chrome at the top of the page declares its own. */
function readFx(layer: Layer): void {
  const parts = getComputedStyle(layer.el)
    .getPropertyValue('--fx')
    .split(',')
    .map((n) => Number.parseFloat(n))
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    layer.fx = [parts[0], parts[1], parts[2]]
  }
}

function fit(layer: Layer): boolean {
  const r = layer.el.getBoundingClientRect()
  if (!r.width || !r.height) return false
  const w = Math.max(1, Math.round(r.width))
  const h = Math.max(1, Math.round(r.height))
  if (layer.el.width !== w || layer.el.height !== h) {
    layer.el.width = w
    layer.el.height = h
    layer.img = layer.ctx.createImageData(w, h)
    layer.primed = false
  }
  return true
}

function paint(layer: Layer, t: number): void {
  if (!fit(layer) || !layer.img) return
  const { data } = layer.img
  const { width: w, height: h } = layer.el
  if (!layer.primed) {
    primeRgb(data, layer.fx)
    layer.primed = true
  }
  if (layer.kind === 'smoke') drawSmoke(data, w, h, t)
  else drawField(data, w, h, t)
  layer.ctx.putImageData(layer.img, 0, 0)
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function tick(ts: number): void {
  frame = requestAnimationFrame(tick)
  for (const layer of layers) {
    if (!layer.visible || ts - layer.last < INTERVAL[layer.kind]) continue
    layer.last = ts
    paint(layer, ts / 1000)
  }
}

function ensureLoop(): void {
  if (!frame && !reduced()) frame = requestAnimationFrame(tick)
}

/**
 * Mounts one atmosphere layer. Layers share a single animation frame rather than each holding
 * their own, and a layer scrolled out of view stops being painted: the smoke leaves the screen
 * as soon as the hero does, and would otherwise cost a full redraw a frame for nothing.
 */
export function mountAtmosphere(el: HTMLCanvasElement, kind: AtmosphereKind): () => void {
  const ctx = el.getContext('2d')
  if (!ctx) return () => {}

  const layer: Layer = { el, ctx, kind, img: null, fx: FALLBACK_FX, visible: true, last: -Infinity, primed: false }
  readFx(layer)
  layers.add(layer)
  // A frame immediately, so the layer is never blank at rest or under reduced motion.
  paint(layer, 0)
  ensureLoop()

  const io = new IntersectionObserver(
    ([entry]) => {
      layer.visible = entry.isIntersecting
    },
    { rootMargin: '120px' },
  )
  io.observe(el)

  const scheme = matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => {
    readFx(layer)
    paint(layer, performance.now() / 1000)
  }
  const onResize = () => paint(layer, performance.now() / 1000)
  scheme.addEventListener('change', onScheme)
  addEventListener('resize', onResize)

  return () => {
    io.disconnect()
    scheme.removeEventListener('change', onScheme)
    removeEventListener('resize', onResize)
    layers.delete(layer)
    if (!layers.size && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }
}
