import { describe, it, expect } from 'vitest'
import {
  Session, STOP_AFTER_ZERO_MS, STAGNANT_DISTANCE_MS, ARMED_QUIET_AFTER, RECENT_STROKE_MS,
} from './state'
import { COURSES, type Course } from './courses'
import { meanIntensityBetween } from './profile'
import { GhostTrack } from './ghost'
import type { SessionRecord } from './history'
import type { RowerSample } from '../types'

const course = COURSES.find(c => c.id === 'henley-steady-30')!

/** 실기기가 대기 중에 보내는 샘플 — 페이스·파워·레이트가 전부 0 */
const idle = (over: Partial<RowerSample> = {}): RowerSample => ({
  at: 0, strokeRate: 0, strokeCount: 10, totalDistance: 100,
  instantaneousPace: 0, instantaneousPower: 0, ...over,
})
const rowing = (over: Partial<RowerSample> = {}): RowerSample => ({
  at: 0, strokeRate: 26, strokeCount: 10, totalDistance: 100,
  instantaneousPace: 145, instantaneousPower: 200, ...over,
})

function run(s: Session, seconds: number, dt = 1 / 60) {
  for (let i = 0; i < Math.round(seconds / dt); i++) s.update(dt)
}

/** 2Hz로 젓는 샘플을 먹이며 seconds초 돌린다. 마지막 샘플 시각(ms) 등을 돌려준다. */
function rowFor(s: Session, seconds: number, startAt = 0, startCount = 10, startDist = 100) {
  let at = startAt
  let count = startCount
  let dist = startDist
  for (let t = 0; t < seconds; t += 0.5) {
    if (Math.round(t * 2) % 5 === 4) count++         // 2.5초마다 스트로크 하나
    dist += 1.7
    s.onSample(rowing({ at, strokeCount: count, totalDistance: Math.round(dist) }))
    run(s, 0.5)
    at += 500
  }
  return { at, count, dist: Math.round(dist) }
}

