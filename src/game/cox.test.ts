import { describe, it, expect } from 'vitest'
import {
  Cox, lineFor, COX_MIN_GAP, COX_GENERIC_GAP, COX_BEHIND_AFTER, COX_AHEAD_DELTA, COX_AHEAD_AFTER, COX_PRAISE_GAP,
  COX_PRESEGMENT_AT, type CoxTick, type CoxEvent,
} from './cox'
import type { CheckpointPass } from './checkpoints'
import type { PowerZone } from './powerZones'

/** 기본은 '달리는 중, 스플릿 값 없음' — 일반 문구(뒤처짐·칭찬)가 끼어들지 않는다 */
const tick = (over: Partial<CoxTick> = {}): CoxTick => ({
  elapsed: 0, remaining: 1800, delta: Infinity, spm: 26, running: true,
  nextStepIn: null, nextLabel: null, nextHarder: false, ...over,
})

/** from..to초를 1초씩 tick하며 말한 줄과 시각을 모은다 */
function run(cox: Cox, from: number, to: number, over: Partial<CoxTick> | ((elapsed: number) => Partial<CoxTick>) = {}) {
  const lines: string[] = []
  const times: number[] = []
  for (let t = from; t <= to; t++) {
    const o = typeof over === 'function' ? over(t) : over
    const line = cox.tick(tick({ elapsed: t, remaining: 1800 - t, ...o }))
    if (line) { lines.push(line); times.push(t) }
  }
  return { lines, times }
}

const LAST_MINUTE = '마지막 1분! 남은 걸 다 쏟아요'
const LAST_30 = '30초! 열 번만 더!'

describe('tick — 평가 주기와 침묵', () => {
  it('초가 바뀔 때만 평가한다 — 같은 초 안의 두 번째 호출은 null', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 10, remaining: 1000 }))).toBeNull()
    // 같은 초 — 말할 거리가 생겨도 다음 초까지 기다린다
    expect(cox.tick(tick({ elapsed: 10.5, remaining: 50 }))).toBeNull()
    expect(cox.tick(tick({ elapsed: 11, remaining: 50 }))).toBe(LAST_MINUTE)
  })

  it('달리는 중이 아니면 아무 말도 하지 않는다', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 10, remaining: 50, running: false }))).toBeNull()
    expect(cox.tick(tick({ elapsed: 11, remaining: 49, running: false }))).toBeNull()
    expect(cox.spoken).toBe(0)
    expect(cox.tick(tick({ elapsed: 12, remaining: 48 }))).toBe(LAST_MINUTE)
    expect(cox.spoken).toBe(1)
  })
})

describe('tick — 마지막 1분·30초', () => {
  it('남은 시간이 60초 이하가 되면 한 번, 30초 이하가 되면 한 번 더', () => {
    const cox = new Cox()
    const { lines, times } = run(cox, 1700, 1800)
    expect(lines).toEqual([LAST_MINUTE, LAST_30])
    expect(times).toEqual([1740, 1770])
    expect(cox.spoken).toBe(2)
  })

  it('바로 30초 안으로 들어오면 30초 줄만 말한다 (1분 줄은 건너뛴다)', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 1775, remaining: 25 }))).toBe(LAST_30)
    expect(cox.tick(tick({ elapsed: 1780, remaining: 20 }))).toBeNull()
    // 이미 지난 1분 줄은 다시 나오지 않는다
    expect(cox.tick(tick({ elapsed: 1785, remaining: 45 }))).toBeNull()
  })

  it('0초가 되면 더는 말하지 않는다', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 1800, remaining: 0 }))).toBeNull()
  })

  it('마지막 1분 줄은 다른 규칙보다 먼저다 — 뒤처져 있어도 1분 줄이 나온다', () => {
    const cox = new Cox()
    const before = run(cox, 1700, 1739, { delta: 5 })    // 1720에 뒤처짐 잔소리 한 번
    expect(before.times).toEqual([1720])
    expect(cox.tick(tick({ elapsed: 1740, remaining: 60, delta: 5 }))).toBe(LAST_MINUTE)
  })
})

