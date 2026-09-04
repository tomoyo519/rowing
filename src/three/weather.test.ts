import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COURSES } from '../game/courses'
import { profileSections } from '../game/profile'
import {
  BRIGHT_KINDS,
  WEATHER_KINDS,
  WeatherSystem,
  createWeatherAppearance,
  createWeatherSchedule,
  resolveWeatherAppearance,
  weatherAt,
  type WeatherAppearance,
  type WeatherBasePalette,
  type WeatherBlend,
  type WeatherKind,
} from './weather'

function middleOf(kind: WeatherKind, schedule: ReturnType<typeof createWeatherSchedule>) {
  const segment = schedule.find(item => item.kind === kind)
  if (!segment) throw new Error(`Missing ${kind} segment`)
  return segment.start + segment.transitionSec + (segment.end - segment.start - segment.transitionSec) / 2
}

/** 여러 seed를 돌려 원하는 날씨 조합이 있는 일정을 찾는다. */
function scheduleContaining(...kinds: WeatherKind[]) {
  const sections = Array.from({ length: 12 }, (_, i) => ({ start: i * 150, end: (i + 1) * 150 }))
  for (let index = 0; index < 512; index++) {
    const seed = `weather-containing-${kinds.join('-')}-${index}`
    const schedule = createWeatherSchedule(seed, 1_800, sections)
    if (kinds.every(kind => schedule.some(item => item.kind === kind))) {
      return { seed, schedule, sections }
    }
  }
  throw new Error(`Could not reach weather kinds: ${kinds.join(', ')}`)
}

/** 비 다음에 밝은 구간이 오는 일정 (무지개 확인용). */
function scheduleWithRainThenBright() {
  const sections = Array.from({ length: 12 }, (_, i) => ({ start: i * 150, end: (i + 1) * 150 }))
  for (let index = 0; index < 512; index++) {
    const seed = `rain-then-bright-${index}`
    const schedule = createWeatherSchedule(seed, 1_800, sections)
    const at = schedule.findIndex((item, i) => item.kind === 'rain' && BRIGHT_KINDS.includes(schedule[i + 1]?.kind as WeatherKind))
    if (at >= 0) return { schedule, rain: schedule[at]!, bright: schedule[at + 1]! }
  }
  throw new Error('Could not find rain followed by bright weather')
}

function blendSnapshot(weather: WeatherBlend) {
  return {
    cue: weather.cue,
    from: weather.from,
    to: weather.to,
    mix: weather.mix,
    base: { ...weather.base },
    rainbow: weather.rainbow,
    windStrength: weather.windStrength,
    cloudiness: weather.cloudiness,
  }
}

function appearanceSnapshot(appearance: WeatherAppearance) {
  return {
    skyTop: appearance.skyTop.getHex(),
    skyBottom: appearance.skyBottom.getHex(),
    water: appearance.water.getHex(),
    waterDeep: appearance.waterDeep.getHex(),
    land: appearance.land.getHex(),
    cloud: appearance.cloud.getHex(),
    sunColor: appearance.sunColor.getHex(),
    fogNear: appearance.fogNear,
    fogFar: appearance.fogFar,
    sunIntensity: appearance.sunIntensity,
    hemiIntensity: appearance.hemiIntensity,
    ambientIntensity: appearance.ambientIntensity,
    cloudOpacity: appearance.cloudOpacity,
    sparkle: appearance.sparkle,
    autumn: appearance.autumn,
    foliageLight: appearance.foliageLight,
  }
}

