import { describe, it, expect } from 'vitest'
import {
  SharkChase, RivalChase, rivalSpec, gameModeById, josa, GAME_MODES,
  SHARK_HEAD_START, SHARK_BITE_REACH, SHARK_SURGE_FACTOR, SHARK_SURGE_SEC, SHARK_WARN_SEC,
  SHARK_FIRST_SURGE_MIN, SHARK_SURGE_GAP_MAX, SHARK_RETREAT_SEC, SHARK_DANGER_RANGE,
  RIVAL_FIRST_LEAD, RIVAL_FIRST_FACTOR, RIVAL_FACTOR_MAX, RIVAL_LEAD_MAX, RIVAL_PASS_MARGIN,
  RIVAL_CONTEST_WITHIN, RIVAL_CONTEST_SEC, RIVAL_FADE_BEHIND, RIVAL_NAMES,
  type ModeEvent,
} from './modes'
import { Session } from './state'
import { COURSES } from './courses'
import type { RowerSample } from '../types'

const TARGET = 500 / 135   // 2:15/500m → m/s

/** 플레이어가 목표 속도 × factor로 저으며 seconds초를 보낸다. 이벤트를 모아 돌려준다. */
function drive(
  actor: SharkChase | RivalChase, seconds: number, playerFactor: number,
  start = { elapsed: 0, player: 0 }, dt = 0.1,
) {
  const events: ModeEvent[] = []
  /** events[i]가 일어난 세션 시각 */
  const times: number[] = []
  let { elapsed, player } = start
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    elapsed += dt
    player += TARGET * playerFactor * dt
    for (const e of actor.update(dt, elapsed, TARGET, player)) { events.push(e); times.push(elapsed) }
  }
  return { events, times, elapsed, player }
}

describe('플레이 모드 목록', () => {
  it('클래식·상어·추월 셋이고 모르는 id는 클래식으로 돌아간다', () => {
    expect(GAME_MODES.map(m => m.id)).toEqual(['classic', 'shark', 'chase'])
    expect(gameModeById('nope').id).toBe('classic')
    expect(gameModeById(null).id).toBe('classic')
    expect(gameModeById('shark').actor).toBe('상어')
  })

  it('조사는 받침에 따라 고른다', () => {
    expect(josa('강변의 노장', '이', '가')).toBe('강변의 노장이')
    expect(josa('템스의 번개', '이', '가')).toBe('템스의 번개가')
    expect(josa('보스반 유령', '은', '는')).toBe('보스반 유령은')
    expect(josa('Rival', '이', '가')).toBe('Rival이')
  })
})

