import { describe, it, expect } from 'vitest'
import { Rig, COLORS_PLAYER, DIMS } from './rig'
import { StrokeEngine } from '../game/stroke'

/** 사이클 전체에 걸쳐 자세를 뽑는다 */
function posesAcrossCycle(spm = 26, n = 60) {
  const e = new StrokeEngine()
  e.onSample(spm, 0, 0)
  e.update(0.5)          // spm 평활화가 붙도록
  e.update(0.5)
  e.update(0.5)
  const out = []
  const cycle = 60 / spm
  for (let i = 0; i < n; i++) {
    e.phase = i / n      // 위상을 직접 훑는다
    out.push({ pose: e.pose(), t: (i / n) * cycle })
  }
  return out
}

describe('Rig 관절 계산', () => {
  it('사이클 어디에서도 NaN이 나오지 않는다', () => {
    const rig = new Rig(COLORS_PLAYER)
    for (const { pose } of posesAcrossCycle()) {
      rig.apply(pose, 1 / 60, 4)
      const j = rig.joints
      const all = [j.hip, j.shoulder, j.head, ...j.knee, ...j.elbow, ...j.handle, ...j.blade]
      for (const v of all) {
        expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true)
      }
      expect(Number.isFinite(j.theta)).toBe(true)
    }
  })

  it('발은 발판에 고정되어 움직이지 않는다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const seen = new Set<string>()
    for (const { pose } of posesAcrossCycle()) {
      rig.apply(pose, 1 / 60, 4)
      seen.add(rig.joints.foot[0]!.toArray().map(v => v.toFixed(4)).join(','))
    }
    expect(seen.size).toBe(1)
  })

  it('블레이드는 드라이브에 물에 잠기고 리커버리엔 뜬다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const drive: number[] = []
    const recovery: number[] = []
    for (const { pose } of posesAcrossCycle()) {
      rig.apply(pose, 1 / 60, 4)
      ;(pose.inWater ? drive : recovery).push(rig.joints.blade[0]!.y)
    }
    // 드라이브: 수면(y=0) 근처
    for (const y of drive) expect(Math.abs(y)).toBeLessThan(0.09)
    // 리커버리: 확실히 수면 위
    for (const y of recovery) expect(y).toBeGreaterThan(0.10)
  })

  it('노는 지렛대다 — 손잡이가 뒤로 갈 때 블레이드는 앞으로 간다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const samples: { handleX: number; bladeX: number }[] = []
    for (const { pose } of posesAcrossCycle()) {
      rig.apply(pose, 1 / 60, 4)
      samples.push({ handleX: rig.joints.handle[0]!.x, bladeX: rig.joints.blade[0]!.x })
    }
    // 손잡이 X가 최소일 때 블레이드 X는 최대여야 한다
    const minHandle = samples.reduce((a, b) => (b.handleX < a.handleX ? b : a))
    const maxHandle = samples.reduce((a, b) => (b.handleX > a.handleX ? b : a))
    expect(minHandle.bladeX).toBeGreaterThan(maxHandle.bladeX)
  })

  it('캐치에서 블레이드가 뱃머리 쪽(+X), 피니시에서 선미 쪽(-X)에 있다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)

    e.phase = 0.02                       // 캐치 직후
    rig.apply(e.pose(), 1 / 60, 4)
    const catchBladeX = rig.joints.blade[0]!.x

    e.phase = e.driveFraction * 0.97      // 피니시 직전
    rig.apply(e.pose(), 1 / 60, 4)
    const finishBladeX = rig.joints.blade[0]!.x

    expect(catchBladeX).toBeGreaterThan(0)
    expect(finishBladeX).toBeLessThan(0)
  })

  it('무릎은 캐치에서 높이 솟고 피니시에서 낮아진다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)

    e.phase = 0
    rig.apply(e.pose(), 1 / 60, 4)
    const kneeCatch = rig.joints.knee[0]!.y

    e.phase = e.driveFraction * 0.97
    rig.apply(e.pose(), 1 / 60, 4)
    const kneeFinish = rig.joints.knee[0]!.y

    expect(kneeCatch).toBeGreaterThan(kneeFinish + 0.15)
  })

  it('시트는 캐치에서 선미 쪽, 피니시에서 뱃머리 쪽에 있다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)

    e.phase = 0
    rig.apply(e.pose(), 1 / 60, 4)
    const hipCatch = rig.joints.hip.x

    e.phase = e.driveFraction * 0.97
    rig.apply(e.pose(), 1 / 60, 4)
    const hipFinish = rig.joints.hip.x

    expect(hipFinish).toBeGreaterThan(hipCatch + 0.3)
  })

  it('손잡이는 항상 노받이에서 inboard 거리만큼 떨어져 있다 (강체)', () => {
    const rig = new Rig(COLORS_PLAYER)
    for (const { pose } of posesAcrossCycle()) {
      rig.apply(pose, 1 / 60, 4)
      const h = rig.joints.handle[0]!
      const b = rig.joints.blade[0]!
      // 손잡이~블레이드 = inboard + outboard 로 항상 일정
      expect(h.distanceTo(b)).toBeCloseTo(DIMS.inboard + DIMS.outboard, 5)
    }
  })

  it('팔이 손잡이에 닿는다 — 팔꿈치가 어깨와 손잡이 사이에 있다', () => {
    const rig = new Rig(COLORS_PLAYER)
    for (const { pose } of posesAcrossCycle()) {
      rig.apply(pose, 1 / 60, 4)
      const sh = rig.joints.shoulder.clone().setZ(0.17)
      const el = rig.joints.elbow[0]!
      const ha = rig.joints.handle[0]!
      // 위팔 0.30, 아래팔 0.30 — IK가 클램프해도 각 뼈 길이는 유지되어야 한다
      expect(sh.distanceTo(el)).toBeCloseTo(0.30, 4)
      expect(el.distanceTo(ha)).toBeCloseTo(0.30, 4)
    }
  })
})