describe('날씨 일정', () => {
  it('같은 seed는 같은 일정, 다른 seed는 다른 일정을 만든다', () => {
    const first = createWeatherSchedule('rowing-weather-a', 1_200)
    expect(createWeatherSchedule('rowing-weather-a', 1_200)).toEqual(first)
    expect(createWeatherSchedule('rowing-weather-b', 1_200)).not.toEqual(first)
  })

  it('코스 구간마다 날씨가 하나씩 고정되고 구간 경계에서만 바뀐다', () => {
    for (const course of COURSES) {
      const sections = profileSections(course.profile, course.durationSec)
      const schedule = createWeatherSchedule(`${course.id}:test`, course.durationSec, sections)
      expect(schedule).toHaveLength(sections.length)
      schedule.forEach((segment, index) => {
        expect(segment.start).toBe(sections[index]!.start)
        if (index < schedule.length - 1) expect(segment.end).toBe(sections[index]!.end)
        expect(segment.transitionSec).toBeLessThan(segment.end - segment.start)
        if (index === 0) expect(segment.transitionSec).toBe(0)
        else expect(segment.transitionSec).toBeGreaterThan(0)
      })
      // 요약 화면까지 이어지도록 마지막 구간은 코스보다 길다
      expect(schedule.at(-1)!.end).toBeGreaterThan(course.durationSec)
    }
  })

  it('구간 정보가 없으면 5분 단위로 자른다', () => {
    const schedule = createWeatherSchedule('fallback', 1_800)
    expect(schedule).toHaveLength(6)
    expect(schedule[1]!.start).toBe(300)
  })

  it('밝은 날씨가 대부분이고 여섯 날씨가 모두 도달 가능하다', () => {
    const reached = new Set<WeatherKind>()
    let bright = 0
    let total = 0
    for (let index = 0; index < 60; index++) {
      const sections = Array.from({ length: 10 }, (_, i) => ({ start: i * 180, end: (i + 1) * 180 }))
      for (const item of createWeatherSchedule(`reachable-${index}`, 1_800, sections)) {
        reached.add(item.kind)
        total++
        if (BRIGHT_KINDS.includes(item.kind)) bright++
      }
    }
    expect(reached).toEqual(new Set(WEATHER_KINDS))
    expect(bright / total).toBeGreaterThan(0.6)
  })

  it('첫 구간은 대체로 밝게 시작한다', () => {
    let bright = 0
    for (let index = 0; index < 80; index++) {
      const first = createWeatherSchedule(`first-${index}`, 1_200)[0]!
      if (BRIGHT_KINDS.includes(first.kind)) bright++
    }
    expect(bright / 80).toBeGreaterThan(0.75)
  })

  it('같은 날씨가 연달아 오지 않고 눈과 비는 붙어 있지 않다', () => {
    for (let seed = 0; seed < 40; seed++) {
      const sections = Array.from({ length: 14 }, (_, i) => ({ start: i * 120, end: (i + 1) * 120 }))
      const schedule = createWeatherSchedule(`legal-${seed}`, 1_680, sections)
      schedule.forEach((segment, index) => {
        const previous = schedule[index - 1]?.kind
        if (previous === undefined) return
        expect(previous).not.toBe(segment.kind)
        expect(new Set([previous, segment.kind])).not.toEqual(new Set(['rain', 'snow']))
      })
    }
  })

  it('전환 중에도 날씨 가중치 합은 1이고 비와 눈은 동시에 오지 않는다', () => {
    const { schedule } = scheduleContaining(...WEATHER_KINDS)
    for (let time = -10; time <= 1_900; time += 1.7) {
      const weather = weatherAt(schedule, time)
      const weights = Object.values(weather.base)
      for (const weight of [...weights, weather.rainbow, weather.windStrength, weather.cloudiness]) {
        expect(Number.isFinite(weight)).toBe(true)
        expect(weight).toBeGreaterThanOrEqual(0)
        expect(weight).toBeLessThanOrEqual(1)
      }
      expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10)
      expect(weather.base.rain * weather.base.snow).toBe(0)
    }
  })

  it('전환은 구간 시작 직후에 일어나고 그 뒤로는 구간 내내 고정된다', () => {
    const { schedule } = scheduleContaining('rain', 'clear')
    const second = schedule[1]!
    const previous = schedule[0]!
    const out = weatherAt(schedule, second.start)
    expect(out.mix).toBe(0)
    expect(out.base[previous.kind]).toBe(1)
    expect(out.cue).toBe(previous.kind)

    expect(weatherAt(schedule, second.start + second.transitionSec / 2, out)).toBe(out)
    expect(out.mix).toBeCloseTo(0.5, 10)
    expect(out.base[previous.kind]).toBeCloseTo(0.5, 10)
    expect(out.base[second.kind]).toBeCloseTo(0.5, 10)
    expect(out.cue).toBe(second.kind)

    const settled = blendSnapshot(weatherAt(schedule, second.start + second.transitionSec + 1, out))
    const later = blendSnapshot(weatherAt(schedule, second.end - 1, out))
    expect(settled.base[second.kind]).toBe(1)
    expect(later.base).toEqual(settled.base)
    expect(later.mix).toBe(0)
  })

  it('무지개는 비가 그친 뒤 밝은 구간 초반에만 잠깐 뜬다', () => {
    const { schedule, rain, bright } = scheduleWithRainThenBright()
    expect(weatherAt(schedule, middleOf('rain', schedule)).rainbow).toBe(0)
    expect(weatherAt(schedule, rain.end - 1).rainbow).toBe(0)
    const peak = weatherAt(schedule, bright.start + 30).rainbow
    expect(peak).toBeGreaterThan(0.9)
    expect(weatherAt(schedule, bright.start + 120).rainbow).toBe(0)
    expect(weatherAt(schedule, bright.end - 1).rainbow).toBe(0)
  })
})

