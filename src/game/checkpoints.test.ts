import { describe, it, expect } from 'vitest'
import { createCheckpoints, CheckpointTracker, type Checkpoint } from './checkpoints'
import { COURSES, type Landmark } from './courses'

const venueOf = (id: string) => COURSES.find(c => c.id === id)!.venue

describe('createCheckpoints', () => {
  it('출발 직후(3% 미만)·결승 직전(98.5% 초과)의 랜드마크는 빼고, 거리순으로 index를 붙이며, at은 비율 × 총거리', () => {
    const landmarks: Landmark[] = [
      { at: 0.99, name: 'Finish', kind: 'tower' },
      { at: 0.5, name: 'Mid', kind: 'bridge' },
      { at: 0.02, name: 'Start', kind: 'buoy' },
      { at: 0.03, name: 'Low edge', kind: 'trees' },
      { at: 0.985, name: 'High edge', kind: 'castle' },
    ]
    const points = createCheckpoints(landmarks, 6000)
    expect(points.map(p => p.name)).toEqual(['Low edge', 'Mid', 'High edge'])
    expect(points.map(p => p.index)).toEqual([0, 1, 2])
    expect(points.map(p => p.kind)).toEqual(['trees', 'bridge', 'castle'])
    expect(points[0]!.at).toBeCloseTo(180, 9)
    expect(points[1]!.at).toBeCloseTo(3000, 9)
    expect(points[2]!.at).toBeCloseTo(5910, 9)
  })

  it('입력 배열은 건드리지 않는다', () => {
    const landmarks: Landmark[] = [
      { at: 0.5, name: 'B', kind: 'bridge' },
      { at: 0.2, name: 'A', kind: 'trees' },
    ]
    createCheckpoints(landmarks, 1000)
    expect(landmarks.map(l => l.name)).toEqual(['B', 'A'])
  })

  it('실제 코스의 랜드마크는 모두 [3%, 98.5%] 안에 있어 하나도 빠지지 않고 거리순이다', () => {
    for (const [courseId, total] of [['bosbaan-steady-40', 10000], ['henley-steady-30', 6000]] as const) {
      const landmarks = venueOf(courseId).landmarks
      const points = createCheckpoints(landmarks, total)
      expect(points).toHaveLength(landmarks.length)
      expect(points.map(p => p.at)).toEqual([...points.map(p => p.at)].sort((a, b) => a - b))
      for (const p of points) {
        expect(p.at).toBeGreaterThanOrEqual(0.03 * total)
        expect(p.at).toBeLessThanOrEqual(0.985 * total)
      }
    }
    // 보스반 결승탑(0.97)은 상한 0.985 안쪽이라 체크포인트로 남는다
    expect(createCheckpoints(venueOf('bosbaan-steady-40').landmarks, 10000).map(p => p.name)).toContain('Finish Tower')
  })
})

const POINTS: Checkpoint[] = [
  { index: 0, name: 'A', kind: 'bridge', at: 100 },
  { index: 1, name: 'B', kind: 'tower', at: 200 },
  { index: 2, name: 'C', kind: 'buoy', at: 300 },
]

describe('CheckpointTracker', () => {
  it('거리가 체크포인트에 닿는 순간 한 번 알리고, 다음 체크포인트로 넘어간다', () => {
    const t = new CheckpointTracker(POINTS)
    expect(t.upcoming).toBe(POINTS[0])
    expect(t.update(99.9, 24, 1, null)).toEqual([])
    const passes = t.update(100, 25, 3, null)
    expect(passes).toHaveLength(1)
    expect(passes[0]).toMatchObject({ index: 0, name: 'A', kind: 'bridge', at: 100, elapsed: 25, gap: 3, ghostGap: null })
    expect(t.upcoming).toBe(POINTS[1])
    // 같은 자리에 머물거나 다음 체크포인트 전이면 다시 알리지 않는다
    expect(t.update(100, 26, 3, null)).toEqual([])
    expect(t.update(150, 40, 3, 2)).toEqual([])
  })

  it('legSplit은 직전 체크포인트(또는 출발)부터의 초 / m × 500', () => {
    const t = new CheckpointTracker(POINTS)
    const [a] = t.update(100, 25, 0, null)        // 출발부터 100m를 25초
    expect(a!.legSplit).toBe(125)
    const [b] = t.update(200, 70, 0, null)        // 다음 100m를 45초
    expect(b!.legSplit).toBe(225)
  })

  it('고스트 차이는 있으면 싣고 없으면 null', () => {
    const t = new CheckpointTracker(POINTS)
    expect(t.update(100, 25, 2, 7)[0]!.ghostGap).toBe(7)
    expect(t.update(200, 50, 2, null)[0]!.ghostGap).toBeNull()
  })

  it('한 번의 update로 여러 개를 넘으면 모두 순서대로 돌려준다', () => {
    const t = new CheckpointTracker(POINTS)
    const passes = t.update(350, 100, -2, 5)
    expect(passes.map(p => p.name)).toEqual(['A', 'B', 'C'])
    expect(passes.map(p => p.index)).toEqual([0, 1, 2])
    expect(passes.every(p => p.elapsed === 100 && p.gap === -2 && p.ghostGap === 5)).toBe(true)
    expect(passes[0]!.legSplit).toBeCloseTo((100 / 350) * 500, 9)
    expect(t.upcoming).toBeNull()
    expect(t.update(400, 110, 0, null)).toEqual([])
  })

  it('거리가 0이거나 줄어도 던지지 않고 아무것도 알리지 않는다', () => {
    const t = new CheckpointTracker(POINTS)
    expect(t.update(0, 0, 0, null)).toEqual([])
    expect(t.update(-5, 1, 0, null)).toEqual([])
    expect(t.upcoming).toBe(POINTS[0])
  })

  it('체크포인트가 없으면 upcoming은 null이고 update는 늘 빈 배열', () => {
    const t = new CheckpointTracker([])
    expect(t.upcoming).toBeNull()
    expect(t.update(5000, 100, 0, null)).toEqual([])
    expect(t.leads).toBe(0)
  })

  it('leads는 passes 중 페이스 보트와 같거나 앞선(gap ≥ 0) 것만 센다', () => {
    const t = new CheckpointTracker(POINTS)
    expect(t.leads).toBe(0)
    t.passes.push(
      { ...POINTS[0]!, elapsed: 25, gap: 3, ghostGap: null, legSplit: 125 },
      { ...POINTS[1]!, elapsed: 50, gap: 0, ghostGap: null, legSplit: 125 },
      { ...POINTS[2]!, elapsed: 75, gap: -4, ghostGap: null, legSplit: 125 },
    )
    expect(t.leads).toBe(2)
  })
})
