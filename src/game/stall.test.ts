import { describe, it, expect } from 'vitest'
import { Session, STALL_AFTER } from './state'
import { COURSES } from './courses'
import { GhostTrack } from './ghost'
import type { SessionRecord } from './history'
import type { RowerSample } from '../types'

const course = COURSES.find(c => c.id === 'henley-steady-30')!
const sample = (over: Partial<RowerSample> = {}): RowerSample => ({
  at: 0, strokeRate: 26, strokeCount: 10, totalDistance: 100,
  instantaneousPace: 145, instantaneousPower: 200, ...over,
})

/** dt초씩 seconds초 동안 돌린다. 샘플은 주지 않는다 — 끊김 테스트용. */
function run(s: Session, seconds: number, dt = 1 / 60) {
  for (let i = 0; i < Math.round(seconds / dt); i++) s.update(dt)
}

/** 실기기처럼 2Hz로 샘플을 먹이면서 돌린다 */
function runFed(s: Session, seconds: number, dt = 1 / 60) {
  let since = 0
  let dist = 100
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    since += dt
    if (since >= 0.5) {
      since = 0
      dist += 1.7
      s.onSample(sample({ totalDistance: Math.round(dist) }))
    }
    s.update(dt)
  }
}

describe('데이터가 끊겼을 때', () => {
  it('카운트다운 중 알려진 연결 끊김 상태를 start가 덮어쓰지 않는다', () => {
    const s = new Session(course, 145)
    s.setLinkDown(true)
    s.start()

    expect(s.metrics().stalled).toBe(true)
    expect(s.metrics().stallReason).toBe('link')
  })

  it('연결이 끊기면 기록 시간이 멈춘다', () => {
    const s = new Session(course, 145)
    s.start()
    s.onSample(sample())
    run(s, 5)
    const before = s.elapsed
    expect(before).toBeGreaterThan(4)

    s.setLinkDown(true)
    run(s, 10)
    // 젓지 못한 시간을 기록에 넣을 수는 없다
    expect(s.elapsed).toBeCloseTo(before, 1)
    expect(s.metrics().stalled).toBe(true)
    expect(s.metrics().stallReason).toBe('link')
  })

  it('다시 연결되면 시계가 이어서 간다', () => {
    const s = new Session(course, 145)
    s.start()
    s.onSample(sample())
    run(s, 5)
    s.setLinkDown(true)
    run(s, 10)
    const paused = s.elapsed

    s.setLinkDown(false)
    s.onSample(sample())
    run(s, 5)
    expect(s.elapsed).toBeGreaterThan(paused + 4)
    expect(s.metrics().stalled).toBe(false)
  })

  it('연결은 살아있어도 패킷이 끊기면 멈춘다', () => {
    // GATT는 유지되는데 알림만 죽는 실제 BLE 실패 모드
    const s = new Session(course, 145)
    s.start()
    s.onSample(sample())
    run(s, STALL_AFTER - 2)
    expect(s.metrics().stalled).toBe(false)

    run(s, 4)   // 샘플 없이 더 흐르면
    expect(s.metrics().stalled).toBe(true)
    expect(s.metrics().stallReason).toBe('nodata')
  })

  it('샘플이 계속 오면 멈추지 않는다', () => {
    const s = new Session(course, 145)
    s.start()
    for (let i = 0; i < 30; i++) {
      s.onSample(sample({ totalDistance: 100 + i * 4 }))
      run(s, 0.5)
    }
    expect(s.metrics().stalled).toBe(false)
    expect(s.elapsed).toBeGreaterThan(14)
  })

  it('페이스 보트도 멈춘 동안엔 나아가지 않는다', () => {
    const s = new Session(course, 145)
    s.start()
    s.onSample(sample())
    run(s, 5)
    const paceBefore = s.paceDistance
    s.setLinkDown(true)
    run(s, 10)
    expect(s.paceDistance).toBeCloseTo(paceBefore, 1)
  })
})

describe('고스트를 얹은 세션', () => {
  const pb: SessionRecord = {
    id: 'pb', at: '2026-08-01T00:00:00.000Z', courseId: course.id,
    courseName: course.name, courseType: course.type, venue: 'Henley',
    durationSec: 1800, baseSplit: 145, elapsed: 1800, distance: 6000,
    avgSplit: 150, avgSpm: 26, avgPower: 200, strokeCount: 780,
    gap: 0, completed: true,
    curve: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, split: 150 })),
  }

  it('고스트가 없으면 갭이 null이다', () => {
    const s = new Session(course, 145)
    s.start()
    expect(s.metrics().ghostGap).toBeNull()
    expect(s.metrics().ghostDistance).toBeNull()
  })

  it('고스트가 있으면 경과 시간에 맞춰 나아간다', () => {
    const s = new Session(course, 145, new GhostTrack(pb))
    s.start()
    runFed(s, 60)
    const d = s.metrics().ghostDistance!
    // 6000m / 1800s = 3.33m/s → 60초에 약 200m
    expect(d).toBeGreaterThan(190)
    expect(d).toBeLessThan(210)
  })

  it('멈춰 있는 동안엔 고스트도 나아가지 않는다', () => {
    const s = new Session(course, 145, new GhostTrack(pb))
    s.start()
    runFed(s, 30)
    const before = s.metrics().ghostDistance!
    s.setLinkDown(true)
    run(s, 20)
    expect(s.metrics().ghostDistance!).toBeCloseTo(before, 1)
  })
})
