import * as THREE from 'three'
import { describe, it, expect } from 'vitest'
import {
  Rig, COLORS_PLAYER, DIMS, RACING_HULL_LENGTH, createRacingHullGeometry,
} from './rig'
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

  it('블레이드는 드라이브에 물에 잠기고 리커버리엔 뜨며, 그 사이를 한 프레임에 건너뛰지 않는다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const drive: number[] = []
    const recovery: number[] = []
    const ys: number[] = []
    for (const { pose } of posesAcrossCycle(26, 120)) {
      rig.apply(pose, 1 / 60, 4)
      const y = rig.joints.blade[0]!.y
      ys.push(y)
      // 진입·추출 중인 샘플은 어느 쪽도 아니다
      if (pose.bladeDepth > 0.95) drive.push(y)
      else if (pose.bladeDepth < 0.05) recovery.push(y)
    }
    expect(drive.length).toBeGreaterThan(10)
    expect(recovery.length).toBeGreaterThan(20)
    // 드라이브: 수면(y=0) 근처
    for (const y of drive) expect(Math.abs(y)).toBeLessThan(0.09)
    // 리커버리: 확실히 수면 위
    for (const y of recovery) expect(y).toBeGreaterThan(0.10)
    // 잠김↔뜸 사이 높이 차가 한 샘플(1/120 사이클)에 다 일어나지 않는다
    let worst = 0
    for (let i = 1; i < ys.length; i++) worst = Math.max(worst, Math.abs(ys[i]! - ys[i - 1]!))
    const range = Math.max(...ys) - Math.min(...ys)
    expect(worst).toBeLessThan(range * 0.5)
  })

  it('블레이드 면은 드라이브에 수직, 리커버리에 수평이다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)
    const df = e.driveFraction
    /** 블레이드 면 법선의 수직 성분. 1이면 눕힌 것(페더), 0이면 세운 것(스퀘어) */
    const normalY = () => {
      rig.apply(e.pose(), 1 / 60, 4)
      const mesh = rig.bladeMeshes[0]!
      mesh.updateMatrixWorld(true)
      return Math.abs(
        new THREE.Vector3(0, 0, 1)
          .applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion())).y,
      )
    }
    e.phase = df * 0.5
    expect(normalY()).toBeLessThan(0.35)                    // 드라이브: 세워져 물을 민다
    e.phase = df + (1 - df) * 0.5
    expect(normalY()).toBeGreaterThan(0.85)                 // 리커버리: 눕혀 물 위를 스친다
    e.phase = 0.995
    expect(normalY()).toBeLessThan(0.45)                    // 캐치 직전: 다시 세워져 있다
  })

  it('블레이드는 드라이브에서 세워지고 리커버리에서 눕는다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)
    e.phase = e.driveFraction * 0.5
    expect(e.pose().square).toBe(1)
    e.phase = e.driveFraction + (1 - e.driveFraction) * 0.5
    expect(e.pose().square).toBe(0)
    // 캐치 직전엔 다시 세워져 있다
    e.phase = 0.995
    expect(e.pose().square).toBeGreaterThan(0.9)
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
      const sh = rig.joints.armRoot[0]!
      const el = rig.joints.elbow[0]!
      const ha = rig.joints.handle[0]!
      // 위팔 0.30, 아래팔 0.30 — IK가 클램프해도 각 뼈 길이는 유지되어야 한다
      expect(sh.distanceTo(el)).toBeCloseTo(0.30, 4)
      expect(el.distanceTo(ha)).toBeCloseTo(0.30, 4)
    }
  })
})

