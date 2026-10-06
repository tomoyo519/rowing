import * as THREE from 'three'

/**
 * 절차적 텍스처.
 *
 * 외부 이미지 파일 없이 캔버스에 잔디·나무껍질·판자·돌·물결·탄소섬유·잎사귀 카드를 그린다.
 * 모든 노이즈는 정수 격자를 주기(period)로 감싸 **이음매 없이 반복**된다 — 강둑과 수면처럼 수백 m를
 * 타일링해도 경계가 보이지 않는다. 높이맵에서 노멀맵을 뽑아 조명이 결을 따라 반응하게 한다.
 *
 * 생성은 한 번만 하고 모듈 안에 캐시한다 (세션마다 다시 만들면 레이스 시작이 느려진다).
 */

type Rgb = [number, number, number]

const cache = new Map<string, THREE.Texture>()

function hash2(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 주기 period로 반복되는 값 노이즈 (0..1). */
function periodicNoise(x: number, y: number, period: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const p = period
  const x0 = ((ix % p) + p) % p, x1 = (x0 + 1) % p
  const y0 = ((iy % p) + p) % p, y1 = (y0 + 1) % p
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed)
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** 옥타브를 쌓은 반복 fbm (0..1 근방). frequency는 텍스처 한 변당 격자 수. */
function fbm(u: number, v: number, frequency: number, octaves: number, seed: number, gain = 0.5) {
  let value = 0, amp = 0.5, freq = frequency, total = 0
  for (let o = 0; o < octaves; o++) {
    value += periodicNoise(u * freq, v * freq, Math.max(1, Math.round(freq)), seed + o * 17) * amp
    total += amp
    amp *= gain
    freq *= 2
  }
  return value / total
}

function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v }
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
function hexRgb(hex: string): Rgb {
  const c = new THREE.Color(hex)
  return [c.r * 255, c.g * 255, c.b * 255]
}

/**
 * 2D 캔버스를 쓸 수 있는가. 테스트 러너(Node)에는 document가 없고 jsdom은 getContext가 null이다 —
 * 그런 환경에서는 캔버스로 그리는 텍스처(잎 획·잎사귀 카드·풀포기)를 단색 대체 텍스처로 돌린다.
 */
let canvasSupport: boolean | null = null
function hasCanvas() {
  if (canvasSupport !== null) return canvasSupport
  try {
    canvasSupport = typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d')
  } catch {
    canvasSupport = false
  }
  return canvasSupport
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

/** 캔버스가 없는 환경용 — 2×2 흰색 불투명 텍스처 */
function blankTexture(color: boolean) {
  const pixels = new Uint8Array(2 * 2 * 4).fill(255)
  return finish(new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType), color, false)
}

function finish(texture: THREE.Texture, color: boolean, repeat = true) {
  texture.wrapS = texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.anisotropy = 4
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

/**
 * 픽셀 배열을 그대로 GPU에 올린다 (캔버스를 거치지 않아 빠르고, DOM이 없어도 된다).
 * flipY가 false라 배열의 y가 커지는 쪽이 uv v가 커지는 쪽이다 — normalFromHeight의 부호가 이 기준이다.
 */
function fromPixels(w: number, h: number, pixels: Uint8ClampedArray, color: boolean, repeat = true) {
  const data = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  return finish(texture, color, repeat)
}

/** 높이 배열(0..1, 타일링)에서 접선공간 노멀맵을 만든다. strength가 클수록 결이 깊다. */
function normalFromHeight(w: number, h: number, height: Float32Array, strength: number) {
  const out = new Uint8ClampedArray(w * h * 4)
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)]!
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const len = Math.hypot(dx, dy, 1)
      const i = (y * w + x) * 4
      out[i] = ((-dx / len) * 0.5 + 0.5) * 255
      out[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255
      out[i + 2] = (1 / len) * 0.5 * 255 + 127.5
      out[i + 3] = 255
    }
  }
  return out
}

