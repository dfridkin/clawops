/** Small orthographic renderer: real spherical panels, with no WebGL/runtime dependency. */
type Vec = [number, number, number]
type Point = [number, number]
type Panel = { lat: [number, number]; lon: [number, number]; offset: Vec; turn: number; lean: number; pivot: Vec }
type Paint = { z: number; draw: () => void }
const TAU = Math.PI * 2
const RADIUS = 137
const clamp = (n: number) => Math.max(0, Math.min(1, n))
const ease = (n: number) => n * n * (3 - 2 * n)
const wrap = (n: number) => Math.atan2(Math.sin(n), Math.cos(n))
const sphere = (lat: number, lon: number, radius = RADIUS): Vec => [
  radius * Math.cos(lat) * Math.sin(lon), radius * Math.cos(lat) * Math.cos(lon), radius * Math.sin(lat),
]
const yaw = ([x, y, z]: Vec, angle: number): Vec => [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)]
const pitch = ([x, y, z]: Vec, angle: number): Vec => [x, y * Math.cos(angle) - z * Math.sin(angle), y * Math.sin(angle) + z * Math.cos(angle)]

export function mountShell(canvas: HTMLCanvasElement, trigger: HTMLButtonElement, pause: HTMLButtonElement) {
  const context = canvas.getContext('2d')
  if (!context) return () => {}
  const ctx = context
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const abort = new AbortController()
  const options = { signal: abort.signal }
  let angle = -0.45, opening = 0, hovered = false, focused = false, pinned = false
  let paused = false, visible = true, disposed = false, frame = 0, previous = 0
  let size = 500, pixelRatio = 1, ink = '', ground = '', accent = ''
  let wasActive = false
  const active = () => hovered || focused || pinned
  const readColors = () => {
    const css = getComputedStyle(canvas)
    const probe = document.createElement('span'); canvas.parentElement?.append(probe)
    const read = (token: string) => { probe.style.color = css.getPropertyValue(token); return getComputedStyle(probe).color }
    ground = read('--ground'); ink = read('--ink'); accent = read('--accent'); probe.remove()
  }
  const refresh = () => {
    readColors()
    if (!disposed && !frame && visible && !document.hidden) frame = requestAnimationFrame(tick)
  }
  const resize = () => {
    size = Math.max(1, canvas.getBoundingClientRect().width)
    pixelRatio = 192 / size
    canvas.width = Math.round(size * pixelRatio)
    canvas.height = canvas.width
    refresh()
  }
  const updateInteraction = () => {
    trigger.setAttribute('aria-expanded', String(active()))
    refresh()
  }
  trigger.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hovered = true; updateInteraction() } }, options)
  trigger.addEventListener('pointerleave', () => { hovered = false; updateInteraction() }, options)
  trigger.addEventListener('focus', () => { focused = trigger.matches(':focus-visible'); updateInteraction() }, options)
  trigger.addEventListener('blur', () => { focused = false; pinned = false; updateInteraction() }, options)
  trigger.addEventListener('click', (e) => {
    if (e.detail === 0 || !matchMedia('(hover: hover)').matches) {
      pinned = !active(); focused = false; updateInteraction()
    }
  }, options)
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hovered = false; focused = false; pinned = false; updateInteraction() }
  }, options)
  pause.addEventListener('click', () => {
    paused = !paused
    pause.setAttribute('aria-pressed', String(paused))
    pause.textContent = paused ? 'Resume animation' : 'Pause animation'
    refresh()
  }, options)
  reduced.addEventListener('change', refresh, options)
  dark.addEventListener('change', refresh, options)
  window.addEventListener('clawops-themechange', refresh, options)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; previous = 0 }
    else refresh()
  }, options)
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (!visible) { cancelAnimationFrame(frame); frame = 0; previous = 0 }
    else refresh()
  })
  observer.observe(canvas)
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)

  function render() {
    const open = ease(opening)
    // Move the panels clear of the core before turning their outer faces forward.
    const swivel = ease(clamp((open - 0.12) / 0.88))
    const viewSize = 556 + 256 * open
    const scale = size / viewSize
    ctx.setTransform(pixelRatio * scale, 0, 0, pixelRatio * scale, canvas.width / 2, canvas.height / 2)
    ctx.clearRect(-viewSize/2, -viewSize/2, viewSize, viewSize)
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    const tilt = 0.20 * (1 - open)
    const panels: Panel[] = [0,1,2].map(index => {
      const longitude = index * TAU / 3
      const normal = sphere(0,longitude,1)
      return { lat: [-Math.PI/2,Math.PI/2], lon: [longitude-Math.PI/3+.022,longitude+Math.PI/3-.022],
        offset: normal.map(v=>v*106*open) as Vec, pivot: normal.map(v=>v*RADIUS) as Vec, turn: Math.PI/2*swivel, lean:0 }
    })
    const orient = (v: Vec, panel: Panel): Vec => {
      const axis: Vec = [panel.pivot[1]/RADIUS,-panel.pivot[0]/RADIUS,0]
      const c=Math.cos(panel.turn),s=Math.sin(panel.turn),dot=axis.reduce((sum,n,i)=>sum+n*v[i],0)
      const cross: Vec = [axis[1]*v[2],-axis[0]*v[2],axis[0]*v[1]-axis[1]*v[0]]
      return v.map((n,i)=>n*c+cross[i]*s+axis[i]*dot*(1-c)) as Vec
    }
    const rotate = (v: Vec) => pitch(yaw(v, angle), tilt)
    const transform = (v: Vec, panel: Panel) => {
      const relative = v.map((value, i) => value - panel.pivot[i]) as Vec
      const p = orient(relative, panel)
      return rotate(p.map((value, i) => value + panel.pivot[i] + panel.offset[i]) as Vec)
    }
    const project = ([x, y]: Vec): Point => [x, -y]
    const path = (points: Point[], close = false) => {
      ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
      if (close) ctx.closePath()
    }
    const queue: Paint[] = []
    const line = (a: Vec, b: Vec, color: string, width: number, glow = 0, opacity = 1, silhouette = false) => {
      queue.push({ z: silhouette ? 10000 : (a[2] + b[2]) / 2 + 3, draw: () => {
        ctx.save(); ctx.globalAlpha = opacity; ctx.strokeStyle = color; ctx.lineWidth = width
        ctx.shadowColor = accent; ctx.shadowBlur = glow * scale
        path([project(a), project(b)]); ctx.stroke(); ctx.restore()
      } })
    }
    panels.forEach((panel) => {
      const cap = false
      const rows = 16, columns = 64
      const latAt = (i: number) => panel.lat[0] + (panel.lat[1] - panel.lat[0]) * i / rows
      const lonAt = (j: number) => panel.lon[0] + (panel.lon[1] - panel.lon[0]) * j / columns
      const vertices: Vec[][] = Array.from({ length: rows + 1 }, (_, i) =>
        Array.from({ length: columns + 1 }, (_, j) => transform(sphere(latAt(i), lonAt(j)), panel)))
      const facing = (i: number, j: number) => rotate(orient(sphere(latAt(i + 0.5), lonAt(j + 0.5), 1), panel))[2]
      for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) {
        const points = [vertices[i][j], vertices[i][j + 1], vertices[i + 1][j + 1], vertices[i + 1][j]]
        queue.push({ z: points.reduce((total, p) => total + p[2], 0) / 4, draw: () => {
          path(points.map(project), true)
          ctx.fillStyle = ground; ctx.strokeStyle = ground; ctx.lineWidth = 1.15
          ctx.fill(); ctx.stroke()
        } })
        const front = facing(i, j) >= 0
        // Only physical edges and the silhouette; never draw the spherical mesh.
        if (i === 0) line(points[0], points[1], ink, 1.35, 0, 1, front)
        else if (front && facing(i - 1, j) < 0) line(points[0], points[1], ink, 1.35, 0, 1, true)
        if (i === rows - 1) line(points[3], points[2], ink, 1.35, 0, 1, front)
        else if (front && facing(i + 1, j) < 0) line(points[3], points[2], ink, 1.35, 0, 1, true)
        if (!cap && j === 0) line(points[0], points[3], ink, 1.35, 0, 1, front)
        else if (front && facing(i, (j - 1 + columns) % columns) < 0) line(points[0], points[3], ink, 1.35, 0, 1, true)
        if (!cap && j === columns - 1) line(points[1], points[2], ink, 1.35, 0, 1, front)
        else if (front && facing(i, (j + 1) % columns) < 0) line(points[1], points[2], ink, 1.35, 0, 1, true)

      }
    })

    const overlays: (() => void)[] = []
    const halo = (points: Point[], opacity: number) => {
      if (points.length < 2) return
      ctx.save()
      path(points)
      ctx.strokeStyle = accent
      ctx.shadowColor = accent
      ctx.shadowBlur = 16 * pixelRatio * scale
      ctx.lineWidth = 5
      ctx.globalAlpha = opacity * 0.32
      ctx.stroke()
      ctx.shadowBlur = 7 * pixelRatio * scale
      ctx.lineWidth = 2.7
      ctx.globalAlpha = opacity * 0.65
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.lineWidth = 1.25
      ctx.globalAlpha = opacity
      ctx.stroke()
      ctx.restore()
    }
    // Identical glowing seam edges on all three spherical segments.
    const seam = (panel: Panel, sample: (t: number) => [number, number], opacity: number) => {
      overlays.push(() => {
        let points: Point[] = []
        for (let i = 0; i <= 160; i++) {
          const [lat, lon] = sample(i / 160)
          const normal = rotate(orient(sphere(lat, lon, 1), panel))[2]
          if (normal > 0.015) points.push(project(transform(sphere(lat, lon, RADIUS + 0.5), panel)))
          else { halo(points, opacity); points = [] }
        }
        halo(points, opacity)
      })
    }
    const seamOpacity = .8-open*.4
    for (const panel of panels) for (const lon of panel.lon)
      seam(panel,t=>[-Math.PI/2+Math.PI*t,lon],seamOpacity)

    // Stamps are projected from the shell surface, so they rotate and open with it.
    const rect = (x: number, y: number, w: number, h: number): Point[] => [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]
    const chip: Point[][] = [rect(-10,-10,20,20)]
    for (const t of [-6,0,6]) chip.push([[t,-15],[t,-10]], [[t,10],[t,15]], [[-15,t],[-10,t]], [[10,t],[15,t]])
    const network: Point[][] = [rect(-5,-16,10,10),rect(-17,6,10,10),rect(7,6,10,10),[[0,-6],[0,0],[-12,0],[-12,6]],[[0,0],[12,0],[12,6]]]
    const storage: Point[][] = [rect(-16,-14,32,11),rect(-16,3,32,11),[[9,-9],[10,-9]],[[9,9],[10,9]]]
    // Surface-area centroid in the panel's own coordinates, projected back
    // onto the sphere. No camera angle or opening offset enters this anchor.
    const stampCenter = (panel: Panel): Vec => sphere(0,(panel.lon[0]+panel.lon[1])/2,1)
    const stamp = (panel: Panel, strokes: Point[][]) => {
      const center = stampCenter(panel)
      const inverse = {...panel,turn:-Math.PI/2}
      const east = orient([1,0,0],inverse)
      const north = orient([0,1,0],inverse)
      const onSurface = (u: number, v: number): Vec => {
        const point = center.map((value, i) => RADIUS*value + u*east[i] - v*north[i]) as Vec
        const length = Math.hypot(...point)
        return point.map(value => value*(RADIUS+1)/length) as Vec
      }
      overlays.push(() => {
        const glyph = new Path2D()
        for (const stroke of strokes) {
          let drawing = false
          for (let i = 1; i < stroke.length; i++) {
            const [u0,v0] = stroke[i-1], [u1,v1] = stroke[i]
            const steps = Math.max(1, Math.ceil(Math.hypot(u1-u0,v1-v0)/2))
            for (let part = 0; part <= steps; part++) {
              const t = part/steps
              const local = onSurface(u0+(u1-u0)*t,v0+(v1-v0)*t)
              // Clip the glyph against the visible hemisphere, like painted ink.
              if (rotate(orient(local,panel))[2] <= 0) { drawing = false; continue }
              const [x,y] = project(transform(local,panel))
              if (drawing) glyph.lineTo(x,y)
              else glyph.moveTo(x,y)
              drawing = true
            }
          }
        }
        ctx.save()
        ctx.strokeStyle = accent
        ctx.lineWidth = 3.4
        ctx.shadowColor = accent
        ctx.shadowBlur = 11 * pixelRatio * scale
        ctx.stroke(glyph)
        ctx.shadowBlur = 0
        ctx.strokeStyle = ink
        ctx.lineWidth = 1.65
        ctx.stroke(glyph)
        ctx.restore()
      })
    }
    stamp(panels[0], chip)
    stamp(panels[2], network)
    stamp(panels[1], storage)

    queue.push({ z: 0, draw: () => {
      if (open < 0.01) return
      ctx.save(); ctx.globalAlpha = clamp(open * 2)
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.shadowColor = accent; ctx.shadowBlur = 12*scale
      const claw = new Path2D('M -28 61 C -63 58 -69 17 -55 -19 C -40 -53 -8 -76 30 -78 C 40 -79 37 -69 31 -64 L 28 -57 L 22 -57 L 23 -50 L 17 -49 L 18 -42 L 12 -41 L 13 -34 L 7 -32 L 8 -25 L 2 -23 L 2 -16 L -4 -12 C -10 -4 -8 5 -2 10 C 15 -2 30 -18 47 -40 C 55 -51 60 -48 59 -37 C 58 3 42 39 9 54 C -4 61 -17 64 -28 61 Z')
      ctx.stroke(claw)
      ctx.save(); ctx.clip(claw); ctx.globalAlpha *= .20; ctx.lineWidth=.7
      for(let y=-78;y<64;y+=4){path([[-70,y],[70,y]]);ctx.stroke()}
      ctx.restore()
      ctx.stroke(new Path2D('M -3 10 C -23 12 -15 26 -12 34 C -8 46 -17 54 -21 60 M -44 -35 C -48 -12 -38 5 -18 9'))
      ctx.globalAlpha*=.4;ctx.beginPath();ctx.ellipse(0,88,40,8,0,0,TAU);ctx.stroke();ctx.restore()

    } })
    queue.sort((a,b) => a.z - b.z)
    queue.forEach((op) => op.draw())
    overlays.forEach(draw => draw())
  }

  function tick(time: number) {
    frame = 0
    if (disposed || !visible || document.hidden) return
    const dt = Math.min(previous ? (time - previous) / 1000 : 1 / 60, 0.05)
    previous = time
    const engaged = active()
    if (engaged !== wasActive) { angle = wrap(angle); wasActive = engaged }
    if (reduced.matches) {
      angle = 0; opening = engaged ? 1 : 0
    } else {
      if (engaged) angle += -angle * (1 - Math.exp(-dt * 6))
      else if (opening < 0.025 && !paused) angle = wrap(angle + dt * 0.19)
      const target = engaged && Math.abs(angle) < 0.075 ? 1 : 0
      opening += (target - opening) * (1 - Math.exp(-dt * 4.6))
      if (Math.abs(opening - target) < 0.0008) opening = target
      if (engaged && Math.abs(angle) < 0.0008) angle = 0
    }
    trigger.dataset.state = engaged ? (opening === 1 ? 'open' : 'opening') : (opening > 0 ? 'closing' : 'rotating')
    render()
    const transitioning = engaged ? opening < 1 || angle !== 0 : opening > 0
    if (!reduced.matches && (transitioning || (!engaged && !paused))) frame = requestAnimationFrame(tick)
    else previous = 0
  }
  resize()
  return () => {
    disposed = true; cancelAnimationFrame(frame); abort.abort(); observer.disconnect(); resizeObserver.disconnect()
  }
}