describe('tick — 구간 예고', () => {
  it('다음 구간 12초 전에 라벨을 넣어 한 번 예고하고, 같은 구간에는 다시 하지 않는다', () => {
    const cox = new Cox()
    const { lines, times } = run(cox, 90, 110, t => ({ nextStepIn: 112 - t, nextLabel: '푸시', nextHarder: true }))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('푸시')
    expect(times).toEqual([112 - COX_PRESEGMENT_AT])
  })

  it('더 쉬운 구간이면 풀어주는 말로, 더 어려운 구간이면 준비시키는 말로', () => {
    const easier = new Cox('a').tick(tick({ elapsed: 100, nextStepIn: 12, nextLabel: '회복', nextHarder: false }))!
    expect(easier).toContain('회복')
    expect(easier).toMatch(/풀어요|힘만 빼요|어깨 내리고/)
    const harder = new Cox('a').tick(tick({ elapsed: 100, nextStepIn: 12, nextLabel: '푸시', nextHarder: true }))!
    expect(harder).toContain('푸시')
    expect(harder).toMatch(/다리 준비|열 번 세게|숨 고르고/)
  })

  it('구간마다 한 번씩 — 다음 구간이 오면 다시 예고한다', () => {
    const cox = new Cox()
    const a = run(cox, 90, 103, t => ({ nextStepIn: 112 - t, nextLabel: '푸시', nextHarder: true }))
    const b = run(cox, 280, 303, t => ({ nextStepIn: 312 - t, nextLabel: '회복', nextHarder: false }))
    expect(a.lines).toHaveLength(1)
    expect(b.lines).toHaveLength(1)
    expect(b.lines[0]).toContain('회복')
    expect(b.times).toEqual([300])
  })

  it('예고는 40초 일반 간격에 묶이지 않는다 — 잔소리 직후라도 4초만 지나면 나온다', () => {
    const cox = new Cox()
    const behind = run(cox, 0, 20, { delta: 5 })
    expect(behind.times).toEqual([COX_BEHIND_AFTER])
    expect(cox.tick(tick({ elapsed: 26, nextStepIn: 12, nextLabel: '푸시', nextHarder: true }))).toContain('푸시')
  })

  it('12초보다 멀거나 8초 이하로 가까우면, 또는 라벨이 없으면 예고하지 않는다', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 100, nextStepIn: 13, nextLabel: '푸시', nextHarder: true }))).toBeNull()
    expect(cox.tick(tick({ elapsed: 101, nextStepIn: 8, nextLabel: '푸시', nextHarder: true }))).toBeNull()
    expect(cox.tick(tick({ elapsed: 102, nextStepIn: 10, nextLabel: null }))).toBeNull()
    expect(cox.spoken).toBe(0)
  })
})