export interface SurfaceMaps {
  map: THREE.Texture
  normalMap: THREE.Texture
  roughnessMap?: THREE.Texture
}

function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  const hit = cache.get(key)
  if (hit) return hit as T
  const texture = make()
  cache.set(key, texture)
  return texture
}

// ── 잔디 ────────────────────────────────────────────────────

/**
 * 잔디: 큰 얼룩(마른 풀·짙은 풀) 위에 짧은 세로 잎 획을 수천 개 흩뿌린다.
 * 노멀맵은 잎 획을 따라 잘게 요철이 생겨 비스듬한 햇빛에 결이 드러난다.
 */
export function grassMaps(size = 512): SurfaceMaps {
  const map = cached('grass:map', () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    const lush: Rgb = hexRgb('#4f8a34')
    const dark: Rgb = hexRgb('#2f5d26')
    const dry: Rgb = hexRgb('#8c9a48')
    const soil: Rgb = hexRgb('#5b4a32')
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        const patch = fbm(u, v, 3, 4, 11)
        const fine = fbm(u, v, 24, 3, 23)
        const bare = clamp01((fbm(u, v, 5, 3, 31) - 0.62) * 6)
        let rgb = mixRgb(dark, lush, clamp01((patch - 0.35) * 2.2))
        rgb = mixRgb(rgb, dry, clamp01((patch - 0.55) * 3) * 0.7)
        rgb = mixRgb(rgb, soil, bare)
        const shade = 0.82 + fine * 0.36
        const i = (y * w + x) * 4
        pixels[i] = rgb[0] * shade
        pixels[i + 1] = rgb[1] * shade
        pixels[i + 2] = rgb[2] * shade
        pixels[i + 3] = 255
      }
    }
    if (!hasCanvas()) return fromPixels(w, h, pixels, true)
    // 잎 획: 짧고 살짝 기운 세로선. 위쪽 끝이 밝다.
    const canvas = makeCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(pixels, w, h), 0, 0)
    ctx.lineCap = 'round'
    for (let i = 0; i < 9000; i++) {
      const x = hash2(i, 1, 5) * w, y = hash2(i, 2, 5) * h
      const len = 4 + hash2(i, 3, 5) * 9
      const lean = (hash2(i, 4, 5) - 0.5) * 6
      const light = hash2(i, 5, 5)
      ctx.strokeStyle = light > 0.5
        ? `rgba(${150 + light * 60},${190 + light * 40},${70 + light * 30},0.55)`
        : `rgba(${30 + light * 30},${70 + light * 40},${25 + light * 20},0.5)`
      ctx.lineWidth = 1 + hash2(i, 6, 5) * 0.8
      // 가장자리에 걸친 획은 반대편에도 그려 타일 경계가 이어진다
      for (const [ox, oy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]] as [number, number][]) {
        ctx.beginPath()
        ctx.moveTo(x + ox, y + oy)
        ctx.lineTo(x + ox + lean, y + oy - len)
        ctx.stroke()
      }
    }
    return finish(new THREE.CanvasTexture(canvas), true)
  })
  const normalMap = cached('grass:normal', () => {
    const w = size, h = size
    const height = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        // 잎 획 방향으로 늘어난 노이즈 — 세로로 결이 선다
        height[y * w + x] = fbm(u * 1.0, v * 0.35, 40, 3, 29) * 0.7 + fbm(u, v, 6, 3, 13) * 0.3
      }
    }
    return fromPixels(w, h, normalFromHeight(w, h, height, 2.4), false)
  })
  return { map, normalMap }
}

// ── 나무껍질 ────────────────────────────────────────────────

