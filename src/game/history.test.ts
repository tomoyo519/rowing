import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadHistory, saveRecord, deleteRecord, clearHistory,
  personalBest, totals, thinCurve, type SessionRecord,
} from './history'

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

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'a', at: '2026-08-01T10:00:00.000Z', courseId: 'henley-steady-30',
  courseName: '헨리 스테디', courseType: '스테디', venue: 'Henley',
  durationSec: 1800, baseSplit: 145, elapsed: 1800, distance: 6200,
  avgSplit: 145, avgSpm: 26, avgPower: 200, strokeCount: 780,
  gap: 12, completed: true, curve: [], ...over,
})

describe('저장/불러오기', () => {
  it('저장한 기록을 최신순으로 돌려준다', () => {
    saveRecord(rec({ id: 'old', at: '2026-08-01T10:00:00.000Z' }))
    saveRecord(rec({ id: 'new', at: '2026-08-05T10:00:00.000Z' }))
    expect(loadHistory().map(r => r.id)).toEqual(['new', 'old'])
  })

  it('id로 삭제한다', () => {
    saveRecord(rec({ id: 'x' }))
    saveRecord(rec({ id: 'y', at: '2026-08-02T10:00:00.000Z' }))
    deleteRecord('x')
    expect(loadHistory().map(r => r.id)).toEqual(['y'])
  })

  it('손상된 데이터가 있어도 던지지 않는다', () => {
    localStorage.setItem('makeRowing.history.v1', '{{{ not json')
    expect(loadHistory()).toEqual([])
  })

  it('배열이 아닌 값이 들어있어도 빈 배열을 준다', () => {
    localStorage.setItem('makeRowing.history.v1', '{"a":1}')
    expect(loadHistory()).toEqual([])
  })

  it('전체 삭제', () => {
    saveRecord(rec())
    clearHistory()
    expect(loadHistory()).toEqual([])
  })
})

describe('personalBest', () => {
  it('같은 코스에서 가장 멀리 간 완주 기록', () => {
    const h = [
      rec({ id: 'a', distance: 6000 }),
      rec({ id: 'b', distance: 6500 }),
      rec({ id: 'c', distance: 7000, courseId: 'other' }),
    ]
    expect(personalBest('henley-steady-30', h)!.id).toBe('b')
  })

  it('중단한 세션은 PB로 치지 않는다', () => {
    const h = [
      rec({ id: 'a', distance: 6000 }),
      rec({ id: 'dnf', distance: 9000, completed: false }),
    ]
    expect(personalBest('henley-steady-30', h)!.id).toBe('a')
  })

  it('완주 기록이 없으면 null', () => {
    expect(personalBest('henley-steady-30', [rec({ completed: false })])).toBeNull()
  })
})

describe('totals', () => {
  it('거리·시간·스트로크를 합산한다', () => {
    const t = totals([rec({ distance: 6000, elapsed: 1800, strokeCount: 700 }),
                      rec({ id: 'b', distance: 4000, elapsed: 1200, strokeCount: 500 })])
    expect(t).toMatchObject({ sessions: 2, distance: 10000, seconds: 3000, strokes: 1200 })
  })
})

describe('thinCurve', () => {
  it('초 단위 트랙을 분 단위로 솎는다', () => {
    const track = Array.from({ length: 300 }, (_, i) => ({ t: i, split: 140 }))
    const out = thinCurve(track, 60)
    expect(out.length).toBeLessThanOrEqual(6)
    expect(out.every(p => p.split === 140)).toBe(true)
  })

  it('출발 직후의 비정상 스플릿에 끌려가지 않는다 (평균이 아니라 중앙값)', () => {
    // 첫 3초만 말도 안 되게 느리고 나머지는 140
    const track = [
      { t: 0, split: 500 }, { t: 1, split: 400 }, { t: 2, split: 300 },
      ...Array.from({ length: 57 }, (_, i) => ({ t: i + 3, split: 140 })),
    ]
    const out = thinCurve(track, 60)
    expect(out[0]!.split).toBe(140)
  })

  it('범위를 벗어난 값은 버린다', () => {
    const track = [
      ...Array.from({ length: 30 }, (_, i) => ({ t: i, split: Infinity })),
      ...Array.from({ length: 30 }, (_, i) => ({ t: i + 30, split: 150 })),
    ]
    expect(thinCurve(track, 60)[0]!.split).toBe(150)
  })
})