describe('상어 추격', () => {
  it('출발선에서 상어는 선미 뒤 SHARK_HEAD_START에 있다', () => {
    const s = new SharkChase('t')
    s.start(0)
    const v = s.view(0)
    expect(v.gap).toBeCloseTo(SHARK_HEAD_START, 6)
    expect(v.caught).toBe(0)
    expect(v.danger).toBe(0)
  })

  it('목표 페이스를 정확히 지키면 덮치기 전까지 거리가 유지된다', () => {
    const s = new SharkChase('t')
    s.start(0)
    // 첫 덮치기 경고보다 전까지만
    const { player } = drive(s, SHARK_FIRST_SURGE_MIN - SHARK_WARN_SEC - 1, 1.0)
    expect(s.state).toBe('cruise')
    // 관성 때문에 처음 1~2초는 상어가 느려 조금 벌어진다. 그 뒤로는 유지
    expect(s.view(player).gap).toBeGreaterThanOrEqual(SHARK_HEAD_START - 0.01)
    expect(s.view(player).gap).toBeLessThan(SHARK_HEAD_START + 6)
  })

  it('경고 → 덮치기 → 순항으로 돌아오고, 덮칠 때 속도가 오른다', () => {
    const s = new SharkChase('t')
    s.start(0)
    const first = drive(s, SHARK_SURGE_GAP_MAX + 1, 1.0)
    const kinds = first.events.map(e => e.kind)
    expect(kinds.indexOf('shark-warn')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('shark-surge')).toBeGreaterThan(kinds.indexOf('shark-warn'))
    expect(kinds).not.toContain('shark-bite')

    // 덮치는 동안 상어가 목표보다 빨라서 거리가 준다
    const s2 = new SharkChase('t')
    s2.start(0)
    let cur = { elapsed: 0, player: 0 }
    // 덮치기 직전까지 보낸다
    for (let guard = 0; guard < 2000 && s2.state !== 'surge'; guard++) {
      const r = drive(s2, 0.1, 1.0, cur)
      cur = { elapsed: r.elapsed, player: r.player }
    }
    expect(s2.state).toBe('surge')
    const before = s2.view(cur.player).gap
    const r = drive(s2, SHARK_SURGE_SEC - 0.5, 1.0, cur)
    const after = s2.view(r.player).gap
    expect(after).toBeLessThan(before)
    // 8초 × (1.12 − 1) × 3.7m/s ≈ 3.3m — 관성으로 조금 덜
    expect(before - after).toBeGreaterThan(1.5)
    expect(before - after).toBeLessThan(SHARK_SURGE_SEC * TARGET * (SHARK_SURGE_FACTOR - 1) + 0.5)
  })

  it('노를 놓으면 잡히고, 물린 뒤에는 물러났다가 다시 온다', () => {
    const s = new SharkChase('t')
    s.start(0)
    // 30m 뒤의 상어가 3.7m/s로 오면 8초 남짓
    const { events, elapsed, player } = drive(s, 12, 0)
    const bites = events.filter(e => e.kind === 'shark-bite')
    expect(bites).toHaveLength(1)
    expect(s.caught).toBe(1)
    expect(s.state).toBe('retreat')
    expect(s.view(player).gap).toBe(0)
    expect(s.view(player).danger).toBe(1)
    // 물러나는 동안 다시 저으면 거리가 벌어진다
    const r = drive(s, SHARK_RETREAT_SEC - 1, 1.0, { elapsed, player })
    expect(s.view(r.player).gap).toBeGreaterThan(8)
    expect(s.caught).toBe(1)
    // 물러난 뒤엔 순항으로 돌아온다
    drive(s, 2, 1.0, { elapsed: r.elapsed, player: r.player })
    expect(s.state).toBe('cruise')
  })

  it('상어는 보트를 앞지르지 않는다 — 계속 멈춰 있어도 선미에 붙어 있을 뿐', () => {
    const s = new SharkChase('t')
    s.start(0)
    drive(s, 40, 0)
    expect(s.view(0).gap).toBe(0)
    expect(s.distance).toBeLessThanOrEqual(-SHARK_BITE_REACH + 1e-9)
    // 7초마다 한 번씩 다시 문다
    expect(s.caught).toBeGreaterThanOrEqual(3)
  })

  it('위험도는 거리에 따라 0~1로 오른다', () => {
    const s = new SharkChase('t')
    s.start(0)
    expect(s.view(0).danger).toBe(0)
    // 선미 뒤 SHARK_DANGER_RANGE/2 → 0.5
    const player = s.distance + SHARK_BITE_REACH + SHARK_DANGER_RANGE / 2
    expect(s.view(player).danger).toBeCloseTo(0.5, 6)
    expect(s.view(s.distance + SHARK_BITE_REACH).danger).toBe(1)
  })

  it('같은 seed면 덮치는 시각이 같고, 다른 seed면 다르다', () => {
    const a = new SharkChase('one'); a.start(0)
    const b = new SharkChase('one'); b.start(0)
    const c = new SharkChase('two'); c.start(0)
    const surgeAt = (s: SharkChase) => {
      const r = drive(s, 200, 1.0)
      return r.times[r.events.findIndex(e => e.kind === 'shark-surge')]
    }
    const ta = surgeAt(a), tb = surgeAt(b), tc = surgeAt(c)
    expect(ta).toBeDefined()
    expect(ta).toBe(tb)
    expect(ta).not.toBe(tc)
  })
})

