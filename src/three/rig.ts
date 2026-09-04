import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { Pose } from '../game/stroke'

/**
 * 3D 싱글스컬 + 로어 리그.
 *
 * 좌표계: 보트 진행 방향 = +X (bow), 위 = +Y, 좌우 = ±Z.
 * 로어는 스턴(-X)을 보고 앉는다 — 실제 조정과 동일.
 *
 * 매 프레임 관절 **위치**를 계산한 뒤 몸통·팔다리 메시를 두 점 사이에 맞춘다.
 * 회전 계층을 쌓는 것보다 IK를 얹기 쉽고, 다리·팔이 발판/손잡이에 정확히 붙는다.
 *
 * 사람은 회전체(Lathe)로 깎은 몸통, 위아래 굵기가 다른 팔다리, 관절 구, 손가락이
 * 손잡이를 감싼 손, 눈·코·입·귀가 있는 얼굴로 이루어져 실루엣이 사람으로 읽힌다.
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
const HEAD_RADIUS = 0.105

/** 노받이(oarlock) 위치 */
const LOCK = { x: -0.30, y: 0.42, z: 0.85 }
/** 노받이~손잡이 (inboard), 노받이~블레이드 (outboard) */
const INBOARD = 0.90
const OUTBOARD = 1.90
/** 노의 상하 각. 손을 올리면 지렛대라 블레이드가 내려간다 */
const PHI_DRIVE = 0.215     // 블레이드가 수면에 잠김
const PHI_RECOVERY = 0.145  // 블레이드가 수면 위로 뜸

export const RACING_HULL_LENGTH = 8.2

/** 선체 길이의 0..1 위치에서 반폭. 양 끝은 가늘고 중앙은 넓은 싱글스컬 형상이다. */
export function racingHullHalfWidthAt(t: number) {
  const station = clamp(t, 0, 1)
  return 0.012 + 0.176 * Math.pow(Math.sin(station * Math.PI), 0.58)
}