describe('출발 대기 (armed)', () => {
  it('카운트다운이 끝나도 젓지 않으면 시계와 페이스 보트가 멈춰 있다', () => {
    const s = new Session(course, 145)
    s.arm()
    expect(s.phase).toBe('armed')
    expect(s.waitingForStroke).toBe(true)
    for (let i = 0; i < 8; i++) { s.onSample(idle({ at: i * 500 })); run(s, 0.5) }
    expect(s.elapsed).toBe(0)
    expect(s.paceDistance).toBe(0)
    expect(s.metrics().gap).toBe(0)
    expect(s.metrics().progress).toBe(0)
    // 대기는 끊김이 아니다 — 배너가 뜨면 안 된다
    expect(s.metrics().stalled).toBe(false)
  })

  it('arm 뒤 스트로크가 완료되면 그제야 출발한다', () => {
    const s = new Session(course, 145)
    s.arm()
    s.onSample(idle({ at: 0 }))
    run(s, 1)
    expect(s.phase).toBe('armed')
    s.onSample(rowing({ at: 1000, strokeCount: 11 }))
    expect(s.phase).toBe('running')
    run(s, 2)
    expect(s.elapsed).toBeCloseTo(2, 1)
    expect(s.paceDistance).toBeGreaterThan(3)
  })

  it('strokeCount를 안 주는 기기는 속도가 직전보다 빨라질 때 출발한다', () => {
    const s = new Session(course, 145)
    s.arm()
    s.onSample({ at: 0, instantaneousPace: 0, instantaneousPower: 0, totalDistance: 100 })
    run(s, 0.5)
    expect(s.phase).toBe('armed')
    s.onSample({ at: 500, instantaneousPace: 145, totalDistance: 101 })
    expect(s.phase).toBe('running')
  })

  it('카운트다운 내내 조용했던 콘솔은 첫 속도 패킷으로 출발한다', () => {
    const s = new Session(course, 145)
    s.arm()
    run(s, 4)
    // 첫 패킷이 이미 새 strokeCount와 페이스를 실었다 — 기준이 없어도 한 스트로크를 더 기다리지 않는다
    s.onSample(rowing({ at: 4000, strokeCount: 11 }))
    expect(s.phase).toBe('running')
  })

  it('마지막 값을 붙들고 보내는 기기(PM5)의 옛 페이스로는 출발하지 않는다', () => {
    const s = new Session(course, 145)
    // 워밍업: 스트로크 둘 완료 뒤 5초 동안 값이 붙들린 채 가만히 있음
    s.onSample(rowing({ at: 0, strokeCount: 10 }))
    s.onSample(rowing({ at: 1000, strokeCount: 11 }))
    s.onSample(rowing({ at: 2000, strokeCount: 12 }))
    for (let at = 2500; at <= 7000; at += 500) s.onSample(rowing({ at, strokeCount: 12 }))
    s.arm()
    expect(s.phase).toBe('armed')
    // 계속 붙든 값 — 스트로크·거리·페이스 전부 그대로
    for (let at = 7500; at <= 9500; at += 500) { s.onSample(rowing({ at, strokeCount: 12 })); run(s, 0.5) }
    expect(s.phase).toBe('armed')
    expect(s.elapsed).toBe(0)
    expect(s.stroke.spm).toBeLessThan(0.5)
    // 진짜 새 스트로크
    s.onSample(rowing({ at: 10000, strokeCount: 13, totalDistance: 104 }))
    expect(s.phase).toBe('running')
  })

  it('플라이휠 관성(거리는 늘고 페이스는 느려짐)으로는 출발하지 않는다', () => {
    const s = new Session(course, 145)
    // 카운트다운 중에도 콘솔은 마지막 스트로크 값을 보내고 있었다
    s.onSample(rowing({ at: -1000, strokeCount: 10, totalDistance: 100 }))
    s.arm()
    const spin: [number, number, number][] = [[0, 200, 100], [500, 240, 101], [1000, 300, 102], [1500, 400, 103], [2000, 0, 103]]
    for (const [at, pace, dist] of spin) {
      s.onSample({ at, strokeRate: 0, strokeCount: 10, totalDistance: dist, instantaneousPace: pace, instantaneousPower: 0 })
      run(s, 0.5)
    }
    expect(s.phase).toBe('armed')
    expect(s.elapsed).toBe(0)
  })

  it('대기 중엔 보트가 출발선에 붙어 있고, 출발 순간 화면이 튀지 않는다', () => {
    const s = new Session(course, 145)
    s.onSample(rowing({ at: 0, strokeCount: 10, totalDistance: 100 }))
    for (let at = 500; at <= 5000; at += 500) s.onSample(rowing({ at, strokeCount: 10, totalDistance: 104 }))
    s.arm()
    // 플라이휠 관성: 거리는 늘고 페이스는 느려진다 — 그래도 화면의 보트는 안 움직인다
    for (const [at, pace, dist] of [[5500, 170, 106], [6000, 210, 108], [6500, 280, 109]] as const) {
      s.onSample({ at, strokeRate: 0, strokeCount: 10, totalDistance: dist, instantaneousPace: pace, instantaneousPower: 0 })
      run(s, 0.5)
    }
    expect(s.phase).toBe('armed')
    expect(s.boat.distance).toBe(0)
    expect(s.boat.speed).toBeLessThan(0.05)
    // 진짜 첫 스트로크 — 출발선은 이 샘플의 거리(109)
    s.onSample(rowing({ at: 7000, strokeCount: 11, totalDistance: 109 }))
    expect(s.phase).toBe('running')
    expect(s.boat.distance).toBe(0)
    s.onSample(rowing({ at: 7500, strokeCount: 11, totalDistance: 113 }))
    run(s, 1)
    expect(s.boat.distance).toBeGreaterThan(2)
    expect(s.boat.distance).toBeLessThan(9)
  })

  it('카운트다운 마지막에 스트로크를 둘 완료했다면(리듬을 탔다면) arm 즉시 출발한다', () => {
    const s = new Session(course, 145)
    s.onSample(rowing({ at: 0, strokeCount: 10 }))
    s.onSample(rowing({ at: 1000, strokeCount: 11 }))
    s.onSample(rowing({ at: 3000, strokeCount: 12 }))
    s.arm()
    expect(s.phase).toBe('running')
    run(s, 1)
    expect(s.metrics().speed).toBeGreaterThan(1.5)
    // 페이스 보트는 곧바로 목표 속도로 나가므로 첫 샘플이 잠시 늦으면 조금 뒤처진다.
    // 다만 관성 손실(τ·v ≈ 3m)을 넘겨서는 안 된다.
    expect(s.metrics().gap).toBeLessThan(0)
    expect(s.metrics().gap).toBeGreaterThan(-2.5)
  })

  it('시험 삼아 한 번 당긴 것으로는 arm 즉시 출발하지 않는다', () => {
    const s = new Session(course, 145)
    s.onSample(idle({ at: 0, strokeCount: 10 }))
    s.onSample(rowing({ at: 2000, strokeCount: 11 }))       // 한 번
    s.onSample(rowing({ at: 3000, strokeCount: 11 }))
    s.arm()
    expect(s.phase).toBe('armed')
  })

  it('오래전 스트로크 둘은 리듬이 아니다', () => {
    const s = new Session(course, 145)
    s.onSample(rowing({ at: 0, strokeCount: 10 }))
    s.onSample(rowing({ at: 1000, strokeCount: 11 }))
    s.onSample(rowing({ at: 2000, strokeCount: 12 }))
    s.onSample(rowing({ at: 2000 + RECENT_STROKE_MS + 500, strokeCount: 12 }))
    s.arm()
    expect(s.phase).toBe('armed')
  })

  it('거리만 주는 기기는 기준보다 2m 넘게 늘면 출발한다', () => {
    const s = new Session(course, 145)
    s.arm()
    s.onSample({ at: 0, totalDistance: 100 })
    run(s, 0.5)
    expect(s.phase).toBe('armed')
    s.onSample({ at: 500, totalDistance: 103 })
    expect(s.phase).toBe('running')
  })

  it('거리만 주는 기기가 운동 카운터를 리셋해도 새 기준에서 출발한다', () => {
    const s = new Session(course, 145)
    s.onSample({ at: -1000, totalDistance: 800 })
    s.arm()
    s.onSample({ at: 0, totalDistance: 0 })
    s.onSample({ at: 500, totalDistance: 1 })
    expect(s.phase).toBe('armed')
    s.onSample({ at: 1000, totalDistance: 3 })
    expect(s.phase).toBe('running')
  })

  it('말도 안 되는 페이스(잘못 파싱된 패킷)로는 출발하지 않는다', () => {
    const s = new Session(course, 145)
    s.arm()
    s.onSample(idle({ at: 0 }))
    s.onSample(idle({ at: 500, instantaneousPace: 2 }))          // 0:02/500m = 250 m/s
    s.onSample(idle({ at: 1000, instantaneousPower: 30000 }))    // 30 kW
    s.onSample(idle({ at: 1500, instantaneousPace: 65535 }))     // 센티널
    expect(s.phase).toBe('armed')
    run(s, 1)
    expect(s.boat.speed).toBeLessThan(0.01)
  })

  it('스트로크 필드와 거리 필드가 번갈아 오는 분할 알림 콘솔에서도 출발한다', () => {
    const s = new Session(course, 145)
    const strokePacket = (at: number, count: number): RowerSample => ({ at, strokeRate: 24, strokeCount: count })
    const dataPacket = (at: number, dist: number): RowerSample => ({ at, totalDistance: dist, instantaneousPace: 150, instantaneousPower: 190 })
    // 카운트다운 중에도 두 종류 패킷이 번갈아 왔다 (붙든 값)
    s.onSample(strokePacket(-1000, 10)); s.onSample(dataPacket(-900, 200))
    s.arm()
    s.onSample(strokePacket(0, 10)); s.onSample(dataPacket(100, 200))
    run(s, 0.5)
    s.onSample(strokePacket(500, 10)); s.onSample(dataPacket(600, 200))
    run(s, 0.5)
    expect(s.phase).toBe('armed')
    s.onSample(strokePacket(1000, 11))
    expect(s.phase).toBe('running')
  })

  it('분할 알림의 0W 뒤에 붙든 페이스가 와도 새 스트로크로 오판하지 않는다', () => {
    const s = new Session(course, 145)
    s.onSample({ at: -1000, instantaneousPace: 145 })
    s.arm()

    s.onSample({ at: 0, instantaneousPower: 0 })
    s.onSample({ at: 100, instantaneousPace: 145 })

    expect(s.phase).toBe('armed')
    expect(s.elapsed).toBe(0)
  })

  it('속도만 주는 기기는 충분히 긴 0 뒤 같은 페이스로 돌아와도 출발한다', () => {
    const s = new Session(course, 145)
    s.onSample({ at: -1000, instantaneousPace: 145 })
    s.arm()

    s.onSample({ at: 0, instantaneousPower: 0 })
    s.onSample({ at: STOP_AFTER_ZERO_MS + 100, instantaneousPower: 0 })
    s.onSample({ at: STOP_AFTER_ZERO_MS + 200, instantaneousPace: 145 })

    expect(s.phase).toBe('running')
  })

  it('대기 중 연결이 끊기면 바로 알리고, 데이터 없음은 한참 뒤에야 알린다', () => {
    const s = new Session(course, 145)
    s.arm()
    run(s, ARMED_QUIET_AFTER - 5)
    expect(s.stallReason).toBe(null)
    run(s, 10)
    expect(s.stallReason).toBe('nodata')
    expect(s.elapsed).toBe(0)
    s.onSample(idle({ at: 0 }))
    expect(s.stallReason).toBe(null)
    s.setLinkDown(true)
    expect(s.stallReason).toBe('link')
    expect(s.metrics().stalled).toBe(true)
    s.setLinkDown(false)
    expect(s.stallReason).toBe(null)
  })

  it('페이스 보트는 출발선에서 곧바로 목표 속도로 나간다', () => {
    const s = new Session(course, 145)
    s.arm()
    s.onSample(idle({ at: 0 }))
    s.onSample(rowing({ at: 500, strokeCount: 11, totalDistance: 100 }))
    expect(s.phase).toBe('running')
    expect(s.metrics().paceSpeed).toBeCloseTo(500 / 145, 2)
    run(s, 1)
    // 0에서 관성으로 가속했다면 1초 뒤 2.5m도 못 갔을 것이다
    expect(s.paceDistance).toBeCloseTo(500 / 145, 1)
    run(s, 4)
    expect(s.metrics().paceSpeed).toBeCloseTo(500 / 145, 1)
  })

  it('고스트도 출발 전엔 제자리다', () => {
    const rec: SessionRecord = {
      id: 'g', at: '2026-01-01T00:00:00Z', courseId: course.id, courseName: course.name,
      courseType: course.type, venue: course.venue.location, durationSec: course.durationSec,
      baseSplit: 145, elapsed: 600, distance: 2000, avgSplit: 150, avgSpm: 26, avgPower: 200,
      strokeCount: 260, gap: 0, completed: false,
      curve: Array.from({ length: 10 }, (_, i) => ({ t: i * 60, split: 150 })),
    }
    const s = new Session(course, 145, new GhostTrack(rec))
    s.arm()
    for (let i = 0; i < 4; i++) { s.onSample(idle({ at: i * 500 })); run(s, 0.5) }
    expect(s.metrics().ghostDistance).toBe(0)
    expect(s.metrics().ghostGap).toBe(0)
  })

  it('start()는 예전처럼 즉시 달린다 (기존 테스트·시뮬 호환)', () => {
    const s = new Session(course, 145)
    s.start()
    expect(s.phase).toBe('running')
  })
})

