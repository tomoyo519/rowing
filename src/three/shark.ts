import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { SharkState } from '../game/modes'

/**
 * 상어 추격 모드의 상어.
 *
 * 좌표계는 보트와 같다: 진행 방향 +X, 위 +Y, 수면 y=0. 그룹 원점이 **코끝**이라
 * `SharkChase.distance`(코끝의 코스 거리)를 그대로 놓으면 된다.
 *
 * 물은 불투명하므로 보이는 건 수면 위로 나온 등·등지느러미·꼬리 윗잎과 항적뿐이다.
 * 덮칠 때는 몸이 조금 떠오르고, 물면 머리를 들며 턱을 벌린다 — 그때 눈·이빨이 드러난다.
 */
const BODY_LENGTH = 3.8
/** 몸통 중심의 높이. 가장 두꺼운 곳(반지름 0.42×1.05)의 등이 수면 위로 18cm쯤 나온다 — 멀리서도 등이 보인다 */
const BODY_Y = -0.26
/** 전체 배율. 몸길이 4.6m — 큰 백상아리. 작은 뒤 보기 창에서도 지느러미가 읽혀야 한다 */
const SHARK_SCALE = 1.2
const SKIN = '#3f4b57'
const FIN = '#323c47'

export class Shark {
  readonly group = new THREE.Group()
  /** 몸 전체 — 헤엄치며 좌우로 흔들리고, 물 때 머리를 든다 */
  private body = new THREE.Group()
  private tail = new THREE.Group()
  private jaw = new THREE.Group()
  private dorsal!: THREE.Mesh
  private wake!: THREE.Mesh
  private spray!: THREE.Mesh
  private clock = 0
  /** 물고 난 뒤 흐른 시간 (초). 음수면 물지 않았다 */
  private biteT = -1
  /** 덮치기 연출 0~1 — 상태 전환에서 한 번에 튀지 않게 평활 */
  private surge = 0

  constructor() {
    this.group.add(this.body)
    this.group.scale.setScalar(SHARK_SCALE)
    this.build()
  }

