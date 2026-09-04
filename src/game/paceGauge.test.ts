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
