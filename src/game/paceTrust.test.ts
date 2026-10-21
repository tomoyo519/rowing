import { describe, it, expect } from 'vitest'
import {
  Session, PACE_DISTRUST_AFTER_MS, BASE_SPLIT_MIN, BASE_SPLIT_MAX,
} from './state'
import { COURSES, projectedDistance } from './courses'
import { speedToSplit } from './physics'
import type { RowerSample } from '../types'

const steady = COURSES.find(c => c.id === 'henley-steady-30')!
const interval = COURSES.find(c => c.id === 'henley-interval-30')!

function run(s: Session, seconds: number, dt = 1 / 60) {
  for (let i = 0; i < Math.round(seconds / dt); i++) s.update(dt)
}

interface Clock { at: number; dist: number; count: number }

/**
 * 2Hz로 seconds초 동안 젓는다. 실제 속도 speed(t)는 거리로 드러나고, 기기가 보고하는 페이스 필드는
 * paceField(실제 스플릿)로 왜곡할 수 있다 (undefined면 필드 자체를 싣지 않는다). 스트로크는 2.5초마다 하나.
 */
function row(
  s: Session, clock: Clock, seconds: number,
  speed: number | ((t: number) => number),
  paceField: (trueSplit: number) => number | undefined = split => Math.round(split),
) {
  for (let t = 0; t < seconds - 1e-9; t += 0.5) {
    const v = typeof speed === 'function' ? speed(t) : speed
    clock.at += 500
    clock.dist += v * 0.5
    if (Math.round(t * 2) % 5 === 0) clock.count += 1
    const sample: RowerSample = {
      at: clock.at, strokeRate: 24, strokeCount: clock.count, totalDistance: Math.round(clock.dist),
    }
    const pace = v > 0.05 ? paceField(speedToSplit(v)) : 0
    if (pace !== undefined) sample.instantaneousPace = pace
    s.onSample(sample)
    run(s, 0.5)
  }
}

function started(course = steady, baseSplit = 135) {
  const s = new Session(course, baseSplit)
  s.start()
  return { s, clock: { at: 0, dist: 100, count: 10 } as Clock }
}

describe('기기 페이스와 거리가 어긋날 때', () => {
  it('페이스를 0.1초 단위로 보내는 기기: 처음엔 스플릿이 비지만 곧 거리로 잰 값으로 바뀐다', () => {
    const { s, clock } = started()
    // 2:05/500m로 젓는데 기기는 1250을 보낸다 — 범위(60~3000) 안이라 그럴듯해 보이지만 20:50/500m다
    row(s, clock, 3, 4.0, split => Math.round(split * 10))
    expect(s.metrics().paceDistrusted).toBe(false)
    expect(s.metrics().split).toBeGreaterThan(600)   // 이 상태로는 HUD가 '--:--'다

    row(s, clock, PACE_DISTRUST_AFTER_MS / 1000 + 3, 4.0, split => Math.round(split * 10))
    const m = s.metrics()
    expect(m.paceDistrusted).toBe(true)
    expect(m.speedSource).toBe('distance')
    expect(m.split).toBeGreaterThan(115)
    expect(m.split).toBeLessThan(135)
  })

  it('페이스를 1km 기준으로 보내는 기기(2배)도 거리로 바로잡는다', () => {
    const { s, clock } = started()
    row(s, clock, PACE_DISTRUST_AFTER_MS / 1000 + 6, 4.0, split => Math.round(split * 2))
    const m = s.metrics()
    expect(m.paceDistrusted).toBe(true)
    expect(m.split).toBeGreaterThan(115)
    expect(m.split).toBeLessThan(135)
  })

  it('파워로 환산한 속도가 거리와 몇 배 어긋나는 기기도 거리를 쓴다', () => {
    const { s, clock } = started()
    for (let t = 0; t < 14; t += 0.5) {
      clock.at += 500
      clock.dist += 4.0 * 0.5
      // 자석식 콘솔이 '파워'라며 보내는 값이 실제(약 180W)의 1/9 — 속도는 파워의 세제곱근이라 절반쯤으로 환산된다. 페이스 필드는 없다
      s.onSample({ at: clock.at, strokeRate: 24, strokeCount: 10 + Math.floor(t / 2.5), totalDistance: Math.round(clock.dist), instantaneousPower: 20 })
      run(s, 0.5)
    }
    const m = s.metrics()
    expect(m.paceDistrusted).toBe(true)
    expect(m.split).toBeGreaterThan(115)
    expect(m.split).toBeLessThan(135)
  })

  it('정상 기기는 페이스를 계속 믿는다 — 스트로크 안의 흔들림은 불일치가 아니다', () => {
    const { s, clock } = started()
    let i = 0
    row(s, clock, 40, 3.8, split => Math.round(split + (i++ % 2 ? 9 : -9)))
    const m = s.metrics()
    expect(m.paceDistrusted).toBe(false)
    expect(m.speedSource).toBe('pace')
  })

  it('출발 가속으로는 불신하지 않는다 — 페이스는 첫 스트로크부터 빠른데 거리 창은 천천히 따라온다', () => {
    const { s, clock } = started()
    // 3초 동안 0→4m/s로 가속, 기기는 처음부터 2:05를 보고한다
    row(s, clock, 3, t => 4.0 * Math.min(1, (t + 0.5) / 3), () => 125)
    row(s, clock, 12, 4.0, () => 125)
    expect(s.metrics().paceDistrusted).toBe(false)
  })

  it('PM5처럼 값을 붙들고 보내는 콘솔에서 멈췄다 다시 저어도 불신하지 않는다', () => {
    const { s, clock } = started()
    row(s, clock, 10, 4.0, () => 125)
    // 노를 놓았다. 거리는 멈추는데 콘솔은 마지막 페이스 125를 계속 보낸다
    for (let t = 0; t < 7; t += 0.5) {
      clock.at += 500
      s.onSample({ at: clock.at, strokeRate: 24, strokeCount: clock.count, totalDistance: Math.round(clock.dist), instantaneousPace: 125 })
      run(s, 0.5)
    }
    row(s, clock, 12, 4.0, () => 125)
    expect(s.metrics().paceDistrusted).toBe(false)
  })

  it('불신 뒤에도 페이스가 다시 거리와 맞아 들어가면 같은 시간을 두고 되돌린다', () => {
    const { s, clock } = started()
    row(s, clock, PACE_DISTRUST_AFTER_MS / 1000 + 6, 4.0, split => Math.round(split * 10))
    expect(s.metrics().paceDistrusted).toBe(true)
    row(s, clock, PACE_DISTRUST_AFTER_MS / 1000 + 6, 4.0)
    expect(s.metrics().paceDistrusted).toBe(false)
    expect(s.metrics().speedSource).toBe('pace')
  })

  it('페이스도 파워도 안 주는 기기는 거리로 잰 속도를 쓰고 그렇게 표시한다', () => {
    const { s, clock } = started()
    row(s, clock, 12, 4.0, () => undefined)
    const m = s.metrics()
    expect(m.speedSource).toBe('distance')
    expect(m.paceDistrusted).toBe(false)
    expect(m.split).toBeGreaterThan(115)
    expect(m.split).toBeLessThan(135)
  })
})