  private mat(color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...extra })
  }

  private build() {
    const skin = this.mat(SKIN)
    const fin = this.mat(FIN, { side: THREE.DoubleSide })

    // ── 몸통: 코끝에서 꼬리까지의 회전체 ─────────────────────
    const profile: [number, number][] = [
      [0.02, 0], [0.22, 0.35], [0.36, 0.8], [0.42, 1.3], [0.40, 1.9],
      [0.32, 2.5], [0.20, 3.1], [0.11, 3.5], [0.07, BODY_LENGTH],
    ]
    const points = profile.map(([r, s]) => new THREE.Vector2(r, -s))
    const bodyGeometry = new THREE.LatheGeometry(points, 18)
    bodyGeometry.rotateZ(-Math.PI / 2)   // 회전축 Y → X: 코끝이 원점, 꼬리가 -X
    bodyGeometry.scale(1, 1.05, 1)
    bodyGeometry.computeVertexNormals()
    const body = new THREE.Mesh(bodyGeometry, skin)
    body.castShadow = true
    body.position.y = BODY_Y
    this.body.add(body)

    // ── 등지느러미: 앞전은 뒤로 눕고 뒷전은 오목한 낫 모양 ───
    const dorsalShape = new THREE.Shape()
    dorsalShape.moveTo(0.32, 0)
    dorsalShape.quadraticCurveTo(0.12, 0.30, -0.06, 0.64)
    dorsalShape.quadraticCurveTo(-0.16, 0.30, -0.44, 0)
    dorsalShape.closePath()
    // 두께 8cm: 정면·뒤에서 날로 보여도 선 하나가 아니라 지느러미로 읽힌다
    const dorsalGeometry = new THREE.ExtrudeGeometry(dorsalShape, { depth: 0.08, bevelEnabled: false })
    dorsalGeometry.translate(0, 0, -0.04)
    this.dorsal = new THREE.Mesh(dorsalGeometry, fin)
    this.dorsal.castShadow = true
    // 가장 두꺼운 자리의 등 위에 살짝 박아 넣는다
    this.dorsal.position.set(-1.3, BODY_Y + 0.42 * 1.05 - 0.04, 0)
    this.body.add(this.dorsal)

    // ── 꼬리지느러미: 윗잎이 큰 초승달. 꼬리 뿌리에서 좌우로 젓는다 ──
    const tailShape = new THREE.Shape()
    tailShape.moveTo(0.12, 0.07)
    tailShape.quadraticCurveTo(-0.10, 0.40, -0.42, 0.70)
    tailShape.quadraticCurveTo(-0.22, 0.30, -0.14, 0.02)
    tailShape.quadraticCurveTo(-0.22, -0.22, -0.34, -0.44)
    tailShape.quadraticCurveTo(-0.08, -0.26, 0.12, -0.07)
    tailShape.closePath()
    const tailGeometry = new THREE.ExtrudeGeometry(tailShape, { depth: 0.04, bevelEnabled: false })
    tailGeometry.translate(0, 0, -0.02)
    const tail = new THREE.Mesh(tailGeometry, fin)
    tail.castShadow = true
    tail.position.set(-(BODY_LENGTH - 3.4), 0, 0)
    this.tail.position.set(-3.4, BODY_Y, 0)
    this.tail.add(tail)
    this.body.add(this.tail)

    // ── 가슴지느러미: 물속이라 거의 안 보이지만 들 때 드러난다 ──
    const pecShape = new THREE.Shape()
    pecShape.moveTo(0.18, 0)
    pecShape.lineTo(-0.30, 0.55)
    pecShape.lineTo(-0.34, 0)
    pecShape.closePath()
    const pecGeometry = new THREE.ExtrudeGeometry(pecShape, { depth: 0.03, bevelEnabled: false })
    for (const side of [1, -1]) {
      const pec = new THREE.Mesh(pecGeometry, fin)
      pec.position.set(-1.05, BODY_Y - 0.16, side * 0.30)
      // 지느러미 면을 옆으로 눕히고 아래·바깥으로 펼친다
      pec.rotation.set(side * Math.PI / 2 + side * 0.35, 0, 0)
      this.body.add(pec)
    }

    // ── 입: 아래턱·입속·이빨. 물 때 턱이 내려가며 벌어진다 ───
    const jawMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin)
    jawMesh.scale.set(0.36, 0.085, 0.21)
    jawMesh.position.set(0.30, -0.02, 0)
    this.jaw.add(jawMesh)
    this.jaw.position.set(-0.58, BODY_Y - 0.16, 0)
    this.body.add(this.jaw)
    const mouth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8), this.mat('#6b1520', { roughness: 0.8 }),
    )
    mouth.scale.set(0.30, 0.10, 0.19)
    mouth.position.set(-0.30, BODY_Y - 0.13, 0)
    this.body.add(mouth)
    const toothGeometries: THREE.BufferGeometry[] = []
    for (let i = 0; i < 9; i++) {
      const t = i / 8
      const angle = (t - 0.5) * Math.PI * 0.9
      const g = new THREE.ConeGeometry(0.018, 0.055, 5)
      g.rotateX(Math.PI)   // 끝이 아래를 향한다
      g.translate(-0.30 + Math.cos(angle) * 0.30, BODY_Y - 0.10, Math.sin(angle) * 0.19)
      toothGeometries.push(g)
    }
    const teeth = new THREE.Mesh(mergeGeometries(toothGeometries), this.mat('#f4f1e8', { roughness: 0.35 }))
    this.body.add(teeth)

    // ── 눈 ───────────────────────────────────────────────────
    const eyeGeometry = new THREE.SphereGeometry(0.035, 10, 8)
    const eyeMaterial = this.mat('#0b0d10', { roughness: 0.25 })
    for (const side of [1, -1]) {
      const eye = new THREE.Mesh(eyeGeometry, eyeMaterial)
      eye.position.set(-0.55, BODY_Y + 0.11, side * 0.27)
      this.body.add(eye)
    }

    // ── 항적: 등지느러미 뒤로 벌어지는 V ────────────────────
    const wakeGeometry = new THREE.BufferGeometry()
    wakeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1.0, 0.105, 0, -5.2, 0.105, 0.62, -5.2, 0.105, -0.62,
    ], 3))
    this.wake = new THREE.Mesh(
      wakeGeometry,
      new THREE.MeshBasicMaterial({
        color: '#d9f1f7', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }),
    )
    this.wake.renderOrder = 1
    this.group.add(this.wake)
    // 덮칠 때 코앞에서 튀는 물보라
    this.spray = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 7),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }),
    )
    this.spray.scale.set(1, 0.3, 1.2)
    this.spray.position.set(0.1, 0.08, 0)
    this.group.add(this.spray)
  }

  /** 물었다 — 머리를 들고 턱을 벌리는 연출을 시작한다 */
  bite() { this.biteT = 0 }

  /**
   * @param dt     프레임 간격 (초)
   * @param speed  상어 속도 (m/s) — 꼬리질 빠르기와 항적
   * @param state  순항·경고·덮치기·물러남
   */
  update(dt: number, speed: number, state: SharkState) {
    const dtc = Math.min(dt, 0.05)
    this.clock += dtc
    const moving = Math.min(1, Math.max(0, speed) / 3)
    const surging = state === 'surge' || state === 'warn'
    this.surge += ((surging ? 1 : 0) - this.surge) * (1 - Math.exp(-dtc / 0.5))

    // 꼬리는 빠를수록 빨리, 덮칠 때 더 세게 젓는다. 서 있을 땐 천천히 흔들 뿐
    const beatHz = 0.5 + moving * 1.1 + this.surge * 0.7
    const beat = Math.sin(this.clock * beatHz * Math.PI * 2)
    this.tail.rotation.y = beat * (0.12 + moving * 0.22 + this.surge * 0.1)
    // 몸은 꼬리에 반 박자 늦게 작게 따라 흔들린다
    const sway = Math.sin(this.clock * beatHz * Math.PI * 2 - 0.9)
    this.body.rotation.y = sway * (0.02 + moving * 0.03)

    // 물기: 1초 동안 머리를 들었다가 내린다
    let lunge = 0
    if (this.biteT >= 0) {
      this.biteT += dtc
      if (this.biteT >= 1.0) this.biteT = -1
      else lunge = Math.sin(this.biteT * Math.PI)
    }
    const rise = this.surge * 0.07 + lunge * 0.42
    this.body.position.y = rise + Math.sin(this.clock * 1.3) * 0.015 * (1 - lunge)
    this.body.rotation.z = lunge * 0.38 + this.surge * 0.03
    this.body.rotation.x = sway * 0.02
    this.jaw.rotation.z = -lunge * 0.55
    // 등지느러미는 덮칠 때 앞으로 조금 기운다 — 속도감
    this.dorsal.rotation.z = this.surge * 0.08

    const wakeMaterial = this.wake.material as THREE.MeshBasicMaterial
    wakeMaterial.opacity = moving * (0.10 + this.surge * 0.08)
    this.wake.scale.x = 0.6 + moving * 0.6 + this.surge * 0.3
    const sprayMaterial = this.spray.material as THREE.MeshBasicMaterial
    sprayMaterial.opacity = Math.max(this.surge * moving * 0.22, lunge * 0.38)
    this.spray.scale.set(1 + lunge * 0.6, 0.3 + lunge * 0.4, 1.2 + lunge * 0.5)
  }

  dispose() {
    this.group.traverse(obj => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach(m => m.dispose())
      else material?.dispose()
    })
  }
}