/** 캡슐 대신 뱃머리와 선미가 뾰족한 실제 레이싱 셸 실루엣을 만든다. */
export function createRacingHullGeometry() {
  const sections = 25
  const ringSegments = 14
  const positions: number[] = []
  const indices: number[] = []

  for (let i = 0; i < sections; i++) {
    const t = i / (sections - 1)
    const fullness = Math.pow(Math.sin(t * Math.PI), 0.62)
    const x = (t - 0.5) * RACING_HULL_LENGTH
    const halfWidth = racingHullHalfWidthAt(t)
    const halfHeight = 0.026 + fullness * 0.082
    const centerY = 0.055 + fullness * 0.012
    for (let j = 0; j < ringSegments; j++) {
      const angle = (j / ringSegments) * Math.PI * 2
      // 윗면을 조금 평평하게 눌러 얇은 데크와 깊은 킬이 함께 보이게 한다.
      const sin = Math.sin(angle)
      const yScale = sin > 0 ? 0.82 : 1.08
      positions.push(
        x,
        centerY + sin * halfHeight * yScale,
        Math.cos(angle) * halfWidth,
      )
    }
  }

  for (let i = 0; i < sections - 1; i++) {
    for (let j = 0; j < ringSegments; j++) {
      const next = (j + 1) % ringSegments
      const a = i * ringSegments + j
      const b = i * ringSegments + next
      const c = (i + 1) * ringSegments + j
      const d = (i + 1) * ringSegments + next
      indices.push(a, c, b, b, c, d)
    }
  }

  // 정중앙 후방 카메라에서도 열린 단면이 보이지 않도록 양 끝을 막는다.
  const startCenter = positions.length / 3
  positions.push(-RACING_HULL_LENGTH / 2, 0.055, 0)
  const endCenter = positions.length / 3
  positions.push(RACING_HULL_LENGTH / 2, 0.055, 0)
  const endRing = (sections - 1) * ringSegments
  for (let j = 0; j < ringSegments; j++) {
    const next = (j + 1) % ringSegments
    indices.push(startCenter, j, next)
    indices.push(endCenter, endRing + next, endRing + j)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** 가느다란 목에서 바깥쪽 끝으로 넓어지는 마콘형 스컬 블레이드. */
function createOarBladeGeometry() {
  const levels: [number, number][] = [
    [-0.26, 0.045], [-0.13, 0.075], [0.08, 0.14], [0.26, 0.17],
  ]
  const depth = 0.014
  const positions: number[] = []
  for (const [y, halfWidth] of levels) {
    positions.push(-halfWidth, y, -depth, halfWidth, y, -depth)
    positions.push(-halfWidth, y, depth, halfWidth, y, depth)
  }
  const indices: number[] = []
  for (let i = 0; i < levels.length - 1; i++) {
    const a = i * 4, b = a + 1, c = a + 2, d = a + 3
    const e = a + 4, f = a + 5, h = a + 6, k = a + 7
    indices.push(a, e, b, b, e, f, c, d, h, d, k, h)
    indices.push(a, c, e, c, h, e, b, f, d, d, f, k)
  }
  indices.push(0, 1, 2, 1, 3, 2)
  const last = (levels.length - 1) * 4
  indices.push(last, last + 2, last + 1, last + 1, last + 2, last + 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 어깨는 넓고 허리는 잘록한 회전체 몸통. y=0이 엉덩이, y=TORSO가 어깨 높이다.
 * 앞뒤로 납작하고 좌우로 넓게 눌러 사람 흉곽 비율을 만든다.
 */
function createTorsoGeometry() {
  const profile: [number, number][] = [
    [0.000, 0.000], [0.112, 0.010], [0.124, 0.060], [0.110, 0.160],
    [0.116, 0.240], [0.138, 0.330], [0.152, 0.420], [0.150, 0.500],
    [0.104, 0.545], [0.000, TORSO],
  ]
  const geometry = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)), 20,
  )
  geometry.scale(0.80, 1, 1.30)
  geometry.translate(0, -TORSO / 2, 0)
  geometry.computeVertexNormals()
  return geometry
}

/** 위아래 굵기가 다른 팔다리. 양 끝은 반구라 관절에서 매끄럽게 이어진다. */
function createLimbGeometry(radiusTop: number, radiusBottom: number, length: number) {
  const points: THREE.Vector2[] = []
  const steps = 4
  const bottomCenter = -length / 2 + radiusBottom
  const topCenter = length / 2 - radiusTop
  for (let k = 0; k <= steps; k++) {
    const a = -Math.PI / 2 + (k / steps) * (Math.PI / 2)
    points.push(new THREE.Vector2(radiusBottom * Math.cos(a), bottomCenter + radiusBottom * Math.sin(a)))
  }
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2)
    points.push(new THREE.Vector2(radiusTop * Math.cos(a), topCenter + radiusTop * Math.sin(a)))
  }
  const geometry = new THREE.LatheGeometry(points, 12)
  geometry.computeVertexNormals()
  return geometry
}

export interface RigColors {
  hull: string
  trim: string
  jersey: string
  /** 하의. 상의와 같은 색이면 몸이 한 덩어리로 뭉쳐 보인다 */
  shorts: string
  skin: string
  hair: string
  /** 있으면 모자를 씌운다 (모자색). 없으면 머리카락만 */
  cap?: string
  oar: string
  blade: string
}

export const COLORS_PLAYER: RigColors = {
  hull: '#112b40', trim: '#dce5e8', jersey: '#edf1f2', shorts: '#17283a', skin: '#e9b58e',
  hair: '#2b1d14', cap: '#17324a', oar: '#172737', blade: '#e8edef',
}
/** 고스트(지난 내 최고 기록) — 금빛으로 구분한다. 페이스 보트의 회색과 안 헷갈린다. */
export const COLORS_GHOST: RigColors = {
  hull: '#8a672d', trim: '#f5e3b8', jersey: '#e0a33a', shorts: '#5a4526', skin: '#dcc39c',
  hair: '#b08a45', oar: '#e8d5a8', blade: '#e0a33a',
}

export const COLORS_PACE: RigColors = {
  hull: '#35414d', trim: '#aeb8c1', jersey: '#828d9a', shorts: '#414b56', skin: '#a09aa0',
  hair: '#4a4f57', oar: '#6d7885', blade: '#828d9a',
}