describe('tick — 뒤처짐·앞섬·칭찬', () => {
  it('20초 넘게 뒤처지면 다리 큐, 레이트 30 이상이면 길이 큐 — 다음 잔소리는 40초 뒤', () => {
    const legs = run(new Cox('a'), 0, 120, { delta: 5, spm: 26 })
    expect(legs.times).toEqual([20, 60, 100])
    for (const l of legs.lines) expect(l).toMatch(/다리|발판/)
    const length = run(new Cox('a'), 0, 120, { delta: 5, spm: 32 })
    expect(length.times).toEqual([20, 60, 100])
    for (const l of length.lines) {
      expect(l).toMatch(/길/)
      expect(l).not.toMatch(/다리/)
    }
    expect(COX_GENERIC_GAP).toBe(40)
  })

  it('잠깐 뒤처진 건 넘어간다 — 20초가 차기 전에 돌아오면 아무 말 없음', () => {
    const cox = new Cox()
    const a = run(cox, 0, 15, { delta: 5 })
    const b = run(cox, 16, 40, { delta: 0 })
    expect([...a.lines, ...b.lines]).toEqual([])
  })

  it('2초 이내 차이는 뒤처짐이 아니다', () => {
    expect(run(new Cox(), 0, 60, { delta: 2 }).lines).toEqual([])
    expect(run(new Cox(), 0, 25, { delta: 2.1 }).times).toEqual([20])
  })

  it('6초 이상 빠른 채 20초가 지나면 아끼라고 한다', () => {
    const { lines, times } = run(new Cox('a'), 0, 120, { delta: COX_AHEAD_DELTA })
    expect(times).toEqual([COX_AHEAD_AFTER, COX_AHEAD_AFTER + COX_GENERIC_GAP, COX_AHEAD_AFTER + 2 * COX_GENERIC_GAP])
    for (const l of lines) expect(l).toMatch(/빨라요|여유/)
    expect(run(new Cox(), 0, 60, { delta: COX_AHEAD_DELTA + 0.1 }).lines).toEqual([])
  })

  it('목표를 지키면 90초마다 칭찬한다', () => {
    const { lines, times } = run(new Cox('a'), 0, 300, { delta: 0 })
    expect(lines).toHaveLength(3)
    for (const l of lines) expect(l).toMatch(/좋아요|메트로놈/)
    expect(times[0]).toBeGreaterThanOrEqual(COX_PRAISE_GAP)
    expect(times[0]).toBeLessThanOrEqual(COX_PRAISE_GAP + 1)
    expect(times[1]! - times[0]!).toBe(COX_PRAISE_GAP)
    expect(times[2]! - times[1]!).toBe(COX_PRAISE_GAP)
  })

  it('스플릿 값이 없으면(Infinity) 뒤처짐도 칭찬도 없다', () => {
    expect(run(new Cox(), 0, 300, { delta: Infinity }).lines).toEqual([])
  })

  it('같은 seed면 같은 문구를 고른다', () => {
    const a = run(new Cox('same'), 0, 200, { delta: 5 })
    const b = run(new Cox('same'), 0, 200, { delta: 5 })
    expect(a.lines).toEqual(b.lines)
    expect(a.lines.length).toBeGreaterThan(0)
  })
})

describe('event', () => {
  const milestone: CoxEvent = { kind: 'combo-milestone', count: 10, level: 1 }
  const brk: CoxEvent = { kind: 'combo-break', count: 12 }

  it('사건은 바로 말하되 4초 안에는 겹치지 않는다', () => {
    const cox = new Cox()
    expect(cox.event(milestone, 100)).toBe('열 번 연속! 리듬 탔어요')
    expect(cox.event(brk, 100 + COX_MIN_GAP - 0.5)).toBeNull()
    expect(cox.event(brk, 100 + COX_MIN_GAP)).toBe('괜찮아요. 다시 쌓아요')
    expect(cox.spoken).toBe(2)
  })

  it('tick이 말한 직후의 사건도 4초를 기다린다 (같은 입)', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 100, remaining: 50 }))).toBe(LAST_MINUTE)
    expect(cox.event(milestone, 102)).toBeNull()
    expect(cox.event(milestone, 104)).not.toBeNull()
  })

  it('말할 게 없는 사건(launch·라벨 없는 날씨)은 null이고 간격도 쓰지 않는다', () => {
    const cox = new Cox()
    expect(cox.event({ kind: 'launch' }, 100)).toBeNull()
    expect(cox.event({ kind: 'weather', label: null, mult: 1 }, 100)).toBeNull()
    expect(cox.spoken).toBe(0)
    expect(cox.event(milestone, 100)).not.toBeNull()
  })

  it('hush 동안은 사건도 tick도 조용하고, 풀리면 말한다 — 가장 늦은 hush가 남는다', () => {
    const cox = new Cox()
    cox.hush(120)
    expect(cox.event(milestone, 110)).toBeNull()
    expect(cox.tick(tick({ elapsed: 115, remaining: 50 }))).toBeNull()
    expect(cox.event(milestone, 120)).toBe('열 번 연속! 리듬 탔어요')
    cox.hush(200)
    cox.hush(150)
    expect(cox.event(brk, 190)).toBeNull()
    expect(cox.event(brk, 200)).toBe('괜찮아요. 다시 쌓아요')
  })

  it('reset 뒤에는 처음처럼 말한다', () => {
    const cox = new Cox()
    expect(cox.tick(tick({ elapsed: 1740, remaining: 60 }))).toBe(LAST_MINUTE)
    cox.hush(5000)
    cox.reset()
    expect(cox.spoken).toBe(0)
    expect(cox.tick(tick({ elapsed: 1740, remaining: 60 }))).toBe(LAST_MINUTE)
  })
})

