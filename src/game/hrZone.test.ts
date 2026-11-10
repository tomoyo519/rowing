import { describe, it, expect, beforeEach } from 'vitest'
import {
  hrZoneOf, targetZoneForTier, HrZoneGauge, loadMaxHr, saveMaxHr, ZONE_LABELS, HR_ZONE_BOUNDS,
  MAX_HR_KEY, DEFAULT_MAX_HR, MAX_HR_MIN, MAX_HR_MAX, HRZ_FILL_SEC, HRZ_DRAIN_SEC, HRZ_BOOST_SEC,
  HRZ_HIGH_WARN_SEC, HRZ_HIGH_WARN_GAP, type HrEvent,
} from './hrZone'
import { PACE_TIERS } from './courses'

/** dt 간격으로 seconds초 동안 같은 심박을 넣는다. 이벤트와 그 시각(이번 hold 안에서의 초)을 모은다 */
function hold(g: HrZoneGauge, seconds: number, hr: number | undefined, dt = 0.1) {
  const events: HrEvent[] = []
  const times: number[] = []
  let t = 0
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    t += dt
    for (const e of g.update(dt, hr)) { events.push(e); times.push(t) }
  }
  return { events, times }
}

describe('hrZoneOf', () => {
  it('경계는 60·70·80·90% — 경계값은 위 존', () => {
    expect(HR_ZONE_BOUNDS).toEqual([0.6, 0.7, 0.8, 0.9])
    expect(hrZoneOf(118, 200)).toBe(1)   // 59%
    expect(hrZoneOf(120, 200)).toBe(2)   // 60%
    expect(hrZoneOf(139, 200)).toBe(2)
    expect(hrZoneOf(140, 200)).toBe(3)   // 70%
    expect(hrZoneOf(160, 200)).toBe(4)   // 80%
    expect(hrZoneOf(180, 200)).toBe(5)   // 90%
    expect(hrZoneOf(250, 200)).toBe(5)
    expect(hrZoneOf(0, 200)).toBe(1)
  })

  it('최대 심박이 0이어도 나누기 오류 없이 최대 존', () => {
    expect(hrZoneOf(100, 0)).toBe(5)
  })
})

describe('targetZoneForTier', () => {
  it('가볍게 Z2, 스테디·강하게 Z3, 레이스·전력 Z4, 모르는 티어는 Z3', () => {
    expect(targetZoneForTier('easy')).toBe(2)
    expect(targetZoneForTier('steady')).toBe(3)
    expect(targetZoneForTier('strong')).toBe(3)
    expect(targetZoneForTier('race')).toBe(4)
    expect(targetZoneForTier('max')).toBe(4)
    expect(targetZoneForTier('nope')).toBe(3)
    // 실제 티어 id는 모두 Z2~Z4 안의 목표를 받는다
    for (const t of PACE_TIERS) expect([2, 3, 4]).toContain(targetZoneForTier(t.id))
  })

  it('존 라벨은 1~5번에 이름이 있다', () => {
    expect(ZONE_LABELS).toHaveLength(6)
    expect(ZONE_LABELS[0]).toBe('')
    for (let z = 1; z <= 5; z++) expect(ZONE_LABELS[z]!.length).toBeGreaterThan(0)
  })
})

describe('최대 심박 저장', () => {
  // node 환경엔 localStorage가 없다 — 최소 구현으로 대체
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage
  })

  it('없거나 범위 밖이거나 숫자가 아니면 기본값 185', () => {
    expect(DEFAULT_MAX_HR).toBe(185)
    expect(loadMaxHr()).toBe(DEFAULT_MAX_HR)
    localStorage.setItem(MAX_HR_KEY, String(MAX_HR_MIN - 1))
    expect(loadMaxHr()).toBe(DEFAULT_MAX_HR)
    localStorage.setItem(MAX_HR_KEY, String(MAX_HR_MAX + 1))
    expect(loadMaxHr()).toBe(DEFAULT_MAX_HR)
    localStorage.setItem(MAX_HR_KEY, 'abc')
    expect(loadMaxHr()).toBe(DEFAULT_MAX_HR)
  })

  it('범위 안이면 반올림해 읽고, 경계값도 받는다', () => {
    localStorage.setItem(MAX_HR_KEY, '172.6')
    expect(loadMaxHr()).toBe(173)
    localStorage.setItem(MAX_HR_KEY, String(MAX_HR_MIN))
    expect(loadMaxHr()).toBe(MAX_HR_MIN)
    localStorage.setItem(MAX_HR_KEY, String(MAX_HR_MAX))
    expect(loadMaxHr()).toBe(MAX_HR_MAX)
  })

  it('saveMaxHr는 반올림해 저장하고 다시 읽힌다', () => {
    saveMaxHr(171.4)
    expect(localStorage.getItem(MAX_HR_KEY)).toBe('171')
    expect(loadMaxHr()).toBe(171)
  })

  it('localStorage가 없어도 던지지 않는다', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    expect(() => saveMaxHr(180)).not.toThrow()
    expect(loadMaxHr()).toBe(DEFAULT_MAX_HR)
  })
})