const UP = new THREE.Vector3(0, 1, 0)
const FORWARD_Z = new THREE.Vector3(0, 0, 1)
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
  /** 보트만 선회/롤하고 물에 남은 퍼들은 수평을 유지하도록 분리한 루트. */
  private visualRoot = new THREE.Group()

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
  private chestStripe!: THREE.Mesh
  private neck!: THREE.Mesh
  /** 두개골·얼굴·머리카락(모자)을 한 덩어리로 움직인다 */
  private head!: THREE.Group
  private shoulders: THREE.Mesh[] = []
  private upperArm: THREE.Mesh[] = []
  private elbows: THREE.Mesh[] = []
  private forearm: THREE.Mesh[] = []
  private fingers: THREE.Mesh[] = []
  private palms: THREE.Mesh[] = []
  private shortsLegs: THREE.Mesh[] = []
  private thigh: THREE.Mesh[] = []
  private knees: THREE.Mesh[] = []
  private shin: THREE.Mesh[] = []
  private socks: THREE.Mesh[] = []
  private shoes: THREE.Mesh[] = []
  private oarShaft: THREE.Mesh[] = []
  private oarBlade: THREE.Mesh[] = []
  private collars: THREE.Mesh[] = []
  private splash: THREE.Mesh[] = []
  private wake!: THREE.Mesh
  /** 물에 남는 퍼들 — 월드에 남아 뒤로 흘러간다 */
  private puddles: { mesh: THREE.Mesh; life: number }[] = []
  private puddleGroup = new THREE.Group()
  private wasInWater = false

  constructor(colors: RigColors, private opacity = 1) {
    this.group.add(this.visualRoot, this.puddleGroup)
    this.build(colors)
  }

  private mat(color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({
      color, flatShading: false, roughness: 0.62, metalness: 0.05,
      transparent: this.opacity < 1, opacity: this.opacity,
      ...extra,
    })
  }

  private physical(color: string, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, flatShading: false, roughness: 0.6, metalness: 0.0,
      transparent: this.opacity < 1, opacity: this.opacity,
      ...extra,
    })
  }

  private shadowed<T extends THREE.Object3D>(obj: T, receive = false): T {
    obj.castShadow = true
    obj.receiveShadow = receive
    return obj
  }

  private build(c: RigColors) {
    const g = this.visualRoot

    // ── 재질 ────────────────────────────────────────────────
    // 피부는 약간 매트하고, 유니폼은 직물의 시인(sheen)을 준다. 선체는 클리어코트로 광택.
    const skin = this.physical(c.skin, { roughness: 0.55, sheen: 0.15, sheenColor: new THREE.Color('#ffd9c2') })
    const jersey = this.physical(c.jersey, {
      roughness: 0.82, sheen: 0.55, sheenRoughness: 0.75, sheenColor: new THREE.Color('#ffffff'),
    })
    const shorts = this.physical(c.shorts, { roughness: 0.78, sheen: 0.4 })
    const hairMat = this.mat(c.hair, { roughness: 0.88 })
    const hullMat = this.physical(c.hull, {
      roughness: 0.32, metalness: 0.08, clearcoat: 1, clearcoatRoughness: 0.14,
    })
    const metal = this.mat('#4a545f', { metalness: 0.45, roughness: 0.38 })

    // ── 선체 ────────────────────────────────────────────────
    this.hull = this.shadowed(new THREE.Mesh(createRacingHullGeometry(), hullMat), true)
    this.hull.position.set(0.1, 0.02, 0)
    g.add(this.hull)

    // 밝은 중앙 데크와 어두운 콕핏이 길고 얇은 레이싱 셸의 형태를 읽히게 한다.
    const deckGeo = new THREE.CapsuleGeometry(0.075, 7.0, 3, 12)
    deckGeo.rotateZ(Math.PI / 2)
    deckGeo.scale(1, 0.18, 1)
    const deck = new THREE.Mesh(deckGeo, this.mat(c.trim, { roughness: 0.34 }))
    deck.position.set(0.12, 0.151, 0)
    deck.receiveShadow = true
    g.add(deck)

    const cockpitGeo = new THREE.CapsuleGeometry(0.14, 0.72, 3, 10)
    cockpitGeo.rotateZ(Math.PI / 2)
    cockpitGeo.scale(1, 0.18, 1)
    const cockpit = new THREE.Mesh(cockpitGeo, this.mat('#101820', { roughness: 0.7 }))
    cockpit.position.set(-0.08, 0.174, 0)
    cockpit.receiveShadow = true
    g.add(cockpit)

    // 시트가 구르는 슬라이드 레일 두 줄
    for (const side of [1, -1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.018, 0.02), metal)
      rail.position.set(-0.04, 0.19, side * 0.11)
      g.add(rail)
    }

    // 뱃머리 볼과 선미의 핀(스케그)
    const bowBall = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), this.mat('#f4f7f8'))
    bowBall.position.set(0.1 + RACING_HULL_LENGTH / 2 + 0.02, 0.055, 0)
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.13, 0.014), hullMat)
    fin.position.set(-2.6, -0.04, 0)
    g.add(bowBall, fin)

    // 발판
    const stretcher = new THREE.Mesh(
      new RoundedBoxGeometry(0.06, 0.28, 0.42, 2, 0.015), this.mat('#3d4650'),
    )
    stretcher.position.set(FOOT.x - 0.04, FOOT.y + 0.06, 0)
    stretcher.rotation.z = -0.35
    g.add(stretcher)

    // 삼각형 윙 리거 — 한 줄 막대보다 실제 스컬의 구조와 폭이 잘 보인다.
    for (const side of [1, -1]) {
      const lock = new THREE.Vector3(LOCK.x, LOCK.y, side * LOCK.z)
      const front = cylinderBetween(
        new THREE.Vector3(0.12, 0.22, side * 0.15), lock, 0.018, metal,
      )
      const rear = cylinderBetween(
        new THREE.Vector3(-0.69, 0.22, side * 0.15), lock, 0.018, metal,
      )
      const oarlock = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.012, 6, 12), metal)
      oarlock.rotation.x = Math.PI / 2
      oarlock.position.copy(lock)
      g.add(this.shadowed(front), this.shadowed(rear), oarlock)
    }

    // ── 사람 ────────────────────────────────────────────────
    this.seat = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.05, 0.26, 2, 0.02), this.mat('#2f3841'))
    g.add(this.seat)

    this.pelvis = this.shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.17, 0.30, 3, 0.05), shorts))
    g.add(this.pelvis)

    this.torso = this.shadowed(new THREE.Mesh(createTorsoGeometry(), jersey))
    g.add(this.torso)

    // 가슴을 가로지르는 팀 스트라이프 — 몸통이 한 색으로 뭉치지 않는다.
    const stripeGeo = new THREE.CylinderGeometry(0.157, 0.150, 0.075, 20, 1, true)
    stripeGeo.scale(0.80, 1, 1.30)
    this.chestStripe = new THREE.Mesh(stripeGeo, this.mat(c.trim === c.jersey ? c.shorts : c.shorts, { roughness: 0.8 }))
    g.add(this.chestStripe)

    this.neck = new THREE.Mesh(createLimbGeometry(0.052, 0.056, 0.14), skin)
    g.add(this.neck)

    this.head = this.buildHead(c, skin, hairMat)
    g.add(this.head)

    for (let i = 0; i < 2; i++) {
      this.shoulders.push(new THREE.Mesh(new THREE.SphereGeometry(0.057, 14, 10), jersey))
      this.upperArm.push(new THREE.Mesh(createLimbGeometry(0.052, 0.042, UPPER_ARM), skin))
      this.elbows.push(new THREE.Mesh(new THREE.SphereGeometry(0.044, 12, 9), skin))
      this.forearm.push(new THREE.Mesh(createLimbGeometry(0.045, 0.036, FOREARM), skin))
      // 손가락은 손잡이를 감싸는 고리, 손바닥은 아래팔 쪽에 붙는 타원
      const finger = new THREE.Mesh(new THREE.TorusGeometry(0.031, 0.016, 8, 14, Math.PI * 1.6), skin)
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 9), skin)
      palm.scale.set(1.0, 1.25, 1.05)
      this.fingers.push(finger)
      this.palms.push(palm)

      this.shortsLegs.push(new THREE.Mesh(createLimbGeometry(0.094, 0.088, 0.21), shorts))
      this.thigh.push(new THREE.Mesh(createLimbGeometry(0.084, 0.064, THIGH), skin))
      this.knees.push(new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 9), skin))
      this.shin.push(new THREE.Mesh(createLimbGeometry(0.062, 0.040, SHIN), skin))
      this.socks.push(new THREE.Mesh(createLimbGeometry(0.045, 0.045, 0.09), this.mat('#f2f4f4', { roughness: 0.9 })))
      this.shoes.push(new THREE.Mesh(
        new RoundedBoxGeometry(0.19, 0.08, 0.105, 2, 0.028), this.mat('#202a36', { roughness: 0.7 }),
      ))
      for (const part of [
        this.shoulders[i]!, this.upperArm[i]!, this.elbows[i]!, this.forearm[i]!,
        finger, palm, this.shortsLegs[i]!, this.thigh[i]!, this.knees[i]!, this.shin[i]!,
        this.socks[i]!, this.shoes[i]!,
      ]) g.add(this.shadowed(part))
    }

    // ── 노 ──────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.030, INBOARD + OUTBOARD, 9),
        this.mat(c.oar, { roughness: 0.4 }),
      )
      const blade = new THREE.Mesh(
        createOarBladeGeometry(), this.mat(c.blade, { roughness: 0.35 }),
      )
      const collar = new THREE.Mesh(
        new THREE.SphereGeometry(0.052, 10, 8), this.mat(c.trim, { roughness: 0.45 }),
      )
      this.oarShaft.push(this.shadowed(shaft))
      this.oarBlade.push(this.shadowed(blade))
      this.collars.push(collar)

      const sp = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 7),
        new THREE.MeshBasicMaterial({
          color: '#ffffff', transparent: true, opacity: 0,
        }),
      )
      sp.scale.set(1, 0.35, 1)
      this.splash.push(sp)
      g.add(shaft, blade, collar, sp)
    }

    const wakeGeometry = new THREE.BufferGeometry()
    wakeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.4, 0.105, 0, -4.4, 0.105, 0.48, -4.4, 0.105, -0.48,
    ], 3))
    this.wake = new THREE.Mesh(
      wakeGeometry,
      new THREE.MeshBasicMaterial({
        color: '#d9f1f7', transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    )
    this.wake.renderOrder = 1
    g.add(this.wake)
  }

  /** 두개골·턱·눈·눈썹·코·입·귀·머리카락(+모자). 얼굴은 -X(선미) 쪽을 본다. */
  private buildHead(c: RigColors, skin: THREE.Material, hairMat: THREE.Material) {
    const head = new THREE.Group()
    const r = HEAD_RADIUS

    const skull = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 16), skin)
    skull.scale.set(1.0, 1.14, 0.86)
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(r * 0.66, 14, 12), skin)
    jaw.scale.set(1.0, 0.82, 1.05)
    jaw.position.set(-0.018, -r * 0.72, 0)
    head.add(this.shadowed(skull), jaw)

    const eyeWhite = this.mat('#f6f1ec', { roughness: 0.35 })
    const iris = this.mat('#2b2018', { roughness: 0.3 })
    const lips = this.mat('#b5695f', { roughness: 0.7 })
    for (const side of [1, -1]) {
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), eyeWhite)
      white.position.set(-r * 0.80, 0.018, side * 0.037)
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 8, 6), iris)
      pupil.position.set(-r * 0.94, 0.018, side * 0.037)
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.007, 0.034), hairMat)
      brow.position.set(-r * 0.86, 0.047, side * 0.037)
      brow.rotation.x = side * 0.18
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.019, 10, 8), skin)
      ear.scale.set(0.55, 1.0, 0.9)
      ear.position.set(0.012, 0.0, side * r * 0.86)
      head.add(white, pupil, brow, ear)
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.013, 0.038, 8), skin)
    nose.rotation.z = Math.PI / 2
    nose.position.set(-r * 1.02, -0.006, 0)
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.005, 0.034), lips)
    mouth.position.set(-r * 0.90, -0.048, 0)
    head.add(nose, mouth)

    // 머리카락: 이마는 드러나고 뒤통수는 덮이도록 캡을 뒤로 기울인다.
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.07, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), hairMat,
    )
    hair.scale.set(1.0, 1.12, 0.88)
    hair.position.set(0.012, 0.024, 0)
    hair.rotation.z = -0.34
    head.add(this.shadowed(hair))

    if (c.cap) {
      const capMat = this.mat(c.cap, { roughness: 0.85 })
      const crown = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.09, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), capMat,
      )
      crown.scale.set(1.02, 0.92, 0.9)
      crown.position.set(0.004, 0.03, 0)
      crown.rotation.z = -0.1
      const visor = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.78, 14, Math.PI / 2, Math.PI),
        this.mat(c.cap, { roughness: 0.85, side: THREE.DoubleSide }),
      )
      visor.rotation.x = -Math.PI / 2
      visor.rotation.z = 0.08
      visor.position.set(-r * 0.86, 0.047, 0)
      head.add(this.shadowed(crown), visor)
    }
    return head
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
    const bodyAxis = new THREE.Vector3(-sh, ch, 0)

    this.pelvis.position.copy(hip).addScaledVector(bodyAxis, 0.02)
    this.pelvis.rotation.z = pose.bodyAngle * 0.4
    place(this.torso, hip, shoulder, TORSO)
    const stripeCenter = hip.clone().addScaledVector(bodyAxis, 0.36)
    place(this.chestStripe, stripeCenter.clone().addScaledVector(bodyAxis, -0.0375),
      stripeCenter.clone().addScaledVector(bodyAxis, 0.0375), 0.075)

    const headPos = shoulder.clone().addScaledVector(bodyAxis, 0.21)
    const neckStart = shoulder.clone().addScaledVector(bodyAxis, -0.02)
    const neckEnd = headPos.clone().addScaledVector(bodyAxis, -0.09)
    place(this.neck, neckStart, neckEnd, 0.14)
    this.head.position.copy(headPos)
    // 몸을 숙여도 고개는 거의 수평을 유지해 후방 카메라에서 얼굴이 잘 보이게 한다.
    this.head.rotation.z = pose.bodyAngle * 0.22

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
      const bladeTip = blade.clone().addScaledVector(dir, -0.52)
      place(this.oarBlade[i]!, blade, bladeTip, 0.52)
      this.collars[i]!.position.copy(lock).addScaledVector(dir, 0.035)

      // ── 팔 IK: 어깨 → 손잡이 ────────────────────────────
      const shoulderPt = new THREE.Vector3(shoulder.x, shoulder.y, side * SHOULDER_HALF)
      const pole = new THREE.Vector3(0, -1, side * 0.55).normalize()
      const elbow = solveIK(shoulderPt, handle, UPPER_ARM, FOREARM, pole)
      this.joints.elbow[i]!.copy(elbow)
      this.shoulders[i]!.position.copy(shoulderPt).addScaledVector(bodyAxis, -0.01)
      place(this.upperArm[i]!, shoulderPt, elbow, UPPER_ARM)
      this.elbows[i]!.position.copy(elbow)
      place(this.forearm[i]!, elbow, handle, FOREARM)

      // 손가락 고리는 노 축을 감싸고, 손바닥은 아래팔 쪽에서 손잡이를 받친다.
      const finger = this.fingers[i]!
      finger.position.copy(handle).addScaledVector(dir, -0.02)
      finger.quaternion.setFromUnitVectors(FORWARD_Z, dir)
      const toElbow = _b.subVectors(elbow, handle).normalize()
      const palm = this.palms[i]!
      palm.position.copy(handle).addScaledVector(toElbow, 0.035)
      palm.quaternion.setFromUnitVectors(UP, toElbow)

      // ── 다리 IK: 엉덩이 → 발 ────────────────────────────
      const hipPt = new THREE.Vector3(hipX, SEAT_Y, side * HIP_HALF)
      const footPt = new THREE.Vector3(FOOT.x, FOOT.y, side * FOOT.z)
      const knee = solveIK(hipPt, footPt, THIGH, SHIN, UP)
      this.joints.knee[i]!.copy(knee)
      this.joints.foot[i]!.copy(footPt)
      const thighDir = _c.subVectors(knee, hipPt).normalize()
      place(this.shortsLegs[i]!, hipPt.clone().addScaledVector(thighDir, -0.02),
        hipPt.clone().addScaledVector(thighDir, 0.19), 0.21)
      place(this.thigh[i]!, hipPt, knee, THIGH)
      this.knees[i]!.position.copy(knee)
      place(this.shin[i]!, knee, footPt, SHIN)
      const shinDir = _b.subVectors(knee, footPt).normalize()
      place(this.socks[i]!, footPt.clone().addScaledVector(shinDir, 0.01),
        footPt.clone().addScaledVector(shinDir, 0.10), 0.09)
      this.shoes[i]!.position.set(footPt.x - 0.035, footPt.y + 0.005, footPt.z)
      this.shoes[i]!.rotation.z = -0.35

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

    const wakeMaterial = this.wake.material as THREE.MeshBasicMaterial
    const moving = Math.min(1, Math.max(0, speed / 4.8))
    wakeMaterial.opacity = moving * 0.20 * this.opacity
    this.wake.scale.x = 0.72 + moving * 0.55
  }

  /** 곡선에서 보트 본체만 선회하고 안쪽으로 살짝 기울인다. */
  setCourseAttitude(yaw: number, lean: number) {
    this.visualRoot.rotation.order = 'YXZ'
    this.visualRoot.rotation.y = yaw
    this.visualRoot.rotation.x = lean
    this.visualRoot.rotation.z = 0
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

function cylinderBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
) {
  const length = from.distanceTo(to)
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 8), material,
  )
  place(mesh, from, to, length)
  return mesh
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
