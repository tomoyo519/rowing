import * as THREE from 'three'
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
const CLOUD_COUNT = 4
const PROP_COUNT = 5
const BANK_OUTER_Z = BANK_Z + 26
const BANK_STEP = 8

type Side = 1 | -1
export type BankPropKind = 'cottage' | 'deer' | 'sheep' | 'heron'

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
      baseX: 20 + i * 76 + random() * 30,
      z: (random() - 0.5) * 90,
      scale: 2.0 + random() * 2.2,
      phase: random() * Math.PI * 2,
    })
  }

  const guaranteed: BankPropKind[] = ['cottage', 'deer', 'sheep', 'heron']
  for (let i = 0; i < PROP_COUNT; i++) {
    const side: Side = i % 2 === 0 ? 1 : -1
    const kind = guaranteed[i] ?? guaranteed[Math.floor(random() * guaranteed.length)]!
    const shoreOffset = kind === 'heron' ? 1.6 : 4.5 + random() * 5
    props.push({
      baseX: 18 + Math.floor(i / 2) * 70 + random() * 22,
      z: side * (BANK_Z + shoreOffset),
      side,
      kind,
      scale: 0.82 + random() * 0.32,
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

function createCloud(material: THREE.Material) {
  const group = new THREE.Group()
  const parts: [number, number, number, number][] = [
    [-0.55, 0, 0, 0.58], [0, 0.14, 0, 0.78], [0.62, 0, 0.04, 0.60], [0.18, -0.12, 0, 0.68],
  ]
  for (const [x, y, z, scale] of parts) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.65, 9, 6), material)
    puff.position.set(x, y, z)
    puff.scale.set(scale * 1.45, scale, scale)
    group.add(puff)
  }
  return group
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
    const cloudSpan = CLOUD_COUNT * 86
    layout.clouds.forEach((item, index) => {
      const cloud = createCloud(this.cloudMaterial)
      const y = 22 + (index % 3) * 4 + item.scale
      cloud.position.set(0, y, item.z)
      cloud.scale.setScalar(item.scale)
      this.scene.add(cloud)
      this.clouds.push({
        obj: cloud, baseX: item.baseX, baseY: y, baseZ: item.z,
        baseYaw: 0, span: cloudSpan, phase: item.phase,
      })
    })

    const cottageWall = standard(p.landmark)
    const cottageRoof = standard('#8f4f3f')
    const dark = standard('#3c3431')
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
      prop.position.set(0, 0.85, item.z)
      prop.scale.setScalar(item.scale)
      this.courseRoot.add(prop)
      this.bankProps.push({
        obj: prop, baseX: item.baseX, baseY: 0.85, baseZ: item.z,
        baseYaw: prop.rotation.y,
        // 각 종류의 반복 주기를 다르게 두어 전체 풍경이 같은 조합으로 되풀이되지 않게 한다.
        span: propSpan + index * 37, phase: item.phase, animated: item.kind !== 'cottage',
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

    // 오두막과 동물은 고정 풀을 재활용한다 — 긴 코스에서도 오브젝트 수가 늘지 않는다
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
