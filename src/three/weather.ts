import * as THREE from 'three'

/**
 * 날씨.
 *
 * 코스 구간(섹션)마다 날씨 하나가 고정된다. 구간이 바뀔 때만 다음 날씨로
 * 크로스페이드하므로 한 구간 안에서는 하늘이 흔들리지 않는다.
 *
 * 맑은 날이 대부분이다 — 쨍한 파란 하늘, 햇빛이 물에 반짝이는 가을 하늘, 황금빛 오후.
 * 바람·비·눈은 가끔 끼어들고, 비 뒤에 맑아지면 무지개가 잠깐 뜬다.
 */
export const WEATHER_KINDS = ['clear', 'autumn', 'sun', 'wind', 'rain', 'snow'] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]
/** 하늘색 팔레트를 갖는 날씨. 무지개는 팔레트가 아니라 오버레이라 여기 없다. */
export type BaseWeatherKind = WeatherKind

/** 밝은 날씨 — 무지개는 비 뒤에 이런 날씨가 올 때만 뜬다. */
export const BRIGHT_KINDS: readonly WeatherKind[] = ['clear', 'autumn', 'sun']

export interface WeatherSection {
  start: number
  end: number
}

export interface WeatherSegment {
  kind: WeatherKind
  start: number
  end: number
  /** 구간 시작 직후 이전 날씨에서 넘어오는 데 걸리는 시간 */
  transitionSec: number
}

export type WeatherWeights = Record<WeatherKind, number>

export interface WeatherBlend {
  cue: WeatherKind
  from: WeatherKind
  to: WeatherKind
  mix: number
  base: WeatherWeights
  /** 비가 그치고 맑아진 직후에만 켜지는 별도 오버레이. */
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
  sunColor: THREE.Color
  fogNear: number
  fogFar: number
  sunIntensity: number
  hemiIntensity: number
  ambientIntensity: number
  cloudOpacity: number
  /** 물 위 햇빛 반짝임 세기 0..1 */
  sparkle: number
  /** 나뭇잎이 단풍으로 물드는 정도 0..1 */
  autumn: number
  /** 나뭇잎 밝기 배율 — 흐린 날은 잎도 어두워진다 */
  foliageLight: number
}

const TRANSITION_SEC = 18
const RAINBOW_SEC = 80
const RAIN_COUNT = 160
const SNOW_COUNT = 80
const WIND_COUNT = 24
const FALLBACK_SECTION_SEC = 300

