import { describe, it, expect } from 'vitest'
import {
  SwanCrossing, SWAN_FIRST_MIN, SWAN_FIRST_MAX, SWAN_GAP_MIN, SWAN_GAP_MAX, SWAN_WINDOW_SEC, SWAN_LEAD_SEC,
  SWAN_MIN_LEAD, SWAN_TAIL_SEC, SWAN_POSTPONE_SEC, type SwanEvent,
} from './wildlife'

const SPEED = 3.7        // 2:15/500m 근처 (m/s)
const DURATION = 1800

type Cursor = { elapsed: number; distance: number }
type Appear = Extract<SwanEvent, { kind: 'swans-appear' }>
type Result = Extract<SwanEvent, { kind: 'swans-result' }>
const appears = (events: SwanEvent[]) => events.filter((e): e is Appear => e.kind === 'swans-appear')
const results = (events: SwanEvent[]) => events.filter((e): e is Result => e.kind === 'swans-result')

/** SPEED × factor로 seconds초 젓는다. 이벤트와 그 시각을 모아 돌려준다 */
function drive(s: SwanCrossing, seconds: number, factor: number, start: Cursor = { elapsed: 0, distance: 0 }, blocked = false, dt = 0.1) {
  const events: SwanEvent[] = []
  const times: number[] = []
  let { elapsed, distance } = start
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    elapsed += dt
    distance += SPEED * factor * dt
    for (const e of s.update(elapsed, distance, SPEED * factor, blocked)) { events.push(e); times.push(elapsed) }
  }
  return { events, times, elapsed, distance }
}

/** 첫 백조가 나타날 때까지 젓는다 */
function untilFirstSwans(s: SwanCrossing, factor = 1) {
  let cur: Cursor = { elapsed: 0, distance: 0 }
  for (let guard = 0; guard < 5000; guard++) {
    const r = drive(s, 0.1, factor, cur)
    cur = { elapsed: r.elapsed, distance: r.distance }
    const event = appears(r.events)[0]
    if (event) return { ...cur, event }
  }
  throw new Error('백조가 나타나지 않았다')
}

