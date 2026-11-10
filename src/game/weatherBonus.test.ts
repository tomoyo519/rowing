import { describe, it, expect } from 'vitest'
import { weatherBonusOf, WeatherBonusTracker, WEATHER_BONUS, RAINBOW_BONUS } from './weatherBonus'
import { createWeatherSchedule, weatherAt, WEATHER_KINDS, type WeatherSection } from '../three/weather'

const SECTIONS: WeatherSection[] = [{ start: 0, end: 300 }, { start: 300, end: 600 }, { start: 600, end: 900 }]

describe('weatherBonusOf', () => {
  it('바람 ×1.3, 비 ×1.5, 눈 ×2 — 맑은 날씨(clear·autumn·sun)는 ×1에 라벨 없음', () => {
    expect(weatherBonusOf('wind', 0)).toEqual({ mult: 1.3, label: '바람', kind: 'wind', rainbow: false })
    expect(weatherBonusOf('rain', 0)).toEqual({ mult: 1.5, label: '비', kind: 'rain', rainbow: false })
    expect(weatherBonusOf('snow', 0)).toEqual({ mult: 2, label: '눈', kind: 'snow', rainbow: false })
    for (const kind of ['clear', 'autumn', 'sun'] as const) {
      expect(weatherBonusOf(kind, 0)).toEqual({ mult: 1, label: null, kind, rainbow: false })
    }
  })

  it('표(WEATHER_BONUS)에 모든 날씨가 있고 배율은 1 이상이며 함수는 표를 그대로 쓴다', () => {
    for (const kind of WEATHER_KINDS) {
      expect(WEATHER_BONUS[kind].mult).toBeGreaterThanOrEqual(1)
      expect(weatherBonusOf(kind, 0).mult).toBe(WEATHER_BONUS[kind].mult)
      expect(weatherBonusOf(kind, 0).label).toBe(WEATHER_BONUS[kind].label)
    }
  })

  it('무지개가 절반 이상 떠 있으면 날씨와 무관하게 ×3 "무지개"', () => {
    expect(RAINBOW_BONUS).toEqual({ mult: 3, label: '무지개' })
    expect(weatherBonusOf('clear', 0.5)).toEqual({ mult: 3, label: '무지개', kind: 'clear', rainbow: true })
    expect(weatherBonusOf('autumn', 1)).toMatchObject({ mult: 3, label: '무지개', rainbow: true })
    // 반 미만이면 아직 날씨 보너스
    expect(weatherBonusOf('clear', 0.49)).toEqual({ mult: 1, label: null, kind: 'clear', rainbow: false })
  })
})

describe('WeatherBonusTracker', () => {
  it('일정은 world.ts와 같은 입력으로 만든 createWeatherSchedule과 같다', () => {
    const tracker = new WeatherBonusTracker('x', 900, SECTIONS)
    expect(tracker.schedule).toEqual(createWeatherSchedule('x', 900, SECTIONS))
    const noSections = new WeatherBonusTracker('x', 1800)
    expect(noSections.schedule).toEqual(createWeatherSchedule('x', 1800))
  })

  it('첫 호출과 같은 날씨가 이어지는 동안은 changed=false', () => {
    const tracker = new WeatherBonusTracker('x', 900, SECTIONS)
    const first = tracker.update(0)
    expect(first.changed).toBe(false)
    expect(tracker.update(0).changed).toBe(false)
    expect(tracker.update(60).changed).toBe(false)
    expect(tracker.update(60).label).toBe(first.label)
    expect(tracker.update(60).mult).toBe(first.mult)
  })

  it('매 초 결과는 weatherAt + weatherBonusOf와 같고, changed는 라벨이나 배율이 바뀐 순간에만 true', () => {
    for (const seed of ['d', 'h', 'x']) {
      const tracker = new WeatherBonusTracker(seed, 900, SECTIONS)
      const schedule = createWeatherSchedule(seed, 900, SECTIONS)
      let prev: { label: string | null; mult: number } | null = null
      let changes = 0
      for (let t = 0; t <= 900; t++) {
        const got = tracker.update(t)
        const blend = weatherAt(schedule, t)
        const want = weatherBonusOf(blend.cue, blend.rainbow)
        expect(got).toMatchObject(want)
        expect(got.changed).toBe(prev !== null && (prev.label !== want.label || prev.mult !== want.mult))
        if (got.changed) changes++
        prev = want
      }
      expect(changes).toBeGreaterThan(0)
    }
  })

  it('비 뒤 맑아지면 무지개 ×3이 잠시 떴다가 ×1로 돌아온다 (seed x: 맑음→비→맑음)', () => {
    const tracker = new WeatherBonusTracker('x', 900, SECTIONS)
    // 전제: 이 seed의 하늘. 날씨 알고리즘이 바뀌면 다른 seed를 고른다
    expect(tracker.schedule.map(s => s.kind)).toEqual(['clear', 'rain', 'clear'])
    const changes: { t: number; label: string | null; mult: number; rainbow: boolean }[] = []
    for (let t = 0; t <= 900; t++) {
      const r = tracker.update(t)
      if (r.changed) changes.push({ t, label: r.label, mult: r.mult, rainbow: r.rainbow })
    }
    expect(changes.map(c => c.label)).toEqual(['비', '무지개', null])
    expect(changes.map(c => c.mult)).toEqual([1.5, 3, 1])
    expect(changes.map(c => c.rainbow)).toEqual([false, true, false])
    // 라벨은 구간 경계가 아니라 크로스페이드 중간에 넘어간다
    expect(changes[0]!.t).toBeGreaterThan(300)
    expect(changes[0]!.t).toBeLessThan(318)
    // 무지개는 맑은 구간이 시작된 직후에 떠서 잠시 뒤 사라진다
    expect(changes[1]!.t).toBeGreaterThanOrEqual(600)
    expect(changes[1]!.t).toBeLessThan(630)
    expect(changes[2]!.t).toBeGreaterThan(changes[1]!.t)
    expect(changes[2]!.t).toBeLessThan(720)
  })
})