/** 한 구간의 날씨를 뽑는 가중치. 밝은 날이 2/3 이상이다. */
const KIND_WEIGHTS: WeatherWeights = {
  clear: 0.27, autumn: 0.27, sun: 0.16, wind: 0.12, rain: 0.11, snow: 0.07,
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

function isBright(kind: WeatherKind) {
  return BRIGHT_KINDS.includes(kind)
}

/** 같은 날씨가 연달아 오지 않고, 비와 눈은 붙어 있지 않게 다음 날씨를 고른다. */
function pickKind(random: () => number, previous: WeatherKind | undefined, preferBright: boolean) {
  const weights: WeatherWeights = { ...KIND_WEIGHTS }
  if (previous) weights[previous] = 0
  if (previous === 'rain') weights.snow = 0
  if (previous === 'snow') weights.rain = 0
  if (preferBright) {
    for (const kind of WEATHER_KINDS) if (!isBright(kind)) weights[kind] *= 0.25
  }
  let total = 0
  for (const kind of WEATHER_KINDS) total += weights[kind]
  let roll = random() * total
  for (const kind of WEATHER_KINDS) {
    roll -= weights[kind]
    if (roll <= 0 && weights[kind] > 0) return kind
  }
  return 'clear'
}

/**
 * 한 세션 동안 사용할 날씨 타임라인.
 *
 * sections를 주면 구간마다 날씨 하나가 고정된다. 없으면 5분 단위로 자른다.
 * 마지막 구간은 세션이 끝난 뒤에도 요약 화면까지 이어지도록 90초 연장한다.
 */
export function createWeatherSchedule(
  seed: string,
  durationSec: number,
  sections?: readonly WeatherSection[],
): WeatherSegment[] {
  const random = seededRandom(seed)
  const duration = Math.max(1, durationSec)
  const spans: WeatherSection[] = sections && sections.length > 0
    ? sections.map(section => ({ start: section.start, end: section.end }))
    : []
  if (spans.length === 0) {
    for (let t = 0; t < duration; t += FALLBACK_SECTION_SEC) {
      spans.push({ start: t, end: Math.min(duration, t + FALLBACK_SECTION_SEC) })
    }
  }

  const schedule: WeatherSegment[] = []
  let previous: WeatherKind | undefined
  spans.forEach((span, index) => {
    // 첫 화면은 대체로 밝게 시작한다.
    const kind = pickKind(random, previous, index === 0 && random() < 0.8)
    const length = span.end - span.start
    schedule.push({
      kind,
      start: span.start,
      end: span.end,
      transitionSec: index === 0 ? 0 : Math.min(TRANSITION_SEC, length * 0.3),
    })
    previous = kind
  })
  schedule[schedule.length - 1]!.end += 90
  return schedule
}

function createBlend(): WeatherBlend {
  return {
    cue: 'clear', from: 'clear', to: 'clear', mix: 0,
    base: { clear: 1, autumn: 0, sun: 0, wind: 0, rain: 0, snow: 0 },
    rainbow: 0, windStrength: 0.06, cloudiness: 0.12,
  }
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
  const previous = schedule[low - 1]
  const into = time - current.start
  const transitioning = previous !== undefined
    && current.transitionSec > 0
    && into < current.transitionSec
  const rawMix = transitioning ? into / current.transitionSec : 1
  const mix = transitioning ? smoothstep(rawMix) : 0
  const from = transitioning ? previous.kind : current.kind
  const to = current.kind

  out.from = from
  out.to = to
  out.mix = mix
  out.cue = mix >= 0.5 || !transitioning ? to : from
  for (const kind of WEATHER_KINDS) out.base[kind] = 0
  out.base[from] += 1 - mix
  out.base[to] += mix

  // 무지개: 비 구간이 끝나고 밝은 구간이 시작된 직후에만.
  out.rainbow = 0
  if (previous?.kind === 'rain' && isBright(current.kind)) {
    const fadeIn = smoothstep(into / 16)
    const fadeOut = 1 - smoothstep((into - (RAINBOW_SEC - 24)) / 24)
    const beforeEnd = 1 - smoothstep((time - (current.end - 14)) / 14)
    out.rainbow = Math.max(0, Math.min(1, fadeIn * fadeOut * beforeEnd))
  }

  const b = out.base
  out.windStrength = Math.min(1,
    b.clear * 0.06 + b.autumn * 0.12 + b.sun * 0.08
    + b.wind + b.rain * 0.55 + b.snow * 0.35,
  )
  out.cloudiness = Math.min(1,
    b.clear * 0.12 + b.autumn * 0.10 + b.sun * 0.22
    + b.wind * 0.56 + b.rain + b.snow * 0.88 + out.rainbow * 0.18,
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
  sunColor: THREE.Color
  fogNear: number
  fogFar: number
  sunIntensity: number
  hemiIntensity: number
  ambientIntensity: number
  cloudOpacity: number
  sparkle: number
  autumn: number
  foliageLight: number
}

const style = (
  blend: number,
  colors: readonly [string, string, string, string, string, string, string],
  values: readonly [number, number, number, number, number, number],
  extra: readonly [number, number, number],
): WeatherStyle => ({
  blend,
  skyTop: new THREE.Color(colors[0]),
  skyBottom: new THREE.Color(colors[1]),
  water: new THREE.Color(colors[2]),
  waterDeep: new THREE.Color(colors[3]),
  land: new THREE.Color(colors[4]),
  cloud: new THREE.Color(colors[5]),
  sunColor: new THREE.Color(colors[6]),
  fogNear: values[0], fogFar: values[1], sunIntensity: values[2],
  hemiIntensity: values[3], ambientIntensity: values[4], cloudOpacity: values[5],
  sparkle: extra[0], autumn: extra[1], foliageLight: extra[2],
})

/**
 * 날씨별 팔레트. blend가 클수록 코스 고유 팔레트보다 날씨색이 강하게 나온다.
 * 밝은 날씨는 blend를 높여 어두운 코스 팔레트에 눌리지 않게 했다.
 */
const STYLES: Record<BaseWeatherKind, WeatherStyle> = {
  // 쨍한 한낮 — 진한 파랑에서 하얗게 풀리는 하늘
  clear: style(
    0.9,
    ['#3a8fe2', '#dcefff', '#2f7fb2', '#17496b', '#3f7d3c', '#ffffff', '#fff6e4'],
    [64, 380, 2.2, 1.02, 0.34, 0.85],
    [0.9, 0, 1.06],
  ),
  // 가을 하늘 — 높고 맑은 파랑, 지평선은 따뜻한 크림색, 단풍 든 나무와 반짝이는 물
  autumn: style(
    0.88,
    ['#4692dc', '#f4e0bb', '#3b7a9a', '#1c4862', '#7f8a3c', '#fff8ee', '#ffd9a4'],
    [58, 350, 2.05, 0.94, 0.32, 0.7],
    [1.0, 1, 1.0],
  ),
  // 황금빛 오후
  sun: style(
    0.72,
    ['#5a9bd6', '#f8d194', '#3d7fa6', '#1a4359', '#3f6d3b', '#fff1dc', '#ffcb8e'],
    [52, 300, 1.85, 0.9, 0.3, 0.8],
    [0.8, 0.12, 0.98],
  ),
  wind: style(
    0.5,
    ['#6a93b4', '#d3dee6', '#3c6f8c', '#1c3e52', '#3e6a44', '#e0e7ec', '#f2f5f7'],
    [42, 240, 1.35, 0.86, 0.28, 0.85],
    [0.3, 0, 0.9],
  ),
  rain: style(
    0.62,
    ['#4a5f70', '#8b9aa5', '#2f5871', '#14303f', '#2f4a3c', '#8f9ca6', '#dfe6ec'],
    [28, 160, 0.7, 0.72, 0.22, 0.9],
    [0, 0, 0.72],
  ),
  snow: style(
    0.58,
    ['#9eafbd', '#d7dfe4', '#53778b', '#294757', '#a9b5aa', '#d6e0e6', '#eef3f8'],
    [30, 180, 0.9, 0.8, 0.24, 0.85],
    [0.12, 0, 0.86],
  ),
}

const RAINBOW_SKY = new THREE.Color('#86b8d7')
const RAINBOW_WATER = new THREE.Color('#3f7896')
const CLOUD_BASE = new THREE.Color('#f6fbff')
const SUN_BASE = new THREE.Color('#ffffff')
const COLOR_SCRATCH = new THREE.Color()

export function createWeatherAppearance(): WeatherAppearance {
  return {
    skyTop: new THREE.Color(), skyBottom: new THREE.Color(),
    water: new THREE.Color(), waterDeep: new THREE.Color(),
    land: new THREE.Color(), cloud: new THREE.Color(), sunColor: new THREE.Color(),
    fogNear: 0, fogFar: 0, sunIntensity: 0,
    hemiIntensity: 0, ambientIntensity: 0, cloudOpacity: 0,
    sparkle: 0, autumn: 0, foliageLight: 1,
  }
}

function mixColor(
  out: THREE.Color,
  base: THREE.Color,
  key: 'skyTop' | 'skyBottom' | 'water' | 'waterDeep' | 'land' | 'cloud' | 'sunColor',
  weights: WeatherWeights,
) {
  out.setRGB(0, 0, 0)
  for (const kind of WEATHER_KINDS) {
    const weight = weights[kind]
    if (weight <= 0) continue
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
  mixColor(out.sunColor, SUN_BASE, 'sunColor', weather.base)

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
  out.sparkle = 0
  out.autumn = 0
  out.foliageLight = 0
  for (const kind of WEATHER_KINDS) {
    const weight = weather.base[kind]
    if (weight <= 0) continue
    const preset = STYLES[kind]
    out.fogNear += preset.fogNear * weight
    out.fogFar += preset.fogFar * weight
    out.sunIntensity += preset.sunIntensity * weight
    out.hemiIntensity += preset.hemiIntensity * weight
    out.ambientIntensity += preset.ambientIntensity * weight
    out.cloudOpacity += preset.cloudOpacity * weight
    out.sparkle += preset.sparkle * weight
    out.autumn += preset.autumn * weight
    out.foliageLight += preset.foliageLight * weight
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
    color: '#fff3c9', transparent: true, opacity: 0, depthWrite: false, fog: false,
  })
  private sunHaloMaterial = new THREE.MeshBasicMaterial({
    color: '#ffe7a3', transparent: true, opacity: 0, depthWrite: false, fog: false,
  })

  private rain: THREE.LineSegments
  private snow: THREE.Points
  private wind: THREE.LineSegments
  private rainbow: THREE.Mesh
  private sunGroup = new THREE.Group()

  constructor(seed: string, durationSec: number, sections?: readonly WeatherSection[]) {
    this.root.name = 'weather-fx'
    this.precipitationRoot.name = 'weather-precipitation'
    this.schedule = createWeatherSchedule(seed, durationSec, sections)
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
    const halo = new THREE.Mesh(new THREE.SphereGeometry(5.6, 12, 8), this.sunHaloMaterial)
    this.sunGroup.position.set(-105, 52, -20)
    this.sunGroup.add(halo, core)

    this.precipitationRoot.add(this.rain, this.snow, this.wind)
    this.root.add(this.rainbow, this.sunGroup, this.precipitationRoot)
    this.update(0, 0)
  }

  update(animationTimeSec: number, elapsedSec: number) {
    weatherAt(this.schedule, elapsedSec, this.state)
    const b = this.state.base
    const rainOpacity = b.rain * 0.18
    const snowOpacity = b.snow * 0.46
    const windOpacity = b.wind * 0.16
    const sunOpacity = Math.max(0, b.clear + b.autumn + b.sun + b.wind * 0.35 + b.snow * 0.15)

    this.rainMaterial.opacity = rainOpacity
    this.snowMaterial.opacity = snowOpacity
    this.windMaterial.opacity = windOpacity
    this.rainbowMaterial.opacity = this.state.rainbow * 0.25
    this.sunCoreMaterial.opacity = sunOpacity * 0.95
    this.sunHaloMaterial.opacity = sunOpacity * (0.12 + b.autumn * 0.06 + b.sun * 0.08)
    // 가을·황금빛 오후는 해가 더 노랗다.
    this.sunCoreMaterial.color.setRGB(1, 0.96 - (b.sun + b.autumn) * 0.1, 0.8 - (b.sun + b.autumn) * 0.25)

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