describe('노를 놓으면 배가 멈춘다', () => {
  it('페이스·파워 0이 충분히 오래 이어지면 멈춘다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    expect(s.boat.speed).toBeGreaterThan(3)
    for (const dt of [0, 1000, STOP_AFTER_ZERO_MS + 100]) {
      s.onSample(idle({ at: at + dt, strokeCount: count, totalDistance: dist }))
      run(s, 0.5)
    }
    run(s, 5)
    expect(s.boat.speed).toBeLessThan(0.1)
  })

  it('0이 잠깐(리커버리)만 오면 속도를 유지한다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    const before = s.boat.speed
    s.onSample(idle({ at, strokeCount: count, totalDistance: dist }))
    s.onSample(idle({ at: at + 1000, strokeCount: count, totalDistance: dist }))
    run(s, 1)
    expect(s.boat.speed).toBeCloseTo(before, 1)
  })

  it('0이 이어지다 실제 이동이 감지되면 정지 타이머를 새로 센다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    s.onSample(idle({ at, strokeCount: count, totalDistance: dist }))
    s.onSample(idle({ at: at + 2000, strokeCount: count + 1, totalDistance: dist + 2 }))
    s.onSample(idle({ at: at + 3000, strokeCount: count + 1, totalDistance: dist + 2 }))
    run(s, 1)
    expect(s.boat.speed).toBeGreaterThan(2.5)
    expect(s.stroke.spm).toBeGreaterThan(15)
  })

  it('파워를 안 주고 페이스만 주는 기기의 0도 멈춤이다', () => {
    const s = new Session(course, 145)
    s.start()
    let at = 0
    let dist = 100
    for (; at < 4000; at += 500) {
      dist += 1.7
      s.onSample({ at, strokeRate: 26, strokeCount: 10, totalDistance: Math.round(dist), instantaneousPace: 145 })
      run(s, 0.5)
    }
    for (const dt of [0, 1000, STOP_AFTER_ZERO_MS + 100]) {
      s.onSample({ at: at + dt, strokeRate: 0, strokeCount: 10, totalDistance: Math.round(dist), instantaneousPace: 0 })
      run(s, 0.5)
    }
    run(s, 5)
    expect(s.boat.speed).toBeLessThan(0.1)
  })

  it('페이스 0xFFFF(없음 센티널)와 파워 0도 멈춤이다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    for (const dt of [0, 1000, STOP_AFTER_ZERO_MS + 100]) {
      s.onSample(idle({ at: at + dt, strokeCount: count, totalDistance: dist, instantaneousPace: 65535 }))
      run(s, 0.5)
    }
    run(s, 5)
    expect(s.boat.speed).toBeLessThan(0.1)
  })

  it('값을 붙들고 보내는 기기(PM5)는 거리가 멈추면 배도 멈추고 아바타도 노를 놓는다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    expect(s.stroke.spm).toBeGreaterThan(20)
    // 사용자는 멈췄지만 콘솔은 마지막 스트로크 값을 그대로 보낸다 (26spm → 창은 4초)
    for (const dt of [0, 1000, 2000, 3000, STAGNANT_DISTANCE_MS + 300]) {
      s.onSample(rowing({ at: at + dt, strokeCount: count, totalDistance: dist }))
      run(s, 0.5)
    }
    run(s, 6)
    expect(s.boat.speed).toBeLessThan(0.1)
    expect(s.stroke.spm).toBeLessThan(0.5)
    expect(s.metrics().power).toBe(0)
  })

  it('분할 알림의 붙든 페이스·레이트가 거리 정지 뒤 배와 아바타를 다시 살리지 않는다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    for (const dt of [0, 1000, 2000, 3000, STAGNANT_DISTANCE_MS + 300]) {
      s.onSample({ at: at + dt, totalDistance: dist })
      run(s, 0.5)
    }
    s.onSample({ at: at + STAGNANT_DISTANCE_MS + 400, instantaneousPace: 145, instantaneousPower: 200 })
    s.onSample({ at: at + STAGNANT_DISTANCE_MS + 500, strokeRate: 26, strokeCount: count })
    run(s, 6)
    expect(s.boat.speed).toBeLessThan(0.1)
    expect(s.stroke.spm).toBeLessThan(0.5)
    expect(s.metrics().power).toBe(0)
  })

  it('거리 정지 뒤 확실히 빨라진 새 페이스가 오면 다시 움직인다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    for (const dt of [0, 1000, 2000, 3000, STAGNANT_DISTANCE_MS + 300]) {
      s.onSample(rowing({ at: at + dt, strokeCount: count, totalDistance: dist }))
      run(s, 0.5)
    }
    run(s, 4)
    expect(s.boat.speed).toBeLessThan(0.1)
    s.onSample({ at: at + STAGNANT_DISTANCE_MS + 500, strokeRate: 28, instantaneousPace: 120, instantaneousPower: 280 })
    run(s, 1)
    expect(s.boat.speed).toBeGreaterThan(2)
    expect(s.stroke.spm).toBeGreaterThan(20)
  })

  it('스트로크마다 한 번만 거리를 갱신하는 콘솔에서는 저레이트에서도 멈칫거리지 않는다', () => {
    const s = new Session(course, 145)
    s.start()
    // 18spm: 3.33초마다 스트로크 완료와 함께 거리가 한 번 뛴다. 그 사이엔 붙든 값만 온다.
    let at = 0
    let count = 10
    let dist = 100
    let minSpeed = Infinity
    for (let stroke = 0; stroke < 8; stroke++) {
      count++
      dist += 9
      for (let k = 0; k < 7; k++) {
        s.onSample({ at, strokeRate: 18, strokeCount: count, totalDistance: dist, instantaneousPace: 165, instantaneousPower: 140 })
        run(s, 0.476)
        at += 476
        if (stroke >= 3) minSpeed = Math.min(minSpeed, s.boat.speed)
      }
    }
    expect(minSpeed).toBeGreaterThan((500 / 165) * 0.8)
  })

  it('리커버리 동안 0을 보내는 4Hz 콘솔에서는 매 스트로크 멈칫거리지 않는다', () => {
    const s = new Session(course, 145)
    s.start()
    let at = 0
    let dist = 100
    let count = 10
    let minSpeed = Infinity
    let minSpm = Infinity
    // 3초 사이클: 1초 드라이브(값 있음, 거리 증가) + 2초 리커버리(전부 0)
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let t = 0; t < 3000; t += 250) {
        const drive = t < 1000
        if (drive) dist += 1.4
        if (t === 750) count++
        s.onSample({
          at, strokeRate: drive ? 20 : 0, strokeCount: count, totalDistance: Math.round(dist),
          instantaneousPace: drive ? 150 : 0, instantaneousPower: drive ? 180 : 0,
        })
        run(s, 0.25)
        at += 250
        if (cycle >= 2) {
          minSpeed = Math.min(minSpeed, s.boat.speed)
          minSpm = Math.min(minSpm, s.stroke.spm)
        }
      }
    }
    expect(minSpeed).toBeGreaterThan(3.33 * 0.8)
    expect(minSpm).toBeGreaterThan(20 * 0.8)
  })

  it('페이스·파워 필드를 아예 안 보내는 기기는 거리 증가분으로 속도를 구한다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count, dist } = rowFor(s, 4)
    const before = s.boat.speed
    // 0.5초마다 2m — 4 m/s로 젓고 있다. 옛 속도(3.4)를 붙들면 스플릿·게이지가 실제와 어긋난다.
    for (let i = 0; i < 9; i++) {
      s.onSample({ at: at + i * 500, strokeRate: 26, strokeCount: count + i, totalDistance: dist + i * 2 })
      run(s, 0.5)
    }
    expect(s.boat.speed).toBeGreaterThan(before)
    expect(s.boat.speed).toBeCloseTo(4, 1)
    expect(Math.abs(s.metrics().split - 125)).toBeLessThan(3)
  })

  it('처음부터 거리만 주는 기기도 스플릿과 게이지가 비지 않는다', () => {
    const s = new Session(course, 145)
    s.start()
    for (let i = 0; i < 12; i++) {
      s.onSample({ at: i * 500, strokeRate: 24, strokeCount: 10 + (i >> 1), totalDistance: 100 + i * 1.8 })
      run(s, 0.5)
    }
    expect(s.boat.speed).toBeGreaterThan(3)
    expect(isFinite(s.metrics().split)).toBe(true)
    expect(s.metrics().split).toBeLessThan(600)
  })

  it('5Hz 근처에서 199ms 지터가 있는 거리-only 기기도 속도를 구한다', () => {
    const s = new Session(course, 145)
    s.start()
    let at = 0
    for (let i = 0; i < 30; i++) {
      s.onSample({ at, strokeRate: 30, strokeCount: 10 + (i >> 3), totalDistance: 100 + i })
      const interval = i % 2 === 0 ? 199 : 201
      run(s, interval / 1000)
      at += interval
    }
    expect(s.metrics().speed).toBeCloseTo(5, 1)
    expect(s.metrics().split).toBeCloseTo(100, 0)
  })

  it('분할 알림에서 심박 필드가 빠져도 마지막 값을 유지한다', () => {
    const s = new Session(course, 145)
    s.start()
    s.onSample(rowing({ at: 0, heartRate: 151 }))
    expect(s.metrics().heartRate).toBe(151)
    s.onSample({ at: 500, strokeRate: 26, strokeCount: 11, totalDistance: 102 })
    expect(s.metrics().heartRate).toBe(151)
    s.onSample({ at: 10_501, strokeRate: 26, strokeCount: 12, totalDistance: 104 })
    expect(s.metrics().heartRate).toBeUndefined()
  })

  it('구간 경계선은 페이스 보트가 구간을 넘는 자리에 놓인다', () => {
    const interval: Course = {
      ...course,
      profile: { kind: 'intervals', pattern: [{ sec: 60, intensity: 1.0, label: 'A' }, { sec: 60, intensity: 1.1, label: 'B' }] },
    }
    const s = new Session(interval, 145)
    s.start()
    rowFor(s, 10)
    const m = s.metrics()
    expect(m.nextStep?.label).toBe('B')
    expect(m.nextTargetSplit).toBeCloseTo(145 / 1.1, 3)
    // 남은 50초 × 목표 속도만큼 페이스 보트 앞에 있고, 내 보트 기준으로는 거기서 gap을 뺀 만큼
    expect(m.boundaryAlong).toBeCloseTo(s.paceDistance + (500 / 145) * m.step.remaining! - m.distance, 3)
    expect(m.boundaryAlong!).toBeGreaterThan(150)
  })

  it('전환 램프 중에도 구간 경계선은 남은 목표 강도의 평균으로 고정한다', () => {
    const interval: Course = {
      ...course,
      profile: {
        kind: 'intervals',
        pattern: [{ sec: 180, intensity: 1.1, label: '푸시' }, { sec: 120, intensity: 0.9, label: '회복' }],
      },
    }
    const s = new Session(interval, 145)
    s.start()
    rowFor(s, 185)
    const m = s.metrics()
    const remaining = m.step.remaining!
    const mean = meanIntensityBetween(interval.profile, s.elapsed, s.elapsed + remaining)
    const expected = s.paceDistance + (500 / 145) * mean * remaining - m.distance
    expect(m.boundaryAlong).toBeCloseTo(expected, 3)
    // 현재 순간의 강도를 남은 115초 전체에 곱하던 옛 계산은 경계선을 수십 m 앞에 놓았다.
    const oldProjection = s.paceDistance + (500 / 145) * m.intensity * remaining - m.distance
    expect(oldProjection - m.boundaryAlong!).toBeGreaterThan(30)
  })

  it('스트로크 레이트가 없는 기기도 거리가 멈추면 기본 시간 뒤에 멈춘다', () => {
    const s = new Session(course, 145)
    s.start()
    let at = 0
    let dist = 100
    for (; at < 4000; at += 500) {
      dist += 2
      s.onSample({ at, totalDistance: dist, instantaneousPace: 145 })
      run(s, 0.5)
    }
    expect(s.boat.speed).toBeGreaterThan(3)
    for (const dt of [0, 1000, 2000, 3000, STAGNANT_DISTANCE_MS + 300]) {
      s.onSample({ at: at + dt, totalDistance: dist, instantaneousPace: 145 })
      run(s, 0.5)
    }
    run(s, 6)
    expect(s.boat.speed).toBeLessThan(0.1)
  })

  it('콘솔이 새 운동을 시작해 누적 거리를 리셋해도 화면 거리는 이어진다', () => {
    const s = new Session(course, 145)
    s.start()
    const { at, count } = rowFor(s, 4)
    const before = s.boat.distance
    expect(before).toBeGreaterThan(8)
    // 누적 거리가 0으로 떨어졌다 다시 올라간다
    s.onSample(rowing({ at, strokeCount: count, totalDistance: 0 }))
    run(s, 0.5)
    s.onSample(rowing({ at: at + 500, strokeCount: count + 1, totalDistance: 2 }))
    run(s, 0.5)
    expect(s.boat.distance).toBeGreaterThan(before)
    expect(s.boat.distance).toBeLessThan(before + 8)
  })
})
