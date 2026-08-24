import * as THREE from 'three'
import { Water } from './water'
import type { Course, Landmark } from '../game/courses'

/**
 * 코스 월드 — 하늘, 조명, 물, 강둑, 랜드마크.
 *
 * 보트는 원점에 고정하고 세상이 뒤로 흐른다. 좌표가 커지지 않아
 * 긴 코스에서도 부동소수점 정밀도 문제가 없다.
 */

/** 나무 반복 간격 (m) */
const TREE_SPACING = 14
const TREE_COUNT = 26
const BANK_Z = 15

export class World {
  readonly scene = new THREE.Scene()
  readonly water: Water
  private sky: THREE.Mesh
  private sun: THREE.DirectionalLight
  private hemi: THREE.HemisphereLight
  private trees: THREE.Object3D[] = []
  private banks: THREE.Mesh[] = []
  private landmarkGroup = new THREE.Group()
  private landmarkNodes: { obj: THREE.Object3D; lm: Landmark }[] = []
  private course: Course

  constructor(course: Course) {
    this.course = course
    const p = course.venue.palette

    // ── 하늘 ────────────────────────────────────────────────
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uTop: { value: new THREE.Color(p.skyTop) },
          uBottom: { value: new THREE.Color(p.skyBottom) },
        },
        vertexShader: /* glsl */`
          varying float vY;
          void main() {
            vY = normalize(position).y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          uniform vec3 uTop; uniform vec3 uBottom;
          varying float vY;
          void main() {
            float t = smoothstep(-0.15, 0.55, vY);
            gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
          }
        `,
      }),
    )
    this.scene.add(this.sky)

    // 안개로 원경을 하늘색에 녹여 깊이를 만든다
    this.scene.fog = new THREE.Fog(new THREE.Color(p.skyBottom), 40, 260)

    // ── 조명 ────────────────────────────────────────────────
    this.hemi = new THREE.HemisphereLight(new THREE.Color(p.skyTop), new THREE.Color(p.water), 0.85)
    this.scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xffffff, 1.45)
    this.sun.position.set(-30, 22, 18)
    this.scene.add(this.sun)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25))

    // ── 물 ──────────────────────────────────────────────────
    this.water = new Water(p.water, p.waterDeep)
    this.scene.add(this.water.mesh)

    // ── 강둑 ────────────────────────────────────────────────
    const bankMat = new THREE.MeshStandardMaterial({
      color: p.land, flatShading: true, roughness: 0.9,
    })
    for (const side of [1, -1]) {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(700, 1.2, 26), bankMat)
      bank.position.set(0, 0.25, side * (BANK_Z + 13))
      this.banks.push(bank)
      this.scene.add(bank)
    }

    // ── 나무 (반복 배치) ────────────────────────────────────
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#3b2f26', flatShading: true })
    const leafMat = new THREE.MeshStandardMaterial({ color: p.land, flatShading: true, roughness: 0.95 })
    for (let i = 0; i < TREE_COUNT; i++) {
      const side = i % 2 === 0 ? 1 : -1
      const t = new THREE.Group()
      const h = 3.4 + ((i * 37) % 21) / 10
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, h * 0.45, 5), trunkMat)
      trunk.position.y = h * 0.22
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.42, 0), leafMat)
      leaves.position.y = h * 0.62
      t.add(trunk, leaves)
      t.position.set(0, 0.7, side * (BANK_Z + 2 + ((i * 53) % 70) / 10))
      this.trees.push(t)
      this.scene.add(t)
    }

    // ── 랜드마크 ────────────────────────────────────────────
    this.scene.add(this.landmarkGroup)
    this.buildLandmarks()
  }

  private buildLandmarks() {
    const p = this.course.venue.palette
    const mat = new THREE.MeshStandardMaterial({ color: p.landmark, flatShading: true, roughness: 0.8 })
    const accent = new THREE.MeshStandardMaterial({ color: '#ff9f43', flatShading: true })

    for (const lm of this.course.venue.landmarks) {
      const g = new THREE.Group()
      switch (lm.kind) {
        case 'bridge': {
          const deck = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.9, 46), mat)
          deck.position.y = 6.2
          g.add(deck)
          for (const z of [-15, 0, 15]) {
            const pier = new THREE.Mesh(new THREE.BoxGeometry(2.6, 6.2, 3.2), mat)
            pier.position.set(0, 3.1, z)
            g.add(pier)
          }
          break
        }
        case 'tower': {
          const body = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.1, 11, 8), mat)
          body.position.y = 5.5
          const roof = new THREE.Mesh(new THREE.ConeGeometry(2.5, 3.4, 8), mat)
          roof.position.y = 12.7
          g.add(body, roof)
          g.position.z = BANK_Z + 5
          break
        }
        case 'boathouse': {
          const body = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 7), mat)
          body.position.y = 2.1
          const roof = new THREE.Mesh(new THREE.ConeGeometry(6.6, 2.8, 4), mat)
          roof.position.y = 5.6
          roof.rotation.y = Math.PI / 4
          g.add(body, roof)
          g.position.z = BANK_Z + 4
          break
        }
        case 'trees': {
          const leafMat = new THREE.MeshStandardMaterial({
            color: this.course.venue.palette.land, flatShading: true,
          })
          for (let i = 0; i < 7; i++) {
            const h = 5 + ((i * 41) % 30) / 10
            const cone = new THREE.Mesh(new THREE.ConeGeometry(h * 0.34, h, 6), leafMat)
            cone.position.set(((i * 29) % 18) - 9, h / 2, BANK_Z + 3 + ((i * 17) % 60) / 10)
            g.add(cone)
          }
          break
        }
        case 'buoy': {
          for (const side of [1, -1]) {
            const b = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), accent)
            b.position.set(0, 0.2, side * 5.5)
            g.add(b)
          }
          break
        }
      }
      this.landmarkGroup.add(g)
      this.landmarkNodes.push({ obj: g, lm })
    }
  }

  /**
   * @param distance 코스 진행 거리 (m)
   * @param total    코스 전체 예상 거리 (m) — 랜드마크 배치 기준
   */
  update(timeSec: number, distance: number, total: number, cameraX: number) {
    this.water.update(timeSec, distance)
    this.sky.position.x = cameraX

    // 나무: 일정 간격으로 반복시키고 뒤로 흘린다
    const span = TREE_SPACING * (TREE_COUNT / 2)
    for (let i = 0; i < this.trees.length; i++) {
      const base = Math.floor(i / 2) * TREE_SPACING
      let x = base - (distance % span)
      if (x < -span * 0.35) x += span
      this.trees[i]!.position.x = x
    }

    // 강둑은 카메라를 따라다니게 해서 끝이 안 보이게 한다
    for (const b of this.banks) b.position.x = cameraX

    // 랜드마크: 코스상 위치 - 현재 거리
    for (const { obj, lm } of this.landmarkNodes) {
      const x = lm.at * total - distance
      obj.position.x = x
      obj.visible = x > -60 && x < 300
    }
  }

  /** 화면에 보이는 랜드마크 중 가장 가까운 것 (이름표 표시용) */
  nearestLandmark(distance: number, total: number): { name: string; dist: number } | null {
    let best: { name: string; dist: number } | null = null
    for (const { lm } of this.landmarkNodes) {
      const d = lm.at * total - distance
      if (d > -25 && d < 120) {
        if (!best || Math.abs(d) < Math.abs(best.dist)) best = { name: lm.name, dist: d }
      }
    }
    return best
  }

  dispose() {
    this.scene.traverse(o => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material
      if (Array.isArray(mat)) mat.forEach(x => x.dispose())
      else mat?.dispose?.()
    })
  }
}
