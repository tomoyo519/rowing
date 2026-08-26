import { describe, it, expect } from 'vitest'
import { GhostTrack } from './ghost'
import type { SessionRecord } from './history'

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'g', at: '2026-08-01T10:00:00.000Z', courseId: 'henley-steady-30',
  courseName: '헨리 스테디', courseType: '스테디', venue: 'Henley',
  durationSec: 1800, baseSplit: 145, elapsed: 1800, distance: 6000,
  avgSplit: 150, avgSpm: 26, avgPower: 200, strokeCount: 780,
  gap: 0, completed: true,
  curve: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, split: 150 })),
  ...over,
})

describe('GhostTrack', () => {
  it('0초에는 출발선에 있다', () => {
    expect(new GhostTrack(rec()).distanceAt(0)).toBe(0)
  })

  it('끝나는 시점의 거리가 기록과 정확히 일치한다', () => {
    const g = new GhostTrack(rec())
    expect(g.distanceAt(1800)).toBeCloseTo(6000, 6)
  })

  it('일정 페이스면 중간 지점이 절반이다', () => {
    const g = new GhostTrack(rec())
    expect(g.distanceAt(900)).toBeCloseTo(3000, 0)
  })

  it('거리는 시간에 따라 단조 증가한다', () => {
    const g = new GhostTrack(rec({
      curve: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, split: 140 + Math.sin(i) * 12 })),
    }))
    let prev = -1
    for (let t = 0; t <= 1800; t += 7) {
      const d = g.distanceAt(t)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
  })

  it('전반이 빨랐던 기록은 중간 지점에서 절반보다 앞서 있다', () => {
    const g = new GhostTrack(rec({
      curve: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, split: i < 15 ? 135 : 165 })),
    }))
    expect(g.distanceAt(900)).toBeGreaterThan(3000)
    expect(g.distanceAt(1800)).toBeCloseTo(6000, 6)   // 끝점은 여전히 정확
  })

  it('곡선 데이터가 없으면 평균 속도로 균등하게 달린다', () => {
    const g = new GhostTrack(rec({ curve: [] }))
    expect(g.distanceAt(900)).toBeCloseTo(3000, 6)
    expect(g.distanceAt(1800)).toBeCloseTo(6000, 6)
  })

  it('망가진 곡선 값(무한대·음수)은 걸러낸다', () => {
    const g = new GhostTrack(rec({
      curve: [
        { t: 0, split: Infinity },
        { t: 60, split: -5 },
        { t: 120, split: 150 },
        { t: 180, split: 150 },
      ],
    }))
    expect(Number.isFinite(g.distanceAt(900))).toBe(true)
    expect(g.distanceAt(1800)).toBeCloseTo(6000, 6)
  })

  it('기록 시간을 넘어서면 최종 거리에 머문다', () => {
    const g = new GhostTrack(rec())
    expect(g.distanceAt(5000)).toBeCloseTo(6000, 6)
  })

  it('splitAt은 그 시점의 페이스를 돌려준다', () => {
    const g = new GhostTrack(rec())
    expect(g.splitAt(600)).toBeCloseTo(150, 0)
  })
})
