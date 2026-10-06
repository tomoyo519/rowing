import { describe, expect, it } from 'vitest'
import { initialQuality, QUALITY_PRESETS, QualityGovernor } from './quality'

/** 프레임 간격 dt를 n번 흘려보낸다 */
function run(governor: QualityGovernor, dt: number, frames: number) {
  for (let i = 0; i < frames; i++) governor.update(dt)
}

describe('그래픽 품질 티어', () => {
  it('URL로 고정한 티어가 있으면 그것을 쓰고, 없으면 high에서 시작한다', () => {
    expect(initialQuality('?quality=low')).toEqual({ tier: 'low', locked: true })
    expect(initialQuality('?weather=3&quality=medium')).toEqual({ tier: 'medium', locked: true })
    expect(initialQuality('?quality=ultra')).toEqual({ tier: 'high', locked: false })
    expect(initialQuality('')).toEqual({ tier: 'high', locked: false })
  })

  it('프리셋은 티어가 내려갈수록 반사·그림자·픽셀 비율·풀포기가 줄어든다', () => {
    const { high, medium, low } = QUALITY_PRESETS
    expect(high.reflectionScale).toBeGreaterThan(medium.reflectionScale)
    expect(low.reflectionScale).toBe(0)
    expect(high.shadowMapSize).toBeGreaterThan(medium.shadowMapSize)
    expect(medium.shadowMapSize).toBeGreaterThan(low.shadowMapSize)
    expect(high.pixelRatioCap).toBeGreaterThanOrEqual(medium.pixelRatioCap)
    expect(medium.pixelRatioCap).toBeGreaterThanOrEqual(low.pixelRatioCap)
    expect(high.vegetation).toBeGreaterThan(low.vegetation)
    expect(low.bloom).toBe(false)
    expect(low.smaa).toBe(false)
  })

  it('시작 직후 4초는 셰이더 컴파일 때문에 느려도 재지 않는다', () => {
    const changes: string[] = []
    const governor = new QualityGovernor('high', false, tier => changes.push(tier))
    // 4초 동안 10fps — 무시된다
    run(governor, 0.1, 40)
    expect(governor.tier).toBe('high')
    expect(changes).toEqual([])
  })

  it('30fps에 못 미치는 프레임이 이어지면 한 단계씩 내리고 다시 올리지 않는다', () => {
    const changes: string[] = []
    const governor = new QualityGovernor('high', false, tier => changes.push(tier))
    run(governor, 0.016, 260)        // 준비 구간(4초)을 지나 빠른 프레임 — 그대로
    expect(governor.tier).toBe('high')
    run(governor, 0.045, 130)        // 22fps가 120프레임 넘게 이어진다
    expect(governor.tier).toBe('medium')
    expect(changes).toEqual(['medium'])
    // 티어를 바꾼 직후는 다시 준비 구간 — 같은 느린 프레임도 4초 동안은 무시
    run(governor, 0.045, 80)
    expect(governor.tier).toBe('medium')
    run(governor, 0.045, 140)
    expect(governor.tier).toBe('low')
    // 다시 빨라져도 올라가지 않는다 (오르내리면 화면이 깜빡인다)
    run(governor, 0.01, 1000)
    expect(governor.tier).toBe('low')
    expect(changes).toEqual(['medium', 'low'])
  })

  it('가끔 끼어드는 긴 프레임(탭 전환)에는 흔들리지 않는다 — 중앙값을 본다', () => {
    const governor = new QualityGovernor('high')
    run(governor, 0.016, 260)
    for (let i = 0; i < 300; i++) governor.update(i % 10 === 0 ? 0.2 : 0.016)
    expect(governor.tier).toBe('high')
  })

  it('URL로 고정한 티어는 느려도 바꾸지 않는다', () => {
    const governor = new QualityGovernor('high', true)
    run(governor, 0.1, 1000)
    expect(governor.tier).toBe('high')
    expect(governor.settings).toBe(QUALITY_PRESETS.high)
  })
})
