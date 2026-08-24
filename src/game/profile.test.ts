import { describe, it, expect } from 'vitest'
import {
  intensityAt, stepAt, meanIntensity, patternTotal, profileSwing, profileRange,
  profileOscillation,
  type PaceProfile,
} from './profile'

const intervals: PaceProfile = {
  kind: 'intervals',
  pattern: [
    { sec: 180, intensity: 1.10, label: '푸시' },
    { sec: 120, intensity: 0.90, label: '회복' },
  ],
}

describe('intensityAt', () => {
  it('steady는 항상 1', () => {
    for (const t of [0, 100, 5000]) expect(intensityAt({ kind: 'steady' }, t)).toBe(1)
  })

  it('wave는 주기의 1/4에서 최대, 3/4에서 최소', () => {
    const p: PaceProfile = { kind: 'wave', periodSec: 300, amplitude: 0.08 }
    expect(intensityAt(p, 0)).toBeCloseTo(1.0, 6)
    expect(intensityAt(p, 75)).toBeCloseTo(1.08, 6)
    expect(intensityAt(p, 225)).toBeCloseTo(0.92, 6)
    expect(intensityAt(p, 300)).toBeCloseTo(1.0, 6)
  })

  it('인터벌 구간 값이 맞는다 (램프 구간 밖에서)', () => {
    expect(intensityAt(intervals, 60)).toBeCloseTo(1.10, 6)   // 푸시 한가운데
    expect(intensityAt(intervals, 240)).toBeCloseTo(0.90, 6)  // 회복 한가운데
  })

  it('구간 전환은 램프로 이어져 속도가 튀지 않는다', () => {
    // 회복 시작 직후 = 1.10 → 0.90 으로 넘어가는 중
    const atStart = intensityAt(intervals, 180.0)
    const mid = intensityAt(intervals, 182)
    expect(atStart).toBeCloseTo(1.10, 2)
    expect(mid).toBeGreaterThan(0.90)
    expect(mid).toBeLessThan(1.10)
  })

  it('패턴이 코스 길이를 넘어가면 앞에서부터 반복한다', () => {
    const total = patternTotal(intervals as never)
    expect(total).toBe(300)
    expect(intensityAt(intervals, 60)).toBeCloseTo(intensityAt(intervals, 60 + total), 6)
  })
})

describe('stepAt', () => {
  it('현재 구간 이름과 남은 시간을 준다', () => {
    const s = stepAt(intervals, 60)
    expect(s.label).toBe('푸시')
    expect(s.remaining).toBeCloseTo(120, 6)
  })

  it('wave는 오르내림을 알려주고 남은 시간은 없다', () => {
    const p: PaceProfile = { kind: 'wave', periodSec: 300, amplitude: 0.08 }
    expect(stepAt(p, 10).label).toBe('페이스 올림')
    expect(stepAt(p, 160).label).toBe('페이스 내림')
    expect(stepAt(p, 10).remaining).toBeNull()
  })
})

describe('meanIntensity', () => {
  it('wave는 한 주기 평균이 1에 수렴한다', () => {
    const p: PaceProfile = { kind: 'wave', periodSec: 300, amplitude: 0.08 }
    expect(meanIntensity(p, 1800)).toBeCloseTo(1.0, 3)
  })

  it('인터벌 평균은 시간 가중 평균이다', () => {
    // (180*1.10 + 120*0.90) / 300 = 1.02, 램프 때문에 아주 살짝 낮다
    expect(meanIntensity(intervals, 1800)).toBeCloseTo(1.02, 2)
  })

  it('피라미드처럼 대칭이면 평균이 중앙값 근처', () => {
    const pyramid: PaceProfile = {
      kind: 'intervals',
      pattern: [0.94, 0.98, 1.02, 1.06, 1.10, 1.06, 1.00, 0.94]
        .map((intensity, i) => ({ sec: 300, intensity, label: `s${i}` })),
    }
    expect(meanIntensity(pyramid, 2400)).toBeCloseTo(1.0125, 2)
  })
})

