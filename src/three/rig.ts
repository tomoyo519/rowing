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
/**
 * 엉덩이 **관절**의 높이. 시트 상판이 아니라 골반 안쪽 관절이다.
 * 예전엔 0.24로 발(0.20)보다 4cm밖에 높지 않아, 89cm짜리 다리를 32cm 간격에 접느라
 * 캐치에서 무릎이 엉덩이보다 39cm 솟아 가슴을 뚫고 정강이가 뒤로 넘어갔다.
 * 실제 싱글스컬은 발뒤꿈치가 엉덩이보다 15~18cm 아래에 있다.
 */
const SEAT_Y = 0.32
/** 시트 상판 — 레일(y=0.19) 위에 얹힌다 */
const SEAT_TOP_Y = 0.18
const SEAT_CATCH_X = -0.30
const SEAT_FINISH_X = 0.22
const FOOT = { x: -0.62, y: 0.20, z: 0.14 }
const THIGH = 0.45
const SHIN = 0.44
/** 엉덩이에서 어깨선(견봉)까지 */
const TORSO = 0.55
/**
 * 몸통 회전체는 어깨선 위로 승모근 칼라가 솟아 목 아래를 받친다.
 * 예전엔 몸통이 어깨 높이에서 뚜껑처럼 납작하게 끝나 목이 통 위에 꽂힌 못처럼 보였다.
 */
const TORSO_TOP = 0.604
/** 팔 관절은 어깨선보다 이만큼 아래, 몸통 안쪽에 있다 — 위팔 반구가 삼각근이 되어 바깥으로 드러난다 */
const SHOULDER_DROP = 0.05
/** 척추를 두 마디로 나눈다: 골반~갈비뼈(허리)와 갈비뼈~어깨(등). 따로 굽어야 캐치에서 등이 둥글어진다 */
const TORSO_LOWER = 0.30
const TORSO_UPPER = TORSO - TORSO_LOWER
/** 허리는 덜 굽고 등은 더 굽는다 — 허리 각도 = bodyAngle × LOWER, 등 각도 = bodyAngle × UPPER + ROUND */
const SPINE_LOWER = 0.85
const SPINE_UPPER = 1.22
/** 등은 항상 살짝 앞으로 말려 있다 (rad). 캐치에서 둥근 등, 피니시에서도 완전히 펴지진 않는다 */
const SPINE_ROUND = 0.05
/** 캐치에서 어깨가 손잡이 쪽으로 나가는 거리 (m), 피니시에서 뒤로 당겨지는 거리 */
const SHOULDER_REACH = 0.045
const SHOULDER_RETRACT = 0.02
/** 손잡이는 손 너머로 조금 더 이어진다 (m) */
const HANDLE_TAIL = 0.09
/**
 * 스컬은 왼손이 오른손 위로 지나간다. 왼쪽(+Z) 노받이를 1.5cm 높게 리깅하고 왼손을 조금 더 들어
 * 두 손이 정면에서 겹쳐 뚫고 지나가지 않게 한다. OUTBOARD × HAND_CROSS_PHI ≈ LOCK_RISE라 블레이드 깊이는 같다.
 */
const LOCK_RISE = 0.015
const HAND_CROSS_PHI = 0.008
const UPPER_ARM = 0.30
const FOREARM = 0.30
/**
 * 캐치에서 어깨~손잡이 거리. 팔 길이(0.60)보다 1cm 짧아 팔이 거의 곧게 펴진다.
 * 예전엔 손잡이 X만 정해 놓아서 어깨~손잡이가 늘 0.45~0.53m였고, 팔꿈치가 100° 남짓 굽은 채
 * 다리 드라이브 내내 팔로 젓는 것처럼 보였다 — 정면 카메라에서 가장 눈에 띄는 오류다.
 */
