import * as THREE from 'three'

export const WEATHER_KINDS = ['sun', 'wind', 'rain', 'rainbow', 'snow'] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]
export type BaseWeatherKind = 'sun' | 'wind' | 'rain' | 'snow'

export interface WeatherSegment {
  kind: WeatherKind
  start: number
  end: number
  transitionSec: number
}

export interface WeatherWeights {
  sun: number
  wind: number
  rain: number
  snow: number
}

export interface WeatherBlend {
  cue: WeatherKind
  from: WeatherKind
  to: WeatherKind
  mix: number
  base: WeatherWeights
  /** 비가 잦아들며 해가 돌아오는 동안만 켜지는 별도 오버레이. */
  rainbow: number
  windStrength: number
  cloudiness: number
}

export interface WeatherBasePalette {
  skyTop: THREE.Color
  skyBottom: THREE.Color
  water: THREE.Color
  waterDeep: THREE.Color
  land: THREE.Color
}

export interface WeatherAppearance {
  skyTop: THREE.Color
  skyBottom: THREE.Color
  water: THREE.Color
  waterDeep: THREE.Color
  land: THREE.Color
  cloud: THREE.Color
  fogNear: number
  fogFar: number
  sunIntensity: number
  hemiIntensity: number
  ambientIntensity: number
  cloudOpacity: number
}

const BASE_KINDS: BaseWeatherKind[] = ['sun', 'wind', 'rain', 'snow']
const TRANSITION_SEC = 18
const RAIN_COUNT = 160
const SNOW_COUNT = 80
const WIND_COUNT = 24

