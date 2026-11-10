import { describe, it, expect } from 'vitest'
import { hashString, seededRandom, range } from './random'

describe('hashString', () => {
  it('32비트 부호 없는 정수를 돌려주고, 빈 문자열은 FNV-1a 오프셋 그대로다', () => {
    expect(hashString('')).toBe(2166136261)
    for (const s of ['a', 'seed', '헨리 인터벌', 'daily:2026-11-10', 'x'.repeat(200)]) {
      const h = hashString(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('같은 문자열은 같은 값, 다른 문자열(순서만 달라도)은 다른 값', () => {
    expect(hashString('one')).toBe(hashString('one'))
    expect(hashString('one')).not.toBe(hashString('two'))
    expect(hashString('ab')).not.toBe(hashString('ba'))
    expect(hashString('seed:power-zones')).not.toBe(hashString('seed:swans'))
  })
})

describe('seededRandom', () => {
  it('[0, 1) 범위 값만 낸다', () => {
    const random = seededRandom('range')
    for (let i = 0; i < 2000; i++) {
      const v = random()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('같은 seed면 같은 순서, 다른 seed면 다른 순서', () => {
    const take = (seed: string, n = 20) => {
      const random = seededRandom(seed)
      return Array.from({ length: n }, () => random())
    }
    expect(take('one')).toEqual(take('one'))
    expect(take('one')).not.toEqual(take('two'))
    // 꼬리만 달라도 다른 흐름 — 모듈마다 `${seed}:이름`으로 갈라 쓴다
    expect(take('seed:power-zones')).not.toEqual(take('seed:swans'))
  })

  it('한 값에 몰리지 않는다 — 평균은 0.5 근처, 값이 거의 겹치지 않는다', () => {
    const random = seededRandom('spread')
    const values = Array.from({ length: 4000 }, () => random())
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
    expect(new Set(values).size).toBeGreaterThan(3900)
  })
})

describe('range', () => {
  it('난수 0이면 min, 0.5면 가운데, 1 직전이면 max 미만', () => {
    expect(range(() => 0, 150, 240)).toBe(150)
    expect(range(() => 0.5, 150, 240)).toBe(195)
    expect(range(() => 0.999999, 150, 240)).toBeLessThan(240)
  })

  it('seededRandom과 함께 쓰면 항상 [min, max) 안에 든다', () => {
    const random = seededRandom('r')
    for (let i = 0; i < 1000; i++) {
      const v = range(random, 210, 330)
      expect(v).toBeGreaterThanOrEqual(210)
      expect(v).toBeLessThan(330)
    }
  })
})