/** 세로 섬유가 갈라진 껍질. 골은 어둡고 능선은 밝다. */
export function barkMaps(tint = '#4a3628', size = 256): SurfaceMaps {
  const map = cached(`bark:map:${tint}`, () => {
    const w = size, h = size * 2
    const pixels = new Uint8ClampedArray(w * h * 4)
    const base = hexRgb(tint)
    const light = mixRgb(base, [200, 180, 150], 0.35)
    const dark = mixRgb(base, [10, 6, 4], 0.55)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        const ridges = fbm(u, v * 0.18, 18, 4, 41)
        const crack = clamp01((0.5 - Math.abs(ridges - 0.5)) * 6 - 1.6)
        const mottle = fbm(u, v, 4, 3, 43)
        let rgb = mixRgb(dark, light, clamp01((ridges - 0.3) * 1.6))
        rgb = mixRgb(rgb, dark, crack)
        rgb = mixRgb(rgb, [90, 110, 70], clamp01((mottle - 0.62) * 4) * 0.5)   // 이끼
        const i = (y * w + x) * 4
        pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2]; pixels[i + 3] = 255
      }
    }
    return fromPixels(w, h, pixels, true)
  })
  const normalMap = cached('bark:normal', () => {
    const w = size, h = size * 2
    const height = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        height[y * w + x] = fbm(u, v * 0.18, 18, 4, 41)
      }
    }
    return fromPixels(w, h, normalFromHeight(w, h, height, 3.2), false)
  })
  return { map, normalMap }
}

/** 자작나무: 흰 껍질에 가로로 찢긴 검은 무늬 */
export function birchMaps(size = 256): SurfaceMaps {
  const map = cached('birch:map', () => {
    const w = size, h = size * 2
    const pixels = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        const paper = fbm(u, v, 6, 3, 51)
        const lenticel = fbm(u * 0.15, v, 30, 3, 53)
        const mark = clamp01((lenticel - 0.63) * 9) * clamp01((fbm(u, v, 3, 2, 55) - 0.35) * 3)
        const g = 225 + paper * 25
        const i = (y * w + x) * 4
        pixels[i] = g - mark * 190; pixels[i + 1] = g - 4 - mark * 195; pixels[i + 2] = g - 14 - mark * 200
        pixels[i + 3] = 255
      }
    }
    return fromPixels(w, h, pixels, true)
  })
  return { map, normalMap: barkMaps().normalMap }
}

// ── 판자·돌·지붕 ────────────────────────────────────────────

/** 나무 판자: 가로 판자 사이 어두운 틈, 판자마다 결과 색이 조금 다르다. */
export function plankMaps(tint = '#9a7250', size = 256): SurfaceMaps {
  const key = `plank:${tint}`
  const map = cached(`${key}:map`, () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    const base = hexRgb(tint)
    const planks = 6
    for (let y = 0; y < h; y++) {
      const plank = Math.floor((y / h) * planks)
      const within = ((y / h) * planks) % 1
      const gap = within < 0.05 || within > 0.95 ? 1 : 0
      const tone = 0.85 + hash2(plank, 7, 61) * 0.3
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        const grain = fbm(u * 0.25 + plank * 0.37, v, 32, 3, 63 + plank)
        const knots = fbm(u, v, 5, 2, 67)
        let k = tone * (0.8 + grain * 0.4) * (1 - clamp01((knots - 0.7) * 5) * 0.35)
        if (gap) k *= 0.45
        const i = (y * w + x) * 4
        pixels[i] = base[0] * k; pixels[i + 1] = base[1] * k; pixels[i + 2] = base[2] * k; pixels[i + 3] = 255
      }
    }
    return fromPixels(w, h, pixels, true)
  })
  const normalMap = cached('plank:normal', () => {
    const w = size, h = size
    const height = new Float32Array(w * h)
    const planks = 6
    for (let y = 0; y < h; y++) {
      const within = ((y / h) * planks) % 1
      const edge = within < 0.05 || within > 0.95 ? 0 : 1
      for (let x = 0; x < w; x++) {
        height[y * w + x] = edge * (0.7 + fbm(x / w * 0.25, y / h, 32, 2, 63) * 0.3)
      }
    }
    return fromPixels(w, h, normalFromHeight(w, h, height, 2.5), false)
  })
  return { map, normalMap }
}