const DURATION_RANGE: Record<WeatherKind, readonly [number, number]> = {
  sun: [95, 165],
  wind: [85, 145],
  rain: [120, 210],
  rainbow: [55, 90],
  snow: [120, 210],
}

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: string) {
  let state = hashString(seed)
  return () => {
    state += 0x6d2b79f5
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 한 세션 동안 사용할 날씨 타임라인.
 *
 * 매 세션의 seed가 달라 시작 날씨, 사건 종류, 길이가 모두 달라진다.
 * 비와 눈 사이에는 항상 맑은 구간이 있고 무지개는 반드시 비 직후에만 나타난다.
 */
export function createWeatherSchedule(seed: string, durationSec: number): WeatherSegment[] {
  const random = seededRandom(seed)
  const schedule: WeatherSegment[] = []
  const target = Math.max(1, durationSec) + 90
  let cursor = 0

  const add = (kind: WeatherKind) => {
    if (schedule[schedule.length - 1]?.kind === kind) return
    const [min, max] = DURATION_RANGE[kind]
    const duration = min + random() * (max - min)
    schedule.push({ kind, start: cursor, end: cursor + duration, transitionSec: TRANSITION_SEC })
    cursor += duration
  }

  type WeatherEvent = 'wind' | 'rain' | 'snow'
  let previousEvent: WeatherEvent | undefined
  const chooseEvent = (): WeatherEvent => {
    const roll = random()
    let event: WeatherEvent = roll < 0.45 ? 'rain' : roll < 0.72 ? 'wind' : 'snow'
    if (event === previousEvent) {
      const alternatives: WeatherEvent[] = event === 'rain'
        ? ['wind', 'snow']
        : event === 'wind'
          ? ['rain', 'snow']
          : ['rain', 'wind']
      event = alternatives[Math.floor(random() * alternatives.length)]!
    }
    previousEvent = event
    return event
  }

  // 매번 맑은 날부터 시작하지 않게 해 첫 화면부터 세션별 분위기가 달라진다.
  const initialRoll = random()
  if (initialRoll < 0.34) {
    add('sun')
  } else {
    const initial = chooseEvent()
    add(initial)
    if (initial === 'rain') add('rainbow')
    add('sun')
  }

  while (cursor < target) {
    const event = chooseEvent()
    add(event)
    if (event === 'rain') add('rainbow')
    add('sun')
  }

  return schedule
}

function createBlend(): WeatherBlend {
  return {
    cue: 'sun', from: 'sun', to: 'sun', mix: 0,
    base: { sun: 1, wind: 0, rain: 0, snow: 0 },
    rainbow: 0, windStrength: 0.08, cloudiness: 0.22,
  }
}

function baseKind(kind: WeatherKind): BaseWeatherKind {
  return kind === 'rainbow' ? 'sun' : kind
}

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/** 세션 경과 시간만으로 날씨를 샘플링한다. out을 주면 매 프레임 할당하지 않는다. */
export function weatherAt(
  schedule: WeatherSegment[],
  elapsedSec: number,
  out: WeatherBlend = createBlend(),
) {
  if (schedule.length === 0) throw new Error('Weather schedule must not be empty')
  const last = schedule[schedule.length - 1]!
  const time = Math.max(0, Math.min(elapsedSec, last.end))

  let low = 0
  let high = schedule.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (schedule[mid]!.end <= time) low = mid + 1
    else high = mid
  }

  const current = schedule[low]!
  const next = schedule[low + 1]
  const transitionStart = current.end - current.transitionSec
  const rawMix = next && time >= transitionStart
    ? (time - transitionStart) / current.transitionSec
    : 0
  const mix = next ? smoothstep(rawMix) : 0
  const from = current.kind
  const to = next && rawMix > 0 ? next.kind : from

  out.from = from
  out.to = to
  out.mix = mix
  out.cue = mix >= 0.5 ? to : from
  for (const kind of BASE_KINDS) out.base[kind] = 0

  const fromBase = baseKind(from)
  const toBase = baseKind(to)
  out.base[fromBase] += 1 - mix
  out.base[toBase] += mix

  const fromRainbow = from === 'rainbow' ? 1 : 0
  const toRainbow = to === 'rainbow' ? 1 : 0
  out.rainbow = fromRainbow * (1 - mix) + toRainbow * mix
  out.windStrength = (
    out.base.sun * 0.08
    + out.base.wind
    + out.base.rain * 0.55
    + out.base.snow * 0.35
  )
  out.cloudiness = Math.min(1,
    out.base.sun * 0.22
    + out.base.wind * 0.56
    + out.base.rain
    + out.base.snow * 0.88
    + out.rainbow * 0.18,
  )
  return out
}

interface WeatherStyle {
  blend: number
  skyTop: THREE.Color
  skyBottom: THREE.Color
  water: THREE.Color
  waterDeep: THREE.Color
  land: THREE.Color
  cloud: THREE.Color
  fogNear: number
  fogFar: number
  sunIntensity: number
  hemiIntensity: number
  ambientIntensity: number
  cloudOpacity: number
}

const style = (
  blend: number,
  colors: readonly [string, string, string, string, string, string],
  values: readonly [number, number, number, number, number, number],
): WeatherStyle => ({
  blend,
  skyTop: new THREE.Color(colors[0]),
  skyBottom: new THREE.Color(colors[1]),
  water: new THREE.Color(colors[2]),
  waterDeep: new THREE.Color(colors[3]),
  land: new THREE.Color(colors[4]),
  cloud: new THREE.Color(colors[5]),
  fogNear: values[0], fogFar: values[1], sunIntensity: values[2],
  hemiIntensity: values[3], ambientIntensity: values[4], cloudOpacity: values[5],
})

const STYLES: Record<BaseWeatherKind, WeatherStyle> = {
  sun: style(
    0.36,
    ['#4387c5', '#f3c47e', '#397ba1', '#173e55', '#315e38', '#ffffff'],
    [48, 280, 1.68, 0.93, 0.28, 0.28],
  ),
  wind: style(
    0.30,
    ['#57788f', '#b7c5cb', '#35657f', '#183748', '#31543b', '#c2ccd1'],
    [38, 225, 1.18, 0.82, 0.24, 0.50],
  ),
  rain: style(
    0.58,
    ['#344958', '#71828c', '#284f65', '#132c3a', '#273d34', '#7f8d98'],
    [26, 150, 0.62, 0.70, 0.20, 0.72],
  ),
  snow: style(
    0.56,
    ['#9eafbd', '#d7dfe4', '#53778b', '#294757', '#a9b5aa', '#d6e0e6'],
    [30, 180, 0.86, 0.78, 0.24, 0.60],
  ),
}

const RAINBOW_SKY = new THREE.Color('#86b8d7')
const RAINBOW_WATER = new THREE.Color('#3f7896')
const CLOUD_BASE = new THREE.Color('#f6fbff')
const COLOR_SCRATCH = new THREE.Color()

export function createWeatherAppearance(): WeatherAppearance {
  return {
    skyTop: new THREE.Color(), skyBottom: new THREE.Color(),
    water: new THREE.Color(), waterDeep: new THREE.Color(),
    land: new THREE.Color(), cloud: new THREE.Color(),
    fogNear: 0, fogFar: 0, sunIntensity: 0,
    hemiIntensity: 0, ambientIntensity: 0, cloudOpacity: 0,
  }
}

function mixColor(
  out: THREE.Color,
  base: THREE.Color,
  key: 'skyTop' | 'skyBottom' | 'water' | 'waterDeep' | 'land' | 'cloud',
  weights: WeatherWeights,
) {
  out.setRGB(0, 0, 0)
  for (const kind of BASE_KINDS) {
    const weight = weights[kind]
    COLOR_SCRATCH.copy(base).lerp(STYLES[kind][key], STYLES[kind].blend)
    out.r += COLOR_SCRATCH.r * weight
    out.g += COLOR_SCRATCH.g * weight
    out.b += COLOR_SCRATCH.b * weight
  }
}

/** 항상 원래 코스 팔레트에서 다시 계산하므로 반복 적용해도 색이 누적 변형되지 않는다. */
export function resolveWeatherAppearance(
  base: WeatherBasePalette,
  weather: WeatherBlend,
  out: WeatherAppearance = createWeatherAppearance(),
) {
  mixColor(out.skyTop, base.skyTop, 'skyTop', weather.base)
  mixColor(out.skyBottom, base.skyBottom, 'skyBottom', weather.base)
  mixColor(out.water, base.water, 'water', weather.base)
  mixColor(out.waterDeep, base.waterDeep, 'waterDeep', weather.base)
  mixColor(out.land, base.land, 'land', weather.base)
  mixColor(out.cloud, CLOUD_BASE, 'cloud', weather.base)

  if (weather.rainbow > 0) {
    const amount = weather.rainbow * 0.12
    out.skyTop.lerp(RAINBOW_SKY, amount)
    out.skyBottom.lerp(RAINBOW_SKY, amount * 0.45)
    out.water.lerp(RAINBOW_WATER, amount * 0.5)
  }

  out.fogNear = 0
  out.fogFar = 0
  out.sunIntensity = 0
  out.hemiIntensity = 0
  out.ambientIntensity = 0
  out.cloudOpacity = 0
  for (const kind of BASE_KINDS) {
    const weight = weather.base[kind]
    const preset = STYLES[kind]
    out.fogNear += preset.fogNear * weight
    out.fogFar += preset.fogFar * weight
    out.sunIntensity += preset.sunIntensity * weight
    out.hemiIntensity += preset.hemiIntensity * weight
    out.ambientIntensity += preset.ambientIntensity * weight
    out.cloudOpacity += preset.cloudOpacity * weight
  }
  out.sunIntensity += weather.rainbow * 0.08
  return out
}

function wrap(value: number, min: number, span: number) {
  return min + ((value - min) % span + span) % span
}

function createRainbowGeometry() {
  const positions: number[] = []
  const colors: number[] = []
  const palette = ['#ef5a4c', '#f5a34a', '#f7d85b', '#58b86b', '#4e88d9', '#8c67c9']
  const segments = 28

  const vertex = (radius: number, angle: number, color: THREE.Color) => {
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0)
    colors.push(color.r, color.g, color.b)
  }

  palette.forEach((hex, band) => {
    const color = new THREE.Color(hex)
    const outer = 29 - band * 1.15
    const inner = outer - 1.0
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI
      const b = ((i + 1) / segments) * Math.PI
      vertex(inner, a, color); vertex(outer, a, color); vertex(outer, b, color)
      vertex(inner, a, color); vertex(outer, b, color); vertex(inner, b, color)
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geometry
}

/** 고정된 소수의 draw object로 모든 날씨 효과를 표현한다. */
export class WeatherSystem {
  /** 태양과 무지개는 월드의 먼 하늘에 고정된다. */
  readonly root = new THREE.Group()
  /** 비·눈·바람만 카메라 근처의 고정 입자 볼륨을 사용한다. */
  readonly precipitationRoot = new THREE.Group()
  readonly schedule: WeatherSegment[]
  readonly state = createBlend()

  private rainPositions = new Float32Array(RAIN_COUNT * 2 * 3)
  private rainSeeds = new Float32Array(RAIN_COUNT * 4)
  private snowPositions = new Float32Array(SNOW_COUNT * 3)
  private snowSeeds = new Float32Array(SNOW_COUNT * 4)
  private windPositions = new Float32Array(WIND_COUNT * 2 * 3)
  private windSeeds = new Float32Array(WIND_COUNT * 4)

  private rainMaterial = new THREE.LineBasicMaterial({
    color: '#a8d8ee', transparent: true, opacity: 0, depthWrite: false, depthTest: true,
  })
  private snowMaterial = new THREE.PointsMaterial({
    color: '#f4fbff', size: 0.32, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, depthTest: true,
  })
  private windMaterial = new THREE.LineBasicMaterial({
    color: '#d8e8ed', transparent: true, opacity: 0, depthWrite: false, depthTest: true,
  })
  private rainbowMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
    depthTest: true, side: THREE.DoubleSide, fog: false,
  })
  private sunCoreMaterial = new THREE.MeshBasicMaterial({
    color: '#ffd46c', transparent: true, opacity: 0, depthWrite: false, fog: false,
  })
  private sunHaloMaterial = new THREE.MeshBasicMaterial({
    color: '#ffe7a3', transparent: true, opacity: 0, depthWrite: false, fog: false,
  })

  private rain: THREE.LineSegments
  private snow: THREE.Points
  private wind: THREE.LineSegments
  private rainbow: THREE.Mesh
  private sunGroup = new THREE.Group()

  constructor(seed: string, durationSec: number) {
    this.root.name = 'weather-fx'
    this.precipitationRoot.name = 'weather-precipitation'
    this.schedule = createWeatherSchedule(seed, durationSec)
    const random = seededRandom(`${seed}:particles`)
    for (let i = 0; i < RAIN_COUNT; i++) {
      const offset = i * 4
      this.rainSeeds[offset] = random() * 2 - 1
      this.rainSeeds[offset + 1] = random()
      this.rainSeeds[offset + 2] = random()
      this.rainSeeds[offset + 3] = random()
    }
    for (let i = 0; i < SNOW_COUNT; i++) {
      const offset = i * 4
      this.snowSeeds[offset] = random() * 2 - 1
      this.snowSeeds[offset + 1] = random()
      this.snowSeeds[offset + 2] = random()
      this.snowSeeds[offset + 3] = random() * Math.PI * 2
    }
    for (let i = 0; i < WIND_COUNT; i++) {
      const offset = i * 4
      this.windSeeds[offset] = random()
      this.windSeeds[offset + 1] = random()
      this.windSeeds[offset + 2] = random()
      this.windSeeds[offset + 3] = random()
    }

    const rainGeometry = new THREE.BufferGeometry()
    rainGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.rainPositions, 3).setUsage(THREE.DynamicDrawUsage),
    )
    this.rain = new THREE.LineSegments(rainGeometry, this.rainMaterial)
    this.rain.frustumCulled = false

    const snowGeometry = new THREE.BufferGeometry()
    snowGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.snowPositions, 3).setUsage(THREE.DynamicDrawUsage),
    )
    this.snow = new THREE.Points(snowGeometry, this.snowMaterial)
    this.snow.frustumCulled = false

    const windGeometry = new THREE.BufferGeometry()
    windGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.windPositions, 3).setUsage(THREE.DynamicDrawUsage),
    )
    this.wind = new THREE.LineSegments(windGeometry, this.windMaterial)
    this.wind.frustumCulled = false

    this.rainbow = new THREE.Mesh(createRainbowGeometry(), this.rainbowMaterial)
    this.rainbow.position.set(-100, -18, 0)
    this.rainbow.rotation.y = Math.PI / 2
    this.rainbow.frustumCulled = false

    const core = new THREE.Mesh(new THREE.SphereGeometry(3.1, 12, 8), this.sunCoreMaterial)
    const halo = new THREE.Mesh(new THREE.SphereGeometry(5.2, 12, 8), this.sunHaloMaterial)
    this.sunGroup.position.set(-105, 46, -20)
    this.sunGroup.add(halo, core)

    this.precipitationRoot.add(this.rain, this.snow, this.wind)
    this.root.add(this.rainbow, this.sunGroup, this.precipitationRoot)
    this.update(0, 0)
  }

  update(animationTimeSec: number, elapsedSec: number) {
    weatherAt(this.schedule, elapsedSec, this.state)
    const rainOpacity = this.state.base.rain * 0.18
    const snowOpacity = this.state.base.snow * 0.46
    const windOpacity = this.state.base.wind * 0.16
    const sunOpacity = Math.max(0, this.state.base.sun - this.state.base.wind * 0.10)

    this.rainMaterial.opacity = rainOpacity
    this.snowMaterial.opacity = snowOpacity
    this.windMaterial.opacity = windOpacity
    this.rainbowMaterial.opacity = this.state.rainbow * 0.25
    this.sunCoreMaterial.opacity = sunOpacity * 0.95
    this.sunHaloMaterial.opacity = sunOpacity * 0.14

    this.rain.visible = rainOpacity > 0.002
    this.snow.visible = snowOpacity > 0.002
    this.wind.visible = windOpacity > 0.002
    this.rainbow.visible = this.rainbowMaterial.opacity > 0.002
    this.sunGroup.visible = sunOpacity > 0.002

    if (this.rain.visible) this.updateRain(animationTimeSec)
    if (this.snow.visible) this.updateSnow(animationTimeSec)
    if (this.wind.visible) this.updateWind(animationTimeSec)
    return this.state
  }

  private updateRain(timeSec: number) {
    const wind = this.state.windStrength
    for (let i = 0; i < RAIN_COUNT; i++) {
      const seed = i * 4
      const depth = 8 + this.rainSeeds[seed + 2]! * 48
      const xRange = depth * 0.48
      const ySpan = depth * 0.52
      const x = wrap(
        this.rainSeeds[seed]! * xRange + timeSec * wind * 1.8,
        -xRange, xRange * 2,
      )
      const y = wrap(
        this.rainSeeds[seed + 1]! * ySpan - timeSec * (10 + this.rainSeeds[seed + 3]! * 7),
        -depth * 0.18, ySpan,
      )
      const z = -depth
      const offset = i * 6
      this.rainPositions[offset] = x
      this.rainPositions[offset + 1] = y
      this.rainPositions[offset + 2] = z
      this.rainPositions[offset + 3] = x - 0.14 - wind * 0.38
      this.rainPositions[offset + 4] = y - 0.72
      this.rainPositions[offset + 5] = z
    }
    ;(this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }

  private updateSnow(timeSec: number) {
    const wind = this.state.windStrength
    for (let i = 0; i < SNOW_COUNT; i++) {
      const seed = i * 4
      const depth = 7 + this.snowSeeds[seed + 2]! * 44
      const xRange = depth * 0.48
      const ySpan = depth * 0.54
      const phase = this.snowSeeds[seed + 3]!
      const x = wrap(
        this.snowSeeds[seed]! * xRange
          + Math.sin(timeSec * 0.9 + phase) * (0.2 + depth * 0.012)
          + timeSec * wind * 0.24,
        -xRange, xRange * 2,
      )
      const y = wrap(
        this.snowSeeds[seed + 1]! * ySpan
          - timeSec * (0.72 + (phase / (Math.PI * 2)) * 0.72),
        -depth * 0.20, ySpan,
      )
      const offset = i * 3
      this.snowPositions[offset] = x
      this.snowPositions[offset + 1] = y
      this.snowPositions[offset + 2] = -depth
    }
    ;(this.snow.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }

  private updateWind(timeSec: number) {
    for (let i = 0; i < WIND_COUNT; i++) {
      const seed = i * 4
      const depth = 12 + this.windSeeds[seed + 2]! * 42
      const xRange = depth * 0.48
      const y = depth * (0.06 + this.windSeeds[seed + 1]! * 0.20)
      const x = wrap(
        -xRange + this.windSeeds[seed]! * xRange * 2
          + timeSec * (5 + this.windSeeds[seed + 3]! * 4),
        -xRange, xRange * 2,
      )
      const length = 0.7 + depth * 0.018
      const offset = i * 6
      this.windPositions[offset] = x
      this.windPositions[offset + 1] = y
      this.windPositions[offset + 2] = -depth
      this.windPositions[offset + 3] = x - length
      this.windPositions[offset + 4] = y - length * 0.06
      this.windPositions[offset + 5] = -depth
    }
    ;(this.wind.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    const roots = this.precipitationRoot.parent === this.root
      ? [this.root]
      : [this.root, this.precipitationRoot]
    const disposed = new Set<THREE.Object3D>()
    roots.forEach(root => root.traverse(node => {
      if (disposed.has(node)) return
      disposed.add(node)
      const drawable = node as THREE.Mesh
      drawable.geometry?.dispose?.()
      const material = drawable.material
      if (Array.isArray(material)) material.forEach(item => item.dispose())
      else material?.dispose?.()
    }))
  }
}
