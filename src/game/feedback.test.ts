import { describe, it, expect } from 'vitest'
import { toneOf, buildFeedback, type WindowStats } from './feedback'

const w = (split: number, targetSplit: number): WindowStats => ({
  split, targetSplit, spm: 26, power: 200, distance: 1200, seconds: 300,
})

describe('toneOf', () => {
  it('스플릿은 작을수록 빠르다 — 음수 delta가 앞선 것', () => {
    expect(toneOf(-6)).toBe('great')
    expect(toneOf(-2.5)).toBe('good')
    expect(toneOf(0)).toBe('onpace')
    expect(toneOf(2.5)).toBe('push')
    expect(toneOf(6)).toBe('behind')
  })

  it('경계값에서 톤이 정확히 넘어간다', () => {
    expect(toneOf(-4.0)).toBe('great')
    expect(toneOf(-3.99)).toBe('good')
    expect(toneOf(-1.5)).toBe('good')
    expect(toneOf(-1.49)).toBe('onpace')
    expect(toneOf(1.49)).toBe('onpace')
    expect(toneOf(1.5)).toBe('push')
    expect(toneOf(3.99)).toBe('push')
    expect(toneOf(4.0)).toBe('behind')
  })
})

describe('buildFeedback', () => {
  it('목표보다 느려도 꾸짖지 않고, 바로 할 수 있는 동작으로 올리라고 한다', () => {
    for (const i of [0, 1, 2]) {
      const f = buildFeedback(w(150, 140), -30, i)
      expect(f.tone).toBe('behind')
      expect(f.title).not.toMatch(/느|못/)
      expect(f.body).toContain('올려')
    }
  })

  it('지금까지 저은 시간과 최근 거리를 먼저 짚어 준다', () => {
    const f = buildFeedback(w(140, 140), 0, 1, undefined, 600)
    expect(f.body.startsWith('10분 돌파!')).toBe(true)
    expect(f.body).toContain('m를 저었어요')
  })

  it('목표보다 빠르면 칭찬한다', () => {
    const f = buildFeedback(w(133, 140), 40, 0)
    expect(f.tone).toBe('great')
  })

  it('체크포인트마다 문구가 돌아간다', () => {
    const titles = [0, 1, 2, 3].map(i => buildFeedback(w(150, 140), 0, i).title)
    expect(new Set(titles.slice(0, 3)).size).toBe(3)
    expect(titles[3]).toBe(titles[0])   // 한 바퀴 돌면 다시 처음
  })

  it('목표 대비 차이를 부호와 함께 보여준다', () => {
    const slow = buildFeedback(w(150, 140), 0, 0)
    expect(slow.stats.find(([k]) => k === '목표')![1]).toContain('+10.0s')
    const fast = buildFeedback(w(130, 140), 0, 0)
    expect(fast.stats.find(([k]) => k === '목표')![1]).toContain('−10.0s')
  })

  it('다음 구간이 있으면 예고를 붙인다', () => {
    expect(buildFeedback(w(140, 140), 0, 0, '푸시').body).toContain('푸시')
    expect(buildFeedback(w(140, 140), 0, 0).body).not.toContain('구간')
  })
})
