import { createWeatherSchedule, weatherAt, type WeatherKind, type WeatherSegment, type WeatherSection } from '../three/weather'

/**
 * 날씨 보너스 — 궂은 날 타면 코인이 더 붙는다.
 *
 * 하늘은 이미 구간마다 바뀐다(weather.ts). 거기에 규칙 하나만 얹는다: 바람 ×1.3, 비 ×1.5, 눈 ×2,
 * 비 뒤 무지개가 떠 있는 동안 ×3. 상대(페이스 보트·상어)의 속도는 건드리지 않는다 — 목표 페이스는 코스 설계고,
 * 날씨는 보상 쪽에만 손댄다.
 *
 * 날씨 일정은 world.ts와 같은 입력(seed, 코스 길이, 구간)으로 다시 만들어 읽는다. 3D 쪽을 건드리지 않고도 같은 하늘을 안다.
 */
export const WEATHER_BONUS: Record<WeatherKind, { mult: number; label: string | null }> = {
  clear: { mult: 1, label: null },
  autumn: { mult: 1, label: null },
  sun: { mult: 1, label: null },
  wind: { mult: 1.3, label: '바람' },
  rain: { mult: 1.5, label: '비' },
  snow: { mult: 2, label: '눈' },
}
export const RAINBOW_BONUS = { mult: 3, label: '무지개' }
/** 무지개가 이만큼 이상 떠 있을 때 보너스로 친다 */
const RAINBOW_ON = 0.5

export interface WeatherBonus {
  mult: number
  label: string | null
  kind: WeatherKind
  rainbow: boolean
}

export function weatherBonusOf(cue: WeatherKind, rainbow: number): WeatherBonus {
  if (rainbow >= RAINBOW_ON) return { mult: RAINBOW_BONUS.mult, label: RAINBOW_BONUS.label, kind: cue, rainbow: true }
  const b = WEATHER_BONUS[cue]
  return { mult: b.mult, label: b.label, kind: cue, rainbow: false }
}

export class WeatherBonusTracker {
  readonly schedule: WeatherSegment[]
  private blend = weatherAt(createWeatherSchedule('x', 60), 0)
  private last: WeatherBonus | null = null

  constructor(seed: string, durationSec: number, sections?: readonly WeatherSection[]) {
    this.schedule = createWeatherSchedule(seed, durationSec, sections)
  }

  /** 지금 보너스. changed는 라벨이 바뀐 순간(알림용) */
  update(elapsed: number): WeatherBonus & { changed: boolean } {
    this.blend = weatherAt(this.schedule, elapsed, this.blend)
    const now = weatherBonusOf(this.blend.cue, this.blend.rainbow)
    const changed = this.last !== null && (this.last.label !== now.label || this.last.mult !== now.mult)
    this.last = now
    return { ...now, changed }
  }
}