describe('ramp (한 방향 변화)', () => {
  const p: PaceProfile = { kind: 'ramp', from: 0.94, to: 1.06, overSec: 1800 }

  it('시작·중간·끝 값이 선형으로 이어진다', () => {
    expect(intensityAt(p, 0)).toBeCloseTo(0.94, 6)
    expect(intensityAt(p, 900)).toBeCloseTo(1.00, 6)
    expect(intensityAt(p, 1800)).toBeCloseTo(1.06, 6)
  })

  it('끝난 뒤에도 마지막 값을 유지한다', () => {
    expect(intensityAt(p, 5000)).toBeCloseTo(1.06, 6)
  })

  it('절대 내려가지 않는다 — 오르내림이 없어야 하는 코스', () => {
    let prev = -Infinity
    for (let t = 0; t <= 1800; t += 10) {
      const v = intensityAt(p, t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('전환 램프', () => {
  it('짧은 구간에서는 램프가 구간을 다 잡아먹지 않는다', () => {
    // 40초 전력 구간에 12초 기본 램프를 그대로 쓰면 30%를 넘는다
    const sprint: PaceProfile = {
      kind: 'intervals',
      pattern: [
        { sec: 40, intensity: 1.28, label: '전력' },
        { sec: 80, intensity: 0.84, label: '회복' },
      ],
    }
    // 40 * 0.3 = 12초가 상한. 그 직후에는 목표 강도에 도달해 있어야 한다
    expect(intensityAt(sprint, 120 + 12.1)).toBeCloseTo(1.28, 6)
  })

  it('rampSec으로 전환을 더 느긋하게 만들 수 있다', () => {
    const blocks: PaceProfile = {
      kind: 'intervals', rampSec: 40,
      pattern: [
        { sec: 600, intensity: 0.96, label: 'a' },
        { sec: 600, intensity: 1.06, label: 'b' },
      ],
    }
    // 전환 20초 지점이면 아직 절반쯤 와 있어야 한다
    const mid = intensityAt(blocks, 600 + 20)
    expect(mid).toBeGreaterThan(0.99)
    expect(mid).toBeLessThan(1.03)
  })
})

describe('profileSwing / profileRange', () => {
  it('steady는 흔들림이 0', () => {
    expect(profileSwing({ kind: 'steady' }, 1800)).toBe(0)
  })

  it('wave의 폭은 진폭의 2배', () => {
    const p: PaceProfile = { kind: 'wave', periodSec: 300, amplitude: 0.06 }
    expect(profileSwing(p, 1800)).toBeCloseTo(0.12, 2)
  })

  it('ramp의 폭은 시작~끝 차이', () => {
    const p: PaceProfile = { kind: 'ramp', from: 0.94, to: 1.06, overSec: 1800 }
    expect(profileSwing(p, 1800)).toBeCloseTo(0.12, 2)
  })

  it('범위를 min/max로 준다', () => {
    const p: PaceProfile = { kind: 'ramp', from: 0.95, to: 1.08, overSec: 2400 }
    const r = profileRange(p, 2400)
    expect(r.min).toBeCloseTo(0.95, 2)
    expect(r.max).toBeCloseTo(1.08, 2)
  })
})

describe('profileOscillation', () => {
  it('단조 증가하는 ramp는 범위가 넓어도 0이다', () => {
    const p: PaceProfile = { kind: 'ramp', from: 0.90, to: 1.15, overSec: 1800 }
    expect(profileSwing(p, 1800)).toBeCloseTo(0.25, 2)
    expect(profileOscillation(p, 1800)).toBe(0)
  })

  it('steady도 0', () => {
    expect(profileOscillation({ kind: 'steady' }, 1800)).toBe(0)
  })

  it('wave는 마루~골 낙차가 나온다', () => {
    const p: PaceProfile = { kind: 'wave', periodSec: 300, amplitude: 0.06 }
    expect(profileOscillation(p, 1800)).toBeCloseTo(0.12, 2)
  })

  it('인터벌은 구간 간 낙차가 나온다', () => {
    const p: PaceProfile = {
      kind: 'intervals',
      pattern: [
        { sec: 180, intensity: 1.10, label: 'a' },
        { sec: 120, intensity: 0.90, label: 'b' },
      ],
    }
    expect(profileOscillation(p, 1800)).toBeCloseTo(0.20, 2)
  })
})