describe('날씨 외관과 고정 렌더 풀', () => {
  const base: WeatherBasePalette = {
    skyTop: new THREE.Color('#1b3a5c'),
    skyBottom: new THREE.Color('#e8a765'),
    water: new THREE.Color('#2d5a7a'),
    waterDeep: new THREE.Color('#16344a'),
    land: new THREE.Color('#1e3d2f'),
  }

  it('외관은 이전 상태와 무관하고 같은 입력을 반복해도 누적 변형되지 않는다', () => {
    const { schedule } = scheduleContaining('rain', 'clear')
    const rain = weatherAt(schedule, middleOf('rain', schedule))
    const clear = weatherAt(schedule, middleOf('clear', schedule))
    const out = resolveWeatherAppearance(base, rain)
    const firstRain = appearanceSnapshot(out)
    for (let i = 0; i < 1_000; i++) resolveWeatherAppearance(base, rain, out)
    expect(appearanceSnapshot(out)).toEqual(firstRain)

    resolveWeatherAppearance(base, clear, out)
    const freshClear = resolveWeatherAppearance(base, clear, createWeatherAppearance())
    expect(appearanceSnapshot(out)).toEqual(appearanceSnapshot(freshClear))
  })

  it('맑음과 가을 하늘은 비보다 훨씬 밝고, 가을에만 단풍이 든다', () => {
    const { schedule } = scheduleContaining('rain', 'clear', 'autumn')
    const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    const rain = resolveWeatherAppearance(base, weatherAt(schedule, middleOf('rain', schedule)))
    const clear = resolveWeatherAppearance(base, weatherAt(schedule, middleOf('clear', schedule)))
    const autumn = resolveWeatherAppearance(base, weatherAt(schedule, middleOf('autumn', schedule)))
    expect(luminance(clear.skyBottom)).toBeGreaterThan(luminance(rain.skyBottom) * 1.4)
    expect(luminance(autumn.skyBottom)).toBeGreaterThan(luminance(rain.skyBottom) * 1.4)
    expect(clear.sunIntensity).toBeGreaterThan(rain.sunIntensity * 2)
    expect(clear.sparkle).toBeGreaterThan(0.8)
    expect(rain.sparkle).toBe(0)
    expect(autumn.autumn).toBe(1)
    expect(clear.autumn).toBe(0)
    // 가을 햇살은 따뜻하다
    expect(autumn.sunColor.r).toBeGreaterThan(autumn.sunColor.b)
  })

  it('모든 날씨에서 오브젝트와 버퍼를 새로 만들지 않고 좌표를 유한하게 유지한다', () => {
    const { seed, sections } = scheduleContaining(...WEATHER_KINDS)
    const weather = new WeatherSystem(seed, 1_800, sections)
    const before: THREE.Object3D[] = []
    const bufferArrays: ArrayLike<number>[] = []
    weather.root.traverse(node => {
      before.push(node)
      const geometry = (node as THREE.Mesh).geometry
      const position = geometry?.getAttribute?.('position')
      if (position) bufferArrays.push(position.array)
    })

    const drawables = before.filter(node => (
      node instanceof THREE.Mesh
      || node instanceof THREE.Points
      || node instanceof THREE.LineSegments
    ))
    expect(drawables.length).toBeLessThanOrEqual(6)

    WEATHER_KINDS.forEach((kind, index) => {
      weather.update(100 + index * 13, middleOf(kind, weather.schedule))
    })
    const elapsed = middleOf('rain', weather.schedule)
    weather.update(1, elapsed)
    const firstState = blendSnapshot(weather.state)
    weather.update(10_000, elapsed)
    expect(blendSnapshot(weather.state)).toEqual(firstState)

    const after: THREE.Object3D[] = []
    const afterArrays: ArrayLike<number>[] = []
    weather.root.traverse(node => {
      after.push(node)
      expect(node.position.toArray().every(Number.isFinite)).toBe(true)
      const geometry = (node as THREE.Mesh).geometry
      const position = geometry?.getAttribute?.('position')
      if (position) {
        afterArrays.push(position.array)
        expect(Array.from(position.array).every(Number.isFinite)).toBe(true)
      }
    })
    expect(after).toEqual(before)
    expect(afterArrays).toEqual(bufferArrays)
    weather.dispose()
  })
})