/** 돌담: 어긋나게 쌓인 블록과 회반죽 줄눈. */
export function stoneMaps(tint = '#a9a397', size = 256): SurfaceMaps {
  const key = `stone:${tint}`
  const build = () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    const height = new Float32Array(w * h)
    const base = hexRgb(tint)
    const rows = 6, cols = 4
    for (let y = 0; y < h; y++) {
      const row = Math.floor((y / h) * rows)
      const vy = ((y / h) * rows) % 1
      const shift = row % 2 ? 0.5 : 0
      for (let x = 0; x < w; x++) {
        const cx = (x / w) * cols + shift
        const col = Math.floor(cx)
        const vx = cx % 1
        const mortar = vx < 0.06 || vx > 0.94 || vy < 0.08 || vy > 0.92 ? 1 : 0
        const block = hash2(col, row, 71)
        const rough = fbm(x / w, y / h, 12, 3, 73 + row)
        const k = mortar ? 0.62 + rough * 0.15 : 0.8 + block * 0.3 + (rough - 0.5) * 0.25
        const i = (y * w + x) * 4
        pixels[i] = base[0] * k; pixels[i + 1] = base[1] * k; pixels[i + 2] = base[2] * k; pixels[i + 3] = 255
        height[y * w + x] = mortar ? 0.2 : 0.6 + rough * 0.4
      }
    }
    return { map: fromPixels(w, h, pixels, true), normalMap: fromPixels(w, h, normalFromHeight(w, h, height, 2.0), false) }
  }
  const map = cached(`${key}:map`, () => build().map)
  const normalMap = cached(`${key}:normal`, () => build().normalMap)
  return { map, normalMap }
}

/** 기와 지붕: 겹쳐 놓인 반원 기와 열. */
export function roofMaps(tint = '#8f4f3f', size = 256): SurfaceMaps {
  const key = `roof:${tint}`
  const build = () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    const height = new Float32Array(w * h)
    const base = hexRgb(tint)
    const rows = 8, cols = 6
    for (let y = 0; y < h; y++) {
      const row = Math.floor((y / h) * rows)
      const vy = ((y / h) * rows) % 1
      const shift = row % 2 ? 0.5 : 0
      for (let x = 0; x < w; x++) {
        const cx = (x / w) * cols + shift
        const vx = cx % 1
        const col = Math.floor(cx)
        const curve = Math.sin(vx * Math.PI)         // 기와 한 장의 볼록함
        const lip = vy < 0.12 ? 0.5 : 1                // 아래 기와가 겹치는 그림자
        const tone = 0.75 + hash2(col, row, 81) * 0.3
        const weather = fbm(x / w, y / h, 8, 3, 83)
        const k = tone * (0.7 + curve * 0.4) * lip * (0.85 + weather * 0.3)
        const i = (y * w + x) * 4
        pixels[i] = base[0] * k; pixels[i + 1] = base[1] * k; pixels[i + 2] = base[2] * k; pixels[i + 3] = 255
        height[y * w + x] = curve * 0.6 + (vy < 0.12 ? 0 : 0.4)
      }
    }
    return { map: fromPixels(w, h, pixels, true), normalMap: fromPixels(w, h, normalFromHeight(w, h, height, 2.2), false) }
  }
  const map = cached(`${key}:map`, () => build().map)
  const normalMap = cached(`${key}:normal`, () => build().normalMap)
  return { map, normalMap }
}

// ── 물 ──────────────────────────────────────────────────────

