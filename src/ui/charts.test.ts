import { describe, expect, it } from 'vitest'
import { COURSES, courseById } from '../game/courses'
import { profileSections } from '../game/profile'
import {
  buildSplitChart, deltaChipHtml, niceSplitDomain, profileStripSvg, signedSeconds, sparklineSvg,
} from './charts'

const sprint = courseById('thames-sprint-20')
const steady = courseById('henley-steady-30')

describe('코스 강도 띠 (레이스 HUD)', () => {
  it('구간 경계마다 2px 틈을 두고 5분마다 눈금을 긋는다', () => {
    const svg = profileStripSvg(sprint, 800)
    const gaps = (svg.match(/width="2" height="24" fill="var\(--hud-ring/g) ?? []).length
    expect(gaps).toBe(profileSections(sprint.profile, sprint.durationSec).length - 1)
    const ticks = (svg.match(/stroke="rgba\(255,255,255,\.55\)"/g) ?? []).length
    expect(ticks).toBe(Math.floor(sprint.durationSec / 300) - (sprint.durationSec % 300 === 0 ? 1 : 0))
    expect(svg).toContain('id="prof-done-r"')
    expect(svg).toContain('id="s-prog"')
    expect(svg).toContain('id="s-prog-ring"')
    // 스크린리더용 구간 목록
    expect(svg).toContain('id="race-profile-alt"')
  })

  it('폭을 재서 그리므로 viewBox 폭이 주어진 폭과 같다 (늘리지 않는다)', () => {
    expect(profileStripSvg(steady, 640)).toContain('viewBox="0 0 640 24"')
    expect(profileStripSvg(steady, 10)).toContain('viewBox="0 0 120 24"')
  })

  it('스프린트 코스는 기준선(1.0) 위로 솟는 구간이 있다', () => {
    const svg = profileStripSvg(sprint, 400)
    const baseline = Number(svg.match(/<line x1="0" x2="400" y1="([\d.]+)"/)![1])
    const ys = [...svg.matchAll(/L[\d.]+,([\d.]+)/g)].map(m => Number(m[1]))
    expect(Math.min(...ys)).toBeLessThan(baseline - 3)
  })
})

describe('코스 카드 스파크라인', () => {
  it('기준선을 긋고, 기준보다 5% 넘게 센 코스에만 최고 배율을 적는다', () => {
    expect(sparklineSvg(sprint)).toContain('class="spark-peak num"')
    expect(sparklineSvg(sprint)).toContain('×1.28')
    expect(sparklineSvg(steady)).not.toContain('spark-peak')
    expect(sparklineSvg(steady)).toContain('class="spark-base"')
  })

  it('카드마다 그라데이션 id가 다르다', () => {
    const ids = COURSES.map(c => sparklineSvg(c).match(/id="(sp-[^"]+)"/)![1])
    expect(new Set(ids).size).toBe(COURSES.length)
  })
})

describe('스플릿 추이 차트', () => {
  const curve = Array.from({ length: 30 }, (_, k) => ({ t: k * 60, split: 136 + Math.sin(k / 4) * 6 }))

  it('점이 둘 미만이면 그리지 않는다', () => {
    expect(buildSplitChart({ id: 'a', curve: [], baseSplit: 135, course: steady, durationSec: 1800, width: 600 })).toBeNull()
    expect(buildSplitChart({ id: 'a', curve: [{ t: 0, split: Infinity }, { t: 60, split: 0 }], baseSplit: 135, course: steady, durationSec: 1800, width: 600 })).toBeNull()
  })

  it('y축은 뒤집혀 빠른 스플릿이 위에 온다', () => {
    const m = buildSplitChart({ id: 'a', curve, baseSplit: 135, course: steady, durationSec: 1800, width: 600 })!
    const fast = m.points.reduce((a, b) => (b.split < a.split ? b : a))
    const slow = m.points.reduce((a, b) => (b.split > a.split ? b : a))
    expect(fast.y).toBeLessThan(slow.y)
  })

  it('코스를 알면 목표선과 목표 대비 띠(빠름·느림)를, 모르면 옅은 면만 그린다', () => {
    const withTarget = buildSplitChart({ id: 'a', curve, baseSplit: 135, course: steady, durationSec: 1800, width: 600 })!
    expect(withTarget.html).toContain('class="hcurve-target"')
    expect(withTarget.html).toContain('class="hband fast"')
    expect(withTarget.html).toContain('class="hband slow"')
    expect(withTarget.points.every(p => p.target !== null)).toBe(true)
    const noTarget = buildSplitChart({ id: 'b', curve, baseSplit: NaN, course: null, durationSec: 1800, width: 600 })!
    expect(noTarget.html).not.toContain('hcurve-target')
    expect(noTarget.html).toContain('class="hband wash"')
    expect(noTarget.points.every(p => p.target === null)).toBe(true)
  })

  it('눈금은 5초 또는 10초 단위이고 자료와 목표를 모두 품는다', () => {
    const m = buildSplitChart({ id: 'a', curve, baseSplit: 135, course: sprint, durationSec: 1200, width: 600 })!
    expect([5, 10]).toContain(m.step)
    expect(m.lo % m.step).toBe(0)
    expect(m.hi % m.step).toBe(0)
    for (const p of m.points) {
      expect(p.split).toBeGreaterThanOrEqual(m.lo)
      expect(p.split).toBeLessThanOrEqual(m.hi)
      expect(p.target!).toBeGreaterThanOrEqual(m.lo)
      expect(p.target!).toBeLessThanOrEqual(m.hi)
    }
    expect(niceSplitDomain(131, 142)).toEqual({ lo: 130, hi: 145, step: 5 })
    expect(niceSplitDomain(120, 199)).toEqual({ lo: 120, hi: 200, step: 10 })
    expect(niceSplitDomain(135, 136)).toEqual({ lo: 135, hi: 145, step: 5 })
  })

  it('직접 표기는 가장 빠른 지점 하나뿐이고, 표 쌍둥이와 범례가 있다', () => {
    const m = buildSplitChart({ id: 'a', curve, baseSplit: 135, course: steady, durationSec: 1800, width: 600 })!
    expect((m.html.match(/class="hlabel num"/g) ?? []).length).toBe(1)
    expect((m.html.match(/<tr><td>/g) ?? []).length).toBe(curve.length)
    expect(m.html).toContain('class="hlegend"')
    expect(m.html).toContain('내 스플릿')
    expect(m.html).toContain('목표')
  })
})

describe('비교 칩', () => {
  it('방향 글리프와 부호를 붙이고, 스플릿은 작을수록 좋은 쪽이다', () => {
    expect(deltaChipHtml(34, 'm', '페이스 보트 대비')).toContain('▲')
    expect(deltaChipHtml(34, 'm', '페이스 보트 대비')).toContain('class="delta good"')
    expect(deltaChipHtml(-12, 'm', '페이스 보트 대비')).toContain('class="delta bad"')
    expect(deltaChipHtml(-3.2, 's', '목표 대비', false)).toContain('class="delta good"')
    expect(deltaChipHtml(-3.2, 's', '목표 대비', false)).toContain('−3.2s')
    expect(deltaChipHtml(0.2, 'm', '같다')).toContain('같음')
    expect(deltaChipHtml(NaN, 'm', 'x')).toBe('')
    expect(signedSeconds(2.04)).toBe('+2.0s')
    expect(signedSeconds(-0.01)).toBe('±0.0s')
  })
})