describe('심박 존 게이지', () => {
  const MAX = 200
  const inZone = 150     // Z3 (75%)
  const below = 130      // Z2
  const above = 170      // Z4
  const z5 = 190         // Z5 (95%)

  it('기본값은 최대 심박 185, 목표 Z3', () => {
    const g = new HrZoneGauge()
    expect(g.maxHr).toBe(DEFAULT_MAX_HR)
    expect(g.targetZone).toBe(3)
    expect(g.fill).toBe(0)
    expect(g.zone).toBeNull()
    expect(g.boosting).toBe(false)
  })

  it('목표 존에 머물면 120초에 가득 차고, 부스트 이벤트와 함께 0으로 돌아가며 10초 부스트가 켜진다', () => {
    const g = new HrZoneGauge(MAX, 3)
    const { events } = hold(g, 119, inZone)
    expect(events).toEqual([])
    expect(g.fill).toBeCloseTo(119 / HRZ_FILL_SEC, 3)
    expect(g.boosting).toBe(false)
    const more = hold(g, 2, inZone)
    expect(more.events).toEqual([{ kind: 'hr-boost', boosts: 1 }])
    expect(119 + more.times[0]!).toBeCloseTo(HRZ_FILL_SEC, 0)
    expect(g.fill).toBeCloseTo(0, 1)     // 리셋 뒤 조금 다시 찼을 수 있다
    expect(g.boosts).toBe(1)
    expect(g.boosting).toBe(true)
    expect(g.boostRemaining).toBeGreaterThan(HRZ_BOOST_SEC - 1.1)
    expect(g.boostRemaining).toBeLessThanOrEqual(HRZ_BOOST_SEC)
  })

  it('부스트는 10초 뒤 꺼진다 — 그동안 심박이 끊겨도 남은 시간은 줄어든다', () => {
    const g = new HrZoneGauge(MAX, 3)
    g.fill = 1 - 0.05 / HRZ_FILL_SEC   // 다음 스텝에 가득
    expect(hold(g, 0.1, inZone).events.map(e => e.kind)).toEqual(['hr-boost'])
    expect(g.boosting).toBe(true)
    hold(g, 5, undefined)
    expect(g.boostRemaining).toBeCloseTo(HRZ_BOOST_SEC - 5, 1)
    hold(g, 6, below)
    expect(g.boostRemaining).toBe(0)
    expect(g.boosting).toBe(false)
  })

  it('부스트 중에는 가득 차도 새 부스트가 나지 않는다', () => {
    const g = new HrZoneGauge(MAX, 3)
    g.fill = 1 - 0.05 / HRZ_FILL_SEC
    hold(g, 0.1, inZone)
    g.fill = 1 - 0.05 / HRZ_FILL_SEC
    const { events } = hold(g, 5, inZone)
    expect(events).toEqual([])
    expect(g.boosts).toBe(1)
    expect(g.fill).toBe(1)
  })

  it('존보다 낮으면 60초에 걸쳐 빠진다', () => {
    const g = new HrZoneGauge(MAX, 3)
    g.fill = 0.5
    hold(g, 15, below)
    expect(g.fill).toBeCloseTo(0.5 - 15 / HRZ_DRAIN_SEC, 3)
    hold(g, 30, below)
    expect(g.fill).toBe(0)
  })

  it('존보다 높으면 게이지는 멈춘다 — 과열로 채우지 않는다', () => {
    const g = new HrZoneGauge(MAX, 3)
    g.fill = 0.5
    hold(g, 60, above)
    expect(g.fill).toBe(0.5)
    expect(g.zone).toBe(4)
  })

  it('목표 존은 티어에 따라 다르다 — 레이스(Z4)면 Z4에서 차고 Z3에선 빠진다', () => {
    const g = new HrZoneGauge(MAX, targetZoneForTier('race'))
    hold(g, 30, above)
    expect(g.fill).toBeCloseTo(30 / HRZ_FILL_SEC, 3)
    hold(g, 6, inZone)
    expect(g.fill).toBeCloseTo(30 / HRZ_FILL_SEC - 6 / HRZ_DRAIN_SEC, 3)
  })

  it('Z5에 45초 이어지면 한 번 경고하고, 180초 안에는 다시 하지 않는다', () => {
    const g = new HrZoneGauge(MAX, 3)
    const { events, times } = hold(g, 300, z5, 1)
    expect(events.map(e => e.kind)).toEqual(['hr-high', 'hr-high'])
    expect(events[0]).toEqual({ kind: 'hr-high', zone: 5 })
    // 첫 Z5 샘플(1초)에서 45초 뒤
    expect(times[0]! - 1).toBe(HRZ_HIGH_WARN_SEC)
    expect(times[1]! - times[0]!).toBe(HRZ_HIGH_WARN_GAP)
  })

  it('Z5를 잠깐이라도 벗어나면 45초를 다시 센다', () => {
    const g = new HrZoneGauge(MAX, 3)
    expect(hold(g, 40, z5, 1).events).toEqual([])
    hold(g, 1, inZone, 1)
    expect(hold(g, 40, z5, 1).events).toEqual([])
    expect(hold(g, 10, z5, 1).events.map(e => e.kind)).toEqual(['hr-high'])
  })

  it('심박이 없거나 0이면 존은 null이고 게이지는 그대로', () => {
    const g = new HrZoneGauge(MAX, 3)
    hold(g, 10, inZone)
    expect(g.zone).toBe(3)
    const fill = g.fill
    hold(g, 10, undefined)
    expect(g.zone).toBeNull()
    expect(g.fill).toBe(fill)
    hold(g, 1, 0)
    expect(g.zone).toBeNull()
    hold(g, 1, inZone)
    expect(g.zone).toBe(3)
  })

  it('reset은 게이지·부스트·존·경고 기록을 지운다', () => {
    const g = new HrZoneGauge(MAX, 3)
    hold(g, 60, z5, 1)
    g.fill = 0.4
    g.boosts = 2
    g.boostRemaining = 3
    g.reset()
    expect(g).toMatchObject({ fill: 0, boosts: 0, boostRemaining: 0, zone: null })
    // 리셋 뒤 Z5 경고는 다시 45초부터 (180초 간격도 잊는다)
    const { times } = hold(g, 60, z5, 1)
    expect(times).toEqual([HRZ_HIGH_WARN_SEC + 1])
  })
})