describe('자연스러운 자세', () => {
  function engineAt(phase: number) {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)
    e.phase = phase
    return e
  }

  it('캐치에서 등이 허리보다 더 굽고, 피니시에서 가슴이 열린다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const catchE = engineAt(0.01)
    rig.apply(catchE.pose(), 1 / 60, 4)
    const hip = rig.joints.hip.clone()
    const shoulder = rig.joints.shoulder.clone()
    // 두 마디 척추: 어깨가 한 마디 직선(TORSO × sin bodyAngle)보다 더 앞(-X)으로 나간다
    const straight = hip.x - Math.sin(catchE.pose().bodyAngle) * 0.55
    expect(shoulder.x).toBeLessThan(straight)

    const finishE = engineAt(catchE.driveFraction * 0.97)
    rig.apply(finishE.pose(), 1 / 60, 4)
    expect(rig.joints.shoulder.x).toBeGreaterThan(rig.joints.hip.x)
  })

  it('어깨는 캐치에서 손잡이 쪽으로 나가고 피니시에서 뒤로 당겨진다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = engineAt(0.01)
    rig.apply(e.pose(), 1 / 60, 4)
    const reachAtCatch = rig.joints.armRoot[0]!.x - rig.joints.shoulder.x
    e.phase = e.driveFraction * 0.97
    rig.apply(e.pose(), 1 / 60, 4)
    const reachAtFinish = rig.joints.armRoot[0]!.x - rig.joints.shoulder.x
    // 팔 관절은 어깨선 아래에 있어 이 값에는 몸통 기울기가 섞인다.
    // 그래도 캐치에선 어깨보다 앞(-X), 피니시에선 뒤로 물러나야 한다.
    expect(reachAtCatch).toBeLessThan(0)
    expect(reachAtFinish).toBeGreaterThan(reachAtCatch + 0.01)
  })

  it('교차 지점에서 왼손이 오른손 위로 충분히 떨어져 주먹이 겹치지 않는다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = engineAt(0)
    let minGap = Infinity
    let minGapAtCrossover = Infinity
    for (let k = 0; k < 120; k++) {
      e.phase = k / 120
      rig.apply(e.pose(), 1 / 60, 4)
      const [l, r] = rig.joints.handle
      const gap = l!.distanceTo(r!)
      minGap = Math.min(minGap, gap)
      // 좌우로 겹치는 구간에서는 세로 간격이 주먹 높이(0.066)보다 커야 한다
      if (Math.abs(l!.z - r!.z) < 0.06) minGapAtCrossover = Math.min(minGapAtCrossover, l!.y - r!.y)
    }
    expect(minGap).toBeGreaterThan(0.08)
    expect(minGapAtCrossover).toBeGreaterThan(0.08)
  })

  it('피니시에서 팔꿈치는 손잡이보다 뒤(+X)·바깥에 있다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = engineAt(0.01)
    e.phase = e.driveFraction * 0.97
    rig.apply(e.pose(), 1 / 60, 4)
    const elbow = rig.joints.elbow[0]!
    const handle = rig.joints.handle[0]!
    expect(elbow.x).toBeGreaterThan(handle.x)
    expect(Math.abs(elbow.z)).toBeGreaterThan(0.17)
  })

  it('보트는 캐치에서 뱃머리가 들리고 피니시에서 내려간다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = engineAt(0.01)
    rig.apply(e.pose(), 1 / 60, 4)
    rig.setCourseAttitude(0, 0)
    const pitchAtCatch = rig.group.children[0]!.rotation.z
    e.phase = e.driveFraction + (1 - e.driveFraction) * 0.05
    rig.apply(e.pose(), 1 / 60, 4)
    rig.setCourseAttitude(0, 0)
    const pitchAtFinish = rig.group.children[0]!.rotation.z
    expect(pitchAtCatch).toBeGreaterThan(pitchAtFinish + 0.01)
    expect(Math.abs(pitchAtCatch)).toBeLessThan(0.03)
  })

  it('예약 시각이 되면 눈을 감았다가 다시 뜬다', () => {
    const rig = new Rig(COLORS_PLAYER, 1, 0)
    const e = engineAt(0.5)
    const eyes = (rig as unknown as { eyes: THREE.Mesh[] }).eyes
    let minScale = 1
    for (let i = 0; i < 120; i++) {
      rig.apply(e.pose(), 1 / 60, 4)
      minScale = Math.min(minScale, ...eyes.map(eye => eye.scale.y))
    }
    expect(minScale).toBeLessThan(0.2)
    expect(eyes.every(eye => eye.scale.y > 0.99)).toBe(true)
  })
})

