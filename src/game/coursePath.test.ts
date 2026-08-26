import { describe, expect, it } from 'vitest'
import { createCoursePath, localPathPoint, pathPointAt } from './coursePath'

describe('곡선 코스 중심선', () => {
  it('같은 코스는 같은 경로, 다른 코스는 다른 경로를 만든다', () => {
    const first = createCoursePath('henley-steady-30')
    expect(createCoursePath('henley-steady-30')).toEqual(first)
    expect(createCoursePath('bosbaan-steady-40')).not.toEqual(first)
  })

  it('현재 보트 중심은 항상 로컬 원점과 정면이다', () => {
    const path = createCoursePath('origin-check')
    for (const distance of [0, 127.4, 2_000, 12_345]) {
      const p = localPathPoint(path, distance, 0, 0)
      expect(p.x).toBeCloseTo(0, 9)
      expect(p.z).toBeCloseTo(0, 9)
      expect(p.yaw).toBeCloseTo(0, 9)
    }
  })

  it('좌우 레인은 진행 방향에 수직이고 서로 충분히 떨어진다', () => {
    const path = createCoursePath('lane-check')
    const left = localPathPoint(path, 842, -4, 6.4, 3.2)
    const right = localPathPoint(path, 842, -4, -6.4, 3.2)
    expect(Math.hypot(left.x - right.x, left.z - right.z)).toBeCloseTo(12.8, 6)
  })

  it('같은 station의 두 레인은 플레이어 기준 정확히 6.4m 떨어진다', () => {
    const path = createCoursePath('pacer-check')
    const player = localPathPoint(path, 1_337, 0, 3.2, 3.2)
    const pace = localPathPoint(path, 1_337, 0, -3.2, 3.2)
    expect(player.x).toBeCloseTo(0, 9)
    expect(player.z).toBeCloseTo(0, 9)
    expect(pace.x).toBeCloseTo(0, 9)
    expect(pace.z).toBeCloseTo(-6.4, 9)
  })

  it('긴 거리에서도 좌표와 각도가 유한하고 굽이가 실제로 존재한다', () => {
    const path = createCoursePath('finite-check')
    const values = [0, 250, 5_000, 20_000].map(s => pathPointAt(path, s))
    for (const p of values) {
      expect([p.x, p.z, p.heading].every(Number.isFinite)).toBe(true)
      expect(Math.abs(p.heading)).toBeLessThan(0.5)
    }
    expect(new Set(values.map(p => p.z.toFixed(3))).size).toBeGreaterThan(2)
  })

  it('강둑이 뒤집히지 않는 완만한 곡률 범위를 지킨다', () => {
    for (const id of ['henley', 'bosbaan', 'thames', 'long-course']) {
      const path = createCoursePath(id)
      for (let station = 0; station <= 20_000; station += 25) {
        const before = pathPointAt(path, station - 1)
        const after = pathPointAt(path, station + 1)
        const delta = Math.atan2(
          Math.sin(after.heading - before.heading),
          Math.cos(after.heading - before.heading),
        )
        const curvature = Math.abs(delta / 2)
        expect(curvature).toBeLessThan(0.006)
        expect(1 - curvature * 41).toBeGreaterThan(0.75)
      }
    }
  })

  it('페이스 보트의 앞뒤 부호가 모든 굽이에서 스칼라 gap과 일치한다', () => {
    const path = createCoursePath('gap-sign')
    for (let station = 0; station <= 5_000; station += 125) {
      for (const gap of [-90, -20, 20, 90]) {
        const pace = localPathPoint(path, station, -gap, -3.2, 3.2)
        expect(Math.sign(pace.x)).toBe(Math.sign(-gap))
      }
    }
  })
})
