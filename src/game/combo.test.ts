import { describe, it, expect } from 'vitest'
import {
  RhythmCombo, comboLevel, COMBO_MILESTONES, COMBO_MAX_MISSES, COMBO_BREAK_ANNOUNCE, COMBO_TOLERANCE,
  type ComboEvent,
} from './combo'
import { GAUGE_TOLERANCE } from './paceGauge'

/** 좋은 스트로크 n번. 돌아온 이벤트를 모은다 */
function good(combo: RhythmCombo, n: number): ComboEvent[] {
  const events: ComboEvent[] = []
  for (let i = 0; i < n; i++) {
    const e = combo.onStroke(0)
    if (e) events.push(e)
  }
  return events
}

describe('상수', () => {
  it('허용 범위는 페이스 게이지의 유지 띠와 같고, 두 번 연속 느리면 끊기며, 10 이상 잃었을 때만 알린다', () => {
    expect(COMBO_TOLERANCE).toBe(GAUGE_TOLERANCE)
    expect(COMBO_MAX_MISSES).toBe(2)
    expect(COMBO_BREAK_ANNOUNCE).toBe(10)
    expect(COMBO_MILESTONES).toEqual([10, 25, 50, 100, 200])
  })
})

describe('comboLevel', () => {
  it('10·25·50·100·200에서 한 단계씩 오른다', () => {
    expect(comboLevel(0)).toBe(0)
    expect(comboLevel(9)).toBe(0)
    expect(comboLevel(10)).toBe(1)
    expect(comboLevel(24)).toBe(1)
    expect(comboLevel(25)).toBe(2)
    expect(comboLevel(50)).toBe(3)
    expect(comboLevel(100)).toBe(4)
    expect(comboLevel(200)).toBe(5)
    expect(comboLevel(999)).toBe(5)
  })
})

describe('리듬 콤보', () => {
  it('허용 범위 안이거나 더 빠르면 쌓이고, 경계를 넘으면 느린 스트로크다', () => {
    const c = new RhythmCombo()
    c.onStroke(-5)                  // 더 빠름
    c.onStroke(0)
    c.onStroke(COMBO_TOLERANCE)     // 경계는 포함
    expect(c.count).toBe(3)
    c.onStroke(COMBO_TOLERANCE + 0.01)
    expect(c.count).toBe(3)         // 느린 한 번은 봐준다
    expect(c.goodStrokes).toBe(3)
    expect(c.strokes).toBe(4)
  })

  it('단계 이벤트는 정확히 10·25·50·100·200에서만 나온다', () => {
    const c = new RhythmCombo()
    const events = good(c, 250)
    expect(events.map(e => e.kind)).toEqual(Array(5).fill('combo-milestone'))
    expect(events.map(e => e.kind === 'combo-milestone' && e.count)).toEqual([10, 25, 50, 100, 200])
    expect(events.map(e => e.kind === 'combo-milestone' && e.level)).toEqual([1, 2, 3, 4, 5])
    expect(c.count).toBe(250)
    expect(c.level).toBe(5)
    expect(c.best).toBe(250)
  })

  it('느린 스트로크 한 번은 봐주고, 다시 좋으면 이어진다', () => {
    const c = new RhythmCombo()
    good(c, 5)
    expect(c.onStroke(5)).toBeNull()
    expect(c.count).toBe(5)
    expect(c.onStroke(0)).toBeNull()
    expect(c.count).toBe(6)
  })

  it('느림·좋음이 번갈아 와도 끊기지 않는다 — 좋은 스트로크가 실수 기록을 지운다', () => {
    const c = new RhythmCombo()
    for (let i = 0; i < 30; i++) { c.onStroke(0); c.onStroke(9) }
    expect(c.count).toBe(30)
    expect(c.goodStrokes).toBe(30)
    expect(c.strokes).toBe(60)
  })

  it('두 번 연속 느리면 끊긴다 — 10 이상 잃었으면 알린다', () => {
    const c = new RhythmCombo()
    good(c, 15)
    expect(c.onStroke(5)).toBeNull()
    expect(c.onStroke(5)).toEqual({ kind: 'combo-break', count: 15 })
    expect(c.count).toBe(0)
    expect(c.level).toBe(0)
  })

  it('정확히 10을 잃으면 알리고, 9 이하면 조용히 끊긴다', () => {
    const ten = new RhythmCombo()
    good(ten, COMBO_BREAK_ANNOUNCE)
    ten.onStroke(5)
    expect(ten.onStroke(5)).toEqual({ kind: 'combo-break', count: COMBO_BREAK_ANNOUNCE })

    const nine = new RhythmCombo()
    good(nine, COMBO_BREAK_ANNOUNCE - 1)
    nine.onStroke(5)
    expect(nine.onStroke(5)).toBeNull()
    expect(nine.count).toBe(0)
  })

  it('값이 없는 스플릿(Infinity·NaN)은 느린 것으로 본다', () => {
    const c = new RhythmCombo()
    good(c, 12)
    expect(c.onStroke(Infinity)).toBeNull()
    expect(c.onStroke(Infinity)).toEqual({ kind: 'combo-break', count: 12 })
    good(c, 12)
    c.onStroke(NaN)
    expect(c.onStroke(NaN)).toEqual({ kind: 'combo-break', count: 12 })
    expect(c.goodStrokes).toBe(24)
  })

  it('노를 놓으면 바로 끊긴다 — 콤보가 없을 때는 조용하다', () => {
    const c = new RhythmCombo()
    good(c, 12)
    expect(c.onStop()).toEqual({ kind: 'combo-break', count: 12 })
    expect(c.count).toBe(0)
    expect(c.onStop()).toBeNull()
    good(c, 3)
    expect(c.onStop()).toBeNull()   // 3을 잃은 건 알리지 않는다
    expect(c.count).toBe(0)
  })

  it('최장 콤보는 끊겨도 남고, 좋은 스트로크·전체 스트로크 수는 계속 센다', () => {
    const c = new RhythmCombo()
    good(c, 12)
    c.onStop()
    good(c, 5)
    expect(c.best).toBe(12)
    expect(c.count).toBe(5)
    expect(c.goodStrokes).toBe(17)
    expect(c.strokes).toBe(17)
  })

  it('reset은 모든 수치를 0으로 돌린다', () => {
    const c = new RhythmCombo()
    good(c, 30)
    c.onStroke(9)
    c.reset()
    expect(c).toMatchObject({ count: 0, best: 0, goodStrokes: 0, strokes: 0, level: 0 })
  })
})
