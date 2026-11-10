import { describe, it, expect } from 'vitest'
import {
  createPowerZones, PowerZoneTracker,
  ZONE_SEC, ZONE_FIRST_MIN, ZONE_FIRST_MAX, ZONE_GAP_MIN, ZONE_GAP_MAX, ZONE_TAIL_SEC, ZONE_WARN_SEC,
  ZONE_SUCCESS_MARGIN, ZONE_MIN_INTENSITY, type PowerZone, type ZoneEvent,
} from './powerZones'
import { COURSES } from './courses'
import { intensityAt, type PaceProfile } from './profile'

const STEADY: PaceProfile = { kind: 'steady' }
const INTERVAL = COURSES.find(c => c.id === 'henley-interval-30')!
const TARGET_SPLIT = 135
const SEEDS = ['one', 'two', 'three', 'daily-2026-11-10', 'x', 'y', 'z', 'henley']

type Cursor = { elapsed: number; distance: number }
type ZoneEnd = Extract<ZoneEvent, { kind: 'zone-end' }>

/** 트래커를 dt=0.1로 돌린다. 플레이어는 split(초/500m)으로 젓는다(0이면 멈춤). 이벤트와 그 시각을 모아 돌려준다 */
function drive(tracker: PowerZoneTracker, seconds: number, split: number, start: Cursor = { elapsed: 0, distance: 0 }, dt = 0.1) {
  const events: ZoneEvent[] = []
  const times: number[] = []
  let { elapsed, distance } = start
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    elapsed += dt
    distance += (split > 0 ? 500 / split : 0) * dt
    for (const e of tracker.update(elapsed, distance, TARGET_SPLIT)) { events.push(e); times.push(elapsed) }
  }
  return { events, times, elapsed, distance }
}

function endOf(events: ZoneEvent[]): ZoneEnd {
  const e = events.find((x): x is ZoneEnd => x.kind === 'zone-end')
  if (!e) throw new Error('zone-end 이벤트가 없다')
  return e
}

const ZONES: PowerZone[] = [{ index: 0, start: 100, end: 130 }, { index: 1, start: 300, end: 330 }]

describe('createPowerZones', () => {
  it('같은 seed면 같은 목록, 다른 seed면 다른 목록', () => {
    expect(createPowerZones('one', INTERVAL.profile, 1800)).toEqual(createPowerZones('one', INTERVAL.profile, 1800))
    expect(createPowerZones('one', INTERVAL.profile, 1800)).not.toEqual(createPowerZones('two', INTERVAL.profile, 1800))
  })

  it('구간은 30초씩이고, 시간순으로 겹치지 않으며, index가 차례로 붙는다', () => {
    for (const seed of SEEDS) {
      for (const profile of [STEADY, INTERVAL.profile]) {
        const zones = createPowerZones(seed, profile, 1800)
        expect(zones.length).toBeGreaterThan(0)
        zones.forEach((z, i) => {
          expect(z.index).toBe(i)
          expect(z.end - z.start).toBeCloseTo(ZONE_SEC, 9)
          if (i > 0) expect(z.start).toBeGreaterThan(zones[i - 1]!.end)
        })
      }
    }
  })

  it('스테디: 첫 구간은 출발 뒤 [150, 240)초, 다음 구간까지 간격은 [210, 330)초', () => {
    for (const seed of SEEDS) {
      const zones = createPowerZones(seed, STEADY, 1800)
      expect(zones[0]!.start).toBeGreaterThanOrEqual(ZONE_FIRST_MIN)
      expect(zones[0]!.start).toBeLessThan(ZONE_FIRST_MAX)
      for (let i = 1; i < zones.length; i++) {
        const gap = zones[i]!.start - zones[i - 1]!.end
        expect(gap).toBeGreaterThanOrEqual(ZONE_GAP_MIN)
        expect(gap).toBeLessThan(ZONE_GAP_MAX)
      }
    }
  })

  it('코스 끝 75초 안에는 구간을 두지 않는다', () => {
    for (const seed of SEEDS) {
      for (const duration of [1200, 1800, 2400]) {
        for (const profile of [STEADY, INTERVAL.profile]) {
          for (const z of createPowerZones(seed, profile, duration)) {
            expect(z.end).toBeLessThanOrEqual(duration - ZONE_TAIL_SEC)
          }
        }
      }
    }
  })

  it('헨리 인터벌: 회복 구간(강도 0.95 미만)에는 시작도 끝도 걸치지 않는다', () => {
    for (const seed of SEEDS) {
      const zones = createPowerZones(seed, INTERVAL.profile, INTERVAL.durationSec)
      expect(zones.length).toBeGreaterThan(0)
      for (const z of zones) {
        expect(intensityAt(INTERVAL.profile, z.start)).toBeGreaterThanOrEqual(ZONE_MIN_INTENSITY)
        expect(intensityAt(INTERVAL.profile, z.end)).toBeGreaterThanOrEqual(ZONE_MIN_INTENSITY)
      }
      // 뒤로 밀려도 첫 구간이 150초보다 앞에 오지는 않는다
      expect(zones[0]!.start).toBeGreaterThanOrEqual(ZONE_FIRST_MIN)
    }
  })

  it('회복 구간에 걸린 시각은 15초씩 뒤로 민다 — 같은 seed의 스테디보다 15의 배수만큼 늦다', () => {
    const steady = createPowerZones('one', STEADY, 1800)
    const interval = createPowerZones('one', INTERVAL.profile, 1800)
    const shift = interval[0]!.start - steady[0]!.start
    expect(shift).toBeGreaterThan(0)
    expect(shift / 15).toBeCloseTo(Math.round(shift / 15), 9)
  })

  it('너무 짧은 코스에는 구간이 없다', () => {
    expect(createPowerZones('one', STEADY, 200)).toEqual([])
    // 첫 구간이 들어갈 자리(150 + 30 ≤ duration − 75)가 없다
    expect(createPowerZones('one', STEADY, ZONE_FIRST_MIN + ZONE_SEC + ZONE_TAIL_SEC - 1)).toEqual([])
  })
})

