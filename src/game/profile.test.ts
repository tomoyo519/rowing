import { describe, it, expect } from 'vitest'
import {
  nextStepAt, intensityAt, stepAt, meanIntensity, patternTotal, profileSwing, profileRange,
  profileOscillation, profileSections,
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

describe('profileSections', () => {
  it('인터벌은 스텝 경계가 구간 경계이고 마지막은 코스 끝에서 끝난다', () => {
    const s = profileSections(intervals, 30 * 60)
    expect(s[0]).toEqual({ start: 0, end: 180, label: '푸시' })
    expect(s[1]).toEqual({ start: 180, end: 300, label: '회복' })
    expect(s.at(-1)!.end).toBe(1800)
    for (let i = 1; i < s.length; i++) expect(s[i]!.start).toBe(s[i - 1]!.end)
  })

  it('아주 짧은 스텝은 최소 길이가 찰 때까지 다음 스텝과 합쳐진다', () => {
    const sprint: PaceProfile = {
      kind: 'intervals',
      pattern: [{ sec: 40, intensity: 1.28, label: '전력' }, { sec: 80, intensity: 0.84, label: '회복' }],
    }
    const s = profileSections(sprint, 20 * 60)
    expect(s).toHaveLength(10)
    expect(s[0]).toEqual({ start: 0, end: 120, label: '전력' })
    expect(s[9]).toEqual({ start: 1080, end: 1200, label: '전력' })
  })

  it('웨이브는 반주기마다, 스테디·빌드는 5분마다 나뉜다', () => {
    const wave = profileSections({ kind: 'wave', periodSec: 330, amplitude: 0.06 }, 30 * 60)
    expect(wave[0]!.end).toBe(165)
    expect(wave[0]!.label).toBe('페이스 올림')
    expect(wave[1]!.label).toBe('페이스 내림')
    expect(wave.at(-1)!.end).toBe(1800)

    const steady = profileSections({ kind: 'steady' }, 40 * 60)
    expect(steady).toHaveLength(8)
    expect(steady.every(x => x.end - x.start === 300)).toBe(true)

    const ramp = profileSections({ kind: 'ramp', from: 0.94, to: 1.06, overSec: 1800 }, 1800)
    expect(ramp).toHaveLength(6)
  })

  it('코스 끝의 짧은 자투리는 앞 구간에 붙는다', () => {
    const s = profileSections({ kind: 'steady' }, 1_260)   // 21분
    expect(s).toHaveLength(4)
    expect(s.at(-1)).toEqual({ start: 900, end: 1260, label: '스테디' })
  })
})

describe('nextStepAt', () => {
  const intervals = {
    kind: 'intervals' as const,
    pattern: [{ sec: 180, intensity: 1.1, label: '푸시' }, { sec: 120, intensity: 0.9, label: '회복' }],
  }

  it('구간 중에는 다음 구간과 남은 시간을 준다', () => {
    const n = nextStepAt(intervals, 30)
    expect(n).toEqual({ label: '회복', intensity: 0.9, startsIn: 150 })
    expect(nextStepAt(intervals, 200)).toEqual({ label: '푸시', intensity: 1.1, startsIn: 100 })
  })

  it('코스가 끝나기 전에 다음 구간이 오지 않으면 null', () => {
    expect(nextStepAt(intervals, 200, 250)).toBeNull()
    expect(nextStepAt(intervals, 200, 400)).not.toBeNull()
  })

  it('구간이 없는 프로파일은 null', () => {
    expect(nextStepAt({ kind: 'steady' }, 10)).toBeNull()
    expect(nextStepAt({ kind: 'wave', periodSec: 60, amplitude: 0.05 }, 10)).toBeNull()
  })

  it('램프는 끝나는 시점을 다음 구간으로 본다', () => {
    const ramp = { kind: 'ramp' as const, from: 0.9, to: 1.1, overSec: 300 }
    expect(nextStepAt(ramp, 100)).toEqual({ label: '마무리', intensity: 1.1, startsIn: 200 })
    expect(nextStepAt(ramp, 300)).toBeNull()
  })
})
