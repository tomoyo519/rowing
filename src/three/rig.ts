import * as THREE from 'three'
import type { Pose } from '../game/stroke'

/**
 * 3D 싱글스컬 + 로어 리그.
 *
 * 좌표계: 보트 진행 방향 = +X (bow), 위 = +Y, 좌우 = ±Z.
 * 로어는 스턴(-X)을 보고 앉는다 — 실제 조정과 동일.
 *
 * 매 프레임 관절 **위치**를 계산한 뒤 캡슐 메시를 두 점 사이에 맞춘다.
 * 회전 계층을 쌓는 것보다 IK를 얹기 쉽고, 다리·팔이 발판/손잡이에 정확히 붙는다.
 */

// ── 치수 (m) ────────────────────────────────────────────────
export const DIMS = { get lockY() { return LOCK.y }, get outboard() { return OUTBOARD }, get inboard() { return INBOARD } }
const SEAT_Y = 0.24
const SEAT_CATCH_X = -0.30
const SEAT_FINISH_X = 0.22
const FOOT = { x: -0.62, y: 0.20, z: 0.14 }
const THIGH = 0.45
const SHIN = 0.44
const TORSO = 0.55
const UPPER_ARM = 0.30
const FOREARM = 0.30
const SHOULDER_HALF = 0.17
const HIP_HALF = 0.11

/** 노받이(oarlock) 위치 */
const LOCK = { x: -0.30, y: 0.42, z: 0.85 }
/** 노받이~손잡이 (inboard), 노받이~블레이드 (outboard) */
const INBOARD = 0.90
const OUTBOARD = 1.90
/** 노의 상하 각. 손을 올리면 지렛대라 블레이드가 내려간다 */
const PHI_DRIVE = 0.215     // 블레이드가 수면에 잠김
const PHI_RECOVERY = 0.145  // 블레이드가 수면 위로 뜸

export interface RigColors {
  hull: string
  jersey: string
  /** 하의. 상의와 같은 색이면 몸이 한 덩어리로 뭉쳐 보인다 */
  shorts: string
  skin: string
  oar: string
  blade: string
}

export const COLORS_PLAYER: RigColors = {
  hull: '#f0f3f7', jersey: '#ff5a3c', shorts: '#1f2c3a', skin: '#e8b48c',
  oar: '#e4e9ef', blade: '#ff5a3c',
}
export const COLORS_PACE: RigColors = {
  hull: '#59636f', jersey: '#828d9a', shorts: '#414b56', skin: '#98a2ac',
  oar: '#6d7885', blade: '#828d9a',
}

const UP = new THREE.Vector3(0, 1, 0)
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

/** 매 프레임 계산된 관절 위치 — 디버깅/테스트용으로 노출한다 */
export interface Joints {
  hip: THREE.Vector3
  shoulder: THREE.Vector3
  head: THREE.Vector3
  knee: THREE.Vector3[]
  foot: THREE.Vector3[]
  elbow: THREE.Vector3[]
  handle: THREE.Vector3[]
  blade: THREE.Vector3[]
  theta: number
}

export class Rig {
  readonly group = new THREE.Group()

  /** apply() 직후의 관절 위치 (보트 로컬 좌표) */
  readonly joints: Joints = {
    hip: new THREE.Vector3(), shoulder: new THREE.Vector3(), head: new THREE.Vector3(),
    knee: [new THREE.Vector3(), new THREE.Vector3()],
    foot: [new THREE.Vector3(), new THREE.Vector3()],
    elbow: [new THREE.Vector3(), new THREE.Vector3()],
    handle: [new THREE.Vector3(), new THREE.Vector3()],
    blade: [new THREE.Vector3(), new THREE.Vector3()],
    theta: 0,
  }

  private hull!: THREE.Mesh
  private seat!: THREE.Mesh
  private pelvis!: THREE.Mesh
  private torso!: THREE.Mesh
  private head!: THREE.Mesh
  private thigh: THREE.Mesh[] = []
  private shin: THREE.Mesh[] = []
  private upperArm: THREE.Mesh[] = []
  private forearm: THREE.Mesh[] = []
  private oarShaft: THREE.Mesh[] = []
  private oarBlade: THREE.Mesh[] = []
  private splash: THREE.Mesh[] = []
  /** 물에 남는 퍼들 — 월드에 남아 뒤로 흘러간다 */
  private puddles: { mesh: THREE.Mesh; life: number }[] = []
  private puddleGroup = new THREE.Group()
  private wasInWater = false

