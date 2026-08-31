import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Water } from './water'
import {
  createWeatherAppearance,
  resolveWeatherAppearance,
  WeatherSystem,
  type WeatherBasePalette,
  type WeatherBlend,
} from './weather'
import {
  createCoursePath,
  localPathPoint,
  offsetPathPoint,
  PLAYER_LANE_OFFSET,
  type CoursePath,
} from '../game/coursePath'
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
const SPECTATOR_COUNT = 6
const DUCK_COUNT = 4
const CLOUD_COUNT = 7
const PROP_COUNT = 6
const BANK_OUTER_Z = BANK_Z + 26
const BANK_STEP = 8

type Side = 1 | -1
export type BankPropKind = 'cottage' | 'manor' | 'deer' | 'sheep' | 'heron'

export interface SceneryPlacement {
  baseX: number
  z: number
  scale: number
  phase: number
}

export interface SceneryLayout {
  spectators: (SceneryPlacement & { side: Side; colorIndex: number })[]
  ducks: SceneryPlacement[]
  clouds: SceneryPlacement[]
  props: (SceneryPlacement & { side: Side; kind: BankPropKind })[]
}

interface LoopObject {
  obj: THREE.Object3D
  baseX: number
  baseY: number
  baseZ: number
  span: number
  phase: number
  baseYaw: number
  animated?: boolean
}

interface LandmarkNode {
  obj: THREE.Object3D
  lm: Landmark
  lateral: number
  baseYaw: number
}

export interface AmbientPresence {
  duck: { distance: number; pan: number }
  spectator: { distance: number; pan: number }
}

/** 반복 배경 오브젝트를 [minX, minX + span) 안으로 감싼다. */
export function wrappedLoopX(baseX: number, distance: number, span: number, minX: number) {
  const offset = ((baseX - distance - minX) % span + span) % span
  return minX + offset
}

/** 한쪽 강둑의 잔디 윗면과 물가 절벽을 하나의 저비용 리본으로 만든다. */
function createBankRibbon(
  path: CoursePath,
  side: Side,
  maxStation: number,
  material: THREE.Material,
) {
  const start = -500
  const count = Math.ceil((maxStation - start) / BANK_STEP) + 1
  const positions = new Float32Array(count * 3 * 3)
  const indices: number[] = []

  for (let i = 0; i < count; i++) {
    const station = start + i * BANK_STEP
    const inner = offsetPathPoint(path, station, side * BANK_Z)
    const outer = offsetPathPoint(path, station, side * BANK_OUTER_Z)
    const offset = i * 9
    positions.set([inner.x, 0.85, inner.z], offset)
    positions.set([outer.x, 0.85, outer.z], offset + 3)
    positions.set([inner.x, -0.35, inner.z], offset + 6)

    if (i === count - 1) continue
    const a = i * 3
    const b = a + 1
    const e = a + 2
    const c = a + 3
    const d = a + 4
    const f = a + 5
    indices.push(a, b, c, b, d, c)
    indices.push(a, c, e, c, f, e)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return new THREE.Mesh(geometry, material)
}

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: string) {
  let state = hashString(seed)
  return () => {
    state += 0x6d2b79f5
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

/** 코스별로 같지만 자연스럽게 흩어진 저폴리 배경 배치. */
export function createSceneryLayout(courseId: string): SceneryLayout {
  const random = seededRandom(courseId)
  const spectators: SceneryLayout['spectators'] = []
  const ducks: SceneryLayout['ducks'] = []
  const clouds: SceneryLayout['clouds'] = []
  const props: SceneryLayout['props'] = []

  for (let i = 0; i < SPECTATOR_COUNT; i++) {
    const side: Side = i % 2 === 0 ? 1 : -1
    spectators.push({
      baseX: Math.floor(i / 2) * 34 + random() * 10,
      z: side * (BANK_Z + 1.2 + random() * 1.5),
      side,
      scale: 0.88 + random() * 0.22,
      phase: random() * Math.PI * 2,
      colorIndex: i < 4 ? i : Math.floor(random() * 4),
    })
  }

  for (let i = 0; i < DUCK_COUNT; i++) {
    const side: Side = i % 2 === 0 ? 1 : -1
    ducks.push({
      baseX: 12 + i * 42 + random() * 14,
      z: side * (10.6 + random() * 2.0),
      scale: 0.82 + random() * 0.25,
      phase: random() * Math.PI * 2,
    })
  }

  for (let i = 0; i < CLOUD_COUNT; i++) {
    clouds.push({
      baseX: 18 + i * 62 + random() * 24,
      z: (random() - 0.5) * 90,
      scale: 1.8 + random() * 2.6,
      phase: random() * Math.PI * 2,
    })
  }

  const guaranteed: BankPropKind[] = ['cottage', 'manor', 'deer', 'sheep', 'heron']
  for (let i = 0; i < PROP_COUNT; i++) {
    const side: Side = i % 2 === 0 ? 1 : -1
    const kind = guaranteed[i] ?? guaranteed[Math.floor(random() * guaranteed.length)]!
    const shoreOffset = kind === 'heron'
      ? 1.6
      : kind === 'manor'
        ? 8 + random() * 4
        : 4.5 + random() * 5
    const scale = kind === 'manor'
      ? 0.94 + random() * 0.24
      : 0.82 + random() * 0.32
    props.push({
      baseX: 18 + Math.floor(i / 2) * 70 + random() * 22,
      z: side * (BANK_Z + shoreOffset),
      side,
      kind,
      scale,
      phase: random() * Math.PI * 2,
    })
  }

  return { spectators, ducks, clouds, props }
}

const UP = new THREE.Vector3(0, 1, 0)

function cylinderBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
) {
  const direction = to.clone().sub(from)
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 6),
    material,
  )
  mesh.position.copy(from).add(to).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize())
  return mesh
}