const ARM_STRAIGHT = UPPER_ARM + FOREARM - 0.010
/** 피니시에서 손잡이가 갈비뼈까지 들어온 거리 (팔꿈치 약 70°) */
const ARM_FINISH = 0.35
/** 스윕각 한계 (rad). 실제 스컬 아크는 캐치 -60~65°, 피니시 +35~45°다 */
const SWEEP_LIMIT = 1.30
const SHOULDER_HALF = 0.17
const HIP_HALF = 0.11
const HEAD_RADIUS = 0.105

/** 노받이(oarlock) 위치 */
const LOCK = { x: -0.30, y: 0.47, z: 0.85 }
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
 * 허리(0~TORSO_LOWER)와 등(TORSO_LOWER~TORSO) 두 마디로 나눠 각각 다른 각도로 세울 수 있게 한다.
 * 이음매는 반지름이 같고 살짝 겹쳐서 굽어도 틈이 벌어지지 않는다.
 */
const TORSO_PROFILE: [number, number][] = [
  [0.000, 0.000], [0.112, 0.010], [0.126, 0.060], [0.112, 0.160],
  [0.118, 0.240], [0.132, 0.300], [0.140, 0.330], [0.153, 0.420], [0.156, 0.470],
  [0.150, 0.505], [0.130, 0.540], [0.098, 0.565], [0.076, 0.585], [0.070, 0.600], [0.000, TORSO_TOP],
]
const SPINE_OVERLAP = 0.03

function torsoRadiusAt(y: number) {
  for (let i = 1; i < TORSO_PROFILE.length; i++) {
    const [r0, y0] = TORSO_PROFILE[i - 1]!
    const [r1, y1] = TORSO_PROFILE[i]!
    if (y <= y1) return r0 + (r1 - r0) * ((y - y0) / (y1 - y0))
  }
  return 0
}

function createTorsoSegmentGeometry(from: number, to: number) {
  const points: THREE.Vector2[] = [new THREE.Vector2(0, from)]
  points.push(new THREE.Vector2(torsoRadiusAt(from), from))
  for (const [r, y] of TORSO_PROFILE) if (y > from && y < to) points.push(new THREE.Vector2(r, y))
  points.push(new THREE.Vector2(torsoRadiusAt(to), to))
  points.push(new THREE.Vector2(0, to))
  const geometry = new THREE.LatheGeometry(points, 20)
  geometry.scale(0.80, 1, 1.30)
  geometry.translate(0, -(from + to) / 2, 0)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 위아래 굵기가 다른 팔다리. 양 끝 반구의 **중심**이 관절 위치에 온다.
 * 그래서 관절에서 만나는 두 팔다리의 반구가 그대로 관절 공이 된다 — 굽힘 바깥쪽은 매끄럽게 이어지고
 * 안쪽은 서로 겹쳐 숨는다. 관절마다 따로 구를 얹으면 굽힐 때 구가 삐져나온다.
 * 관절에서 만나는 두 반지름을 맞춰야 한 덩어리로 읽힌다.
 */
function createLimbGeometry(radiusTop: number, radiusBottom: number, length: number) {
  const points: THREE.Vector2[] = []
  const steps = 6
  const bottomCenter = -length / 2
  const topCenter = length / 2
  for (let k = 0; k <= steps; k++) {
    const a = -Math.PI / 2 + (k / steps) * (Math.PI / 2)
    points.push(new THREE.Vector2(radiusBottom * Math.cos(a), bottomCenter + radiusBottom * Math.sin(a)))
  }
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2)
    points.push(new THREE.Vector2(radiusTop * Math.cos(a), topCenter + radiusTop * Math.sin(a)))
  }
  const geometry = new THREE.LatheGeometry(points, 14)
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
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _m = new THREE.Matrix4()
// 블레이드 축 계산용 스크래치 — place()가 _b/_c를 덮어쓰므로 따로 둔다
const _b2 = new THREE.Vector3()
const _nf = new THREE.Vector3()
const _ns = new THREE.Vector3()
const _nb = new THREE.Vector3()
const _bx = new THREE.Vector3()