  constructor(colors: RigColors, private opacity = 1) {
    this.build(colors)
    this.group.add(this.puddleGroup)
  }

  private mat(color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({
      color, flatShading: true, roughness: 0.62, metalness: 0.05,
      transparent: this.opacity < 1, opacity: this.opacity,
      ...extra,
    })
  }

  private build(c: RigColors) {
    const g = this.group

    // ── 선체 ────────────────────────────────────────────────
    const hullGeo = new THREE.CapsuleGeometry(0.20, 7.0, 4, 14)
    hullGeo.rotateZ(Math.PI / 2)
    hullGeo.scale(1, 0.52, 1)
    this.hull = new THREE.Mesh(hullGeo, this.mat(c.hull, { roughness: 0.35 }))
    this.hull.position.set(0.1, 0.06, 0)
    g.add(this.hull)

    // 좌석 트랙
    const track = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.03, 0.16),
      this.mat('#3d4650'),
    )
    track.position.set(-0.04, 0.17, 0)
    g.add(track)

    // 발판
    const stretcher = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.28, 0.42),
      this.mat('#3d4650'),
    )
    stretcher.position.set(FOOT.x - 0.04, FOOT.y + 0.06, 0)
    stretcher.rotation.z = -0.35
    g.add(stretcher)

    // 리거 — 노받이를 선체 밖으로 뻗어주는 팔
    for (const side of [1, -1]) {
      const rigger = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, LOCK.z - 0.1, 6),
        this.mat('#4a545f'),
      )
      rigger.rotation.x = Math.PI / 2
      rigger.position.set(LOCK.x, LOCK.y - 0.06, side * (LOCK.z + 0.05) / 2)
      g.add(rigger)
    }

    // ── 사람 ────────────────────────────────────────────────
    this.seat = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.24), this.mat('#2f3841'))
    g.add(this.seat)

    this.pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.30), this.mat(c.shorts))
    g.add(this.pelvis)

    this.torso = new THREE.Mesh(capsule(0.145, TORSO), this.mat(c.jersey))
    g.add(this.torso)

    this.head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.115, 1), this.mat(c.skin))
    g.add(this.head)

    for (let i = 0; i < 2; i++) {
      this.thigh.push(new THREE.Mesh(capsule(0.085, THIGH), this.mat(c.shorts)))
      this.shin.push(new THREE.Mesh(capsule(0.070, SHIN), this.mat(c.skin)))
      this.upperArm.push(new THREE.Mesh(capsule(0.058, UPPER_ARM), this.mat(c.skin)))
      this.forearm.push(new THREE.Mesh(capsule(0.050, FOREARM), this.mat(c.skin)))
      g.add(this.thigh[i]!, this.shin[i]!, this.upperArm[i]!, this.forearm[i]!)
    }

    // ── 노 ──────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.030, INBOARD + OUTBOARD, 7),
        this.mat(c.oar, { roughness: 0.4 }),
      )
      // 실제 스컬 블레이드에 가깝게 — 멀리서도 물을 잡는 게 보여야 한다
      const bladeGeo = new THREE.BoxGeometry(0.50, 0.03, 0.24)
      const blade = new THREE.Mesh(bladeGeo, this.mat(c.blade, { roughness: 0.35 }))
      this.oarShaft.push(shaft)
      this.oarBlade.push(blade)

      const sp = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 7),
        new THREE.MeshBasicMaterial({
          color: '#ffffff', transparent: true, opacity: 0,
        }),
      )
      sp.scale.set(1, 0.35, 1)
      this.splash.push(sp)
      g.add(shaft, blade, sp)
    }
  }

  /**
   * 자세 적용.
   * @param pose StrokeEngine이 만든 자세
   * @param dt   퍼들 수명 갱신용 (초)
   */
  apply(pose: Pose, dt: number, speed: number) {
    // ── 몸통 ────────────────────────────────────────────────
    const hipX = SEAT_CATCH_X + (SEAT_FINISH_X - SEAT_CATCH_X) * pose.slide
    const hip = _a.set(hipX, SEAT_Y, 0).clone()
    this.seat.position.set(hipX, SEAT_Y - 0.06, 0)

    // +bodyAngle = 앞(-X)으로 숙임
    const sh = Math.sin(pose.bodyAngle), ch = Math.cos(pose.bodyAngle)
    const shoulder = new THREE.Vector3(hipX - sh * TORSO, SEAT_Y + ch * TORSO, 0)

    this.pelvis.position.copy(hip)
    this.pelvis.rotation.z = pose.bodyAngle * 0.4
    place(this.torso, hip, shoulder, TORSO)

    const headPos = shoulder.clone().add(
      new THREE.Vector3(-sh, ch, 0).multiplyScalar(0.20),
    )
    this.head.position.copy(headPos)
    this.head.rotation.z = pose.bodyAngle * 0.7

    this.joints.hip.copy(hip)
    this.joints.shoulder.copy(shoulder)
    this.joints.head.copy(headPos)

    // ── 노: 손잡이 목표 X → 스윕각 → 노 방향 ────────────────
    const handTargetX = shoulder.x + lerp(-0.44, -0.02, pose.armDraw)
    const sinTheta = clamp((handTargetX - LOCK.x) / INBOARD, -0.97, 0.97)
    const theta = Math.asin(sinTheta)
    const phi = pose.inWater ? PHI_DRIVE : PHI_RECOVERY
    const cosTheta = Math.cos(theta), cosPhi = Math.cos(phi), sinPhi = Math.sin(phi)
    this.joints.theta = theta

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1
      // 노받이에서 손잡이로 향하는 단위벡터
      const dir = new THREE.Vector3(
        sinTheta * cosPhi,
        sinPhi,
        -side * cosTheta * cosPhi,
      )
      const lock = new THREE.Vector3(LOCK.x, LOCK.y, side * LOCK.z)
      const handle = lock.clone().addScaledVector(dir, INBOARD)
      const blade = lock.clone().addScaledVector(dir, -OUTBOARD)

      this.joints.handle[i]!.copy(handle)
      this.joints.blade[i]!.copy(blade)

      place(this.oarShaft[i]!, handle, blade, INBOARD + OUTBOARD)
      this.oarBlade[i]!.position.copy(blade)
      this.oarBlade[i]!.rotation.set(0, -theta, 0)

      // ── 팔 IK: 어깨 → 손잡이 ────────────────────────────
      const shoulderPt = new THREE.Vector3(shoulder.x, shoulder.y, side * SHOULDER_HALF)
      const pole = new THREE.Vector3(0, -1, side * 0.55).normalize()
      const elbow = solveIK(shoulderPt, handle, UPPER_ARM, FOREARM, pole)
      this.joints.elbow[i]!.copy(elbow)
      place(this.upperArm[i]!, shoulderPt, elbow, UPPER_ARM)
      place(this.forearm[i]!, elbow, handle, FOREARM)

      // ── 다리 IK: 엉덩이 → 발 ────────────────────────────
      const hipPt = new THREE.Vector3(hipX, SEAT_Y, side * HIP_HALF)
      const footPt = new THREE.Vector3(FOOT.x, FOOT.y, side * FOOT.z)
      const knee = solveIK(hipPt, footPt, THIGH, SHIN, UP)
      this.joints.knee[i]!.copy(knee)
      this.joints.foot[i]!.copy(footPt)
      place(this.thigh[i]!, hipPt, knee, THIGH)
      place(this.shin[i]!, knee, footPt, SHIN)

      // ── 물보라 ──────────────────────────────────────────
      const spMat = this.splash[i]!.material as THREE.MeshBasicMaterial
      if (pose.inWater) {
        const power = Math.sin(pose.driveProgress * Math.PI)
        this.splash[i]!.position.set(blade.x, 0.10, blade.z)
        this.splash[i]!.scale.set(0.7 + power * 0.9, 0.3, 0.7 + power * 0.9)
        spMat.opacity = 0.42 * power * this.opacity
      } else {
        spMat.opacity = 0
      }
    }

    // 캐치 순간에 퍼들을 남긴다
    if (pose.inWater && !this.wasInWater) this.dropPuddles(theta)
    this.wasInWater = pose.inWater
    this.updatePuddles(dt, speed)
  }

  private dropPuddles(theta: number) {
    for (const side of [1, -1]) {
      const dir = new THREE.Vector3(Math.sin(theta), 0, -side * Math.cos(theta))
      // 파고(최대 ~7cm)보다 위에 둬야 물결에 가려지지 않는다
      const lock = new THREE.Vector3(LOCK.x, 0.10, side * LOCK.z)
      const pos = lock.addScaledVector(dir, -OUTBOARD)

      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(0.22, 14),
        new THREE.MeshBasicMaterial({
          color: '#dff1ff', transparent: true, opacity: 0.5 * this.opacity,
          depthWrite: false,
        }),
      )
      mesh.rotation.x = -Math.PI / 2
      mesh.position.copy(pos)
      mesh.renderOrder = 2
      this.puddleGroup.add(mesh)
      this.puddles.push({ mesh, life: 0 })
    }
    // 오래된 것부터 정리
    while (this.puddles.length > 14) {
      const old = this.puddles.shift()!
      this.puddleGroup.remove(old.mesh)
      old.mesh.geometry.dispose()
      ;(old.mesh.material as THREE.Material).dispose()
    }
  }

  private updatePuddles(dt: number, speed: number) {
    const LIFE = 2.6
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i]!
      p.life += dt
      // 보트가 나아가므로 퍼들은 뒤로 흘러간다
      p.mesh.position.x -= speed * dt
      const k = p.life / LIFE
      const m = p.mesh.material as THREE.MeshBasicMaterial
      m.opacity = Math.max(0, (1 - k) * 0.5 * this.opacity)
      const s = 1 + k * 1.6
      p.mesh.scale.set(s, s, s)
      if (p.life > LIFE) {
        this.puddleGroup.remove(p.mesh)
        p.mesh.geometry.dispose()
        m.dispose()
        this.puddles.splice(i, 1)
      }
    }
  }

  setOpacity(o: number) {
    this.opacity = o
    this.group.traverse(obj => {
      const m = (obj as THREE.Mesh).material as THREE.Material | undefined
      if (m && 'opacity' in m) {
        m.transparent = o < 1
        ;(m as THREE.MeshStandardMaterial).opacity = o
      }
    })
  }
}