describe('PowerZoneTracker', () => {
  it('10초 전 예고 → 시작 → 끝 순서로 알리고, 시각이 구간과 맞는다', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const { events, times } = drive(tracker, 140, TARGET_SPLIT)
    expect(events.map(e => e.kind)).toEqual(['zone-soon', 'zone-start', 'zone-end'])
    expect(times[0]).toBeCloseTo(ZONES[0]!.start - ZONE_WARN_SEC, 0)
    expect(times[1]).toBeCloseTo(ZONES[0]!.start, 0)
    expect(times[2]).toBeCloseTo(ZONES[0]!.end, 0)
    const soon = events[0]!
    expect(soon.kind === 'zone-soon' && soon.startsIn).toBeCloseTo(ZONE_WARN_SEC, 0)
    expect(events.every(e => e.zone === ZONES[0])).toBe(true)
  })

  it('구간 내내 목표보다 3초/500m 이상 빠르면 성공', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const { events } = drive(tracker, 140, TARGET_SPLIT - ZONE_SUCCESS_MARGIN - 1)
    const end = endOf(events)
    expect(end.success).toBe(true)
    expect(end.avgSplit).toBeCloseTo(TARGET_SPLIT - 4, 3)
    expect(end.targetSplit).toBeCloseTo(TARGET_SPLIT, 3)
    expect(end.deltaSec).toBeCloseTo(-4, 3)
    expect(tracker.attempted).toBe(1)
    expect(tracker.successes).toBe(1)
  })

  it('3초를 살짝 넘겨 빠르면 성공 — 경계 바로 안쪽', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const end = endOf(drive(tracker, 140, TARGET_SPLIT - ZONE_SUCCESS_MARGIN - 0.01).events)
    expect(end.success).toBe(true)
  })

  it('3초 미만으로 빠르면 실패', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const end = endOf(drive(tracker, 140, TARGET_SPLIT - 2).events)
    expect(end.success).toBe(false)
    expect(end.deltaSec).toBeCloseTo(-2, 3)
    expect(tracker.attempted).toBe(1)
    expect(tracker.successes).toBe(0)
  })

  it('구간 동안 멈춰 있으면 평균 스플릿은 Infinity이고 실패', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const end = endOf(drive(tracker, 140, 0).events)
    expect(end.success).toBe(false)
    expect(end.avgSplit).toBe(Infinity)
    expect(end.deltaSec).toBe(Infinity)
  })

  it('두 구간을 차례로 평가한다 — 성공·실패를 각각 센다', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const first = drive(tracker, 200, TARGET_SPLIT - 5)
    const second = drive(tracker, 150, TARGET_SPLIT, first)
    expect(endOf(first.events).zone).toBe(ZONES[0])
    expect(endOf(second.events).zone).toBe(ZONES[1])
    expect(tracker.attempted).toBe(2)
    expect(tracker.successes).toBe(1)
    expect(tracker.nextStartsIn(second.elapsed)).toBeNull()
  })

  it('멈춤 뒤 늦게 따라잡으면 이미 끝난 구간은 건너뛴다', () => {
    const tracker = new PowerZoneTracker(ZONES)
    expect(tracker.update(0, 0, TARGET_SPLIT)).toEqual([])
    expect(tracker.nextStartsIn(0)).toBe(ZONES[0]!.start)
    // 0 → 200초로 건너뜀: 100~130 구간은 지나갔다
    expect(tracker.update(200, 0, TARGET_SPLIT)).toEqual([])
    expect(tracker.nextStartsIn(200)).toBe(ZONES[1]!.start - 200)
    expect(tracker.attempted).toBe(0)
    const { events } = drive(tracker, 150, TARGET_SPLIT - 5, { elapsed: 200, distance: 0 })
    expect(events.map(e => e.kind)).toEqual(['zone-soon', 'zone-start', 'zone-end'])
    expect(events.every(e => e.zone === ZONES[1])).toBe(true)
    expect(tracker.attempted).toBe(1)
    expect(tracker.nextStartsIn(400)).toBeNull()
  })

  it('모든 구간이 지난 시각으로 바로 뛰면 아무 일도 없다', () => {
    const tracker = new PowerZoneTracker(ZONES)
    expect(tracker.update(1000, 5000, TARGET_SPLIT)).toEqual([])
    expect(tracker.nextStartsIn(1000)).toBeNull()
    expect(tracker.view(1000, 5000, TARGET_SPLIT)).toBeNull()
    expect(tracker.attempted).toBe(0)
  })

  it('view: 예고 전엔 null, 예고 중엔 soon, 진행 중엔 active와 지금까지의 평균·차이, 끝나면 다시 null', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const split = TARGET_SPLIT - 4
    let cur: Cursor = drive(tracker, 85, split)
    expect(tracker.view(cur.elapsed, cur.distance, TARGET_SPLIT)).toBeNull()
    expect(tracker.nextStartsIn(cur.elapsed)).toBeCloseTo(15, 0)

    cur = drive(tracker, 10, split, cur)        // ≈95초
    const soon = tracker.view(cur.elapsed, cur.distance, TARGET_SPLIT)!
    expect(soon.state).toBe('soon')
    expect(soon.zone).toBe(ZONES[0])
    expect(soon.remaining).toBeCloseTo(5, 0)
    expect(soon.progress).toBe(0)
    expect(soon.avgSplit).toBe(Infinity)

    cur = drive(tracker, 20, split, cur)        // ≈115초, 구간 절반
    const active = tracker.view(cur.elapsed, cur.distance, TARGET_SPLIT)!
    expect(active.state).toBe('active')
    expect(active.remaining).toBeCloseTo(15, 0)
    expect(active.progress).toBeCloseTo(0.5, 1)
    expect(active.avgSplit).toBeCloseTo(split, 2)
    expect(active.targetSplit).toBeCloseTo(TARGET_SPLIT, 2)
    expect(active.delta).toBeCloseTo(-4, 2)
    expect(tracker.nextStartsIn(cur.elapsed)).toBe(0)

    cur = drive(tracker, 20, split, cur)        // ≈135초, 끝난 뒤
    expect(tracker.view(cur.elapsed, cur.distance, TARGET_SPLIT)).toBeNull()
  })

  it('view: 진행 중 아직 거리가 없으면 평균 스플릿은 Infinity', () => {
    const tracker = new PowerZoneTracker(ZONES)
    const cur = drive(tracker, 105, 0)
    const v = tracker.view(cur.elapsed, cur.distance, TARGET_SPLIT)!
    expect(v.state).toBe('active')
    expect(v.avgSplit).toBe(Infinity)
    expect(v.delta).toBe(Infinity)
  })
})