describe('사람다운 보조 동작', () => {
  function engineAt(phase: number) {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)
    e.phase = phase
    return e
  }

  it('손이 교차할 때 왼쪽 어깨가 오른쪽보다 높고, 캐치에서는 거의 수평이다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = engineAt(0)
    let best = { gap: Infinity, dy: 0 }
    for (let k = 0; k < 120; k++) {
      e.phase = k / 120
      rig.apply(e.pose(), 1 / 60, 4)
      const [l, r] = rig.joints.handle
      const gap = Math.abs(l!.z - r!.z)
      if (gap < best.gap) best = { gap, dy: rig.joints.armRoot[0]!.y - rig.joints.armRoot[1]!.y }
    }
    expect(best.dy).toBeGreaterThan(0.015)
    e.phase = 0.01
    rig.apply(e.pose(), 1 / 60, 4)
    rig.apply(e.pose(), 1 / 60, 4)
    expect(Math.abs(rig.joints.armRoot[0]!.y - rig.joints.armRoot[1]!.y)).toBeLessThan(0.01)
  })

  it('무릎은 캐치에서 바깥으로 벌어지고 피니시에서 모인다', () => {
    const rig = new Rig(COLORS_PLAYER)
    const e = engineAt(0.01)
    rig.apply(e.pose(), 1 / 60, 4)
    const kneeCatch = rig.joints.knee[0]!.clone()
    e.phase = e.driveFraction * 0.97
    rig.apply(e.pose(), 1 / 60, 4)
    const kneeFinish = rig.joints.knee[0]!.clone()
    // 엉덩이 관절(z=0.11)에서 바깥으로 얼마나 나갔는지
    expect(kneeCatch.z - 0.11).toBeGreaterThan(0.06)
    expect(kneeFinish.z - 0.11).toBeLessThan(kneeCatch.z - 0.11 - 0.04)
  })

  it('페더링하면 주먹이 노 축 둘레로 구른다 (손목 떨어뜨림)', () => {
    const rig = new Rig(COLORS_PLAYER)
    const fists = (rig as unknown as { fists: THREE.Mesh[] }).fists
    const e = engineAt(0.02)                    // 드라이브: 스퀘어
    rig.apply(e.pose(), 1 / 60, 4)
    const squared = fists[0]!.quaternion.clone()
    const df = e.driveFraction
    e.phase = df + (1 - df) * 0.5               // 리커버리 한가운데: 페더
    const p = e.pose()
    expect(p.square).toBe(0)
    rig.apply(p, 1 / 60, 4)
    const feathered = fists[0]!.quaternion.clone()
    // 두 자세 사이의 회전각이 손목 떨어뜨림(0.45rad) 이상이어야 한다 — 노 방향 차이도 섞이지만 0은 아니다
    expect(squared.angleTo(feathered)).toBeGreaterThan(0.3)
  })
})

describe('체형', () => {
  function poseAt(phase: number) {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)
    e.phase = phase
    return e.pose()
  }

  it('여자 체형은 어깨가 좁고 골반이 넓으며 뒤로 묶은 머리가 있다', () => {
    const male = new Rig(COLORS_PLAYER)
    const female = new Rig(COLORS_PLAYER, 1, 0, 'female')
    const pose = poseAt(0.5)
    male.apply(pose, 1 / 60, 4)
    female.apply(pose, 1 / 60, 4)
    expect(Math.abs(female.joints.armRoot[0]!.z)).toBeLessThan(Math.abs(male.joints.armRoot[0]!.z) - 0.01)
    const headParts = (rig: Rig) => (rig as unknown as { head: THREE.Group }).head.children.length
    expect(headParts(female)).toBeGreaterThan(headParts(male))
  })

  it('체형이 달라도 뼈대는 같다 — 팔 길이와 발 위치가 동일하다', () => {
    const male = new Rig(COLORS_PLAYER)
    const female = new Rig(COLORS_PLAYER, 1, 0, 'female')
    for (const phase of [0.01, 0.2, 0.5, 0.8]) {
      const pose = poseAt(phase)
      male.apply(pose, 1 / 60, 4)
      female.apply(pose, 1 / 60, 4)
      expect(female.joints.armRoot[0]!.distanceTo(female.joints.elbow[0]!)).toBeCloseTo(0.30, 4)
      expect(female.joints.elbow[0]!.distanceTo(female.joints.handle[0]!)).toBeCloseTo(0.30, 4)
      expect(female.joints.foot[0]!.distanceTo(male.joints.foot[0]!)).toBeLessThan(1e-6)
      expect(female.joints.hip.distanceTo(male.joints.hip)).toBeLessThan(1e-6)
    }
  })
})

describe('정교한 레이싱 셸 모델', () => {
  it('선체 중앙은 넓고 뱃머리와 선미는 뾰족하다', () => {
    const geometry = createRacingHullGeometry()
    const position = geometry.getAttribute('position')
    let middle = 0
    let ends = 0
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)
      const z = Math.abs(position.getZ(i))
      if (Math.abs(x) < 0.05) middle = Math.max(middle, z)
      if (Math.abs(x) > RACING_HULL_LENGTH / 2 - 0.05) ends = Math.max(ends, z)
    }
    expect(middle).toBeGreaterThan(ends * 8)
    expect(ends).toBeLessThan(0.025)
    geometry.dispose()
  })

  it('커브 기울기는 보트에만 적용되고 물결 루트는 수평이다', () => {
    const rig = new Rig(COLORS_PLAYER)
    rig.setCourseAttitude(0.12, -0.07)
    const [visualRoot, puddleRoot] = rig.group.children
    expect(visualRoot!.rotation.y).toBeCloseTo(0.12)
    expect(visualRoot!.rotation.x).toBeCloseTo(-0.07)
    expect(puddleRoot!.rotation.x).toBe(0)
    expect(puddleRoot!.rotation.y).toBe(0)
  })
})