/** 수면 잔결 노멀맵 — 셰이더에서 서로 다른 방향·속도로 두 번 겹쳐 샘플링한다. */
export function waterNormalTexture(size = 512) {
  return cached('water:normal', () => {
    const w = size, h = size
    const height = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        // 바람 방향으로 길게 늘어난 잔물결 + 등방성 거품 결
        const a = fbm(u * 1.0, v * 0.55, 10, 4, 91, 0.55)
        const b = fbm(u + 0.31, v + 0.17, 22, 3, 93, 0.5)
        height[y * w + x] = a * 0.65 + b * 0.35
      }
    }
    return fromPixels(w, h, normalFromHeight(w, h, height, 3.0), false)
  })
}

/** 거품·물보라 알파 텍스처 (부드러운 얼룩) */
export function foamTexture(size = 256) {
  return cached('water:foam', () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        const n = fbm(u, v, 8, 4, 101, 0.6)
        const a = clamp01((n - 0.48) * 4)
        const i = (y * w + x) * 4
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = a * 255
      }
    }
    return fromPixels(w, h, pixels, true)
  })
}

// ── 선체·장비 ───────────────────────────────────────────────

/** 탄소섬유 능직(twill) — 아주 미세하게, 클리어코트 아래에서만 보인다. */
export function carbonMaps(size = 256): SurfaceMaps {
  const build = () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    const height = new Float32Array(w * h)
    const cells = 32
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = Math.floor((x / w) * cells), cy = Math.floor((y / h) * cells)
        const fx = ((x / w) * cells) % 1, fy = ((y / h) * cells) % 1
        // 2×2 능직: 셀마다 가로/세로 실이 번갈아 위로 온다
        const over = ((cx + cy) >> 1) % 2 === 0
        const strand = over ? Math.sin(fy * Math.PI) : Math.sin(fx * Math.PI)
        const k = 0.35 + strand * 0.45
        const i = (y * w + x) * 4
        pixels[i] = 34 * k + 8; pixels[i + 1] = 38 * k + 9; pixels[i + 2] = 44 * k + 11; pixels[i + 3] = 255
        height[y * w + x] = strand
      }
    }
    return { map: fromPixels(w, h, pixels, true), normalMap: fromPixels(w, h, normalFromHeight(w, h, height, 0.8), false) }
  }
  const map = cached('carbon:map', () => build().map)
  const normalMap = cached('carbon:normal', () => build().normalMap)
  return { map, normalMap }
}

/** 유니폼 직물의 잔결 노멀 — 저지에 니트 결을 준다 */
export function fabricNormalTexture(size = 128) {
  return cached('fabric:normal', () => {
    const w = size, h = size
    const height = new Float32Array(w * h)
    const cells = 24
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fx = ((x / w) * cells) % 1, fy = ((y / h) * cells) % 1
        height[y * w + x] = Math.sin(fx * Math.PI) * Math.sin(fy * Math.PI) * 0.8 + fbm(x / w, y / h, 8, 2, 111) * 0.2
      }
    }
    return fromPixels(w, h, normalFromHeight(w, h, height, 0.9), false)
  })
}

// ── 잎사귀 카드 ─────────────────────────────────────────────

export type LeafCardKind = 'broad' | 'needle' | 'willow'

/**
 * 잎 무더기 카드. 알파로 잘린 잎 실루엣이 수관 겉면에 붙어 매끈한 구를 잎 덩어리로 바꾼다.
 * 색은 흰색 기반이라 재질 색(계절·날씨)이 곱해진다. 가장자리 잎이 살짝 밝아 빛이 통과하는 느낌을 준다.
 */