describe('백조 떼 건너기', () => {
  it('첫 백조는 출발 뒤 [120, 200)초에 나타난다 — 건너는 지점은 11초 거리, 제한 시간은 10초', () => {
    const s = new SwanCrossing('one', DURATION)
    const { elapsed, distance, event } = untilFirstSwans(s)
    expect(elapsed).toBeGreaterThanOrEqual(SWAN_FIRST_MIN)
    expect(elapsed).toBeLessThan(SWAN_FIRST_MAX + 0.1)
    expect(event.at).toBeCloseTo(distance + SPEED * SWAN_LEAD_SEC, 6)
    expect(event.deadline).toBeCloseTo(elapsed + SWAN_WINDOW_SEC, 9)
    expect(s.attempts).toBe(1)
    expect(s.isActive).toBe(true)
    const v = s.view(elapsed, distance)!
    expect(v.along).toBeCloseTo(SPEED * SWAN_LEAD_SEC, 6)
    expect(v.remaining).toBeCloseTo(SWAN_WINDOW_SEC, 9)
    expect(v.progress).toBeCloseTo(0, 9)
  })

  it('아주 느리면 건너는 지점은 최소 25m 앞', () => {
    // 1.11 m/s — 1 m/s 이상이라 미루지 않는다. 1.11 × 11 = 12.2 < 25
    const s = new SwanCrossing('one', DURATION)
    const { distance, event } = untilFirstSwans(s, 0.3)
    expect(event.at - distance).toBeCloseTo(SWAN_MIN_LEAD, 6)
  })

  it('제한 시간 안에 지점에 닿으면 성공이고 여유(margin)는 양수다', () => {
    const s = new SwanCrossing('one', DURATION)
    const start = untilFirstSwans(s)
    // 15% 더 밀면 40.7m를 9.6초에 — 10초 안
    const { events, times } = drive(s, 12, 1.15, start)
    expect(results(events)).toHaveLength(1)
    const r = results(events)[0]!
    expect(r.success).toBe(true)
    expect(r.margin).toBeGreaterThan(0)
    expect(r.margin).toBeLessThan(1)
    expect(times[0]! - start.elapsed).toBeCloseTo(SWAN_LEAD_SEC / 1.15, 0)
    expect(s.successes).toBe(1)
    expect(s.attempts).toBe(1)
    expect(s.isActive).toBe(false)
    expect(s.view(times[0]!, 0)).toBeNull()
  })

  it('같은 속도로 계속 가면 11초 걸려 늦는다 — 제한 시간이 지나는 순간 실패, 벌은 없다', () => {
    const s = new SwanCrossing('one', DURATION)
    const start = untilFirstSwans(s)
    const { events, times } = drive(s, 12, 1, start)
    expect(results(events)).toHaveLength(1)
    const r = results(events)[0]!
    expect(r.success).toBe(false)
    expect(r.margin).toBeLessThanOrEqual(0)
    expect(times[0]!).toBeCloseTo(start.event.deadline, 0)
    expect(s.successes).toBe(0)
    expect(s.attempts).toBe(1)
    expect(s.isActive).toBe(false)
  })

  it('멈춰 있으면 실패한다', () => {
    const s = new SwanCrossing('one', DURATION)
    const start = untilFirstSwans(s)
    const { events } = drive(s, 12, 0, start)
    expect(results(events).map(r => r.success)).toEqual([false])
  })

  it('view는 진행 중에만 — 지점까지 거리가 줄고 시간 진행이 0→1로 간다', () => {
    const s = new SwanCrossing('one', DURATION)
    expect(s.view(0, 0)).toBeNull()
    const start = untilFirstSwans(s)
    const half = drive(s, 5, 1, start)
    const v = s.view(half.elapsed, half.distance)!
    expect(v.along).toBeCloseTo(SPEED * SWAN_LEAD_SEC - SPEED * 5, 3)
    expect(v.remaining).toBeCloseTo(5, 3)
    expect(v.progress).toBeCloseTo(0.5, 3)
    // 제한 시간을 넘긴 시각으로 보면 1·0에서 멈춘다
    const late = s.view(start.event.deadline + 3, half.distance)!
    expect(late.progress).toBe(1)
    expect(late.remaining).toBe(0)
  })

  it('막혀 있으면(파워 구간) 15초 뒤로 미루고, 풀리면 그때 나온다', () => {
    const t = untilFirstSwans(new SwanCrossing('one', DURATION)).elapsed
    const s = new SwanCrossing('one', DURATION)
    expect(s.update(t, 0, SPEED, true)).toEqual([])
    expect(s.isActive).toBe(false)
    expect(s.update(t + SWAN_POSTPONE_SEC - 0.1, 0, SPEED)).toEqual([])
    expect(appears(s.update(t + SWAN_POSTPONE_SEC, 0, SPEED))).toHaveLength(1)
    expect(s.attempts).toBe(1)
  })

  it('젓고 있지 않으면(속도 1 m/s 미만) 마찬가지로 15초 미룬다', () => {
    const t = untilFirstSwans(new SwanCrossing('one', DURATION)).elapsed
    const s = new SwanCrossing('one', DURATION)
    expect(s.update(t, 0, 0.9)).toEqual([])
    expect(s.update(t + SWAN_POSTPONE_SEC - 0.1, 0, SPEED)).toEqual([])
    expect(appears(s.update(t + SWAN_POSTPONE_SEC, 0, SPEED))).toHaveLength(1)
  })

  it('계속 막혀 있으면 계속 미뤄진다 — 끝까지 한 번도 안 나올 수 있다', () => {
    const s = new SwanCrossing('one', 600)
    expect(drive(s, 600, 1, undefined, true).events).toEqual([])
    expect(s.attempts).toBe(0)
  })

  it('코스 끝 60초 안에는 나오지 않는다', () => {
    // 150초 코스: 90초부터 꼬리인데 첫 백조는 아무리 일러도 120초
    const short = new SwanCrossing('one', 150)
    expect(drive(short, 150, 1).events).toEqual([])
    expect(short.attempts).toBe(0)
    // 첫 등장 시각 직전에 꼬리가 시작하면 안 나오고, 1초 여유가 있으면 나온다
    const t = untilFirstSwans(new SwanCrossing('one', DURATION)).elapsed
    const blockedByTail = new SwanCrossing('one', t + SWAN_TAIL_SEC - 1)
    expect(drive(blockedByTail, t + SWAN_TAIL_SEC - 1, 1).events).toEqual([])
    const justFits = new SwanCrossing('one', t + SWAN_TAIL_SEC + 1)
    expect(appears(drive(justFits, t + 1, 1).events)).toHaveLength(1)
  })

  it('같은 seed면 같은 시각에, 다른 seed면 다른 시각에 나타난다', () => {
    const a = untilFirstSwans(new SwanCrossing('one', DURATION)).elapsed
    const b = untilFirstSwans(new SwanCrossing('one', DURATION)).elapsed
    const c = untilFirstSwans(new SwanCrossing('two', DURATION)).elapsed
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('결과가 난 뒤 다음 백조는 [170, 290)초 뒤에 온다', () => {
    for (const seed of ['one', 'two']) {
      const s = new SwanCrossing(seed, DURATION)
      const { events, times } = drive(s, 700, 1)
      const appearTimes = times.filter((_, i) => events[i]!.kind === 'swans-appear')
      const resultTimes = times.filter((_, i) => events[i]!.kind === 'swans-result')
      expect(appearTimes.length).toBeGreaterThanOrEqual(2)
      const gap = appearTimes[1]! - resultTimes[0]!
      expect(gap).toBeGreaterThanOrEqual(SWAN_GAP_MIN)
      expect(gap).toBeLessThan(SWAN_GAP_MAX + 0.1)
      expect(s.attempts).toBe(appearTimes.length)
    }
  })
})