function createSpectator(
  jersey: THREE.Material,
  skin: THREE.Material,
  trousers: THREE.Material,
) {
  const group = new THREE.Group()
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 0.68, 6), jersey)
  torso.position.y = 1.05
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), skin)
  head.position.y = 1.58
  const leftArm = cylinderBetween(
    new THREE.Vector3(-0.10, 1.31, 0), new THREE.Vector3(-0.48, 1.90, 0), 0.052, skin,
  )
  const rightArm = cylinderBetween(
    new THREE.Vector3(0.10, 1.31, 0), new THREE.Vector3(0.48, 1.90, 0), 0.052, skin,
  )
  const leftLeg = cylinderBetween(
    new THREE.Vector3(-0.08, 0.78, 0), new THREE.Vector3(-0.11, 0.18, 0), 0.065, trousers,
  )
  const rightLeg = cylinderBetween(
    new THREE.Vector3(0.08, 0.78, 0), new THREE.Vector3(0.11, 0.18, 0), 0.065, trousers,
  )
  group.add(torso, head, leftArm, rightArm, leftLeg, rightLeg)
  return group
}

function createDuck(
  bodyMaterial: THREE.Material,
  headMaterial: THREE.Material,
  beakMaterial: THREE.Material,
) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 7), bodyMaterial)
  body.scale.set(1.35, 0.62, 0.78)
  const wing = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), headMaterial)
  wing.scale.set(1.15, 0.32, 0.72)
  wing.position.set(-0.05, 0.15, 0)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 9, 7), headMaterial)
  head.position.set(0.38, 0.22, 0)
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.25, 5), beakMaterial)
  beak.rotation.z = -Math.PI / 2
  beak.position.set(0.58, 0.19, 0)
  group.add(body, wing, head, beak)
  return group
}

function createCloud(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  phase: number,
) {
  const parts: [number, number, number, number][] = [
    [-0.92, -0.04, 0.02, 0.48], [-0.48, 0.12, -0.04, 0.66],
    [0, 0.23, 0.02, 0.82], [0.53, 0.12, -0.02, 0.70],
    [1.02, -0.02, 0.04, 0.48], [-0.28, -0.15, 0.05, 0.62],
    [0.35, -0.14, 0.06, 0.66],
  ]
  const cloud = new THREE.InstancedMesh(geometry, material, parts.length)
  const mirror = Math.sin(phase) < 0 ? -1 : 1
  const stretch = 0.92 + Math.abs(Math.cos(phase)) * 0.22
  const matrix = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const position = new THREE.Vector3()
  const scaleVector = new THREE.Vector3()
  for (let i = 0; i < parts.length; i++) {
    const [x, y, z, scale] = parts[i]!
    position.set(x * mirror * stretch, y, z + Math.sin(phase + i) * 0.045)
    scaleVector.set(scale * (1.35 + stretch * 0.2), scale, scale * 0.92)
    matrix.compose(position, quaternion, scaleVector)
    cloud.setMatrixAt(i, matrix)
  }
  cloud.instanceMatrix.needsUpdate = true
  cloud.computeBoundingSphere()
  return cloud
}

function createCottage(
  wallMaterial: THREE.Material,
  roofMaterial: THREE.Material,
  darkMaterial: THREE.Material,
) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 2.7, 3.2), wallMaterial)
  body.position.y = 1.35
  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.0, 1.8, 4), roofMaterial)
  roof.position.y = 3.58
  roof.rotation.y = Math.PI / 4
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.45, 0.08), darkMaterial)
  door.position.set(0, 0.73, -1.63)
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.25, 0.42), darkMaterial)
  chimney.position.set(0.9, 3.65, 0.35)
  group.add(body, roof, door, chimney)
  return group
}

