import { describe, expect, it } from 'vitest'
import { paceGaugeState } from './paceGauge'

describe('목표 페이스 게이지', () => {
  it('목표 선은 항상 같은 자리에 있고 막대가 움직인다', () => {
    const onTarget = paceGaugeState(135, 135)
    expect(onTarget.target).toBeCloseTo(0.625, 6)
    expect(onTarget.fill).toBeCloseTo(0.625, 6)
    expect(onTarget.state).toBe('ok')
    expect(paceGaugeState(120, 135).target).toBeCloseTo(0.625, 6)
  })

  it('목표보다 느리면 선에 못 미치고 빠르면 넘는다', () => {
    const slow = paceGaugeState(145, 135)
    expect(slow.state).toBe('behind')
    expect(slow.delta).toBe(10)
    expect(slow.fill).toBeLessThan(slow.target)

    const fast = paceGaugeState(128, 135)
    expect(fast.state).toBe('ahead')
    expect(fast.fill).toBeGreaterThan(fast.target)
    expect(paceGaugeState(120, 135).fill).toBe(1)
    expect(paceGaugeState(200, 135).fill).toBe(0)
  })

  it('2초 이내는 유지 중으로 보고, 속도가 없으면 대기 상태다', () => {
    expect(paceGaugeState(136.5, 135).state).toBe('ok')
    expect(paceGaugeState(133.5, 135).state).toBe('ok')
    expect(paceGaugeState(Infinity, 135).state).toBe('idle')
    expect(paceGaugeState(Infinity, 135).fill).toBe(0)
    expect(paceGaugeState(0, 135).state).toBe('idle')
  })
})

describe('양방향 게이지 막대', () => {
  it('느리면 가운데에서 왼쪽으로, 빠르면 오른쪽으로 자란다', async () => {
    const { paceGaugeBar, paceGaugeTolerance, paceGaugeTicks } = await import('./paceGauge')
    expect(paceGaugeBar(Infinity)).toEqual({ left: 50, right: 50 })
    expect(paceGaugeBar(0)).toEqual({ left: 50, right: 50 })
    expect(paceGaugeBar(12.5)).toEqual({ left: 25, right: 50 })
    expect(paceGaugeBar(40)).toEqual({ left: 0, right: 50 })
    expect(paceGaugeBar(-7.5)).toEqual({ left: 50, right: 25 })
    expect(paceGaugeBar(-30)).toEqual({ left: 50, right: 0 })
    // 허용 범위 ±2초: 왼쪽은 25초 중 2초, 오른쪽은 15초 중 2초라 오른쪽이 더 넓다
    const tol = paceGaugeTolerance()
    expect(tol.left).toBeCloseTo(4, 6)
    expect(tol.right).toBeCloseTo(6.6667, 3)
    const ticks = paceGaugeTicks()
    expect(ticks.map(t => t.seconds)).toEqual([-25, -20, -15, -10, -5, 5, 10, 15])
    expect(ticks[0]!.pct).toBe(0)
    expect(ticks[ticks.length - 1]!.pct).toBe(100)
  })
})