describe('추월 레이스', () => {
  it('첫 라이벌은 RIVAL_FIRST_LEAD 앞에서 목표보다 느리게 출발한다', () => {
    const r = new RivalChase('t')
    r.start(0)
    const v = r.view(0)
    expect(v.gap).toBeCloseTo(-RIVAL_FIRST_LEAD, 6)
    expect(v.name).toBe(RIVAL_NAMES[0])
    expect(v.passed).toBe(0)
    expect(v.previous).toBeNull()
    expect(r.spec.factor).toBe(RIVAL_FIRST_FACTOR)
  })

  it('목표 페이스로 저으면 첫 라이벌(6% 느림)을 몇 분 안에 추월하고 다음 라이벌이 더 멀리·더 빠르게 나타난다', () => {
    const r = new RivalChase('t')
    r.start(0)
    const { events, player } = drive(r, 8 * 60, 1.0)
    const overtakes = events.filter(e => e.kind === 'rival-overtake')
    expect(overtakes.length).toBeGreaterThanOrEqual(1)
    const first = overtakes[0]!
    expect(first.kind === 'rival-overtake' && first.name).toBe(RIVAL_NAMES[0])
    expect(first.kind === 'rival-overtake' && first.next).toBe(RIVAL_NAMES[1])
    expect(r.passed).toBe(overtakes.length)
    expect(r.spec.index).toBe(overtakes.length)
    expect(r.spec.factor).toBeGreaterThan(RIVAL_FIRST_FACTOR)
    expect(r.spec.lead).toBeGreaterThan(RIVAL_FIRST_LEAD)
    // 새 라이벌은 앞에 있다
    expect(r.view(player).gap).toBeLessThan(0)
  })

  it('따라붙으면 라이벌이 한 번 버티고(contest), 10초 뒤 풀린다', () => {
    const r = new RivalChase('t')
    r.start(0)
    let cur = { elapsed: 0, player: 0 }
    const all: ModeEvent[] = []
    // 15m 안으로 들어갈 때까지 빠르게 젓는다
    for (let guard = 0; guard < 5000 && r.view(cur.player).gap < -RIVAL_CONTEST_WITHIN; guard++) {
      const step = drive(r, 0.1, 1.08, cur)
      all.push(...step.events)
      cur = { elapsed: step.elapsed, player: step.player }
    }
    expect(all.filter(e => e.kind === 'rival-contest')).toHaveLength(1)
    expect(r.contesting).toBe(true)
    const after = drive(r, RIVAL_CONTEST_SEC + 0.5, 1.08, cur)
    expect(r.contesting).toBe(false)
    // 같은 라이벌은 두 번 버티지 않는다
    expect(after.events.filter(e => e.kind === 'rival-contest')).toHaveLength(0)
  })

  it('추월은 중심이 RIVAL_PASS_MARGIN을 지나야 인정되고, 지나간 라이벌은 뒤로 멀어지다 사라진다', () => {
    const r = new RivalChase('t')
    r.start(0)
    // 라이벌을 바로 앞에 두고 시작
    r.distance = 2
    const dt = 0.1
    let elapsed = 0, player = 0
    let passedAt: number | null = null
    for (let i = 0; i < 600 && passedAt === null; i++) {
      elapsed += dt
      player += TARGET * 1.2 * dt
      const ev = r.update(dt, elapsed, TARGET, player)
      if (ev.some(e => e.kind === 'rival-overtake')) passedAt = player
    }
    expect(passedAt).not.toBeNull()
    const prev = r.view(passedAt!).previous
    expect(prev).not.toBeNull()
    // 지나간 라이벌은 내 뒤 RIVAL_PASS_MARGIN 근처
    expect(prev!.gap).toBeGreaterThanOrEqual(RIVAL_PASS_MARGIN - 0.5)
    expect(prev!.gap).toBeLessThan(RIVAL_PASS_MARGIN + 2)
    // 충분히 멀어지면 더 그리지 않는다 (다음 라이벌은 멀리 치워 두고 지나간 라이벌만 본다)
    r.distance = player + 10_000
    const far = drive(r, 120, 1.3, { elapsed, player })
    expect(far.player - passedAt! > RIVAL_FADE_BEHIND).toBe(true)
    expect(r.view(far.player).previous).toBeNull()
  })

  it('라이벌 사양은 이름이 끝까지 가도 마지막 이름을 쓰고, 속도·거리는 상한에서 멈춘다', () => {
    const rnd = () => 0.5
    const far = rivalSpec(50, rnd)
    expect(far.name).toBe(RIVAL_NAMES[RIVAL_NAMES.length - 1])
    expect(far.factor).toBe(RIVAL_FACTOR_MAX)
    expect(far.lead).toBe(RIVAL_LEAD_MAX)
  })
})

describe('세션과 모드', () => {
  const course = COURSES.find(c => c.id === 'henley-steady-30')!
  const rowing = (over: Partial<RowerSample> = {}): RowerSample => ({
    at: 0, strokeRate: 26, strokeCount: 10, totalDistance: 100,
    instantaneousPace: 135, instantaneousPower: 200, ...over,
  })

  it('클래식에는 상어도 라이벌도 없다', () => {
    const s = new Session(course, 135)
    expect(s.mode).toBe('classic')
    expect(s.metrics().shark).toBeNull()
    expect(s.metrics().rival).toBeNull()
  })

  it('상어 모드: 출발 전엔 상어가 기다리고, 출발하면 쫓아오며, 사건은 한 번만 꺼내진다', () => {
    const s = new Session(course, 135, null, 'seed', 'shark')
    s.arm()
    expect(s.metrics().shark?.gap).toBeCloseTo(SHARK_HEAD_START, 6)
    for (let i = 0; i < 6; i++) s.update(0.5)
    expect(s.metrics().shark?.gap).toBeCloseTo(SHARK_HEAD_START, 6)
    // 출발: 스트로크 완료
    s.onSample(rowing({ at: 0, strokeCount: 10 }))
    s.onSample(rowing({ at: 500, strokeCount: 11 }))
    expect(s.phase).toBe('running')
    // 노를 놓으면(페이스·파워 0이 이어지면) 배가 서고, 30m 뒤의 상어가 8초 남짓이면 와서 문다
    for (let i = 0; i < 30; i++) {
      s.onSample(rowing({ at: 1000 + i * 500, strokeRate: 0, strokeCount: 11, instantaneousPace: 0, instantaneousPower: 0 }))
      s.update(0.25); s.update(0.25)
    }
    const m = s.metrics()
    expect(m.shark).not.toBeNull()
    expect(m.shark!.caught).toBeGreaterThanOrEqual(1)
    const events = s.drainModeEvents()
    expect(events.some(e => e.kind === 'shark-bite')).toBe(true)
    expect(s.drainModeEvents()).toHaveLength(0)
  })

  it('추월 모드: 라이벌이 앞에서 기다린다', () => {
    const s = new Session(course, 135, null, 'seed', 'chase')
    s.arm()
    const v = s.metrics().rival
    expect(v).not.toBeNull()
    expect(v!.gap).toBeCloseTo(-RIVAL_FIRST_LEAD, 6)
    expect(s.metrics().mode).toBe('chase')
  })
})