/** 매 프레임 계산된 관절 위치 — 디버깅/테스트용으로 노출한다 */
export interface Joints {
  hip: THREE.Vector3
  /** 양 어깨의 가운데 */
  shoulder: THREE.Vector3
  /** 팔이 시작하는 좌우 어깨 관절 — 캐치에서 앞으로 나가고 피니시에서 뒤로 당겨진다 */
  armRoot: THREE.Vector3[]
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
    armRoot: [new THREE.Vector3(), new THREE.Vector3()],
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
  /** 허리(골반~갈비뼈)와 등(갈비뼈~어깨) */
  private torsoLower!: THREE.Mesh
  private torsoUpper!: THREE.Mesh
  private chestStripe!: THREE.Mesh
  /** 보트가 스트로크에 따라 앞뒤로 끄덕이는 각도 — setCourseAttitude가 커브 자세와 합친다 */
  private pitch = 0
  private neck!: THREE.Mesh
  /** 두개골·얼굴·머리카락(모자)을 한 덩어리로 움직인다 */
  private head!: THREE.Group
  private upperArm: THREE.Mesh[] = []
  private forearm: THREE.Mesh[] = []
  /** 손잡이를 쥔 주먹 하나 — 고리+손바닥 구슬보다 멀리서도 손으로 읽힌다 */
  private fists: THREE.Mesh[] = []
  private shortsLegs: THREE.Mesh[] = []
  private thigh: THREE.Mesh[] = []
  private shin: THREE.Mesh[] = []
  /** 깜빡임에 쓰는 눈 흰자와 눈동자 */
  private eyes: THREE.Mesh[] = []
  private clock = 0
  private blinkT = -1
  private nextBlinkAt = 2.5
  private blinkCount = 0
  /** 고개는 몸통을 조금 늦게 따라간다 — 같은 프레임에 방향을 바꾸면 막대 인형이다 */
  private headAngle = 0
  private socks: THREE.Mesh[] = []
  private shoes: THREE.Mesh[] = []
  private oarShaft: THREE.Mesh[] = []
  private oarBlade: THREE.Mesh[] = []
  /** 테스트에서 블레이드 자세를 재기 위해 노출한다 */
  get bladeMeshes(): readonly THREE.Mesh[] { return this.oarBlade }
  private collars: THREE.Mesh[] = []
  private splash: THREE.Mesh[] = []
  private wake!: THREE.Mesh
  /** 물에 남는 퍼들 — 월드에 남아 뒤로 흘러간다 */
  private puddles: { mesh: THREE.Mesh; life: number }[] = []
  private puddleGroup = new THREE.Group()
  private wasInWater = false