describe('레이스 중 목표 페이스 변경', () => {
  it('기준 스플릿을 바꾸면 목표·다음 목표·페이스 보트 속도가 따라간다', () => {
    const { s } = started(steady, 135)
    expect(s.metrics().targetSplit).toBe(135)
    expect(s.setBaseSplit(140)).toBe(140)
    expect(s.metrics().targetSplit).toBe(140)
    run(s, 5)
    // 페이스 보트는 관성으로 새 속도(500/140)에 붙는다
    expect(s.metrics().paceSpeed).toBeCloseTo(500 / 140, 2)
  })

  it('구간 강도는 그대로 곱해진다', () => {
    const { s } = started(interval, 135)
    const before = s.metrics()
    s.setBaseSplit(150)
    const after = s.metrics()
    expect(after.targetSplit).toBeCloseTo(before.targetSplit * 150 / 135, 6)
    expect(after.nextTargetSplit!).toBeCloseTo(before.nextTargetSplit! * 150 / 135, 6)
  })

  it('범위를 벗어나면 잘라낸다', () => {
    const { s } = started()
    expect(s.setBaseSplit(10)).toBe(BASE_SPLIT_MIN)
    expect(s.setBaseSplit(9999)).toBe(BASE_SPLIT_MAX)
    expect(s.baseSplit).toBe(BASE_SPLIT_MAX)
  })

  it('예상 완주 거리: 출발 전엔 코스 선택 화면과 같고, 중간에 바꾸면 남은 시간만 새 페이스로 계산한다', () => {
    const { s, clock } = started(steady, 135)
    expect(s.projectedTotal()).toBeCloseTo(projectedDistance(steady, 135), 3)
    row(s, clock, 60, 500 / 135)
    const gone = s.paceDistance
    expect(gone).toBeGreaterThan(200)
    s.setBaseSplit(150)
    const left = steady.durationSec - s.elapsed
    expect(s.projectedTotal()).toBeCloseTo(gone + left * 500 / 150, 1)
  })
})

describe('따로 연결한 심박 센서', () => {
  it('센서 값이 로잉머신 심박보다 우선하고, 센서가 10초 넘게 조용하면 로잉머신 값으로 돌아간다', () => {
    const { s } = started()
    s.setExternalHeartRate(150, 1000)
    s.onSample({ at: 1500, instantaneousPace: 130, heartRate: 120 })
    expect(s.metrics().heartRate).toBe(150)
    s.onSample({ at: 12000, instantaneousPace: 130, heartRate: 118 })
    expect(s.metrics().heartRate).toBe(118)
  })

  it('로잉머신이 심박을 아예 안 보내도 센서 값이 나온다', () => {
    const { s } = started()
    s.onSample({ at: 500, instantaneousPace: 130 })
    expect(s.metrics().heartRate).toBeUndefined()
    s.setExternalHeartRate(142, 600)
    expect(s.metrics().heartRate).toBe(142)
  })
})