/** 강변에서 확실히 실루엣이 읽히는 큰 저택. 같은 재질 부품은 합쳐 draw call을 줄인다. */
function createManor(
  wallMaterial: THREE.Material,
  roofMaterial: THREE.Material,
  darkMaterial: THREE.Material,
  glassMaterial: THREE.Material,
) {
  const group = new THREE.Group()
  const wallParts: THREE.BufferGeometry[] = []
  const addWall = (geometry: THREE.BufferGeometry, x: number, y: number, z: number) => {
    geometry.translate(x, y, z)
    wallParts.push(geometry)
  }
  addWall(new THREE.BoxGeometry(10.5, 5.4, 6.2), 0, 2.7, 0)
  addWall(new THREE.BoxGeometry(4.0, 4.3, 5.2), -6.5, 2.15, 0.25)
  addWall(new THREE.BoxGeometry(4.0, 4.3, 5.2), 6.5, 2.15, 0.25)
  const walls = mergeGeometries(wallParts, false)
  if (walls) group.add(new THREE.Mesh(walls, wallMaterial))
  for (const part of wallParts) part.dispose()

  const roofParts: THREE.BufferGeometry[] = []
  const addRoof = (radius: number, height: number, x: number, y: number) => {
    const geometry = new THREE.ConeGeometry(radius, height, 4)
    geometry.rotateY(Math.PI / 4)
    geometry.translate(x, y, 0)
    roofParts.push(geometry)
  }
  addRoof(7.1, 3.0, 0, 6.75)
  addRoof(3.8, 2.5, -6.5, 5.55)
  addRoof(3.8, 2.5, 6.5, 5.55)
  const roofs = mergeGeometries(roofParts, false)
  if (roofs) group.add(new THREE.Mesh(roofs, roofMaterial))
  for (const part of roofParts) part.dispose()

  const door = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.6, 0.14), darkMaterial)
  door.position.set(0, 1.3, -3.17)
  group.add(door)

  const windowGeometry = new THREE.BoxGeometry(0.82, 0.95, 0.12)
  const windows = new THREE.InstancedMesh(windowGeometry, glassMaterial, 11)
  const matrix = new THREE.Matrix4()
  const positions: [number, number][] = [
    [-4.0, 1.55], [-2.2, 1.55], [2.2, 1.55], [4.0, 1.55],
    [-4.0, 3.75], [-2.0, 3.75], [0, 3.75], [2.0, 3.75], [4.0, 3.75],
    [-6.5, 2.25], [6.5, 2.25],
  ]
  positions.forEach(([x, y], index) => {
    windows.setMatrixAt(index, matrix.makeTranslation(x, y, -3.19))
  })
  windows.instanceMatrix.needsUpdate = true
  windows.computeBoundingSphere()
  group.add(windows)
  return group
}

function createFourLeggedAnimal(
  bodyMaterial: THREE.Material,
  darkMaterial: THREE.Material,
  woolly: boolean,
) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(woolly ? 0.72 : 0.58, 1), bodyMaterial)
  body.scale.set(woolly ? 1.25 : 1.45, woolly ? 0.82 : 0.72, 0.72)
  body.position.y = 0.95
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(woolly ? 0.27 : 0.25, 1), darkMaterial)
  head.position.set(0.72, 1.25, 0)
  group.add(body, head)
  for (const x of [-0.42, 0.42]) {
    for (const z of [-0.24, 0.24]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.62, 5), darkMaterial)
      leg.position.set(x, 0.42, z)
      group.add(leg)
    }
  }
  if (!woolly) {
    for (const z of [-0.12, 0.12]) {
      const antler = cylinderBetween(
        new THREE.Vector3(0.76, 1.43, z), new THREE.Vector3(0.92, 1.73, z), 0.025, darkMaterial,
      )
      group.add(antler)
    }
  }
  return group
}

function createHeron(
  featherMaterial: THREE.Material,
  darkMaterial: THREE.Material,
  beakMaterial: THREE.Material,
) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.30, 8, 6), featherMaterial)
  body.scale.set(1.25, 0.78, 0.72)
  body.position.y = 0.92
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.78, 6), featherMaterial)
  neck.position.set(0.24, 1.38, 0)
  neck.rotation.z = -0.22
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), featherMaterial)
  head.position.set(0.34, 1.79, 0)
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.36, 5), beakMaterial)
  beak.position.set(0.55, 1.78, 0)
  beak.rotation.z = -Math.PI / 2
  group.add(body, neck, head, beak)
  for (const z of [-0.08, 0.08]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.75, 5), darkMaterial)
    leg.position.set(0, 0.38, z)
    group.add(leg)
  }
  return group
}

export class World {
  readonly scene = new THREE.Scene()
  readonly water: Water
  readonly weather: WeatherSystem
  private sky: THREE.Mesh
  private sun: THREE.DirectionalLight
  private hemi: THREE.HemisphereLight
  private ambient: THREE.AmbientLight
  private fog: THREE.Fog
  private bankMaterial: THREE.MeshStandardMaterial
  private leafMaterial: THREE.MeshStandardMaterial
  private cloudMaterial!: THREE.MeshBasicMaterial
  private skyUniforms = {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
  }
  private baseWeatherPalette: WeatherBasePalette
  private weatherAppearance = createWeatherAppearance()
  private landmarkLeafMaterials: THREE.MeshStandardMaterial[] = []
  private spectators: LoopObject[] = []
  private ducks: LoopObject[] = []
  private clouds: LoopObject[] = []
  private bankProps: LoopObject[] = []
  private landmarkGroup = new THREE.Group()
  private landmarkNodes: LandmarkNode[] = []
  /** 매 프레임 회전시킬 부품 (풍차 날개 등) */
  private spinners: THREE.Object3D[] = []
  private course: Course
  private path: CoursePath
  private courseRoot = new THREE.Group()
  private treeNodes: LoopObject[] = []
  private readonly nearby: AmbientPresence = {
    duck: { distance: Number.POSITIVE_INFINITY, pan: 0 },
    spectator: { distance: Number.POSITIVE_INFINITY, pan: 0 },
  }

