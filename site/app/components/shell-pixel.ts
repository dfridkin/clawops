import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { mountShell as mountFallback } from './shell-renderer'

type Point = [number, number]
type Panel = { lat: Point; lon: Point; pivot: THREE.Vector3; target: THREE.Vector3; rotation: THREE.Quaternion; root: THREE.Group }
const R = 137, TAU = Math.PI * 2
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const ease = (v: number) => v * v * (3 - 2 * v)
const surface = (lat: number, lon: number, radius = R) => new THREE.Vector3(radius * Math.cos(lat) * Math.sin(lon), radius * Math.cos(lat) * Math.cos(lon), radius * Math.sin(lat))

/** Real surfaces, physical rims, centered decals and restrained emissive light. */
export function mountShell(canvas: HTMLCanvasElement, trigger: HTMLButtonElement, pause: HTMLButtonElement) {
  const context = canvas.getContext('webgl2', { antialias: false, alpha: false })
  if (!context) return mountFallback(canvas, trigger, pause)
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false, alpha: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.12
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-320, 320, 320, -320, 1, 2000)
  camera.position.z = 800
  const world = new THREE.Group()
  scene.add(world)
  const spin = new THREE.Group()
  world.add(spin)
  const target = new THREE.WebGLRenderTarget(520, 520, { type: THREE.HalfFloatType, samples: 0 })
  const composer = new EffectComposer(renderer, target)
  composer.addPass(new RenderPass(scene, camera))
  const output = new OutputPass()
  composer.addPass(output)
  // Fixed retro palette with ordered dithering. Runs on the 192px framebuffer.
  const pixelPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform sampler2D tDiffuse;varying vec2 vUv;
      float bayer(vec2 p){vec2 a=mod(floor(p),2.);vec2 b=mod(floor(p/2.),2.);
      return (4.*(a.x*2.+a.y*3.-4.*a.x*a.y)+(b.x*2.+b.y*3.-4.*b.x*b.y))/16.-.46875;}
      void main(){vec3 c=texture2D(tDiffuse,vUv).rgb; c+=bayer(gl_FragCoord.xy)*.10;
      vec3 palette[10];
      palette[0]=vec3(.055,.078,.102);palette[1]=vec3(.12,.16,.18);
      palette[2]=vec3(.25,.29,.31);palette[3]=vec3(.40,.44,.46);
      palette[4]=vec3(.60,.63,.64);palette[5]=vec3(.75,.77,.78);
      palette[6]=vec3(.91,.93,.93);palette[7]=vec3(0.,.40,.40);
      palette[8]=vec3(.31,.71,.68);palette[9]=vec3(.64,1.,.88);
      float best=100.;vec3 chosen=palette[0];
      for(int i=0;i<10;i++){vec3 d=c-palette[i];float distance=dot(d,d);if(distance<best){best=distance;chosen=palette[i];}}
      gl_FragColor=vec4(chosen,1.);}`,
  })
  composer.addPass(pixelPass)

  const dark = matchMedia('(prefers-color-scheme: dark)')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const controller = new AbortController()
  const events = { signal: controller.signal }
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const keepGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => { geometries.add(geometry); return geometry }
  const keepMaterial = <T extends THREE.Material>(material: T): T => { materials.add(material); return material }
  const body = keepMaterial(new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ground: { value: new THREE.Color() }, ink: { value: new THREE.Color() }, teal: { value: new THREE.Color() }, isDark: { value: 1 } },
    vertexShader: `varying vec3 vNormal; varying vec3 vView;
      void main(){ vec4 pos=modelViewMatrix*vec4(position,1.); vNormal=normalize(normalMatrix*normal); vView=normalize(-pos.xyz); gl_Position=projectionMatrix*pos; }`,
    fragmentShader: `uniform vec3 ground; uniform vec3 ink; uniform vec3 teal; uniform float isDark;
      varying vec3 vNormal; varying vec3 vView;
      void main(){ vec3 n=normalize(vNormal); float facing=abs(dot(n,normalize(vView))); float edge=pow(1.-facing,4.);
      float key=max(0.,dot(n,normalize(vec3(-.5,.8,1.))));
      vec3 base=mix(vec3(.045,.06,.07),vec3(.40,.44,.46),.16+.67*key);
      base=mix(base,ink,smoothstep(.60,.96,edge)*.70);
      if(!gl_FrontFacing) base*=.58;
      gl_FragColor=vec4(base,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  }))
  const rim = keepMaterial(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  const edge = keepMaterial(new THREE.MeshBasicMaterial({ toneMapped: false }))
  const light = keepMaterial(new THREE.MeshBasicMaterial({ toneMapped: false }))
  const glyph = keepMaterial(new THREE.MeshBasicMaterial({ toneMapped: false }))
  const glyphHalo = keepMaterial(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }))
  const hologram = { teal: { value: new THREE.Color() }, reveal: { value: 0 }, time: { value: 0 } }
  const hologramVertex = `varying float vHeight;void main(){vHeight=position.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`
  const hologramFragment = `uniform vec3 teal;uniform float reveal;uniform float time;uniform float opacity;varying float vHeight;
    void main(){float cut=smoothstep(vHeight-3.,vHeight+3.,-80.+reveal*174.);
    float shimmer=.97+.03*sin(time*1.8+vHeight*.045);
    gl_FragColor=vec4(teal,opacity*cut*shimmer);}`
  const clawMaterial = keepMaterial(new THREE.ShaderMaterial({
    uniforms:{...hologram,opacity:{value:1}},transparent:true,depthWrite:false,toneMapped:false,
    vertexShader:hologramVertex,fragmentShader:hologramFragment,
  }))

  const atmosphere = keepMaterial(new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: { base: { value: new THREE.Color() }, teal: { value: new THREE.Color() }, strength: { value: 0.1 } },
    vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec2 vUv; uniform vec3 base; uniform vec3 teal; uniform float strength;
      void main(){vec2 p=(vUv-.5)*2.; float a=exp(-5.*dot(p,p)); gl_FragColor=vec4(mix(base,teal,a*strength),1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  }))
  const backdrop = new THREE.Mesh(keepGeometry(new THREE.PlaneGeometry(1400, 1400)), atmosphere)
  backdrop.position.z = -500
  scene.add(backdrop)

  function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, parent: THREE.Object3D, smooth = false) {
    if (points.length < 2) return
    const curve = smooth ? new THREE.CatmullRomCurve3(points, false, 'centripetal') : new THREE.CurvePath<THREE.Vector3>()
    if (curve instanceof THREE.CurvePath) for (let i = 1; i < points.length; i++) curve.add(new THREE.LineCurve3(points[i - 1], points[i]))
    const geometry = keepGeometry(new THREE.TubeGeometry(curve, Math.max(12, points.length * 2), radius, 6, false))
    const mesh = new THREE.Mesh(geometry, material)
    parent.add(mesh)
    return mesh
  }
  function patch(panel: Panel, radius: number) {
    const positions: number[] = [], normals: number[] = [], indices: number[] = []
    const rows = 48, columns = 128
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) {
      const lat = THREE.MathUtils.lerp(...panel.lat, i / rows), lon = THREE.MathUtils.lerp(...panel.lon, j / columns)
      const p = surface(lat, lon, radius), n = p.clone().normalize()
      positions.push(p.x, p.y, p.z); normals.push(n.x, n.y, n.z)
      if (i < rows && j < columns) { const a = i * (columns + 1) + j, b = a + columns + 1; indices.push(a, a + 1, b, a + 1, b + 1, b) }
    }
    const geometry = keepGeometry(new THREE.BufferGeometry())
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setIndex(indices)
    return geometry
  }
  // Congruent spherical lunes: identical 120-degree sectors with equal seam clearance.
  // Their common pole axis points through the front and back of the closed sphere.
  const panels: Panel[] = [0, 1, 2].map(index => {
    const longitude = index * TAU / 3
    const normal = surface(0, longitude, 1)
    return {
      lat: [-Math.PI / 2, Math.PI / 2],
      lon: [longitude - Math.PI / 3 + .022, longitude + Math.PI / 3 - .022],
      pivot: normal.clone().multiplyScalar(R),
      target: normal.clone().multiplyScalar(106),
      rotation: new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 0, 1)),
      root: new THREE.Group(),
    }
  })
  function boundary(sample: (t: number, radius: number) => THREE.Vector3, parent: THREE.Group) {
    const outer = Array.from({ length: 129 }, (_, i) => sample(i / 128, R))
    const inner = Array.from({ length: 129 }, (_, i) => sample(i / 128, R - 3.2))
    const positions: number[] = [], indices: number[] = []
    outer.forEach((p, i) => { positions.push(...p.toArray(), ...inner[i].toArray()); if (i < 128) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) } })
    const geometry = keepGeometry(new THREE.BufferGeometry())
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals()
    parent.add(new THREE.Mesh(geometry, rim))
    tube(outer, 1.35, edge, parent)
    tube(inner, 1.5, light, parent)
    tube(inner, 2.1, glyphHalo, parent)
  }
  const rect = (x: number, y: number, w: number, h: number): Point[] => [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]
  const chip: Point[][] = [rect(-11,-11,22,22)]
  for (const t of [-7,0,7]) chip.push([[t,-17],[t,-11]],[[t,11],[t,17]],[[-17,t],[-11,t]],[[11,t],[17,t]])
  const network: Point[][] = [rect(-5,-17,10,10),rect(-18,7,10,10),rect(8,7,10,10),[[0,-7],[0,0],[-13,0],[-13,7]],[[0,0],[13,0],[13,7]]]
  const storage: Point[][] = [rect(-17,-15,34,12),rect(-17,3,34,12),[[10,-9],[11,-9]],[[10,9],[11,9]]]
  panels.forEach((panel, index) => {
    spin.add(panel.root)
    const shell = new THREE.Group()
    shell.position.copy(panel.pivot).negate()
    panel.root.add(shell)
    shell.add(new THREE.Mesh(patch(panel, R), body))
    // Inner skin plus the connecting rim produces genuine panel thickness.
    shell.add(new THREE.Mesh(patch(panel, R - 3.2), body))
    for (const lon of panel.lon) boundary((t, radius) => surface(THREE.MathUtils.lerp(...panel.lat, t), lon, radius), shell)
    const center = surface(0, (panel.lon[0] + panel.lon[1]) / 2, 1)
    // Orient artwork in its physical tangent plane so it reads upright after pivoting.
    const inverse = panel.rotation.clone().invert()
    const east = new THREE.Vector3(1, 0, 0).applyQuaternion(inverse)
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(inverse)
    for (const stroke of [chip,storage,network][index]) {
      const points: THREE.Vector3[] = []
      for (let i=1;i<stroke.length;i++) for(let n=0;n<=8;n++) {
        const u=THREE.MathUtils.lerp(stroke[i-1][0],stroke[i][0],n/8), v=THREE.MathUtils.lerp(stroke[i-1][1],stroke[i][1],n/8)
        points.push(center.clone().multiplyScalar(R).addScaledVector(east,u).addScaledVector(north,-v).normalize().multiplyScalar(R+1.4))
      }
      tube(points, 2.05, glyphHalo, shell)
      tube(points, 1.65, glyph, shell)
    }
  })

  const core = new THREE.Group()
  scene.add(core)
  // Original concept's asymmetric lobster pincer, with a broad palm and toothed jaws.
  const outline = new THREE.Shape()
  outline.moveTo(-28,-61)
  outline.bezierCurveTo(-63,-58,-69,-17,-55,19)
  outline.bezierCurveTo(-40,53,-8,76,30,78)
  outline.bezierCurveTo(40,79,37,69,31,64)
  for (const [x,y] of [[28,57],[22,57],[23,50],[17,49],[18,42],[12,41],[13,34],[7,32],[8,25],[2,23],[2,16],[-4,12]]) outline.lineTo(x,y)
  outline.bezierCurveTo(-10,4,-8,-5,-2,-10)
  outline.bezierCurveTo(15,2,30,18,47,40)
  outline.bezierCurveTo(55,51,60,48,59,37)
  outline.bezierCurveTo(58,-3,42,-39,9,-54)
  outline.bezierCurveTo(-4,-61,-17,-64,-28,-61)
  const holoFill = keepMaterial(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    uniforms: hologram,
    vertexShader: `varying vec2 p; void main(){p=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec2 p; uniform vec3 teal; uniform float reveal; uniform float time;
      // The claw is about 39 framebuffer pixels tall. At p.y*1.6 the scan period was 1.08 of
      // them, under the two it takes to draw a line and a gap, so the pattern beat against the
      // pixel grid instead of resolving: soft irregular banding rather than lines. 0.862 puts
      // the period at exactly two pixels, which is the finest regular stripe this framebuffer
      // can hold, and raising the exponent narrows the lit band inside it so the line reads
      // thin rather than blurred.
      void main(){float scan=pow(.5+.5*cos(p.y*.862-time*.35),15.);float cut=smoothstep(p.y-4.,p.y+4.,-80.+reveal*174.);
      float sweep=exp(-pow((p.y-(-80.+reveal*174.))/3.,2.))*(1.-step(.999,reveal));
      gl_FragColor=vec4(teal,(.030+.19*scan+.32*sweep)*cut*reveal);}`,
  }))
  core.add(new THREE.Mesh(keepGeometry(new THREE.ShapeGeometry(outline, 48)), holoFill))
  const holoHalo = keepMaterial(new THREE.ShaderMaterial({
    uniforms:{...hologram,opacity:{value:.10}},transparent:true,depthWrite:false,toneMapped:false,
    vertexShader:hologramVertex,fragmentShader:hologramFragment,
  }))
  const contour = outline.getPoints(48).map(p=>new THREE.Vector3(p.x,p.y,.8))
  tube(contour, 2.6, holoHalo, core)
  tube(contour, 1.6, clawMaterial, core)
  const hinge = new THREE.Path()
  hinge.moveTo(-3,-10);hinge.bezierCurveTo(-23,-12,-15,-26,-12,-34);hinge.bezierCurveTo(-8,-46,-17,-54,-21,-60)
  tube(hinge.getPoints(32).map(p=>new THREE.Vector3(p.x,p.y,1)),1.2,clawMaterial,core)
  const palm = new THREE.Path()
  palm.moveTo(-44,35);palm.bezierCurveTo(-48,12,-38,-5,-18,-9)
  tube(palm.getPoints(32).map(p=>new THREE.Vector3(p.x,p.y,1)),1.1,clawMaterial,core)
  const projectionMaterial = keepMaterial(new THREE.MeshBasicMaterial({transparent:true,opacity:.3,depthWrite:false,toneMapped:false}))
  for(const radius of [34,45]) tube(Array.from({length:97},(_,i)=>new THREE.Vector3(Math.cos(i/96*TAU)*radius,-88+Math.sin(i/96*TAU)*8,0)),.5,projectionMaterial,core)
  const beamMaterial = keepMaterial(new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
    uniforms:{teal:{value:new THREE.Color()},power:{value:0}},
    vertexShader:`varying float height;void main(){height=(position.y+87.)/115.;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying float height;uniform vec3 teal;uniform float power;void main(){gl_FragColor=vec4(teal,power*.05*pow(1.-clamp(height,0.,1.),2.));}`,
  }))
  const beamGeometry=keepGeometry(new THREE.BufferGeometry())
  beamGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-28,-87,-2,28,-87,-2,66,28,-2,-28,-87,-2,66,28,-2,-66,28,-2],3))
  core.add(new THREE.Mesh(beamGeometry,beamMaterial))

  let angle=-.45, opening=0, hovered=false, focused=false, pinned=false, paused=false, visible=true, disposed=false, raf=0, previous=0
  let reveal = 0, idleSpeed = 0, motionTime = 0, lastDraw = -Infinity
  const pointer = new THREE.Vector2(), parallax = new THREE.Vector2()
  const active=()=>hovered||focused||pinned
  function palette() {
    const css=getComputedStyle(canvas)
    const probe=document.createElement('span');canvas.parentElement?.append(probe)
    const read=(token:string)=>{probe.style.color=css.getPropertyValue(token);return new THREE.Color(getComputedStyle(probe).color)}
    const ground=read('--ground'), ink=read('--ink'), accent=read('--accent');probe.remove()
    const isDark=ground.getHSL({h:0,s:0,l:0}).l<.4
    scene.background=ground
    body.uniforms.ground.value.copy(ground);body.uniforms.ink.value.copy(ink);body.uniforms.teal.value.copy(accent);body.uniforms.isDark.value=isDark?1:0
    rim.color.copy(ground).lerp(accent,isDark?.22:.10)
    edge.color.copy(ink).multiplyScalar(.68)
    light.color.copy(accent).multiplyScalar(isDark?3.8:1.2)
    glyph.color.copy(ink).multiplyScalar(isDark?.92:.8)
    glyphHalo.color.copy(accent).multiplyScalar(isDark?2.3:1)
    hologram.teal.value.copy(accent).lerp(ink,.18).multiplyScalar(isDark?2.5:.9)
    projectionMaterial.color.copy(accent)
    beamMaterial.uniforms.teal.value.copy(accent)
    atmosphere.uniforms.base.value.copy(ground);atmosphere.uniforms.teal.value.copy(accent);atmosphere.uniforms.strength.value=isDark?.085:.028
  }
  function schedule(){if(!disposed&&!raf&&visible&&!document.hidden)raf=requestAnimationFrame(tick)}
  function refresh(){palette();schedule()}
  function resize(){renderer.setSize(192,192,false);composer.setSize(192,192);refresh()}
  function update(){trigger.setAttribute('aria-expanded',String(active()));schedule()}
  trigger.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hovered=true;update()}},events)
  trigger.addEventListener('pointerleave',()=>{hovered=false;pointer.set(0,0);update()},events)
  trigger.addEventListener('pointermove',e=>{
    if(e.pointerType!=='mouse'||reduced.matches)return
    const rect=trigger.getBoundingClientRect()
    pointer.set(THREE.MathUtils.clamp((e.clientX-rect.left)/rect.width*2-1,-1,1),THREE.MathUtils.clamp((e.clientY-rect.top)/rect.height*2-1,-1,1));schedule()
  },events)
  trigger.addEventListener('focus',()=>{focused=trigger.matches(':focus-visible');update()},events)
  trigger.addEventListener('blur',()=>{focused=false;pinned=false;update()},events)
  trigger.addEventListener('click',e=>{if(e.detail===0||!matchMedia('(hover:hover)').matches){pinned=!active();focused=false;update()}},events)
  trigger.addEventListener('keydown',e=>{if(e.key==='Escape'){hovered=false;focused=false;pinned=false;update()}},events)
  pause.addEventListener('click',()=>{paused=!paused;pause.setAttribute('aria-pressed',String(paused));pause.textContent=paused?'Resume animation':'Pause animation';schedule()},events)
  reduced.addEventListener('change',schedule,events);dark.addEventListener('change',refresh,events)
  window.addEventListener('clawops-themechange',refresh,events)
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;previous=0}else schedule()},events)
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(raf);raf=0;visible=false},events)
  canvas.addEventListener('webglcontextrestored',()=>{visible=true;refresh()},events)
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(canvas)
  const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(visible)schedule();else{cancelAnimationFrame(raf);raf=0;previous=0}});observer.observe(canvas)
  function tick(time:number){
    raf=0;if(disposed||!visible||document.hidden)return
    if(!reduced.matches&&time-lastDraw<1000/12){schedule();return}
    lastDraw=time
    const dt=Math.min(previous?(time-previous)/1000:1/12,.12);previous=time
    const engaged=active()
    if(reduced.matches){angle=0;opening=engaged?1:0}
    else {
      if(engaged){angle=Math.atan2(Math.sin(angle),Math.cos(angle));angle*=Math.exp(-dt*5.4)}
      else if(opening===0&&!paused){idleSpeed+=(.16-idleSpeed)*(1-Math.exp(-dt*2.8));angle+=dt*idleSpeed}
      if(engaged||opening>0||paused)idleSpeed=0
      const desired=engaged&&Math.abs(angle)<.08?1:0
      opening+=(desired-opening)*(1-Math.exp(-dt*4.3))
      if(Math.abs(desired-opening)<.0008)opening=desired
      if(engaged&&Math.abs(angle)<.0008)angle=0
    }
    const open=ease(opening)
    panels.forEach((panel,i)=>{
      const progress=ease(clamp((opening-i*.055)/(1-i*.055)))
      const swivel=ease(clamp((progress-.16)/.84))
      // A small, smooth overshoot settles at the same exact endpoint for every panel.
      const settle=reduced.matches?0:.014*Math.sin(Math.PI*progress)*Math.sin(Math.PI*progress*2)
      panel.root.position.copy(panel.pivot).addScaledVector(panel.target,progress+settle)
      panel.root.quaternion.identity().slerp(panel.rotation,swivel)
    })
    const targetX=engaged&&!reduced.matches?pointer.x*.045*open:0
    const targetY=engaged&&!reduced.matches?pointer.y*.035*open:0
    parallax.x+=(targetX-parallax.x)*(1-Math.exp(-dt*7))
    parallax.y+=(targetY-parallax.y)*(1-Math.exp(-dt*7))
    if(reduced.matches)parallax.set(0,0)
    world.rotation.x=-.20*(1-open)+parallax.y
    world.rotation.y=parallax.x;spin.rotation.y=angle
    core.rotation.set(parallax.y*.45,parallax.x*.45,0)
    const extent=278+128*open
    camera.left=-extent;camera.right=extent;camera.top=extent;camera.bottom=-extent;camera.updateProjectionMatrix()
    const projection=ease(clamp((open-.22)/.38))
    const scanTarget=engaged&&open>.68?1:0
    if(reduced.matches)reveal=engaged?1:0
    else reveal=THREE.MathUtils.clamp(reveal+dt*(scanTarget? .95:-2.6),0,1)
    if(!paused&&!reduced.matches)motionTime+=dt
    hologram.reveal.value=reveal
    hologram.time.value=motionTime
    projectionMaterial.opacity=.32*projection
    beamMaterial.uniforms.power.value=projection
    core.visible=projection>.001
    core.scale.setScalar(.98+.18*open)
    trigger.dataset.state=engaged?(opening===1?'open':'opening'):(opening>0?'closing':'rotating')
    // data-state reaches 'open' when the panels finish moving, which is before the claw has
    // finished being drawn: the scan starts at open>.68 and takes about a second more. The intro
    // waits for the whole sweep, so it needs to know about that second.
    trigger.dataset.reveal=reveal>=1?'complete':reveal>0?'scanning':'idle'
    composer.render()
    const pointerMoving=Math.abs(targetX-parallax.x)+Math.abs(targetY-parallax.y)>.0001
    const transitioning=opening>0&&opening<1||engaged&&angle!==0||reveal!==scanTarget||pointerMoving
    if(!reduced.matches&&(transitioning||!paused&&(engaged||opening===0)))schedule();else previous=0
  }
  resize()
  return ()=>{disposed=true;cancelAnimationFrame(raf);controller.abort();observer.disconnect();resizeObserver.disconnect();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());output.dispose();pixelPass.dispose();composer.dispose();renderer.dispose()}
}