export function leafCardTexture(kind: LeafCardKind, size = 256) {
  return cached(`leafcard:${kind}`, () => {
    if (!hasCanvas()) return blankTexture(true)
    const canvas = makeCanvas(size, size)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, size, size)
    const c = size / 2
    const count = kind === 'needle' ? 140 : kind === 'willow' ? 70 : 64
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(hash2(i, 1, 121)) * size * 0.42
      const a = hash2(i, 2, 121) * Math.PI * 2
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r
      const rot = hash2(i, 3, 121) * Math.PI * 2
      const light = 0.72 + hash2(i, 4, 121) * 0.28 + (r / (size * 0.42)) * 0.12
      const g = Math.round(235 * light), rr = Math.round(215 * light), b = Math.round(200 * light)
      ctx.fillStyle = `rgb(${rr},${g},${b})`
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(rot)
      ctx.beginPath()
      if (kind === 'needle') {
        ctx.ellipse(0, 0, size * 0.028, size * 0.006, 0, 0, Math.PI * 2)
      } else if (kind === 'willow') {
        ctx.ellipse(0, 0, size * 0.07, size * 0.012, 0, 0, Math.PI * 2)
      } else {
        const s = size * (0.055 + hash2(i, 5, 121) * 0.03)
        ctx.moveTo(0, -s)
        ctx.bezierCurveTo(s * 0.9, -s * 0.5, s * 0.9, s * 0.5, 0, s)
        ctx.bezierCurveTo(-s * 0.9, s * 0.5, -s * 0.9, -s * 0.5, 0, -s)
      }
      ctx.fill()
      ctx.restore()
    }
    const texture = finish(new THREE.CanvasTexture(canvas), true, false)
    texture.anisotropy = 2
    return texture
  })
}

/** 풀 포기(갈대) 알파 텍스처 — 세로로 긴 잎 여러 가닥. 아래는 짙고 위는 밝다. */
export function grassTuftTexture(w = 128, h = 256) {
  return cached('grasstuft', () => {
    if (!hasCanvas()) return blankTexture(true)
    const canvas = makeCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.lineCap = 'round'
    for (let i = 0; i < 26; i++) {
      const x0 = w * 0.5 + (hash2(i, 1, 131) - 0.5) * w * 0.35
      const lean = (hash2(i, 2, 131) - 0.5) * w * 0.9
      const top = h * (0.05 + hash2(i, 3, 131) * 0.35)
      const k = 0.6 + hash2(i, 4, 131) * 0.4
      const grad = ctx.createLinearGradient(0, h, 0, top)
      grad.addColorStop(0, `rgba(${40 * k},${70 * k},${30 * k},1)`)
      grad.addColorStop(1, `rgba(${165 * k},${200 * k},${90 * k},1)`)
      ctx.strokeStyle = grad
      ctx.lineWidth = 2.2 + hash2(i, 5, 131) * 2.4
      ctx.beginPath()
      ctx.moveTo(x0, h)
      ctx.quadraticCurveTo(x0 + lean * 0.3, h * 0.55, x0 + lean, top)
      ctx.stroke()
    }
    const texture = finish(new THREE.CanvasTexture(canvas), true, false)
    return texture
  })
}

/** 구름 조각 — 가장자리가 부드럽게 풀리는 둥근 알파 */
export function cloudPuffTexture(size = 128) {
  return cached('cloudpuff', () => {
    const w = size, h = size
    const pixels = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x / w) - 0.5, dy = (y / h) - 0.5
        const d = Math.hypot(dx, dy) * 2
        const n = fbm(x / w, y / h, 4, 3, 141)
        const a = clamp01((1 - d) * 1.6 - 0.25 + (n - 0.5) * 0.55)
        const i = (y * w + x) * 4
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = a * a * 255
      }
    }
    return fromPixels(w, h, pixels, true, false)
  })
}

/** 모든 캐시된 텍스처에 이방성 필터를 켠다 (렌더러가 있어야 최대값을 안다). */
export function applyAnisotropy(renderer: THREE.WebGLRenderer) {
  const max = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  for (const texture of cache.values()) {
    if (texture.wrapS === THREE.RepeatWrapping) texture.anisotropy = max
  }
}

/** 테스트·개발용: 캐시를 비운다 */
export function disposeTextures() {
  for (const texture of cache.values()) texture.dispose()
  cache.clear()
}