// ── 헬퍼 ────────────────────────────────────────────────────

/** Y축 방향 캡슐. place()가 두 점 사이에 맞춰준다. */
function capsule(r: number, len: number) {
  return new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2), 3, 8)
}

/** 캡슐/실린더를 from→to 사이에 배치 */
function place(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, baseLen: number) {
  _b.subVectors(to, from)
  const len = _b.length() || 1e-4
  mesh.position.set(
    (from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2,
  )
  _c.copy(_b).divideScalar(len)
  mesh.quaternion.setFromUnitVectors(UP, _c)
  mesh.scale.set(1, len / baseLen, 1)
}

/**
 * 2뼈 IK. root에서 target까지 길이 l1+l2의 두 뼈로 닿게 하는 중간 관절 위치.
 * poleDir은 관절이 꺾이는 방향 (무릎은 위, 팔꿈치는 아래·바깥).
 */
function solveIK(
  root: THREE.Vector3, target: THREE.Vector3,
  l1: number, l2: number, poleDir: THREE.Vector3,
): THREE.Vector3 {
  const toTarget = new THREE.Vector3().subVectors(target, root)
  let d = toTarget.length()
  const min = Math.abs(l1 - l2) + 1e-3
  const max = l1 + l2 - 1e-3
  d = clamp(d, min, max)
  const dir = toTarget.clone().normalize()

  // 코사인 법칙
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))

  // dir에 수직이면서 poleDir 쪽인 성분
  const perp = poleDir.clone().addScaledVector(dir, -poleDir.dot(dir))
  if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0).addScaledVector(dir, -dir.y)
  perp.normalize()

  return root.clone().addScaledVector(dir, a).addScaledVector(perp, h)
}

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
