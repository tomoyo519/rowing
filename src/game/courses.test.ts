import { describe, it, expect } from 'vitest'
import { COURSES, courseGroups, courseById, projectedDistance, courseRangeLabel } from './courses'
import { profileSwing, profileOscillation, patternTotal } from './profile'

describe('코스 정의', () => {
  it('id가 중복되지 않는다', () => {
    expect(new Set(COURSES.map(c => c.id)).size).toBe(COURSES.length)
  })

  it('인터벌 패턴이 코스 길이에 정수 배로 떨어진다', () => {
    // 안 떨어지면 마지막 세트가 어중간하게 잘려서 끝난다
    for (const c of COURSES) {
      if (c.profile.kind !== 'intervals') continue
      const total = patternTotal(c.profile)
      expect(c.durationSec % total, `${c.name}: ${c.durationSec} % ${total}`).toBe(0)
    }
  })

  it('ramp 코스는 코스 길이에 맞춰 끝난다', () => {
    for (const c of COURSES) {
      if (c.profile.kind !== 'ramp') continue
      if (c.profile.from === c.profile.to) continue      // 고정 강도는 예외
      expect(c.profile.overSec, c.name).toBe(c.durationSec)
    }
  })

  it('강도가 상식적인 범위 안에 있다', () => {
    for (const c of COURSES) {
      const swing = profileSwing(c.profile, c.durationSec)
      expect(swing, `${c.name} 흔들림`).toBeLessThan(0.5)
    }
  })

  it('courseById는 모르는 id에 첫 코스를 준다', () => {
    expect(courseById('없는코스').id).toBe(COURSES[0]!.id)
    expect(courseById(COURSES[3]!.id).id).toBe(COURSES[3]!.id)
  })
})

describe('그룹핑', () => {
  it('모든 코스가 정확히 한 그룹에 들어간다', () => {
    const groups = courseGroups()
    const ids = groups.flatMap(g => g.courses.map(c => c.id))
    expect(ids.length).toBe(COURSES.length)
    expect(new Set(ids).size).toBe(COURSES.length)
  })

  it("'완만' 그룹은 실제로 오르내림이 적다", () => {
    const gentle = courseGroups().find(g => g.tone === 'gentle')!
    for (const c of gentle.courses) {
      expect(profileOscillation(c.profile, c.durationSec), c.name).toBeLessThanOrEqual(0.115)
    }
  })

  it("'변화 있음'은 완만 기준을 넘는다", () => {
    const varied = courseGroups().find(g => g.tone === 'varied')!
    for (const c of varied.courses) {
      expect(profileOscillation(c.profile, c.durationSec), c.name).toBeGreaterThan(0.115)
    }
  })

  it('한 방향으로만 변하는 빌드 코스는 범위가 넓어도 완만으로 분류된다', () => {
    const build = COURSES.find(c => c.id === 'henley-build-30')!
    expect(profileSwing(build.profile, build.durationSec)).toBeGreaterThan(0.115)  // 범위는 넓지만
    expect(profileOscillation(build.profile, build.durationSec)).toBe(0)          // 오르내림은 없다
    const gentle = courseGroups().find(g => g.tone === 'gentle')!
    expect(gentle.courses.map(c => c.id)).toContain('henley-build-30')
  })

  it('그룹 안에서 짧은 코스가 먼저 온다', () => {
    for (const g of courseGroups()) {
      const d = g.courses.map(c => c.durationSec)
      expect(d).toEqual([...d].sort((a, b) => a - b))
    }
  })
})

describe('예상 거리', () => {
  it('빠른 목표일수록 멀리 간다', () => {
    const c = COURSES[0]!
    expect(projectedDistance(c, 118)).toBeGreaterThan(projectedDistance(c, 165))
  })

  it('평균 강도가 1보다 큰 코스는 스테디보다 멀리 간다', () => {
    const steady = COURSES.find(c => c.id === 'henley-steady-30')!
    const interval = COURSES.find(c => c.id === 'henley-interval-30')!
    expect(projectedDistance(interval, 145)).toBeGreaterThan(projectedDistance(steady, 145))
  })
})

describe('범위 라벨', () => {
  it('고정 강도는 "고정"으로 표기한다', () => {
    expect(courseRangeLabel(COURSES.find(c => c.id === 'henley-steady-30')!)).toContain('고정')
  })

  it('변하는 코스는 하한~상한으로 표기한다', () => {
    expect(courseRangeLabel(COURSES.find(c => c.id === 'henley-build-30')!)).toMatch(/^\d+~\d+%$/)
  })
})