  constructor(course: Course, weatherSeed = `${course.id}:weather`) {
    this.course = course
    this.path = createCoursePath(course.id)
    this.scene.add(this.courseRoot)
    const p = course.venue.palette
    this.baseWeatherPalette = {
      skyTop: new THREE.Color(p.skyTop),
      skyBottom: new THREE.Color(p.skyBottom),
      water: new THREE.Color(p.water),
      waterDeep: new THREE.Color(p.waterDeep),
      land: new THREE.Color(p.land),
    }
    this.skyUniforms.uTop.value.copy(this.baseWeatherPalette.skyTop)
    this.skyUniforms.uBottom.value.copy(this.baseWeatherPalette.skyBottom)

    // ── 하늘 ────────────────────────────────────────────────
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: this.skyUniforms,
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
    this.fog = new THREE.Fog(new THREE.Color(p.skyBottom), 40, 260)
    this.scene.fog = this.fog

    // ── 조명 ────────────────────────────────────────────────
    this.hemi = new THREE.HemisphereLight(new THREE.Color(p.skyTop), new THREE.Color(p.water), 0.85)
    this.scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xffffff, 1.45)
    this.sun.position.set(-30, 22, -8)
    this.scene.add(this.sun)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25)
    this.scene.add(this.ambient)

    // ── 물 ──────────────────────────────────────────────────
    this.water = new Water(p.water, p.waterDeep)
    this.scene.add(this.water.mesh)

    // ── 강둑 ────────────────────────────────────────────────
    this.bankMaterial = new THREE.MeshStandardMaterial({
      color: p.land, flatShading: true, roughness: 0.9, side: THREE.DoubleSide,
    })
    const maxStation = course.durationSec * 8 + 1_000
    for (const side of [1, -1] as const) {
      const bank = createBankRibbon(this.path, side, maxStation, this.bankMaterial)
      this.courseRoot.add(bank)
    }

    // ── 나무 (반복 배치) ────────────────────────────────────
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#3b2f26', flatShading: true })
    this.leafMaterial = new THREE.MeshStandardMaterial({
      color: p.land, flatShading: true, roughness: 0.95,
    })
    for (let i = 0; i < TREE_COUNT; i++) {
      const side = i % 2 === 0 ? 1 : -1
      const t = new THREE.Group()
      const h = 3.4 + ((i * 37) % 21) / 10
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, h * 0.45, 5), trunkMat)
      trunk.position.y = h * 0.22
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.42, 0), this.leafMaterial)
      leaves.position.y = h * 0.62
      t.add(trunk, leaves)
      const lateral = side * (BANK_Z + 2 + ((i * 53) % 70) / 10)
      t.position.set(0, 0.7, lateral)
      this.treeNodes.push({
        obj: t,
        baseX: Math.floor(i / 2) * TREE_SPACING,
        baseY: 0.7,
        baseZ: lateral,
        baseYaw: 0,
        span: TREE_SPACING * (TREE_COUNT / 2),
        phase: i * 0.73,
      })
      this.courseRoot.add(t)
    }

    // ── 살아 있는 강변 풍경 ────────────────────────────────
    this.buildScenery()

    // ── 랜드마크 ────────────────────────────────────────────
    this.courseRoot.add(this.landmarkGroup)
    this.buildLandmarks()

    // ── 날씨 ────────────────────────────────────────────────
    this.weather = new WeatherSystem(weatherSeed, course.durationSec)
    this.scene.add(this.weather.root)
    this.applyWeather(this.weather.state)
  }

  private buildScenery() {
    const layout = createSceneryLayout(this.course.id)
    const p = this.course.venue.palette
    const standard = (color: THREE.ColorRepresentation, roughness = 0.82) =>
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness })

    const skin = standard('#e8b48c')
    const trousers = standard('#263747')
    const jersey = ['#ff5a3c', '#ffd166', '#35c2a5', '#63a4ff'].map(c => standard(c))
    const spectatorSpan = Math.ceil(SPECTATOR_COUNT / 2) * 34
    for (const item of layout.spectators) {
      const person = createSpectator(jersey[item.colorIndex]!, skin, trousers)
      person.position.set(0, 0.85, item.z)
      person.scale.setScalar(item.scale)
      person.rotation.y = item.side > 0 ? 0 : Math.PI
      this.courseRoot.add(person)
      this.spectators.push({
        obj: person, baseX: item.baseX, baseY: 0.85, baseZ: item.z,
        baseYaw: person.rotation.y,
        span: spectatorSpan, phase: item.phase, animated: true,
      })
    }

    const duckBody = standard('#7c6547', 0.72)
    const duckHead = standard('#315f4b', 0.7)
    const duckBeak = standard('#f2a541', 0.65)
    const duckSpan = DUCK_COUNT * 46
    for (const item of layout.ducks) {
      const duck = createDuck(duckBody, duckHead, duckBeak)
      duck.position.set(0, 0.15, item.z)
      duck.scale.setScalar(item.scale)
      duck.rotation.y = item.phase > Math.PI ? 0 : Math.PI
      this.courseRoot.add(duck)
      this.ducks.push({
        obj: duck, baseX: item.baseX, baseY: 0.15, baseZ: item.z,
        baseYaw: duck.rotation.y,
        span: duckSpan, phase: item.phase, animated: true,
      })
    }

    this.cloudMaterial = new THREE.MeshBasicMaterial({
      color: '#f6fbff', transparent: true, opacity: 0.48, depthWrite: false,
    })
    const cloudPuffGeometry = new THREE.SphereGeometry(0.68, 9, 6)
    const cloudSpan = CLOUD_COUNT * 70
    layout.clouds.forEach((item, index) => {
      const cloud = createCloud(cloudPuffGeometry, this.cloudMaterial, item.phase)
      const y = 20 + (index % 4) * 3.6 + item.scale
      cloud.position.set(0, y, item.z)
      cloud.scale.setScalar(item.scale)
      cloud.rotation.y = Math.sin(item.phase) * 0.12
      cloud.name = 'scenery:cloud'
      this.scene.add(cloud)
      this.clouds.push({
        obj: cloud, baseX: item.baseX, baseY: y, baseZ: item.z,
        baseYaw: 0, span: cloudSpan, phase: item.phase,
      })
    })

    const cottageWall = standard(p.landmark)
    const cottageRoof = standard('#8f4f3f')
    const dark = standard('#3c3431')
    const glass = standard('#31566d', 0.35)
    const deer = standard('#8b6242')
    const sheep = standard('#d8d7c8')
    const heron = standard('#9eabb4')
    const beak = standard('#d6a33d')
    const propSpan = Math.ceil(PROP_COUNT / 2) * 80
    for (const [index, item] of layout.props.entries()) {
      let prop: THREE.Object3D
      switch (item.kind) {
        case 'cottage':
          prop = createCottage(cottageWall, cottageRoof, dark)
          prop.rotation.y = item.side > 0 ? 0 : Math.PI
          break
        case 'manor':
          prop = createManor(cottageWall, cottageRoof, dark, glass)
          prop.rotation.y = item.side > 0 ? 0 : Math.PI
          break
        case 'deer':
          prop = createFourLeggedAnimal(deer, dark, false)
          prop.rotation.y = item.phase > Math.PI ? 0 : Math.PI
          break
        case 'sheep':
          prop = createFourLeggedAnimal(sheep, dark, true)
          prop.rotation.y = item.phase > Math.PI ? 0 : Math.PI
          break
        case 'heron':
          prop = createHeron(heron, dark, beak)
          prop.rotation.y = item.phase > Math.PI ? 0 : Math.PI
          break
      }
      prop.name = `scenery:${item.kind}`
      prop.position.set(0, 0.85, item.z)
      prop.scale.setScalar(item.scale)
      this.courseRoot.add(prop)
      this.bankProps.push({
        obj: prop, baseX: item.baseX, baseY: 0.85, baseZ: item.z,
        baseYaw: prop.rotation.y,
        // 각 종류의 반복 주기를 다르게 두어 전체 풍경이 같은 조합으로 되풀이되지 않게 한다.
        span: propSpan + index * 37,
        phase: item.phase,
        animated: item.kind !== 'cottage' && item.kind !== 'manor',
      })
    }
  }

  /** 비·눈·바람 입자만 카메라 기준 볼륨에 붙인다. */
  attachWeatherToCamera(camera: THREE.PerspectiveCamera) {
    if (camera.parent !== this.scene) this.scene.add(camera)
    camera.add(this.weather.precipitationRoot)
  }

  private applyWeather(weather: WeatherBlend) {
    const appearance = resolveWeatherAppearance(
      this.baseWeatherPalette, weather, this.weatherAppearance,
    )
    this.skyUniforms.uTop.value.copy(appearance.skyTop)
    this.skyUniforms.uBottom.value.copy(appearance.skyBottom)
    this.fog.color.copy(appearance.skyBottom)
    this.fog.near = appearance.fogNear
    this.fog.far = appearance.fogFar
    this.sun.intensity = appearance.sunIntensity
    this.hemi.intensity = appearance.hemiIntensity
    this.hemi.color.copy(appearance.skyTop)
    this.hemi.groundColor.copy(appearance.water)
    this.ambient.intensity = appearance.ambientIntensity
    this.cloudMaterial.color.copy(appearance.cloud)
    this.cloudMaterial.opacity = appearance.cloudOpacity
    this.bankMaterial.color.copy(appearance.land)
    this.leafMaterial.color.copy(appearance.land)
    for (const material of this.landmarkLeafMaterials) material.color.copy(appearance.land)
    this.water.setPalette(appearance.water, appearance.waterDeep)
    this.water.setWeather(weather.windStrength, weather.base.rain)
  }

  private buildLandmarks() {
    const p = this.course.venue.palette
    const mat = new THREE.MeshStandardMaterial({ color: p.landmark, flatShading: true, roughness: 0.8 })
    const accent = new THREE.MeshStandardMaterial({ color: '#ff9f43', flatShading: true })
    const gateMat = new THREE.MeshStandardMaterial({ color: '#3b2f26', flatShading: true, roughness: 0.9 })
    const sailMat = new THREE.MeshStandardMaterial({ color: '#e8e2d4', flatShading: true, roughness: 0.85 })
    const windowMat = new THREE.MeshStandardMaterial({ color: '#294c62', roughness: 0.28 })

    for (const lm of this.course.venue.landmarks) {
      const g = new THREE.Group()
      switch (lm.kind) {
        case 'bridge': {
          // 판자 위에 기둥 세 개가 아니라 진짜 아치를 뚫는다.
          // 강을 가로지르는 방향(Z)으로 실루엣을 만들고 다리 폭(X)으로 밀어낸다.
          const SPAN = 54, DECK_Y = 10.8, ARCH_BASE = 1.2, WIDTH = 4.0
          const shape = new THREE.Shape()
          shape.moveTo(-SPAN / 2, 0)
          shape.lineTo(SPAN / 2, 0)
          shape.lineTo(SPAN / 2, DECK_Y)
          shape.lineTo(-SPAN / 2, DECK_Y)
          shape.closePath()
          // 중앙 아치는 가장 바깥 고스트 레인의 노 끝까지 통과하도록 넓고 완만하게 만든다.
          for (const [cz, halfWidth, height] of [
            [-19, 5.1, 5.1], [0, 12.75, 8.5], [19, 5.1, 5.1],
          ] as const) {
            const hole = new THREE.Path()
            hole.moveTo(cz - halfWidth, 0)
            hole.lineTo(cz - halfWidth, ARCH_BASE)
            hole.absellipse(cz, ARCH_BASE, halfWidth, height, Math.PI, 0, true)
            hole.lineTo(cz + halfWidth, 0)
            hole.closePath()
            shape.holes.push(hole)
          }
          const body = new THREE.ExtrudeGeometry(shape, { depth: WIDTH, bevelEnabled: false })
          body.rotateY(Math.PI / 2)      // 실루엣을 Z축(강을 가로지르는 방향)으로 세운다
          body.translate(-WIDTH / 2, 0, 0)
          const bodyPart = body.index ? body.toNonIndexed() : body
          if (bodyPart !== body) body.dispose()
          const bridgeParts: THREE.BufferGeometry[] = [bodyPart]

          // 난간
          for (const x of [-WIDTH / 2 + 0.25, WIDTH / 2 - 0.25]) {
            const rail = new THREE.BoxGeometry(0.5, 1.1, SPAN).toNonIndexed()
            rail.translate(x, DECK_Y + 0.55, 0)
            bridgeParts.push(rail)
          }
          const bridge = mergeGeometries(bridgeParts, false)
          if (bridge) g.add(new THREE.Mesh(bridge, mat))
          for (const part of bridgeParts) part.dispose()
          break
        }

        case 'castle': {
          /*
           * 성은 부품이 많다(총안만 50개 넘음). 그대로 두면 draw call 예산을 깬다.
           * 같은 재질을 쓰는 구조물은 지오메트리를 하나로 합쳐 메시 1개로 만든다.
           * 성문만 색이 달라 따로 둔다.
           */
          const parts: THREE.BufferGeometry[] = []
          const put = (
            geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0,
          ) => {
            if (ry) geo.rotateY(ry)
            geo.translate(x, y, z)
            parts.push(geo)
          }

          put(new THREE.CylinderGeometry(17, 21, 3.2, 9), 0, -0.4, 0)          // 흙둔덕
          put(new THREE.BoxGeometry(9, 15, 9), 0, 7.5, 0)                       // 본성

          for (const [tx, tz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]] as const) {
            put(new THREE.CylinderGeometry(2.0, 2.3, 11, 7), tx, 5.5, tz)       // 망루
            put(new THREE.ConeGeometry(2.8, 4.2, 7), tx, 13.1, tz)              // 첨탑
          }

          // 총안(battlement) — 이빨처럼 얹어야 저폴리에서도 성으로 읽힌다
          const merlons = (len: number, y: number, along: 'x' | 'z', x = 0, z = 0) => {
            const n = Math.max(2, Math.round(len / 1.9))
            for (let i = 0; i < n; i++) {
              const t = -len / 2 + (i + 0.5) * (len / n)
              put(
                new THREE.BoxGeometry(0.8, 0.9, 0.8),
                along === 'x' ? x + t : x, y, along === 'z' ? z + t : z,
              )
            }
          }
          merlons(9, 15.4, 'x', 0, -4.2)
          merlons(9, 15.4, 'x', 0, 4.2)

          for (const [wx, wz, len, along] of [
            [0, -8, 16, 'x'], [0, 8, 16, 'x'], [-8, 0, 16, 'z'], [8, 0, 16, 'z'],
          ] as const) {
            put(
              new THREE.BoxGeometry(along === 'x' ? len : 1.6, 7, along === 'z' ? len : 1.6),
              wx, 3.5, wz,
            )
            merlons(len, 7.4, along, wx, wz)
          }

          const merged = mergeGeometries(parts, false)
          if (merged) g.add(new THREE.Mesh(merged, mat))
          for (const part of parts) part.dispose()

          const gate = new THREE.Mesh(new THREE.BoxGeometry(3.4, 4.4, 0.6), gateMat)
          gate.position.set(0, 2.2, -8.6)
          g.add(gate)

          g.scale.setScalar(1.25)
          // 둔덕까지 강둑 안쪽 경계(BANK_Z)를 넘지 않도록 성 전체를 후경으로 물린다.
          g.position.z = BANK_Z + 28
          break
        }

        case 'windmill': {
          const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 3.4, 11, 8), mat)
          tower.position.y = 5.5
          const cap = new THREE.Mesh(new THREE.ConeGeometry(2.9, 3.2, 8), mat)
          cap.position.y = 12.6
          g.add(tower, cap)

          // 날개는 축을 따로 두고 매 프레임 돌린다
          // 날개 4장은 그룹째 도니까 인스턴스로 묶어도 된다 (메시 8개 → 2개)
          const sails = new THREE.Group()
          sails.position.set(0, 12.0, -3.2)
          const arm = (geo: THREE.BufferGeometry, m: THREE.Material, ox: number, oy: number, oz: number) => {
            const im = new THREE.InstancedMesh(geo, m, 4)
            const m4 = new THREE.Matrix4()
            for (let i = 0; i < 4; i++) {
              im.setMatrixAt(i, m4.makeRotationZ((i * Math.PI) / 2)
                .multiply(new THREE.Matrix4().makeTranslation(ox, oy, oz)))
            }
            im.instanceMatrix.needsUpdate = true
            return im
          }
          sails.add(arm(new THREE.BoxGeometry(0.4, 9.5, 0.3), mat, 0, 4.75, 0))
          sails.add(arm(new THREE.BoxGeometry(1.9, 7.6, 0.12), sailMat, 1.0, 5.0, 0.16))
          g.add(sails)
          this.spinners.push(sails)

          g.position.z = BANK_Z + 4
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
          const body = new THREE.Mesh(new THREE.BoxGeometry(13.5, 5.2, 8.5), mat)
          body.position.y = 2.6
          const roof = new THREE.Mesh(new THREE.ConeGeometry(8.4, 3.3, 4), mat)
          roof.position.y = 6.75
          roof.rotation.y = Math.PI / 4
          const windows = new THREE.Mesh(new THREE.BoxGeometry(10.8, 1.15, 0.16), windowMat)
          windows.position.set(0, 3.25, -4.31)
          const balcony = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.22, 1.15), gateMat)
          balcony.position.set(0, 2.35, -4.72)
          g.add(body, roof, windows, balcony)
          g.position.z = BANK_Z + 6
          break
        }
        case 'trees': {
          const leafMat = new THREE.MeshStandardMaterial({
            color: this.course.venue.palette.land, flatShading: true,
          })
          this.landmarkLeafMaterials.push(leafMat)
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
      g.name = `landmark:${lm.kind}`
      g.userData.landmarkName = lm.name
      const lateral = g.position.z
      this.landmarkGroup.add(g)
      this.landmarkNodes.push({
        obj: g,
        lm,
        lateral,
        baseYaw: g.rotation.y,
      })
    }
  }

  private placeOnPath(obj: THREE.Object3D, station: number, lateral: number, baseYaw: number) {
    const point = offsetPathPoint(this.path, station, lateral)
    obj.position.x = point.x
    obj.position.z = point.z
    // Three.js의 +Y 회전 부호는 수학적 XZ heading과 반대이다.
    obj.rotation.y = baseYaw - point.heading
  }

  /** 현재 플레이어 레인의 접선이 로컬 +X가 되도록 코스 전체를 한 번에 역변환한다. */
  private alignCourseRoot(distance: number) {
    const origin = offsetPathPoint(this.path, distance, PLAYER_LANE_OFFSET)
    const c = Math.cos(origin.heading)
    const s = Math.sin(origin.heading)
    this.courseRoot.rotation.y = origin.heading
    this.courseRoot.position.set(
      -(origin.x * c + origin.z * s),
      0,
      -(-origin.x * s + origin.z * c),
    )
  }

  /**
   * @param distance 코스 진행 거리 (m)
   * @param total    코스 전체 예상 거리 (m) — 랜드마크 배치 기준
   */
  update(
    animationTimeSec: number,
    elapsedSec: number,
    distance: number,
    total: number,
    cameraX: number,
  ) {
    const weather = this.weather.update(animationTimeSec, elapsedSec)
    this.applyWeather(weather)

    // 풍차 날개는 바람 세기에 따라 빨라진다
    const spin = animationTimeSec * (0.35 + weather.windStrength * 0.9)
    for (const s of this.spinners) s.rotation.z = spin
    this.water.update(animationTimeSec, distance)
    this.sky.position.x = cameraX
    this.nearby.duck.distance = Number.POSITIVE_INFINITY
    this.nearby.duck.pan = 0
    this.nearby.spectator.distance = Number.POSITIVE_INFINITY
    this.nearby.spectator.pan = 0

    // 나무: 일정 간격으로 반복시키고 뒤로 흘린다
    for (let i = 0; i < this.treeNodes.length; i++) {
      const node = this.treeNodes[i]!
      const along = wrappedLoopX(node.baseX, distance, node.span, -node.span * 0.35)
      this.placeOnPath(node.obj, distance + along, node.baseZ, node.baseYaw)
      node.obj.position.y = node.baseY
      node.obj.rotation.z = Math.sin(animationTimeSec * 1.5 + node.phase)
        * weather.windStrength * 0.038
    }

    // 응원객은 강둑을 따라 반복되고, 팔을 든 채 가볍게 점프한다
    for (const node of this.spectators) {
      const along = wrappedLoopX(node.baseX, distance, node.span, -68)
      const relative = localPathPoint(
        this.path, distance, along, node.baseZ, PLAYER_LANE_OFFSET,
      )
      const proximity = Math.hypot(relative.x, relative.z)
      if (proximity < this.nearby.spectator.distance) {
        this.nearby.spectator.distance = proximity
        this.nearby.spectator.pan = THREE.MathUtils.clamp(relative.z / 18, -1, 1)
      }
      this.placeOnPath(node.obj, distance + along, node.baseZ, node.baseYaw)
      node.obj.position.y = node.baseY
        + Math.max(0, Math.sin(animationTimeSec * 3.2 + node.phase)) * 0.055
      node.obj.rotation.z = Math.sin(animationTimeSec * 2.7 + node.phase) * 0.025
        + Math.sin(animationTimeSec * 1.2 + node.phase) * weather.windStrength * 0.018
    }

    // 오리는 물 위를 천천히 헤엄치며 위아래로 떠오른다
    for (const node of this.ducks) {
      const along = wrappedLoopX(
        node.baseX, distance - animationTimeSec * 0.32, node.span, -72,
      )
      const lateral = node.baseZ + Math.sin(animationTimeSec * 0.55 + node.phase) * 0.24
      const relative = localPathPoint(
        this.path, distance, along, lateral, PLAYER_LANE_OFFSET,
      )
      const proximity = Math.hypot(relative.x, relative.z)
      if (proximity < this.nearby.duck.distance) {
        this.nearby.duck.distance = proximity
        this.nearby.duck.pan = THREE.MathUtils.clamp(relative.z / 14, -1, 1)
      }
      this.placeOnPath(node.obj, distance + along, lateral, node.baseYaw)
      node.obj.position.y = node.baseY + Math.sin(animationTimeSec * 2.1 + node.phase) * 0.035
      node.obj.rotation.z = Math.sin(animationTimeSec * 1.35 + node.phase) * 0.035
    }

    // 구름은 먼 배경답게 지상보다 느리게 흘러 원근감을 만든다
    for (const node of this.clouds) {
      node.obj.position.x = wrappedLoopX(
        node.baseX,
        distance * 0.12 - animationTimeSec * (0.5 + weather.windStrength * 2.1),
        node.span,
        -145,
      )
      node.obj.position.y = node.baseY - weather.cloudiness * 1.8
        + Math.sin(animationTimeSec * 0.16 + node.phase) * 0.32
      node.obj.position.z = node.baseZ
    }

    // 오두막·저택과 동물은 고정 풀을 재활용한다 — 긴 코스에서도 오브젝트 수가 늘지 않는다
    for (const node of this.bankProps) {
      const along = wrappedLoopX(node.baseX, distance, node.span, -82)
      this.placeOnPath(node.obj, distance + along, node.baseZ, node.baseYaw)
      node.obj.position.y = node.baseY + (node.animated
        ? Math.sin(animationTimeSec * 1.4 + node.phase) * 0.018
        : 0)
    }

    // 랜드마크: 코스상 위치 - 현재 거리
    for (const { obj, lm, lateral, baseYaw } of this.landmarkNodes) {
      const station = lm.at * total
      const along = station - distance
      this.placeOnPath(obj, station, lateral, baseYaw)
      obj.visible = along > -60 && along < 300
    }

    this.alignCourseRoot(distance)
  }

  /** 오디오가 매 프레임 할당 없이 읽는 가장 가까운 오리/응원객 거리와 좌우 위치. */
  getAmbientPresence(): Readonly<AmbientPresence> {
    return this.nearby
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
