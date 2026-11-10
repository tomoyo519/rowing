import { describe, it, expect } from 'vitest'
import { motifStep } from './sharkScore'

describe('상어 모티프 빠르기', () => {
  it('멀면 느리고 코앞이면 빠르다 — 단조 감소', () => {
    let prev = Infinity
    for (let d = 0; d <= 1.0001; d += 0.1) {
      const { interval } = motifStep(d, 'cruise')
      expect(interval).toBeLessThanOrEqual(prev + 1e-9)
      prev = interval
    }
    expect(motifStep(0, 'cruise').interval).toBeCloseTo(3.0, 6)
    expect(motifStep(1, 'cruise').interval).toBeCloseTo(0.45, 6)
  })

  it('경고·덮치기는 멀어도 빠르고, 물러날 땐 느려진다', () => {
    expect(motifStep(0, 'warn').interval).toBeLessThanOrEqual(0.85)
    expect(motifStep(0, 'surge').interval).toBeLessThanOrEqual(0.42)
    expect(motifStep(1, 'retreat').interval).toBeGreaterThanOrEqual(2.2)
  })

  it('가까울수록 세진다', () => {
    expect(motifStep(1, 'cruise').gain).toBeGreaterThan(motifStep(0, 'cruise').gain)
    expect(motifStep(0.5, 'surge').gain).toBeGreaterThan(motifStep(0.5, 'cruise').gain)
  })
})