  /**
   * @param seed 보트마다 다른 값을 주면 깜빡임·호흡이 셋이 똑같이 맞물리지 않는다
   */
  constructor(colors: RigColors, private opacity = 1, private seed = 0) {
    this.group.add(this.visualRoot, this.puddleGroup)
    this.nextBlinkAt = 1.5 + (seed % 1) * 2
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
      const lock = new THREE.Vector3(LOCK.x, LOCK.y + side * LOCK_RISE, side * LOCK.z)
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

    // 골반은 타원체 — 상자는 허리에서 모서리가 드러나고 앞면이 허벅지 사이로 보인다
    const pelvisGeo = new THREE.SphereGeometry(0.15, 18, 12)
    pelvisGeo.scale(0.80, 0.55, 1.32)
    this.pelvis = this.shadowed(new THREE.Mesh(pelvisGeo, shorts))
    g.add(this.pelvis)

    this.torsoLower = this.shadowed(new THREE.Mesh(
      createTorsoSegmentGeometry(0, TORSO_LOWER + SPINE_OVERLAP), jersey,
    ))
    this.torsoUpper = this.shadowed(new THREE.Mesh(
      createTorsoSegmentGeometry(TORSO_LOWER - SPINE_OVERLAP, TORSO_TOP), jersey,
    ))
    g.add(this.torsoLower, this.torsoUpper)

    // 가슴을 가로지르는 팀 스트라이프 — 몸통이 한 색으로 뭉치지 않는다.
    // 몸통 회전체 반지름(0.140~0.153)에 3mm만 띄워 붙인다 — 더 크면 허공에 뜬 고리가 된다
    const stripeGeo = new THREE.CylinderGeometry(0.156, 0.143, 0.075, 20, 1, true)
    stripeGeo.scale(0.80, 1, 1.30)
    this.chestStripe = new THREE.Mesh(stripeGeo, this.mat(c.trim === c.jersey ? c.shorts : c.shorts, { roughness: 0.8 }))
    g.add(this.chestStripe)

    this.neck = new THREE.Mesh(createLimbGeometry(0.052, 0.056, 0.14), skin)
    g.add(this.neck)

    this.head = this.buildHead(c, skin, hairMat)
    g.add(this.head)

    for (let i = 0; i < 2; i++) {
      // 관절에서 만나는 반지름을 맞춘다: 어깨 0.058, 팔꿈치 0.044, 손목 0.036 / 엉덩이 0.086, 무릎 0.064, 발목 0.040
      this.upperArm.push(new THREE.Mesh(createLimbGeometry(0.058, 0.044, UPPER_ARM), skin))
      this.forearm.push(new THREE.Mesh(createLimbGeometry(0.044, 0.036, FOREARM), skin))
      // 주먹: x = 손등 두께, y = 손목 방향, z = 노 방향
      const fist = new THREE.Mesh(new RoundedBoxGeometry(0.076, 0.066, 0.090, 2, 0.028), skin)
      this.fists.push(fist)

      this.shortsLegs.push(new THREE.Mesh(createLimbGeometry(0.094, 0.088, 0.21), shorts))
      this.thigh.push(new THREE.Mesh(createLimbGeometry(0.086, 0.064, THIGH), skin))
      this.shin.push(new THREE.Mesh(createLimbGeometry(0.064, 0.040, SHIN), skin))
      this.socks.push(new THREE.Mesh(createLimbGeometry(0.045, 0.045, 0.09), this.mat('#f2f4f4', { roughness: 0.9 })))
      this.shoes.push(new THREE.Mesh(
        new RoundedBoxGeometry(0.19, 0.08, 0.105, 2, 0.028), this.mat('#202a36', { roughness: 0.7 }),
      ))
      for (const part of [
        this.upperArm[i]!, this.forearm[i]!, fist, this.shortsLegs[i]!, this.thigh[i]!, this.shin[i]!,
        this.socks[i]!, this.shoes[i]!,
      ]) g.add(this.shadowed(part))
    }

    // ── 노 ──────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.030, INBOARD + OUTBOARD + HANDLE_TAIL, 9),
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

    const eyeWhite = this.mat('#ddd2c8', { roughness: 0.6 })
    const iris = this.mat('#2b2018', { roughness: 0.3 })
    const lips = this.mat('#b5695f', { roughness: 0.7 })
    for (const side of [1, -1]) {
      // 흰자는 11m 밖에서 하얀 점으로 튀지 않게 살짝 어둡고 작게
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.0145, 10, 8), eyeWhite)
      white.position.set(-r * 0.80, 0.018, side * 0.037)
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0078, 8, 6), iris)
      pupil.position.set(-r * 0.94, 0.018, side * 0.037)
      this.eyes.push(white, pupil)
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
    // 보조 동작의 진폭은 속도에 따른다 — 1:40 스프린트와 2:40 패들이 같은 몸일 수 없다.
    // dt는 탭이 뒤로 갔다 온 뒤의 큰 값이 애니메이션을 폭주시키지 않게 자른다.
    const dtc = Math.min(dt, 0.05)
    this.clock += dtc
    const effort = clamp(speed / 5, 0, 1)
    const alive = clamp(speed / 1.5, 0, 1)

    // ── 몸통 ────────────────────────────────────────────────
    const hipX = SEAT_CATCH_X + (SEAT_FINISH_X - SEAT_CATCH_X) * pose.slide
    const hip = _a.set(hipX, SEAT_Y, 0).clone()
    this.seat.position.set(hipX, SEAT_TOP_Y, 0)

    // +bodyAngle = 앞(-X)으로 숙임. 척추는 두 마디 — 허리는 덜, 등은 더 굽는다.
    // 캐치에서 등이 둥글게 말리고 피니시에서 가슴이 열리는 게 여기서 나온다.
    const lowerAngle = pose.bodyAngle * SPINE_LOWER
    const upperAngle = pose.bodyAngle * SPINE_UPPER + SPINE_ROUND
    const lowerAxis = new THREE.Vector3(-Math.sin(lowerAngle), Math.cos(lowerAngle), 0)
    const upperAxis = new THREE.Vector3(-Math.sin(upperAngle), Math.cos(upperAngle), 0)
    const ribs = hip.clone().addScaledVector(lowerAxis, TORSO_LOWER)
    // 호흡: 젓는 중엔 리커버리에 들이쉬고 드라이브에 내쉰다. 서 있을 땐 분당 16회쯤 제 리듬으로.
    // 내쉴 때 어깨선이 1cm 내려앉는다 — 가슴만 부푸는 게 아니라 어깨가 함께 움직여야 숨으로 보인다.
    const lungStroke = pose.inWater ? 1 - easeInOut(pose.driveProgress) : easeInOut(pose.recoveryProgress)
    const lungIdle = 0.5 + 0.5 * Math.sin((2 * Math.PI * this.clock) / 3.8 + this.seed)
    const lung = lerp(lungIdle, lungStroke, alive)
    const shoulder = ribs.clone().addScaledVector(upperAxis, TORSO_UPPER - 0.010 * (1 - lung))
    const bodyAxis = upperAxis

    // 골반은 관절보다 아래에 있어 시트에 닿는다
    this.pelvis.position.copy(hip).addScaledVector(lowerAxis, -0.045)
    this.pelvis.rotation.z = lowerAngle * 0.5
    place(this.torsoLower, hip, ribs.clone().addScaledVector(lowerAxis, SPINE_OVERLAP), TORSO_LOWER + SPINE_OVERLAP)
    const collarTop = shoulder.clone().addScaledVector(upperAxis, TORSO_TOP - TORSO)
    place(this.torsoUpper, ribs.clone().addScaledVector(upperAxis, -SPINE_OVERLAP), collarTop, TORSO_TOP - TORSO_LOWER + SPINE_OVERLAP)
    const breath = 1 + (0.025 + 0.035 * effort) * lung
    this.torsoUpper.scale.x = breath
    this.torsoUpper.scale.z = breath
    const stripeCenter = ribs.clone().addScaledVector(upperAxis, 0.075)
    place(this.chestStripe, stripeCenter.clone().addScaledVector(upperAxis, -0.0375),
      stripeCenter.clone().addScaledVector(upperAxis, 0.0375), 0.075)
    this.chestStripe.scale.x *= breath
    this.chestStripe.scale.z *= breath

    const headPos = shoulder.clone().addScaledVector(upperAxis, 0.235)
    const neckStart = collarTop.clone().addScaledVector(upperAxis, -0.015)
    const neckEnd = headPos.clone().addScaledVector(upperAxis, -0.09)
    place(this.neck, neckStart, neckEnd, 0.14)
    this.head.position.copy(headPos)
    // 몸을 숙여도 시선은 선미 쪽 수평을 향한다 — 턱이 가슴에 붙지 않는다.
    // 드라이브에 힘이 실릴 때 고개가 살짝 끄덕이고, 몸통보다 한 박자 늦게 따라간다.
    const driveLoad = pose.inWater ? Math.sin(pose.driveProgress * Math.PI) : 0
    const headTarget = upperAngle * 0.18 + driveLoad * 0.04 * (0.5 + 0.5 * effort)
    this.headAngle += (headTarget - this.headAngle) * (1 - Math.exp(-dtc / 0.07))
    this.head.rotation.z = this.headAngle
    this.updateBlink(dtc)

    this.joints.hip.copy(hip)
    this.joints.shoulder.copy(shoulder)
    this.joints.head.copy(headPos)

    // 보트: 캐치에서 무게가 선미로 가 뱃머리가 살짝 들리고, 드라이브 힘이 실리면 물에 눌려 잠긴다.
    // 서 있을 땐 물결에 아주 조금 흔들린다 — 물 위에서 완전히 멈춘 것은 없다.
    const bob = 0.004 * Math.sin(this.clock * 1.3 + this.seed) * (1 - alive)
    this.pitch = (0.012 * (0.5 - pose.slide) * 2 - 0.005 * driveLoad) * (0.6 + 0.4 * effort) + bob
    this.visualRoot.position.y = -0.008 * driveLoad * (0.5 + 0.5 * effort)

    // ── 노: 팔 길이 → 스윕각 → 노 방향 ─────────────────────
    // 손이 내려가며 블레이드가 잠긴다 — 한 프레임에 꽂히지 않고 bladeDepth를 따라 내려간다
    const phi = lerp(PHI_RECOVERY, PHI_DRIVE, pose.bladeDepth)
    // 팔이 얼마나 펴져 있어야 하는지가 손잡이 위치를, 손잡이 위치가 노 각도를 정한다.
    const armReach = lerp(ARM_STRAIGHT, ARM_FINISH, pose.armDraw)
    // 어깨는 캐치에서 손잡이 쪽으로 나가고(견갑골 전인) 피니시에서 뒤로 당겨진다(후인)
    const reach = lerp(-SHOULDER_REACH, SHOULDER_RETRACT, pose.armDraw)

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1
      // 팔 관절은 어깨선 아래 몸통 안쪽에서 시작한다
      const shoulderPt = shoulder.clone().addScaledVector(bodyAxis, -SHOULDER_DROP)
      shoulderPt.x += reach
      shoulderPt.z = side * SHOULDER_HALF
      this.joints.armRoot[i]!.copy(shoulderPt)

      // 왼손(+Z)이 오른손 위로 지나간다 — 노받이도 손도 왼쪽이 조금 높다
      const phiS = phi + side * HAND_CROSS_PHI
      const theta = solveSweep(shoulderPt, armReach, phiS, side)
      if (i === 0) this.joints.theta = theta
      const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta)
      const cosPhi = Math.cos(phiS), sinPhi = Math.sin(phiS)
      // 노받이에서 손잡이로 향하는 단위벡터
      const dir = new THREE.Vector3(
        sinTheta * cosPhi,
        sinPhi,
        -side * cosTheta * cosPhi,
      )
      const lock = new THREE.Vector3(LOCK.x, LOCK.y + side * LOCK_RISE, side * LOCK.z)
      const handle = lock.clone().addScaledVector(dir, INBOARD)
      const blade = lock.clone().addScaledVector(dir, -OUTBOARD)

      this.joints.handle[i]!.copy(handle)
      this.joints.blade[i]!.copy(blade)

      // 손잡이는 손 너머로 조금 더 나온다 — 손이 막대 끝을 쥔 것처럼 보이지 않게
      const handleTail = handle.clone().addScaledVector(dir, HANDLE_TAIL)
      place(this.oarShaft[i]!, handleTail, blade, INBOARD + OUTBOARD + HANDLE_TAIL)
      this.oarBlade[i]!.position.copy(blade)
      const bladeTip = blade.clone().addScaledVector(dir, -0.52)
      place(this.oarBlade[i]!, blade, bladeTip, 0.52)
      // place()는 노 축 **둘레**의 회전(페더링 각)을 정하지 못한다 — 노 방향에 따라 제멋대로 굴러간다.
      // 그래서 축을 직접 세운다: 로컬 +Y는 노 축, 로컬 +Z는 블레이드 면의 법선.
      // 법선이 수직이면 눕힌 것(페더), 수평이면 세운 것(스퀘어)이다.
      const along = _b2.copy(dir).negate()
      const feather = _nf.copy(UP).addScaledVector(along, -UP.dot(along))
      if (feather.lengthSq() < 1e-6) feather.set(1, 0, 0)
      feather.normalize()
      const squared = _ns.crossVectors(along, UP)
      if (squared.lengthSq() < 1e-6) squared.set(0, 0, 1)
      squared.normalize()
      const roll = (Math.PI / 2) * pose.square
      const normal = _nb.copy(feather).multiplyScalar(Math.cos(roll)).addScaledVector(squared, Math.sin(roll))
      this.oarBlade[i]!.quaternion.setFromRotationMatrix(
        _m.makeBasis(_bx.crossVectors(along, normal), along, normal),
      )
      this.collars[i]!.position.copy(lock).addScaledVector(dir, 0.035)

      // ── 팔 IK: 어깨 → 손잡이 ────────────────────────────
      // 팔꿈치는 캐치에서 아래·바깥, 피니시에선 옆·뒤로 빠진다 — 아래로 처지면 노를 배로 젓는 것처럼 보인다
      const pole = new THREE.Vector3(
        lerp(0, 0.45, pose.armDraw),
        lerp(-1, -0.25, pose.armDraw),
        side * lerp(0.55, 0.9, pose.armDraw),
      ).normalize()
      const elbow = solveIK(shoulderPt, handle, UPPER_ARM, FOREARM, pole)
      this.joints.elbow[i]!.copy(elbow)
      place(this.upperArm[i]!, shoulderPt, elbow, UPPER_ARM)
      place(this.forearm[i]!, elbow, handle, FOREARM)

      // 주먹: z축은 노, y축은 아래팔 쪽(손목), x축은 손등. 노가 손가락 안쪽을 지나도록 살짝 비껴 놓는다.
      const zAxis = dir
      const yAxis = new THREE.Vector3().subVectors(elbow, handle)
      yAxis.addScaledVector(zAxis, -yAxis.dot(zAxis))
      if (yAxis.lengthSq() < 1e-6) yAxis.copy(UP)
      yAxis.normalize()
      const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis)
      const fist = this.fists[i]!
      fist.quaternion.setFromRotationMatrix(_m.makeBasis(xAxis, yAxis, zAxis))
      fist.position.copy(handle).addScaledVector(yAxis, 0.012).addScaledVector(dir, -0.01)

      // ── 다리 IK: 엉덩이 → 발 ────────────────────────────
      const hipPt = new THREE.Vector3(hipX, SEAT_Y, side * HIP_HALF)
      const footPt = new THREE.Vector3(FOOT.x, FOOT.y, side * FOOT.z)
      // 무릎은 발 위로 올라가되 살짝 바깥으로 벌어진다
      const kneePole = new THREE.Vector3(0, 1, side * 0.15).normalize()
      const knee = solveIK(hipPt, footPt, THIGH, SHIN, kneePole)
      this.joints.knee[i]!.copy(knee)
      this.joints.foot[i]!.copy(footPt)
      const thighDir = _c.subVectors(knee, hipPt).normalize()
      place(this.shortsLegs[i]!, hipPt.clone().addScaledVector(thighDir, -0.02),
        hipPt.clone().addScaledVector(thighDir, 0.19), 0.21)
      place(this.thigh[i]!, hipPt, knee, THIGH)
      place(this.shin[i]!, knee, footPt, SHIN)
      // 캐치 쪽 마지막 30% 슬라이드에서 뒤꿈치가 발판에서 들린다 — 눌러 접는 게 아니라 몸을 밀어 넣는 것으로 보인다
      const compress = clamp((0.30 - pose.slide) / 0.30, 0, 1)
      const heel = compress * compress * (0.6 + 0.4 * effort)
      const shinDir = _b.subVectors(knee, footPt).normalize()
      place(this.socks[i]!, footPt.clone().addScaledVector(shinDir, 0.01).setY(footPt.y + 0.01 * shinDir.y + 0.03 * heel),
        footPt.clone().addScaledVector(shinDir, 0.10).setY(footPt.y + 0.10 * shinDir.y + 0.03 * heel), 0.09)
      this.shoes[i]!.position.set(footPt.x - 0.035 + 0.04 * heel, footPt.y + 0.005 + 0.035 * heel, footPt.z)
      this.shoes[i]!.rotation.z = -0.35 - 0.30 * heel

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
    if (pose.inWater && !this.wasInWater) this.dropPuddles(this.joints.theta)
    this.wasInWater = pose.inWater
    this.updatePuddles(dt, speed)

    const wakeMaterial = this.wake.material as THREE.MeshBasicMaterial
    const moving = Math.min(1, Math.max(0, speed / 4.8))
    wakeMaterial.opacity = moving * 0.20 * this.opacity
    this.wake.scale.x = 0.72 + moving * 0.55
  }

  /** 2.5~5초마다 눈을 감았다 뜬다. 보트마다 seed가 달라 셋이 동시에 깜빡이지 않는다. */
  private updateBlink(dt: number) {
    if (this.blinkT < 0 && this.clock >= this.nextBlinkAt) {
      this.blinkT = 0
      this.blinkCount++
      this.nextBlinkAt = this.clock + 2.5 + ((this.seed * 7 + this.blinkCount * 13) % 10) / 10 * 2.6
    }
    let lid = 1
    if (this.blinkT >= 0) {
      const t = this.blinkT / 0.14
      lid = t >= 1 ? 1 : 1 - 0.92 * Math.sin(t * Math.PI)
      this.blinkT = t >= 1 ? -1 : this.blinkT + dt
    }
    for (const eye of this.eyes) eye.scale.y = lid
  }

  /** 곡선에서 보트 본체만 선회하고 안쪽으로 살짝 기울인다. */
  setCourseAttitude(yaw: number, lean: number) {
    this.visualRoot.rotation.order = 'YXZ'
    this.visualRoot.rotation.y = yaw
    this.visualRoot.rotation.x = lean
    this.visualRoot.rotation.z = this.pitch
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
 * 손잡이가 어깨에서 reach만큼 떨어지도록 하는 스윕각.
 *
 * 손잡이는 노받이를 중심으로 반지름 INBOARD·cos(phi), 높이 LOCK.y+INBOARD·sin(phi)인
 * 수평 원 위를 돈다. 그 원과 어깨를 중심으로 한 반지름 reach의 구가 만나는 점을 찾는다.
 * 두 교점 중 선미(-X) 쪽을 고른다 — 팔은 언제나 어깨보다 앞(선미 쪽)으로 뻗는다.
 * 닿지 않으면 원 위에서 가장 가까운 점으로 물러난다.
 */
function solveSweep(
  shoulder: THREE.Vector3, reach: number, phi: number, side: number,
): number {
  const lockY = LOCK.y + side * LOCK_RISE
  const yh = lockY + INBOARD * Math.sin(phi)
  const ra = INBOARD * Math.cos(phi)
  // 구를 손잡이 높이에서 자른 수평 원의 반지름
  const rs = Math.sqrt(Math.max(1e-4, reach * reach - (yh - shoulder.y) ** 2))

  const cz = side * LOCK.z
  const dx = shoulder.x - LOCK.x
  const dz = shoulder.z - cz
  const d = Math.hypot(dx, dz) || 1e-4
  const a = clamp((ra * ra - rs * rs + d * d) / (2 * d), -ra, ra)
  const h = Math.sqrt(Math.max(0, ra * ra - a * a))
  const ux = dx / d, uz = dz / d

  const x1 = LOCK.x + a * ux - h * uz, z1 = cz + a * uz + h * ux
  const x2 = LOCK.x + a * ux + h * uz, z2 = cz + a * uz - h * ux
  const px = x1 < x2 ? x1 : x2
  const pz = x1 < x2 ? z1 : z2

  const theta = Math.atan2((px - LOCK.x) / ra, (-side * (pz - cz)) / ra)
  return clamp(theta, -SWEEP_LIMIT, SWEEP_LIMIT)
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
function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