describe('lineFor', () => {
  const zone: PowerZone = { index: 0, start: 100, end: 130 }
  const pass = (gap: number): CheckpointPass => ({
    index: 3, name: 'Henley Bridge', kind: 'bridge', at: 1860, elapsed: 500, gap, ghostGap: null, legSplit: 140,
  })

  it('콤보 단계는 10·25·50·100·200에 전용 문구, 그 밖은 숫자로', () => {
    expect(lineFor({ kind: 'combo-milestone', count: 10, level: 1 })).toBe('열 번 연속! 리듬 탔어요')
    expect(lineFor({ kind: 'combo-milestone', count: 25, level: 2 })).toContain('스물다섯')
    expect(lineFor({ kind: 'combo-milestone', count: 50, level: 3 })).toContain('쉰')
    expect(lineFor({ kind: 'combo-milestone', count: 100, level: 4 })).toContain('백 콤보')
    expect(lineFor({ kind: 'combo-milestone', count: 200, level: 5 })).toContain('이백')
    expect(lineFor({ kind: 'combo-milestone', count: 300, level: 5 })).toBe('300 콤보!')
    expect(lineFor({ kind: 'combo-break', count: 30 })).toBe('괜찮아요. 다시 쌓아요')
  })

  it('파워 구간: 예고·시작·성공/실패', () => {
    expect(lineFor({ kind: 'zone-soon', zone, startsIn: 10 })).toBe('10초 뒤 파워 구간. 호흡 넣고')
    expect(lineFor({ kind: 'zone-start', zone })).toBe('파워 구간! 30초 전력!')
    expect(lineFor({ kind: 'zone-end', zone, success: true, avgSplit: 130, targetSplit: 135, deltaSec: -5 })).toBe('성공! 다시 숨 고르고')
    expect(lineFor({ kind: 'zone-end', zone, success: false, avgSplit: 134, targetSplit: 135, deltaSec: -1 })).toBe('아깝다. 다음 구간에서 다시')
  })

  it('백조: 등장·통과/실패', () => {
    expect(lineFor({ kind: 'swans-appear', at: 700, deadline: 190 })).toBe('백조 떼! 10초 안에 지나가요')
    expect(lineFor({ kind: 'swans-result', success: true, margin: 0.4 })).toBe('통과! 멋져요')
    expect(lineFor({ kind: 'swans-result', success: false, margin: -0.1 })).toBe('백조가 먼저 갔어요. 괜찮아요')
  })

  it('심박: 부스트·과열', () => {
    expect(lineFor({ kind: 'hr-boost', boosts: 1 })).toBe('심박 존 완성! 10초 부스트!')
    expect(lineFor({ kind: 'hr-high', zone: 5 })).toBe('심박 높아요. 길게 내쉬어요')
  })

  it('체크포인트: 이름과 반올림한 미터, 앞/뒤', () => {
    expect(lineFor({ kind: 'checkpoint', pass: pass(12.4) })).toBe('Henley Bridge 통과. 12미터 앞')
    expect(lineFor({ kind: 'checkpoint', pass: pass(-7.6) })).toBe('Henley Bridge 통과. 8미터 뒤')
    expect(lineFor({ kind: 'checkpoint', pass: pass(0) })).toBe('Henley Bridge 통과. 0미터 앞')
  })

  it('날씨: 라벨이 없으면 null, 무지개는 코인 3배, 나머지는 라벨과 배율', () => {
    expect(lineFor({ kind: 'weather', label: null, mult: 1 })).toBeNull()
    expect(lineFor({ kind: 'weather', label: '무지개', mult: 3 })).toBe('무지개! 코인 3배!')
    expect(lineFor({ kind: 'weather', label: '비', mult: 1.5 })).toBe('비가 와요. 코인 1.5배')
    expect(lineFor({ kind: 'weather', label: '눈', mult: 2 })).toBe('눈! 코인 2배')
    const wind = lineFor({ kind: 'weather', label: '바람', mult: 1.3 })!
    expect(wind).toContain('바람')
    expect(wind).toContain('코인 1.3배')
  })

  it('출발 신호는 콕스가 말하지 않는다', () => {
    expect(lineFor({ kind: 'launch' })).toBeNull()
  })
})
