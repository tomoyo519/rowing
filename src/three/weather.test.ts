import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COURSES } from '../game/courses'
import {
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
  return segment.start + (segment.end - segment.start - segment.transitionSec) / 2
}

function scheduleContaining(...kinds: WeatherKind[]) {
  for (let index = 0; index < 256; index++) {
    const seed = `weather-containing-${kinds.join('-')}-${index}`
    const schedule = createWeatherSchedule(seed, 1_800)
    if (kinds.every(kind => schedule.some(item => item.kind === kind))) {
      return { seed, schedule }
    }
  }
  throw new Error(`Could not reach weather kinds: ${kinds.join(', ')}`)
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
    fogNear: appearance.fogNear,
    fogFar: appearance.fogFar,
    sunIntensity: appearance.sunIntensity,
    hemiIntensity: appearance.hemiIntensity,
    ambientIntensity: appearance.ambientIntensity,
    cloudOpacity: appearance.cloudOpacity,
  }
}

describe('날씨 일정', () => {
  it('같은 seed는 같은 일정, 다른 seed는 다른 일정을 만든다', () => {
    const first = createWeatherSchedule('rowing-weather-a', 1_200)
    expect(createWeatherSchedule('rowing-weather-a', 1_200)).toEqual(first)
    expect(createWeatherSchedule('rowing-weather-b', 1_200)).not.toEqual(first)
  })

  it('모든 코스에서 정렬된 일정이 세션을 덮고 seed 묶음에서 다섯 날씨가 도달 가능하다', () => {
    const reached = new Set<WeatherKind>()
    for (const course of COURSES) {
      const schedule = createWeatherSchedule(`${course.id}:test`, course.durationSec)
      expect(schedule[0]?.start).toBe(0)
      expect(schedule[0]?.kind).not.toBe('rainbow')
      expect(schedule.at(-1)!.end).toBeGreaterThan(course.durationSec)
      schedule.forEach(item => reached.add(item.kind))

      schedule.forEach((segment, index) => {
        expect(segment.end).toBeGreaterThan(segment.start)
        expect(segment.transitionSec).toBeGreaterThan(0)
        expect(segment.transitionSec).toBeLessThan(segment.end - segment.start)
        if (index > 0) expect(segment.start).toBe(schedule[index - 1]!.end)
      })
    }
    for (let index = 0; index < 32; index++) {
      createWeatherSchedule(`reachable-${index}`, 1_200)
        .forEach(item => reached.add(item.kind))
    }
    expect(reached).toEqual(new Set(WEATHER_KINDS))
  })

  it('무지개는 비 직후, 눈과 비 사이에는 항상 맑음이 온다', () => {
    for (let seed = 0; seed < 24; seed++) {
      const schedule = createWeatherSchedule(`legal-${seed}`, 1_800)
      schedule.forEach((segment, index) => {
        const previous = schedule[index - 1]?.kind
        const next = schedule[index + 1]?.kind
        if (segment.kind === 'rainbow') {
          expect(previous).toBe('rain')
          expect(next).toBe('sun')
        }
        expect(new Set([previous, segment.kind])).not.toEqual(new Set(['rain', 'snow']))
      })
    }
  })

  it('전환 중에도 기본 날씨 합은 1이고 비와 눈은 동시에 오지 않는다', () => {
    const { schedule } = scheduleContaining(...WEATHER_KINDS)
    for (let time = -10; time <= 1_350; time += 1.7) {
      const weather = weatherAt(schedule, time)
      const weights = Object.values(weather.base)
      for (const weight of [...weights, weather.rainbow, weather.windStrength, weather.cloudiness]) {
        expect(Number.isFinite(weight)).toBe(true)
        expect(weight).toBeGreaterThanOrEqual(0)
        expect(weight).toBeLessThanOrEqual(1)
      }
      expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10)
      expect(weather.base.rain * weather.base.snow).toBe(0)
      if (weather.rainbow > 0) {
        expect(weather.base.sun).toBeGreaterThan(0)
        expect(weather.base.snow).toBe(0)
      }
    }
  })

  it('전환 시작·중간·끝이 부드럽고 out 객체를 완전히 재사용한다', () => {
    const { schedule } = scheduleContaining('rain', 'rainbow', 'snow')
    const rain = schedule.find(item => item.kind === 'rain')!
    const transitionStart = rain.end - rain.transitionSec
    const out = weatherAt(schedule, transitionStart)
    expect(out.mix).toBe(0)
    expect(out.base.rain).toBe(1)
    expect(weatherAt(schedule, transitionStart + rain.transitionSec / 2, out)).toBe(out)
    expect(out.mix).toBeCloseTo(0.5, 10)
    expect(out.base.rain).toBeCloseTo(0.5, 10)
    expect(out.base.sun).toBeCloseTo(0.5, 10)
    expect(out.rainbow).toBeCloseTo(0.5, 10)

    const justBeforeEnd = blendSnapshot(weatherAt(schedule, rain.end - 0.000_001, out))
    const atEnd = weatherAt(schedule, rain.end, out)
    expect(justBeforeEnd.base.sun).toBeCloseTo(atEnd.base.sun, 8)
    expect(justBeforeEnd.rainbow).toBeCloseTo(atEnd.rainbow, 8)

    weatherAt(schedule, middleOf('snow', schedule), out)
    weatherAt(schedule, middleOf('sun', schedule), out)
    expect(out.base).toEqual({ sun: 1, wind: 0, rain: 0, snow: 0 })
    expect(out.rainbow).toBe(0)
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
    const { schedule } = scheduleContaining('rain', 'sun')
    const rain = weatherAt(schedule, middleOf('rain', schedule))
    const sun = weatherAt(schedule, middleOf('sun', schedule))
    const out = resolveWeatherAppearance(base, rain)
    const firstRain = appearanceSnapshot(out)
    for (let i = 0; i < 1_000; i++) resolveWeatherAppearance(base, rain, out)
    expect(appearanceSnapshot(out)).toEqual(firstRain)

    resolveWeatherAppearance(base, sun, out)
    const freshSun = resolveWeatherAppearance(base, sun, createWeatherAppearance())
    expect(appearanceSnapshot(out)).toEqual(appearanceSnapshot(freshSun))
  })

  it('모든 날씨에서 오브젝트와 버퍼를 새로 만들지 않고 좌표를 유한하게 유지한다', () => {
    const { seed } = scheduleContaining(...WEATHER_KINDS)
    const weather = new WeatherSystem(seed, 1_800)
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
