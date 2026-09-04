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
import { profileSections } from '../game/profile'
import type { Course, Landmark } from '../game/courses'

/**
 * 코스 월드 — 하늘, 조명, 물, 강둑, 랜드마크, 살아 있는 강변.
 *
 * 보트는 원점에 고정하고 세상이 뒤로 흐른다. 좌표가 커지지 않아
 * 긴 코스에서도 부동소수점 정밀도 문제가 없다.
 *
 * 배경 오브젝트는 종류마다 다른 주기로 되풀이되므로 같은 조합이 반복해 보이지 않는다.
 * 소품 대부분은 정점 색을 구워 넣은 메시 하나라 종류가 많아도 draw call은 적다.
 */

const BANK_Z = 15
const BANK_OUTER_Z = BANK_Z + 26
const MEADOW_OUTER_Z = BANK_OUTER_Z + 60
const BANK_STEP = 8
const TREE_COUNT = 36
const SPECTATOR_COUNT = 12
const DUCK_COUNT = 4
const SWAN_COUNT = 2
const CLOUD_COUNT = 7
const PROP_COUNT = 18
const BUSH_COUNT = 30
const BIRD_COUNT = 9
const HILL_SEGMENT_LENGTH = 420
const TREELINE_SEGMENT_LENGTH = 150

type Side = 1 | -1
export type TreeKind = 'oak' | 'birch' | 'pine' | 'poplar' | 'willow' | 'maple'
export type SpectatorPose = 'cheer' | 'wave' | 'stand' | 'clap' | 'sit'
export type BankPropKind =
  | 'cottage' | 'manor' | 'deer' | 'sheep' | 'heron'
  | 'bench' | 'lamp' | 'jetty' | 'rowboat' | 'tent' | 'flag' | 'shrub'
  | 'rocks' | 'cow' | 'boatshed' | 'picnic' | 'signpost'
export type SkyObjectKind = 'balloon' | 'blimp' | 'birds'

export interface SceneryPlacement {
  baseX: number
  z: number
  scale: number
  phase: number
}

export interface SceneryLayout {
  trees: (SceneryPlacement & { side: Side; kind: TreeKind; leaf: number; lean: number })[]
  spectators: (SceneryPlacement & {
    side: Side
    colorIndex: number
    pose: SpectatorPose
    hat: number
    skinIndex: number
    hairIndex: number
    trousersIndex: number
  })[]
  ducks: SceneryPlacement[]
  swans: SceneryPlacement[]
  clouds: SceneryPlacement[]
  sky: (SceneryPlacement & { kind: SkyObjectKind; colorIndex: number })[]
  props: (SceneryPlacement & { side: Side; kind: BankPropKind })[]
  bushes: (SceneryPlacement & { side: Side })[]
  /** 나무 반복 주기 (m) */
  treeSpan: number
  bushSpan: number
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
  /** 흔들리는 나무 등 종류별 애니메이션 구분 */
  kind?: string
}

interface LandmarkNode {
  obj: THREE.Object3D
  lm: Landmark
  lateral: number
  baseYaw: number
}

interface FoliageMaterial {
  material: THREE.MeshStandardMaterial
  green: THREE.Color
  fall: THREE.Color
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

// ── 지오메트리 헬퍼 ─────────────────────────────────────────

const UP = new THREE.Vector3(0, 1, 0)
const _matrix = new THREE.Matrix4()
const _quaternion = new THREE.Quaternion()
const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _euler = new THREE.Euler()

/**
 * 지오메트리에 단색 정점 색을 굽고 비인덱스로 바꾼다.
 * 여러 색의 부품을 메시 하나로 합치기 위한 준비다.
 */
function paint(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  transform?: (g: THREE.BufferGeometry) => void,
) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  if (g !== geometry) geometry.dispose()
  transform?.(g)
  const c = new THREE.Color(color)
  const count = g.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

/** paint()된 부품들을 메시 하나로 합친다. 부품은 합친 뒤 버린다. */
function mergeParts(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) return new THREE.BufferGeometry()
  merged.computeBoundingSphere()
  return merged
}

/** 색 없는 부품(재질 색을 쓰는 잎 등)을 합친다. */
function mergePlain(parts: THREE.BufferGeometry[]) {
  const nonIndexed = parts.map(part => {
    const g = part.index ? part.toNonIndexed() : part
    if (g !== part) part.dispose()
    return g
  })
  return mergeParts(nonIndexed)
}

function at(x: number, y: number, z: number, ry = 0, rz = 0, rx = 0) {
  return (g: THREE.BufferGeometry) => {
    if (rx) g.rotateX(rx)
    if (rz) g.rotateZ(rz)
    if (ry) g.rotateY(ry)
    g.translate(x, y, z)
  }
}

/** from→to 사이를 잇는 원기둥 지오메트리 (합치기용). */
function tubeBetween(from: THREE.Vector3, to: THREE.Vector3, radius: number, radiusEnd = radius) {
  const direction = to.clone().sub(from)
  const length = direction.length()
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, 7)
  _quaternion.setFromUnitVectors(UP, direction.normalize())
  geometry.applyQuaternion(_quaternion)
  geometry.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2)
  return geometry
}

function v(x: number, y: number, z = 0) { return new THREE.Vector3(x, y, z) }

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

function pickWeighted<T extends string>(random: () => number, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][]
  let total = 0
  for (const [, w] of entries) total += w
  let roll = random() * total
  for (const [kind, w] of entries) {
    roll -= w
    if (roll <= 0) return kind
  }
  return entries[entries.length - 1]![0]
}

// ── 팔레트 ──────────────────────────────────────────────────

/** 잎 팔레트 — 여름색과 단풍색 쌍. 가을 하늘 날씨에서 fall 쪽으로 물든다. */
const LEAF_PALETTES: [string, string][] = [
  ['#3f7c35', '#d8842c'],   // 참나무 — 주황
  ['#4f8f3c', '#c9a227'],   // 밝은 초록 — 노랑
  ['#2f6b39', '#b4462c'],   // 짙은 초록 — 붉은 단풍
  ['#78a84a', '#e3b93a'],   // 자작나무 — 황금
  ['#2b5a3a', '#2f5d3c'],   // 소나무 — 늘 푸름
  ['#8fb85a', '#d9c25a'],   // 버드나무 — 연노랑
]
const TRUNK_COLOR = '#4a3628'
const BIRCH_COLOR = '#e8e4da'

const SKIN_TONES = ['#f1c9a5', '#dfa980', '#c08557', '#8d5a3c']
const HAIR_COLORS = ['#2b1d14', '#6b4a2b', '#d9b36a', '#3a3a3a', '#b5533c', '#e6e2da']
const SHIRT_COLORS = ['#ff5a3c', '#ffd166', '#35c2a5', '#63a4ff', '#f28cb1', '#f4f1ea', '#7d5bd6', '#2f4d7a']
const TROUSER_COLORS = ['#263747', '#4a4a52', '#6b4f3a', '#8f9aa6', '#b8322a']
const HAT_COLORS = ['#f2efe6', '#2f4d7a', '#c94f3d', '#e8c25a']
const BALLOON_COLORS: [string, string][] = [
  ['#e94e3c', '#f7e46a'], ['#3f7fd6', '#f2f2f2'], ['#7d5bd6', '#f2a33a'],
]

/** 코스별로 같지만 자연스럽게 흩어진 강변 배치. */
export function createSceneryLayout(courseId: string): SceneryLayout {
  const random = seededRandom(courseId)
  const trees: SceneryLayout['trees'] = []
  const spectators: SceneryLayout['spectators'] = []
  const ducks: SceneryLayout['ducks'] = []
  const swans: SceneryLayout['swans'] = []
  const clouds: SceneryLayout['clouds'] = []
  const sky: SceneryLayout['sky'] = []
  const props: SceneryLayout['props'] = []
  const bushes: SceneryLayout['bushes'] = []

  // 나무: 간격을 흩뜨리고 군락과 빈터가 번갈아 나오게 한다.
  let cursor = 0
  const treeWeights: Record<TreeKind, number> = {
    oak: 0.26, birch: 0.15, pine: 0.17, poplar: 0.14, willow: 0.12, maple: 0.16,
  }
  const leafFor: Record<TreeKind, number[]> = {
    oak: [0, 1, 2], birch: [3], pine: [4], poplar: [1, 3], willow: [5], maple: [0, 2],
  }
  for (let i = 0; i < TREE_COUNT; i++) {
    const clustered = random() < 0.35
    cursor += clustered ? 4 + random() * 5 : 9 + random() * 14
    const side: Side = random() < 0.5 ? 1 : -1
    const kind = pickWeighted(random, treeWeights)
    const leaves = leafFor[kind]
    const shore = kind === 'willow' ? 0.6 + random() * 1.6 : 1.8 + random() * 9
    trees.push({
      baseX: cursor,
      z: side * (BANK_Z + shore),
      side,
      kind,
      leaf: leaves[Math.floor(random() * leaves.length)]!,
      scale: 0.78 + random() * 0.55,
      phase: random() * Math.PI * 2,
      lean: (random() - 0.5) * 0.12,
    })
  }
  const treeSpan = cursor + 12

  const poses: SpectatorPose[] = ['cheer', 'wave', 'stand', 'clap', 'sit']
  for (let i = 0; i < SPECTATOR_COUNT; i++) {
    const side: Side = i % 2 === 0 ? 1 : -1
    // 둘씩 붙어 서 있는 사람들이 섞이게 한다.
    const pair = i % 3 === 2
    spectators.push({
      baseX: Math.floor(i / 2) * 30 + (pair ? 1.4 : random() * 12),
      z: side * (BANK_Z + 1.2 + random() * 1.5),
      side,
      scale: random() < 0.2 ? 0.62 + random() * 0.1 : 0.9 + random() * 0.2,
      phase: random() * Math.PI * 2,
      colorIndex: Math.floor(random() * SHIRT_COLORS.length),
      pose: i < poses.length ? poses[i]! : poses[Math.floor(random() * poses.length)]!,
      hat: random() < 0.45 ? 1 + Math.floor(random() * 2) : 0,
      skinIndex: Math.floor(random() * SKIN_TONES.length),
      hairIndex: Math.floor(random() * HAIR_COLORS.length),
      trousersIndex: Math.floor(random() * TROUSER_COLORS.length),
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
  for (let i = 0; i < SWAN_COUNT; i++) {
    const side: Side = i % 2 === 0 ? -1 : 1
    swans.push({
      baseX: 60 + i * 130 + random() * 40,
      z: side * (11.2 + random() * 1.2),
      scale: 0.95 + random() * 0.2,
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

  // 하늘: 열기구 셋, 비행선 하나, 새떼 하나가 저마다 다른 주기로 지나간다.
  for (let i = 0; i < 3; i++) {
    sky.push({
      baseX: 40 + i * 210 + random() * 60,
      z: (random() < 0.5 ? -1 : 1) * (30 + random() * 40),
      scale: 0.9 + random() * 0.5,
      phase: random() * Math.PI * 2,
      kind: 'balloon',
      colorIndex: i % BALLOON_COLORS.length,
    })
  }
  sky.push({
    baseX: 320 + random() * 120, z: (random() < 0.5 ? -1 : 1) * (55 + random() * 30),
    scale: 1, phase: random() * Math.PI * 2, kind: 'blimp', colorIndex: 0,
  })
  sky.push({
    baseX: 90 + random() * 80, z: (random() - 0.5) * 60,
    scale: 1, phase: random() * Math.PI * 2, kind: 'birds', colorIndex: 0,
  })

  const guaranteed: BankPropKind[] = [
    'cottage', 'manor', 'deer', 'sheep', 'heron', 'jetty', 'rowboat', 'tent', 'flag',
    'bench', 'lamp', 'shrub', 'rocks', 'cow', 'boatshed', 'picnic', 'signpost',
  ]
  for (let i = 0; i < PROP_COUNT; i++) {
    const side: Side = i % 2 === 0 ? 1 : -1
    const kind = guaranteed[i] ?? guaranteed[Math.floor(random() * guaranteed.length)]!
    const shoreOffset = ({
      heron: 1.4, jetty: -1.2, rowboat: -1.9, bench: 2.2 + random() * 1.5,
      lamp: 1.8 + random() * 1.2, signpost: 2 + random() * 1.5, flag: 2.5 + random() * 3,
      picnic: 3 + random() * 3, rocks: 0.8 + random() * 1.5, shrub: 1.5 + random() * 4,
      manor: 8 + random() * 4, boatshed: 2.4, tent: 5 + random() * 4,
    } as Partial<Record<BankPropKind, number>>)[kind] ?? 4.5 + random() * 5
    const scale = kind === 'manor'
      ? 0.94 + random() * 0.24
      : 0.82 + random() * 0.32
    props.push({
      baseX: 18 + Math.floor(i / 2) * 60 + random() * 22,
      z: side * (BANK_Z + shoreOffset),
      side,
      kind,
      scale,
      phase: random() * Math.PI * 2,
    })
  }

  let bushCursor = 0
  for (let i = 0; i < BUSH_COUNT; i++) {
    bushCursor += 5 + random() * 16
    const side: Side = random() < 0.5 ? 1 : -1
    bushes.push({
      baseX: bushCursor,
      z: side * (BANK_Z + 0.3 + random() * 1.8),
      side,
      scale: 0.55 + random() * 0.9,
      phase: random() * Math.PI * 2,
    })
  }

  return {
    trees, spectators, ducks, swans, clouds, sky, props, bushes,
    treeSpan, bushSpan: bushCursor + 8,
  }
}

// ── 나무 ────────────────────────────────────────────────────

/** 수종별로 다른 실루엣. 줄기와 잎을 각각 메시 하나로 합친다. */
function createTree(
  kind: TreeKind,
  leaf: THREE.Material,
  trunk: THREE.Material,
  birch: THREE.Material,
  phase: number,
) {
  const group = new THREE.Group()
  const trunkParts: THREE.BufferGeometry[] = []
  const leafParts: THREE.BufferGeometry[] = []
  const sphere = (r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
    const g = new THREE.SphereGeometry(r, 9, 7)
    g.scale(sx, sy, sz)
    g.translate(x, y, z)
    leafParts.push(g)
  }
  let trunkMaterial = trunk

  switch (kind) {
    case 'oak': {
      const t = new THREE.CylinderGeometry(0.22, 0.36, 2.8, 7)
      t.translate(0, 1.4, 0)
      trunkParts.push(t)
      for (const z of [-0.6, 0.6]) {
        trunkParts.push(tubeBetween(v(0, 2.2, 0), v(z * 1.5, 3.4, z), 0.12, 0.06))
      }
      sphere(1.9, 0, 4.1, 0, 1.15, 0.95, 1.1)
      sphere(1.45, -1.5, 3.5, 0.5)
      sphere(1.4, 1.4, 3.7, -0.4)
      sphere(1.3, 0.3, 5.2, 0.4)
      sphere(1.2, -0.4, 3.3, -1.2)
      break
    }
    case 'birch': {
      trunkMaterial = birch
      const t = new THREE.CylinderGeometry(0.08, 0.14, 4.6, 6)
      t.translate(0, 2.3, 0)
      trunkParts.push(t)
      trunkParts.push(tubeBetween(v(0, 3.0, 0), v(0.9, 4.4, 0.3), 0.05, 0.03))
      sphere(1.0, 0, 4.6, 0, 0.85, 1.2, 0.85)
      sphere(0.85, 0.7, 5.4, 0.2, 0.8, 1.1, 0.8)
      sphere(0.8, -0.6, 5.2, -0.3, 0.8, 1.1, 0.8)
      break
    }
    case 'pine': {
      const t = new THREE.CylinderGeometry(0.14, 0.24, 2.2, 6)
      t.translate(0, 1.1, 0)
      trunkParts.push(t)
      for (const [r, h, y] of [[1.9, 2.8, 2.9], [1.5, 2.5, 4.4], [1.05, 2.3, 5.8]] as const) {
        const cone = new THREE.ConeGeometry(r, h, 8)
        cone.translate(0, y, 0)
        leafParts.push(cone)
      }
      break
    }
    case 'poplar': {
      const t = new THREE.CylinderGeometry(0.1, 0.18, 2.6, 6)
      t.translate(0, 1.3, 0)
      trunkParts.push(t)
      sphere(4.2, 0, 5.4, 0, 0.36, 1.0, 0.36)
      sphere(2.2, 0, 3.2, 0, 0.5, 0.7, 0.5)
      break
    }
    case 'willow': {
      const t = new THREE.CylinderGeometry(0.26, 0.42, 2.4, 7)
      t.translate(0, 1.2, 0)
      trunkParts.push(t)
      sphere(2.1, 0, 3.9, 0, 1.15, 0.7, 1.15)
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + phase
        const r = 2.0 + Math.sin(a * 3) * 0.2
        const frond = new THREE.CylinderGeometry(0.08, 0.24, 2.6, 5)
        frond.translate(Math.cos(a) * r, 2.4, Math.sin(a) * r)
        leafParts.push(frond)
      }
      break
    }
    case 'maple': {
      const t = new THREE.CylinderGeometry(0.2, 0.3, 2.6, 7)
      t.translate(0, 1.3, 0)
      trunkParts.push(t)
      sphere(1.75, 0, 3.9, 0, 1.05, 1.0, 1.05)
      sphere(1.4, -1.1, 4.5, 0.2)
      sphere(1.35, 1.0, 4.6, -0.3)
      sphere(1.1, 0.1, 5.4, 0.5)
      break
    }
  }

  const trunkMesh = new THREE.Mesh(mergePlain(trunkParts), trunkMaterial)
  const leafMesh = new THREE.Mesh(mergePlain(leafParts), leaf)
  trunkMesh.castShadow = true
  leafMesh.castShadow = true
  leafMesh.name = 'foliage'
  group.add(trunkMesh, leafMesh)
  return group
}

// ── 사람과 동물 ─────────────────────────────────────────────

interface SpectatorSpec {
  pose: SpectatorPose
  hat: number
  skin: string
  hair: string
  shirt: string
  trousers: string
  hatColor: string
}

/** 포즈·모자·피부·옷이 다른 응원객. 정점 색을 구워 메시 하나로 만든다. */
function createSpectatorGeometry(spec: SpectatorSpec) {
  const parts: THREE.BufferGeometry[] = []
  const sitting = spec.pose === 'sit'
  const lift = sitting ? -0.46 : 0
  const hipY = 0.86 + lift
  const shoulderY = 1.30 + lift
  const headY = 1.60 + lift

  // 몸통 — 어깨가 넓고 허리가 좁다
  parts.push(paint(new THREE.CylinderGeometry(0.19, 0.15, 0.56, 10), spec.shirt, at(0, hipY + 0.28, 0)))
  parts.push(paint(new THREE.SphereGeometry(0.19, 10, 8), spec.shirt, g => {
    g.scale(1, 0.55, 0.8); g.translate(0, shoulderY - 0.02, 0)
  }))
  parts.push(paint(new THREE.CylinderGeometry(0.055, 0.06, 0.12, 8), spec.skin, at(0, shoulderY + 0.06, 0)))
  // 머리
  parts.push(paint(new THREE.SphereGeometry(0.135, 14, 11), spec.skin, g => {
    g.scale(1, 1.12, 0.92); g.translate(0, headY, 0)
  }))
  parts.push(paint(new THREE.ConeGeometry(0.02, 0.05, 5), spec.skin, at(0, headY - 0.01, -0.135, 0, 0, -Math.PI / 2)))
  // 머리카락 — 이마를 드러낸 캡
  parts.push(paint(
    new THREE.SphereGeometry(0.142, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.58), spec.hair, g => {
      g.scale(1, 1.1, 0.95); g.rotateX(0.3); g.translate(0, headY + 0.03, 0.01)
    },
  ))
  if (spec.hat === 1) {
    // 야구 모자
    parts.push(paint(
      new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), spec.hatColor,
      g => { g.scale(1, 0.85, 0.95); g.translate(0, headY + 0.05, 0) },
    ))
    parts.push(paint(new THREE.CircleGeometry(0.11, 10, Math.PI, Math.PI), spec.hatColor, g => {
      g.rotateX(-Math.PI / 2); g.rotateY(Math.PI); g.translate(0, headY + 0.07, -0.11)
    }))
  } else if (spec.hat === 2) {
    // 챙 넓은 모자
    parts.push(paint(new THREE.CylinderGeometry(0.11, 0.12, 0.14, 12), spec.hatColor, at(0, headY + 0.14, 0)))
    parts.push(paint(new THREE.CylinderGeometry(0.27, 0.27, 0.02, 14), spec.hatColor, at(0, headY + 0.08, 0)))
  }

  // 팔: 포즈마다 팔꿈치·손 위치가 다르다. 윗팔은 소매, 아랫팔은 맨살.
  const arm = (side: number, elbow: THREE.Vector3, hand: THREE.Vector3) => {
    const shoulder = v(side * 0.17, shoulderY - 0.02, 0)
    parts.push(paint(tubeBetween(shoulder, elbow, 0.06, 0.05), spec.shirt))
    parts.push(paint(tubeBetween(elbow, hand, 0.05, 0.04), spec.skin))
    parts.push(paint(new THREE.SphereGeometry(0.048, 8, 6), spec.skin, at(hand.x, hand.y, hand.z)))
  }
  switch (spec.pose) {
    case 'cheer':
      for (const s of [1, -1]) arm(s, v(s * 0.32, shoulderY + 0.22), v(s * 0.38, shoulderY + 0.56))
      break
    case 'wave':
      arm(1, v(0.32, shoulderY + 0.22), v(0.42, shoulderY + 0.54))
      arm(-1, v(-0.23, shoulderY - 0.28), v(-0.25, shoulderY - 0.52))
      break
    case 'stand':
      for (const s of [1, -1]) arm(s, v(s * 0.23, shoulderY - 0.28), v(s * 0.25, shoulderY - 0.52))
      break
    case 'clap':
      for (const s of [1, -1]) arm(s, v(s * 0.27, shoulderY - 0.24, -0.06), v(s * 0.07, shoulderY - 0.12, -0.24))
      break
    case 'sit':
      for (const s of [1, -1]) arm(s, v(s * 0.24, shoulderY - 0.3, -0.08), v(s * 0.13, shoulderY - 0.62, -0.36))
      break
  }

  // 다리
  if (sitting) {
    for (const s of [1, -1]) {
      parts.push(paint(tubeBetween(v(s * 0.09, hipY, 0), v(s * 0.1, hipY - 0.02, -0.42), 0.075, 0.065), spec.trousers))
      parts.push(paint(tubeBetween(v(s * 0.1, hipY - 0.02, -0.42), v(s * 0.1, 0.06, -0.44), 0.06, 0.05), spec.trousers))
      parts.push(paint(new THREE.BoxGeometry(0.11, 0.07, 0.24), '#2b2b2f', at(s * 0.1, 0.035, -0.5)))
    }
    // 앉을 의자
    parts.push(paint(new THREE.BoxGeometry(0.62, 0.06, 0.4), '#6b4a2f', at(0, hipY - 0.12, 0.02)))
    for (const s of [1, -1]) {
      parts.push(paint(new THREE.BoxGeometry(0.05, hipY - 0.15, 0.05), '#3b3431', at(s * 0.27, (hipY - 0.15) / 2, 0.02)))
    }
  } else {
    for (const s of [1, -1]) {
      parts.push(paint(tubeBetween(v(s * 0.08, hipY, 0), v(s * 0.11, 0.08, 0), 0.075, 0.06), spec.trousers))
      parts.push(paint(new THREE.BoxGeometry(0.12, 0.07, 0.26), '#2b2b2f', at(s * 0.11, 0.035, -0.04)))
    }
  }
  return mergeParts(parts)
}

function createDuckGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.SphereGeometry(0.34, 10, 7), '#7c6547', g => { g.scale(1.35, 0.62, 0.78); g.translate(0, 0, 0) }))
  parts.push(paint(new THREE.SphereGeometry(0.25, 8, 6), '#4b3d2c', g => { g.scale(1.15, 0.32, 0.72); g.translate(-0.05, 0.15, 0) }))
  parts.push(paint(new THREE.SphereGeometry(0.18, 9, 7), '#315f4b', at(0.38, 0.22, 0)))
  parts.push(paint(new THREE.ConeGeometry(0.09, 0.25, 6), '#f2a541', at(0.58, 0.19, 0, 0, -Math.PI / 2)))
  parts.push(paint(new THREE.TorusGeometry(0.17, 0.03, 5, 10), '#f4f1e6', g => { g.rotateX(Math.PI / 2); g.translate(0.22, 0.14, 0) }))
  return mergeParts(parts)
}

function createSwanGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.SphereGeometry(0.42, 12, 8), '#f7f5f0', g => { g.scale(1.45, 0.7, 0.85) }))
  parts.push(paint(new THREE.SphereGeometry(0.3, 10, 7), '#f7f5f0', g => { g.scale(0.8, 0.9, 0.7); g.translate(-0.42, 0.22, 0) }))
  // S자 목
  parts.push(paint(tubeBetween(v(0.42, 0.12, 0), v(0.68, 0.62, 0), 0.075, 0.065), '#f7f5f0'))
  parts.push(paint(tubeBetween(v(0.68, 0.62, 0), v(0.66, 0.98, 0), 0.065, 0.055), '#f7f5f0'))
  parts.push(paint(new THREE.SphereGeometry(0.11, 9, 7), '#f7f5f0', at(0.7, 1.02, 0)))
  parts.push(paint(new THREE.ConeGeometry(0.045, 0.2, 6), '#f0862f', at(0.86, 1.0, 0, 0, -Math.PI / 2)))
  parts.push(paint(new THREE.SphereGeometry(0.05, 6, 5), '#1a1a1a', at(0.78, 1.02, 0)))
  return mergeParts(parts)
}

function createFourLeggedGeometry(kind: 'deer' | 'sheep' | 'cow') {
  const parts: THREE.BufferGeometry[] = []
  const body = kind === 'sheep' ? '#e2e0d2' : kind === 'cow' ? '#f2efe9' : '#8b6242'
  const dark = kind === 'sheep' ? '#3c3431' : kind === 'cow' ? '#2b2724' : '#5a3d28'
  const size = kind === 'cow' ? 1.35 : 1
  parts.push(paint(new THREE.IcosahedronGeometry(kind === 'sheep' ? 0.72 : 0.6, 1), body, g => {
    g.scale((kind === 'sheep' ? 1.25 : 1.5) * size, (kind === 'sheep' ? 0.82 : 0.8) * size, 0.8 * size)
    g.translate(0, 0.98 * size, 0)
  }))
  if (kind === 'cow') {
    // 얼룩
    parts.push(paint(new THREE.SphereGeometry(0.42, 8, 6), dark, g => { g.scale(1.1, 0.7, 0.5); g.translate(-0.3, 1.35, 0.72) }))
    parts.push(paint(new THREE.SphereGeometry(0.36, 8, 6), dark, g => { g.scale(1.0, 0.7, 0.5); g.translate(0.4, 1.2, -0.72) }))
  }
  parts.push(paint(new THREE.IcosahedronGeometry(0.26 * size, 1), kind === 'cow' ? body : dark, g => {
    g.scale(1.2, 0.95, 0.85); g.translate(0.78 * size, 1.28 * size, 0)
  }))
  if (kind !== 'sheep') {
    parts.push(paint(new THREE.ConeGeometry(0.1 * size, 0.2 * size, 5), kind === 'cow' ? '#e8c9a0' : dark, at(0.98 * size, 1.22 * size, 0, 0, -Math.PI / 2)))
  }
  for (const x of [-0.42, 0.42]) {
    for (const z of [-0.24, 0.24]) {
      parts.push(paint(new THREE.CylinderGeometry(0.05 * size, 0.06 * size, 0.7 * size, 5), dark, at(x * size, 0.42 * size, z * size)))
    }
  }
  if (kind === 'deer') {
    for (const z of [-0.12, 0.12]) {
      parts.push(paint(tubeBetween(v(0.76, 1.46, z), v(0.86, 1.86, z * 2.2), 0.025), dark))
      parts.push(paint(tubeBetween(v(0.81, 1.66, z * 1.6), v(0.98, 1.8, z * 2.6), 0.02), dark))
    }
  }
  if (kind === 'cow') {
    for (const z of [-0.16, 0.16]) parts.push(paint(tubeBetween(v(1.0, 1.55, z), v(1.08, 1.78, z * 1.8), 0.035, 0.02), '#e8dcc0'))
    parts.push(paint(new THREE.SphereGeometry(0.16, 8, 6), '#e8b4b8', g => { g.scale(1.2, 0.6, 1); g.translate(-0.2, 0.55, 0) }))
  }
  parts.push(paint(tubeBetween(v(-0.8 * size, 1.05 * size, 0), v(-1.05 * size, 0.75 * size, 0), 0.04, 0.02), dark))
  return mergeParts(parts)
}

function createHeronGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const feather = '#9eabb4'
  parts.push(paint(new THREE.SphereGeometry(0.3, 9, 7), feather, g => { g.scale(1.25, 0.78, 0.72); g.translate(0, 0.92, 0) }))
  parts.push(paint(tubeBetween(v(0.2, 1.1, 0), v(0.36, 1.78, 0), 0.09, 0.06), feather))
  parts.push(paint(new THREE.SphereGeometry(0.13, 9, 7), '#d8dee2', at(0.34, 1.8, 0)))
  parts.push(paint(new THREE.ConeGeometry(0.045, 0.38, 5), '#d6a33d', at(0.57, 1.78, 0, 0, -Math.PI / 2)))
  parts.push(paint(new THREE.BoxGeometry(0.16, 0.03, 0.03), '#2b2b2f', at(0.32, 1.86, 0)))
  for (const z of [-0.08, 0.08]) {
    parts.push(paint(new THREE.CylinderGeometry(0.018, 0.018, 0.75, 5), '#3c3431', at(0, 0.38, z)))
  }
  return mergeParts(parts)
}

// ── 소품 ────────────────────────────────────────────────────

function createCottageGeometry(wall: string) {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.BoxGeometry(3.8, 2.7, 3.2), wall, at(0, 1.35, 0)))
  parts.push(paint(new THREE.ConeGeometry(3.0, 1.8, 4), '#8f4f3f', at(0, 3.58, 0, Math.PI / 4)))
  parts.push(paint(new THREE.BoxGeometry(0.72, 1.45, 0.08), '#3c3431', at(0, 0.73, -1.63)))
  parts.push(paint(new THREE.BoxGeometry(0.42, 1.25, 0.42), '#4b3f3a', at(0.9, 3.65, 0.35)))
  for (const x of [-1.2, 1.2]) parts.push(paint(new THREE.BoxGeometry(0.7, 0.7, 0.08), '#5a8db0', at(x, 1.5, -1.63)))
  for (const x of [-1.25, 1.25]) parts.push(paint(new THREE.BoxGeometry(0.9, 0.25, 0.35), '#c94f3d', at(x, 1.06, -1.7)))
  return mergeParts(parts)
}

/** 강변에서 확실히 실루엣이 읽히는 큰 저택. */
function createManorGeometry(wall: string) {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.BoxGeometry(10.5, 5.4, 6.2), wall, at(0, 2.7, 0)))
  parts.push(paint(new THREE.BoxGeometry(4.0, 4.3, 5.2), wall, at(-6.5, 2.15, 0.25)))
  parts.push(paint(new THREE.BoxGeometry(4.0, 4.3, 5.2), wall, at(6.5, 2.15, 0.25)))
  parts.push(paint(new THREE.ConeGeometry(7.1, 3.0, 4), '#6f4535', at(0, 6.75, 0, Math.PI / 4)))
  parts.push(paint(new THREE.ConeGeometry(3.8, 2.5, 4), '#6f4535', at(-6.5, 5.55, 0, Math.PI / 4)))
  parts.push(paint(new THREE.ConeGeometry(3.8, 2.5, 4), '#6f4535', at(6.5, 5.55, 0, Math.PI / 4)))
  parts.push(paint(new THREE.BoxGeometry(1.35, 2.6, 0.14), '#3c3431', at(0, 1.3, -3.17)))
  for (const [x, y] of [
    [-4.0, 1.55], [-2.2, 1.55], [2.2, 1.55], [4.0, 1.55],
    [-4.0, 3.75], [-2.0, 3.75], [0, 3.75], [2.0, 3.75], [4.0, 3.75],
    [-6.5, 2.25], [6.5, 2.25],
  ] as const) {
    parts.push(paint(new THREE.BoxGeometry(0.82, 0.95, 0.12), '#31566d', at(x, y, -3.19)))
  }
  for (const x of [-3.4, 3.4]) parts.push(paint(new THREE.BoxGeometry(0.6, 1.4, 0.6), '#4b3f3a', at(x, 8.0, 0.8)))
  // 현관 기둥
  for (const x of [-1.1, 1.1]) parts.push(paint(new THREE.CylinderGeometry(0.16, 0.18, 2.7, 8), '#e9e3d6', at(x, 1.35, -3.6)))
  parts.push(paint(new THREE.BoxGeometry(3.0, 0.3, 1.2), '#e9e3d6', at(0, 2.8, -3.6)))
  return mergeParts(parts)
}

function createBenchGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const wood = '#8a5f3a'
  for (const y of [0.45, 0.72, 0.86]) {
    parts.push(paint(new THREE.BoxGeometry(1.8, 0.06, y === 0.45 ? 0.5 : 0.1), wood, at(0, y, y === 0.45 ? 0 : 0.25)))
  }
  for (const x of [-0.8, 0.8]) {
    parts.push(paint(new THREE.BoxGeometry(0.06, 0.45, 0.5), '#3b3431', at(x, 0.22, 0)))
    parts.push(paint(new THREE.BoxGeometry(0.06, 0.5, 0.06), '#3b3431', at(x, 0.7, 0.24)))
  }
  return mergeParts(parts)
}

function createLampGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.CylinderGeometry(0.06, 0.1, 3.6, 7), '#2f3a44', at(0, 1.8, 0)))
  parts.push(paint(new THREE.CylinderGeometry(0.2, 0.26, 0.2, 7), '#2f3a44', at(0, 0.1, 0)))
  parts.push(paint(new THREE.BoxGeometry(0.36, 0.42, 0.36), '#fff1b8', at(0, 3.8, 0)))
  parts.push(paint(new THREE.ConeGeometry(0.32, 0.3, 4), '#2f3a44', at(0, 4.15, 0, Math.PI / 4)))
  return mergeParts(parts)
}

/** 물가에서 강 쪽으로 뻗은 나무 선착장. 로컬 -Z가 강 쪽이다. */
function createJettyGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const wood = '#9a7250'
  for (let i = 0; i < 6; i++) {
    parts.push(paint(new THREE.BoxGeometry(1.6, 0.08, 0.5), i % 2 ? wood : '#8a6444', at(0, 0.55, -i * 0.58)))
  }
  for (const x of [-0.65, 0.65]) {
    for (const z of [0, -1.5, -2.95]) {
      parts.push(paint(new THREE.CylinderGeometry(0.07, 0.08, 1.5, 6), '#5c4030', at(x, -0.2, z)))
    }
  }
  parts.push(paint(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6), '#5c4030', at(0.75, 0.9, -2.9)))
  return mergeParts(parts)
}

/** 물가에 매어 둔 작은 나무 보트. */
function createRowboatGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const hull = new THREE.CapsuleGeometry(0.55, 2.6, 3, 10)
  hull.rotateZ(Math.PI / 2)
  hull.scale(1, 0.45, 1)
  parts.push(paint(hull, '#b2402f', at(0, 0.12, 0)))
  const inner = new THREE.CapsuleGeometry(0.42, 2.4, 3, 10)
  inner.rotateZ(Math.PI / 2)
  inner.scale(1, 0.25, 1)
  parts.push(paint(inner, '#e6d3b0', at(0, 0.3, 0)))
  for (const x of [-0.7, 0.3]) parts.push(paint(new THREE.BoxGeometry(0.22, 0.05, 0.9), '#8a6444', at(x, 0.4, 0)))
  parts.push(paint(tubeBetween(v(-0.2, 0.42, 0.4), v(1.4, 0.5, 1.3), 0.03), '#8a6444'))
  return mergeParts(parts)
}

function createTentGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.BoxGeometry(6.4, 0.2, 4.4), '#f4f1ea', at(0, 2.9, 0)))
  const roof = new THREE.ConeGeometry(4.2, 1.8, 4)
  roof.rotateY(Math.PI / 4)
  roof.scale(1.1, 1, 0.75)
  parts.push(paint(roof, '#f4f1ea', at(0, 3.85, 0)))
  for (const x of [-3, 3]) for (const z of [-2, 2]) {
    parts.push(paint(new THREE.CylinderGeometry(0.06, 0.06, 2.9, 6), '#5c5c5c', at(x, 1.45, z)))
  }
  // 줄무늬 옆면
  for (let i = 0; i < 6; i++) {
    parts.push(paint(new THREE.BoxGeometry(1.0, 0.5, 0.05), i % 2 ? '#c94f3d' : '#f4f1ea', at(-2.5 + i, 2.55, -2.2)))
  }
  parts.push(paint(new THREE.BoxGeometry(2.6, 0.8, 1.0), '#8a5f3a', at(0, 0.4, 0.4)))
  parts.push(paint(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 5), '#5c5c5c', at(0, 5.5, 0)))
  return mergeParts(parts)
}

function createFlagPoleGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.CylinderGeometry(0.05, 0.08, 6.5, 7), '#d8dde2', at(0, 3.25, 0)))
  parts.push(paint(new THREE.SphereGeometry(0.12, 8, 6), '#e8c25a', at(0, 6.55, 0)))
  parts.push(paint(new THREE.CylinderGeometry(0.3, 0.4, 0.3, 8), '#8f9aa6', at(0, 0.15, 0)))
  return mergeParts(parts)
}

function createShrubGeometry(color: string) {
  const parts: THREE.BufferGeometry[] = []
  for (const [x, y, z, r] of [[0, 0.7, 0, 0.9], [-0.8, 0.5, 0.3, 0.65], [0.75, 0.55, -0.25, 0.7], [0.1, 0.5, 0.75, 0.55]] as const) {
    parts.push(paint(new THREE.IcosahedronGeometry(r, 1), color, at(x, y, z)))
  }
  // 꽃
  for (const [x, y, z, c] of [[-0.3, 1.3, 0.2, '#f26d8a'], [0.5, 1.1, 0.4, '#ffd166'], [0.2, 1.2, -0.6, '#f4f1ea']] as const) {
    parts.push(paint(new THREE.SphereGeometry(0.12, 6, 5), c, at(x, y, z)))
  }
  return mergeParts(parts)
}

function createRocksGeometry() {
  const parts: THREE.BufferGeometry[] = []
  for (const [x, y, z, r, c] of [
    [0, 0.5, 0, 0.9, '#7c7f86'], [-1.2, 0.35, 0.4, 0.6, '#6d7077'], [1.1, 0.4, -0.3, 0.7, '#8a8d94'], [0.4, 0.3, 1.0, 0.45, '#6d7077'],
  ] as const) {
    parts.push(paint(new THREE.IcosahedronGeometry(r, 0), c, g => { g.scale(1.3, 0.75, 1); g.translate(x, y, z) }))
  }
  return mergeParts(parts)
}

function createBoatshedGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.BoxGeometry(7.5, 3.4, 5.5), '#4c6b7d', at(0, 1.7, 0)))
  const roof = new THREE.ConeGeometry(4.9, 2.0, 4)
  roof.rotateY(Math.PI / 4)
  roof.scale(1.12, 1, 0.82)
  parts.push(paint(roof, '#3a3f45', at(0, 4.4, 0)))
  parts.push(paint(new THREE.BoxGeometry(3.6, 2.6, 0.12), '#1f2a33', at(0, 1.3, -2.8)))
  for (const x of [-2.9, 2.9]) parts.push(paint(new THREE.BoxGeometry(0.9, 0.9, 0.1), '#9fd0e8', at(x, 2.2, -2.8)))
  // 지붕 위 보트 거치대와 뒤집힌 보트
  const boat = new THREE.CapsuleGeometry(0.28, 4.6, 3, 8)
  boat.rotateZ(Math.PI / 2)
  boat.scale(1, 0.4, 1)
  parts.push(paint(boat, '#f2efe9', at(0, 5.55, 0.3)))
  parts.push(paint(new THREE.BoxGeometry(6.0, 0.14, 1.4), '#8a6444', at(0, 0.07, -3.6)))
  return mergeParts(parts)
}

function createPicnicGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.BoxGeometry(3.0, 0.04, 2.4), '#d94b4b', at(0, 0.02, 0)))
  for (let i = 0; i < 4; i++) {
    parts.push(paint(new THREE.BoxGeometry(0.28, 0.05, 2.4), '#f4f1ea', at(-1.2 + i * 0.8, 0.03, 0)))
  }
  parts.push(paint(new THREE.BoxGeometry(0.7, 0.4, 0.45), '#8a5f3a', at(-0.8, 0.22, -0.5)))
  parts.push(paint(new THREE.SphereGeometry(0.16, 8, 6), '#f2f2f2', at(0.5, 0.16, 0.3)))
  parts.push(paint(new THREE.SphereGeometry(0.14, 8, 6), '#ffd166', at(0.85, 0.14, -0.2)))
  // 파라솔
  parts.push(paint(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 5), '#5c5c5c', at(0.6, 1.1, 0.6)))
  parts.push(paint(new THREE.ConeGeometry(1.4, 0.55, 8), '#63a4ff', at(0.6, 2.35, 0.6)))
  return mergeParts(parts)
}

function createSignpostGeometry() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(paint(new THREE.CylinderGeometry(0.06, 0.07, 2.4, 6), '#5c4030', at(0, 1.2, 0)))
  parts.push(paint(new THREE.BoxGeometry(1.3, 0.3, 0.06), '#f4f1ea', at(0.4, 2.1, 0)))
  parts.push(paint(new THREE.BoxGeometry(1.0, 0.3, 0.06), '#f4f1ea', at(-0.3, 1.7, 0, 0, 0)))
  parts.push(paint(new THREE.BoxGeometry(0.28, 0.28, 0.02), '#c94f3d', at(0.9, 2.1, -0.03)))
  return mergeParts(parts)
}

// ── 하늘 ────────────────────────────────────────────────────

function createCloud(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  phase: number,
) {
  const parts: [number, number, number, number][] = [
    [-1.25, -0.08, 0.02, 0.42], [-0.92, 0.02, 0.06, 0.56], [-0.48, 0.18, -0.04, 0.72],
    [0, 0.30, 0.02, 0.9], [0.53, 0.18, -0.02, 0.76], [1.02, 0.02, 0.04, 0.56],
    [1.32, -0.08, -0.02, 0.42], [-0.28, -0.12, 0.09, 0.66], [0.35, -0.12, 0.08, 0.7],
    [-0.7, -0.14, -0.3, 0.5], [0.8, -0.14, -0.28, 0.52],
  ]
  const cloud = new THREE.InstancedMesh(geometry, material, parts.length)
  const mirror = Math.sin(phase) < 0 ? -1 : 1
  const stretch = 0.92 + Math.abs(Math.cos(phase)) * 0.22
  for (let i = 0; i < parts.length; i++) {
    const [x, y, z, scale] = parts[i]!
    _position.set(x * mirror * stretch, y, z + Math.sin(phase + i) * 0.045)
    _scale.set(scale * (1.35 + stretch * 0.2), scale, scale * 0.92)
    _matrix.compose(_position, _quaternion.identity(), _scale)
    cloud.setMatrixAt(i, _matrix)
  }
  cloud.instanceMatrix.needsUpdate = true
  cloud.computeBoundingSphere()
  return cloud
}

/** 줄무늬 열기구. 봉투는 세로 띠를 색을 바꿔 가며 붙인다. */
function createBalloonGeometry(colors: [string, string]) {
  const parts: THREE.BufferGeometry[] = []
  const stripes = 10
  for (let i = 0; i < stripes; i++) {
    const g = new THREE.SphereGeometry(3.2, 3, 12, (i / stripes) * Math.PI * 2, (Math.PI * 2) / stripes, 0, Math.PI * 0.82)
    g.scale(1, 1.18, 1)
    parts.push(paint(g, colors[i % 2]!, at(0, 0, 0)))
  }
  parts.push(paint(new THREE.CylinderGeometry(1.5, 0.7, 1.6, 10, 1, true), colors[0], at(0, -3.3, 0)))
  parts.push(paint(new THREE.BoxGeometry(1.2, 0.9, 1.2), '#8a5f3a', at(0, -5.2, 0)))
  for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
    parts.push(paint(tubeBetween(v(x * 1.3, -4.0, z * 1.3), v(x, -4.8, z), 0.03), '#4a4a4a'))
  }
  return mergeParts(parts)
}

function createBlimpGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const hull = new THREE.SphereGeometry(2.4, 14, 10)
  hull.scale(3.4, 1, 1)
  parts.push(paint(hull, '#e6e9ec', at(0, 0, 0)))
  parts.push(paint(new THREE.BoxGeometry(2.6, 0.9, 5.2), '#c94f3d', g => { g.scale(1, 0.12, 1); g.translate(-6.4, 0.3, 0) }))
  parts.push(paint(new THREE.BoxGeometry(2.4, 3.6, 0.2), '#c94f3d', at(-6.6, 0.4, 0)))
  parts.push(paint(new THREE.BoxGeometry(3.0, 1.0, 1.2), '#3a4550', at(0.5, -2.5, 0)))
  parts.push(paint(new THREE.BoxGeometry(5.0, 0.7, 0.3), '#3f7fd6', at(1.0, 0, 2.35)))
  parts.push(paint(new THREE.BoxGeometry(5.0, 0.7, 0.3), '#3f7fd6', at(1.0, 0, -2.35)))
  return mergeParts(parts)
}

/** 새 한 마리 — 가운데가 꺾인 갈매기 모양. 날갯짓은 인스턴스 행렬로 준다. */
function createBirdGeometry() {
  const left = new THREE.BoxGeometry(0.28, 0.03, 0.9)
  left.rotateX(0.35)
  left.translate(0, 0.14, -0.42)
  const right = new THREE.BoxGeometry(0.28, 0.03, 0.9)
  right.rotateX(-0.35)
  right.translate(0, 0.14, 0.42)
  return mergePlain([left, right, new THREE.SphereGeometry(0.1, 6, 5)])
}

// ── 원경 ────────────────────────────────────────────────────

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
  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  return mesh
}

/** 강둑 바깥의 완만한 들판. 언덕과 숲이 물 위가 아니라 땅 위에 서게 한다. */
function createMeadowRibbon(
  path: CoursePath,
  side: Side,
  maxStation: number,
  material: THREE.Material,
) {
  const start = -500
  const step = 24
  const count = Math.ceil((maxStation - start) / step) + 1
  const positions = new Float32Array(count * 2 * 3)
  const indices: number[] = []
  for (let i = 0; i < count; i++) {
    const station = start + i * step
    const inner = offsetPathPoint(path, station, side * (BANK_OUTER_Z - 0.5))
    const outer = offsetPathPoint(path, station, side * MEADOW_OUTER_Z)
    positions.set([inner.x, 0.84, inner.z], i * 6)
    positions.set([outer.x, 0.2, outer.z], i * 6 + 3)
    if (i === count - 1) continue
    const a = i * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return new THREE.Mesh(geometry, material)
}

/** 먼 언덕 한 구간 — 겹친 봉우리 몇 개를 메시 하나로. */
function createHillSegment(random: () => number) {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 8; i++) {
    const x = -HILL_SEGMENT_LENGTH / 2 + (i + random()) * (HILL_SEGMENT_LENGTH / 8)
    const height = 16 + random() * 22
    const radius = 42 + random() * 36
    const cone = new THREE.SphereGeometry(radius, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)
    // 강 쪽으로는 납작하게 눌러 언덕 자락이 강둑까지 내려오지 않게 한다
    cone.scale(1, height / radius, 0.55 + random() * 0.3)
    cone.translate(x, -1, (random() - 0.5) * 24)
    parts.push(cone)
  }
  return mergePlain(parts)
}

/** 강둑 너머의 숲 띠 — 크기가 다른 둥근 나무와 뾰족한 나무가 섞여 있다. */
function createTreelineSegment(random: () => number) {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 20; i++) {
    const x = -TREELINE_SEGMENT_LENGTH / 2 + (i + random() * 0.9) * (TREELINE_SEGMENT_LENGTH / 20)
    const z = (random() - 0.5) * 7
    const h = 6 + random() * 7
    if (random() < 0.4) {
      const cone = new THREE.ConeGeometry(h * 0.32, h, 6)
      cone.translate(x, h / 2, z)
      parts.push(cone)
    } else {
      const ball = new THREE.SphereGeometry(h * 0.4, 7, 5)
      ball.scale(1, 1.1, 1)
      ball.translate(x, h * 0.6, z)
      parts.push(ball)
    }
  }
  return mergePlain(parts)
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
  private hillMaterial: THREE.MeshStandardMaterial
  private cloudMaterial!: THREE.MeshBasicMaterial
  private moonMaterial!: THREE.MeshBasicMaterial
  private skyUniforms = {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
  }
  private baseWeatherPalette: WeatherBasePalette
  private weatherAppearance = createWeatherAppearance()
  private foliage: FoliageMaterial[] = []
  private spectators: LoopObject[] = []
  private ducks: LoopObject[] = []
  private clouds: LoopObject[] = []
  private skyObjects: LoopObject[] = []
  private bankProps: LoopObject[] = []
  private farNodes: LoopObject[] = []
  private flagCloths: THREE.Mesh[] = []
  private birds!: THREE.InstancedMesh
  private birdNode!: LoopObject
  private bushes: THREE.InstancedMesh[] = []
  private bushLayout: SceneryLayout['bushes'] = []
  private bushSpan = 1
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
    // 그림자는 보트 주변만 — 로어와 배가 수면에 그림자를 떨어뜨려 물 위에 떠 있어 보인다.
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(1024, 1024)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 110
    this.sun.shadow.camera.left = -26
    this.sun.shadow.camera.right = 26
    this.sun.shadow.camera.top = 26
    this.sun.shadow.camera.bottom = -26
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.03
    this.scene.add(this.sun, this.sun.target)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25)
    this.scene.add(this.ambient)

    // ── 물 ──────────────────────────────────────────────────
    this.water = new Water(p.water, p.waterDeep)
    this.scene.add(this.water.mesh)

    // ── 강둑과 들판 ─────────────────────────────────────────
    this.bankMaterial = new THREE.MeshStandardMaterial({
      color: p.land, flatShading: true, roughness: 0.9, side: THREE.DoubleSide,
    })
    this.hillMaterial = new THREE.MeshStandardMaterial({
      color: p.land, flatShading: true, roughness: 1, fog: true,
    })
    const maxStation = course.durationSec * 8 + 1_000
    for (const side of [1, -1] as const) {
      const bank = createBankRibbon(this.path, side, maxStation, this.bankMaterial)
      bank.name = 'scenery:bank'
      const meadow = createMeadowRibbon(this.path, side, maxStation, this.bankMaterial)
      meadow.name = 'scenery:meadow'
      this.courseRoot.add(bank, meadow)
    }

    for (const [green, fall] of LEAF_PALETTES) {
      this.foliage.push({
        material: new THREE.MeshStandardMaterial({ color: green, flatShading: true, roughness: 0.95 }),
        green: new THREE.Color(green),
        fall: new THREE.Color(fall),
      })
    }

    // ── 살아 있는 강변 풍경 ────────────────────────────────
    this.buildScenery()

    // ── 랜드마크 ────────────────────────────────────────────
    this.courseRoot.add(this.landmarkGroup)
    this.buildLandmarks()

    // ── 날씨: 코스 구간마다 하나 ───────────────────────────
    const sections = profileSections(course.profile, course.durationSec)
    this.weather = new WeatherSystem(weatherSeed, course.durationSec, sections)
    this.scene.add(this.weather.root)
    this.applyWeather(this.weather.state)
  }

  private buildScenery() {
    const layout = createSceneryLayout(this.course.id)
    const p = this.course.venue.palette
    const random = seededRandom(`${this.course.id}:scenery-detail`)
    const painted = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 })
    const paintedSmooth = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.7 })
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, flatShading: true, roughness: 0.95 })
    const birchMaterial = new THREE.MeshStandardMaterial({ color: BIRCH_COLOR, flatShading: true, roughness: 0.8 })

    // ── 나무 ──────────────────────────────────────────────
    for (const item of layout.trees) {
      const tree = createTree(item.kind, this.foliage[item.leaf]!.material, trunkMaterial, birchMaterial, item.phase)
      tree.position.set(0, 0.7, item.z)
      tree.scale.setScalar(item.scale)
      tree.rotation.y = item.phase
      tree.rotation.z = item.lean
      tree.name = `scenery:tree:${item.kind}`
      this.courseRoot.add(tree)
      this.treeNodes.push({
        obj: tree, baseX: item.baseX, baseY: 0.7, baseZ: item.z, baseYaw: item.phase,
        span: layout.treeSpan, phase: item.phase, kind: item.kind,
      })
    }

    // ── 덤불 (인스턴스) ───────────────────────────────────
    this.bushLayout = layout.bushes
    this.bushSpan = layout.bushSpan
    const bushGeometry = new THREE.IcosahedronGeometry(0.75, 1)
    bushGeometry.scale(1.25, 0.85, 1.1)
    for (const leaf of [1, 5]) {
      const bush = new THREE.InstancedMesh(bushGeometry, this.foliage[leaf]!.material, layout.bushes.length)
      bush.castShadow = true
      bush.frustumCulled = false
      bush.name = 'scenery:bushes'
      this.courseRoot.add(bush)
      this.bushes.push(bush)
    }

    // ── 응원객 ────────────────────────────────────────────
    const spectatorSpan = Math.ceil(SPECTATOR_COUNT / 2) * 30
    for (const item of layout.spectators) {
      const geometry = createSpectatorGeometry({
        pose: item.pose,
        hat: item.hat,
        skin: SKIN_TONES[item.skinIndex]!,
        hair: HAIR_COLORS[item.hairIndex]!,
        shirt: SHIRT_COLORS[item.colorIndex]!,
        trousers: TROUSER_COLORS[item.trousersIndex]!,
        hatColor: HAT_COLORS[(item.colorIndex + item.hat) % HAT_COLORS.length]!,
      })
      const person = new THREE.Mesh(geometry, paintedSmooth)
      person.castShadow = true
      person.name = `scenery:spectator:${item.pose}`
      person.position.set(0, 0.85, item.z)
      person.scale.setScalar(item.scale)
      person.rotation.y = item.side > 0 ? 0 : Math.PI
      this.courseRoot.add(person)
      this.spectators.push({
        obj: person, baseX: item.baseX, baseY: 0.85, baseZ: item.z,
        baseYaw: person.rotation.y,
        span: spectatorSpan, phase: item.phase, animated: item.pose !== 'sit', kind: item.pose,
      })
    }

    // ── 오리와 백조 ───────────────────────────────────────
    const duckSpan = DUCK_COUNT * 46
    const duckGeometry = createDuckGeometry()
    for (const item of layout.ducks) {
      const duck = new THREE.Mesh(duckGeometry, paintedSmooth)
      duck.name = 'scenery:duck'
      duck.position.set(0, 0.15, item.z)
      duck.scale.setScalar(item.scale)
      duck.rotation.y = item.phase > Math.PI ? 0 : Math.PI
      this.courseRoot.add(duck)
      this.ducks.push({
        obj: duck, baseX: item.baseX, baseY: 0.15, baseZ: item.z,
        baseYaw: duck.rotation.y,
        span: duckSpan, phase: item.phase, animated: true, kind: 'duck',
      })
    }
    const swanGeometry = createSwanGeometry()
    for (const item of layout.swans) {
      const swan = new THREE.Mesh(swanGeometry, paintedSmooth)
      swan.name = 'scenery:swan'
      swan.position.set(0, 0.12, item.z)
      swan.scale.setScalar(item.scale)
      swan.rotation.y = item.phase > Math.PI ? 0 : Math.PI
      this.courseRoot.add(swan)
      this.ducks.push({
        obj: swan, baseX: item.baseX, baseY: 0.12, baseZ: item.z,
        baseYaw: swan.rotation.y,
        span: 300, phase: item.phase, animated: true, kind: 'swan',
      })
    }

    // ── 구름 ──────────────────────────────────────────────
    this.cloudMaterial = new THREE.MeshBasicMaterial({
      color: '#f6fbff', transparent: true, opacity: 0.9, depthWrite: false,
    })
    const cloudPuffGeometry = new THREE.SphereGeometry(0.68, 10, 7)
    const cloudSpan = CLOUD_COUNT * 70
    layout.clouds.forEach((item, index) => {
      const cloud = createCloud(cloudPuffGeometry, this.cloudMaterial, item.phase)
      const y = 28 + (index % 4) * 4.2 + item.scale * 1.5
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

    // ── 하늘: 열기구·비행선·새떼·달 ──────────────────────
    for (const item of layout.sky) {
      if (item.kind === 'birds') {
        this.birds = new THREE.InstancedMesh(createBirdGeometry(), new THREE.MeshStandardMaterial({ color: '#2f343a', roughness: 0.9 }), BIRD_COUNT)
        this.birds.frustumCulled = false
        this.birds.name = 'scenery:birds'
        this.scene.add(this.birds)
        this.birdNode = {
          obj: this.birds, baseX: item.baseX, baseY: 26 + item.phase, baseZ: item.z,
          baseYaw: 0, span: 520, phase: item.phase,
        }
        continue
      }
      const geometry = item.kind === 'balloon'
        ? createBalloonGeometry(BALLOON_COLORS[item.colorIndex]!)
        : createBlimpGeometry()
      const mesh = new THREE.Mesh(geometry, painted)
      mesh.name = `scenery:${item.kind}`
      const y = item.kind === 'balloon' ? 34 + item.phase * 3 : 44
      mesh.position.set(0, y, item.z)
      mesh.scale.setScalar(item.scale)
      this.scene.add(mesh)
      this.skyObjects.push({
        obj: mesh, baseX: item.baseX, baseY: y, baseZ: item.z, baseYaw: 0,
        span: item.kind === 'balloon' ? 640 : 900, phase: item.phase, kind: item.kind,
      })
    }
    this.moonMaterial = new THREE.MeshBasicMaterial({
      color: '#f4efe2', transparent: true, opacity: 0, depthWrite: false, fog: false,
    })
    const moon = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 10), this.moonMaterial)
    moon.position.set(150, 34, 55)
    moon.name = 'scenery:moon'
    this.scene.add(moon)

    // ── 강둑 소품 ─────────────────────────────────────────
    const flagMaterial = new THREE.MeshStandardMaterial({ color: '#c94f3d', side: THREE.DoubleSide, roughness: 0.8 })
    const propSpan = Math.ceil(PROP_COUNT / 2) * 60
    for (const [index, item] of layout.props.entries()) {
      let prop: THREE.Object3D
      let flat = true
      let yaw = item.side > 0 ? 0 : Math.PI
      switch (item.kind) {
        case 'cottage': prop = new THREE.Mesh(createCottageGeometry(p.landmark), painted); break
        case 'manor': prop = new THREE.Mesh(createManorGeometry(p.landmark), painted); break
        case 'deer': case 'sheep': case 'cow':
          prop = new THREE.Mesh(createFourLeggedGeometry(item.kind), paintedSmooth)
          flat = false
          yaw = item.phase
          break
        case 'heron': prop = new THREE.Mesh(createHeronGeometry(), paintedSmooth); yaw = item.phase > Math.PI ? 0 : Math.PI; break
        case 'bench': prop = new THREE.Mesh(createBenchGeometry(), painted); break
        case 'lamp': prop = new THREE.Mesh(createLampGeometry(), painted); break
        case 'jetty': prop = new THREE.Mesh(createJettyGeometry(), painted); break
        case 'rowboat': prop = new THREE.Mesh(createRowboatGeometry(), painted); yaw = item.phase * 0.2; break
        case 'tent': prop = new THREE.Mesh(createTentGeometry(), painted); break
        case 'flag': {
          const group = new THREE.Group()
          group.add(new THREE.Mesh(createFlagPoleGeometry(), painted))
          const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.3, 8, 3), flagMaterial)
          cloth.geometry.translate(1.1, 0, 0)
          cloth.position.set(0.06, 5.75, 0)
          this.flagCloths.push(cloth)
          group.add(cloth)
          prop = group
          break
        }
        case 'shrub': prop = new THREE.Mesh(createShrubGeometry(LEAF_PALETTES[1]![0]), painted); yaw = item.phase; break
        case 'rocks': prop = new THREE.Mesh(createRocksGeometry(), painted); yaw = item.phase; break
        case 'boatshed': prop = new THREE.Mesh(createBoatshedGeometry(), painted); break
        case 'picnic': prop = new THREE.Mesh(createPicnicGeometry(), painted); yaw = item.phase; break
        case 'signpost': prop = new THREE.Mesh(createSignpostGeometry(), painted); break
      }
      void flat
      prop.traverse(node => { if (node instanceof THREE.Mesh) node.castShadow = true })
      prop.name = `scenery:${item.kind}`
      const y = item.kind === 'jetty' ? 0.85 : item.kind === 'rowboat' ? 0.05 : 0.85
      prop.position.set(0, y, item.z)
      prop.scale.setScalar(item.scale)
      prop.rotation.y = yaw
      this.courseRoot.add(prop)
      this.bankProps.push({
        obj: prop, baseX: item.baseX, baseY: y, baseZ: item.z,
        baseYaw: yaw,
        // 각 종류의 반복 주기를 다르게 두어 전체 풍경이 같은 조합으로 되풀이되지 않게 한다.
        span: propSpan + index * 37,
        phase: item.phase,
        animated: item.kind === 'deer' || item.kind === 'sheep' || item.kind === 'cow'
          || item.kind === 'heron' || item.kind === 'rowboat',
        kind: item.kind,
      })
    }

    // ── 원경: 숲 띠와 언덕 ────────────────────────────────
    for (const side of [1, -1] as const) {
      for (let i = 0; i < 3; i++) {
        const strip = new THREE.Mesh(createTreelineSegment(random), this.foliage[i % 2 === 0 ? 2 : 4]!.material)
        strip.name = 'scenery:treeline'
        const z = side * (BANK_OUTER_Z + 3 + random() * 3)
        strip.position.set(0, 0.7, z)
        this.courseRoot.add(strip)
        this.farNodes.push({
          obj: strip, baseX: i * TREELINE_SEGMENT_LENGTH, baseY: 0.7, baseZ: z, baseYaw: 0,
          span: TREELINE_SEGMENT_LENGTH * 3, phase: 0,
        })
      }
      for (let i = 0; i < 2; i++) {
        const hills = new THREE.Mesh(createHillSegment(random), this.hillMaterial)
        hills.name = 'scenery:hills'
        const z = side * (150 + random() * 30)
        hills.position.set(0, 0, z)
        this.courseRoot.add(hills)
        this.farNodes.push({
          obj: hills, baseX: i * HILL_SEGMENT_LENGTH, baseY: 0, baseZ: z, baseYaw: 0,
          span: HILL_SEGMENT_LENGTH * 2, phase: 0,
        })
      }
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
    this.sun.color.copy(appearance.sunColor)
    this.hemi.intensity = appearance.hemiIntensity
    this.hemi.color.copy(appearance.skyTop)
    this.hemi.groundColor.copy(appearance.water)
    this.ambient.intensity = appearance.ambientIntensity
    this.cloudMaterial.color.copy(appearance.cloud)
    this.cloudMaterial.opacity = appearance.cloudOpacity
    this.bankMaterial.color.copy(appearance.land)
    // 먼 언덕은 하늘색이 섞여 멀어 보인다 (대기 원근)
    this.hillMaterial.color.copy(appearance.land).lerp(appearance.skyBottom, 0.5)
    for (const leaf of this.foliage) {
      leaf.material.color.copy(leaf.green).lerp(leaf.fall, appearance.autumn)
        .multiplyScalar(appearance.foliageLight)
    }
    // 달은 황금빛 오후와 눈 오는 날에 은은하게 보인다
    const b = weather.base
    this.moonMaterial.opacity = b.sun * 0.7 + b.snow * 0.4 + b.autumn * 0.22 + b.clear * 0.12 + b.wind * 0.2
    this.water.setPalette(appearance.water, appearance.waterDeep)
    this.water.setWeather(weather.windStrength, weather.base.rain, appearance.sparkle)
  }

  private buildLandmarks() {
    const p = this.course.venue.palette
    const mat = new THREE.MeshStandardMaterial({ color: p.landmark, flatShading: true, roughness: 0.8 })
    const painted = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82 })
    const accent = new THREE.MeshStandardMaterial({ color: '#ff9f43', flatShading: true })
    const gateMat = new THREE.MeshStandardMaterial({ color: '#3b2f26', flatShading: true, roughness: 0.9 })
    const sailMat = new THREE.MeshStandardMaterial({ color: '#e8e2d4', flatShading: true, roughness: 0.85 })
    const windowMat = new THREE.MeshStandardMaterial({ color: '#294c62', roughness: 0.28 })
    const random = seededRandom(`${this.course.id}:landmarks`)

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

        case 'footbridge': {
          // 낮은 목조 아치 다리. 가운데가 6m라 가장 바깥 레인의 노 끝(z≈11.4)에서도 4m가 남는다.
          const parts: THREE.BufferGeometry[] = []
          const HALF = 15
          const segments = 16
          const yAt = (z: number) => 6.0 - (z / HALF) * (z / HALF) * 3.2
          for (let i = 0; i < segments; i++) {
            const z0 = -HALF + (i / segments) * HALF * 2
            const z1 = -HALF + ((i + 1) / segments) * HALF * 2
            const from = v(0, yAt(z0), z0)
            const to = v(0, yAt(z1), z1)
            const length = from.distanceTo(to)
            const deck = new THREE.BoxGeometry(2.6, 0.32, length + 0.08)
            const angle = Math.atan2(to.y - from.y, to.z - from.z)
            deck.rotateX(-angle)
            deck.translate(0, (from.y + to.y) / 2, (from.z + to.z) / 2)
            parts.push(paint(deck, i % 2 ? '#9a7250' : '#8a6444'))
            if (i % 2 === 0) {
              for (const x of [-1.2, 1.2]) {
                parts.push(paint(new THREE.BoxGeometry(0.12, 1.1, 0.12), '#6b4a2f', at(x, from.y + 0.7, from.z)))
              }
            }
          }
          for (const x of [-1.2, 1.2]) {
            for (let i = 0; i < segments; i++) {
              const z0 = -HALF + (i / segments) * HALF * 2
              const z1 = -HALF + ((i + 1) / segments) * HALF * 2
              parts.push(paint(tubeBetween(v(x, yAt(z0) + 1.15, z0), v(x, yAt(z1) + 1.15, z1), 0.05), '#6b4a2f'))
            }
          }
          for (const z of [-HALF - 0.5, HALF + 0.5]) {
            parts.push(paint(new THREE.BoxGeometry(3.2, 3.2, 1.6), '#8a8d94', at(0, 1.4, z)))
          }
          g.add(new THREE.Mesh(mergeParts(parts), painted))
          break
        }

        case 'suspension': {
          // 두 탑 사이에 케이블이 늘어진 현수교. 상판이 12m라 모든 레인이 넉넉히 지난다.
          const parts: THREE.BufferGeometry[] = []
          const HALF = 30, DECK_Y = 12, TOWER_Z = 15, TOWER_H = 30
          parts.push(paint(new THREE.BoxGeometry(6, 0.9, HALF * 2), '#6f7780', at(0, DECK_Y, 0)))
          for (const x of [-2.8, 2.8]) parts.push(paint(new THREE.BoxGeometry(0.3, 1.0, HALF * 2), '#c94f3d', at(x, DECK_Y + 0.9, 0)))
          for (const z of [-TOWER_Z, TOWER_Z]) {
            for (const x of [-2.6, 2.6]) {
              parts.push(paint(new THREE.BoxGeometry(1.4, TOWER_H, 1.6), '#c94f3d', at(x, TOWER_H / 2, z)))
            }
            parts.push(paint(new THREE.BoxGeometry(6.6, 1.2, 1.4), '#c94f3d', at(0, TOWER_H - 1, z)))
            parts.push(paint(new THREE.BoxGeometry(6.6, 1.0, 1.4), '#c94f3d', at(0, DECK_Y + 6, z)))
          }
          const cableY = (z: number) => {
            const t = Math.min(1, Math.abs(z) / TOWER_Z)
            return DECK_Y + 2.5 + (TOWER_H - DECK_Y - 2.5) * t * t
          }
          for (const x of [-2.6, 2.6]) {
            const steps = 20
            for (let i = 0; i < steps; i++) {
              const z0 = -HALF + (i / steps) * HALF * 2
              const z1 = -HALF + ((i + 1) / steps) * HALF * 2
              const y0 = Math.abs(z0) > TOWER_Z ? TOWER_H - (Math.abs(z0) - TOWER_Z) * 1.1 : cableY(z0)
              const y1 = Math.abs(z1) > TOWER_Z ? TOWER_H - (Math.abs(z1) - TOWER_Z) * 1.1 : cableY(z1)
              parts.push(paint(tubeBetween(v(x, y0, z0), v(x, y1, z1), 0.13), '#2b2f36'))
              if (i % 2 === 0 && Math.abs(z0) < TOWER_Z - 1) {
                parts.push(paint(tubeBetween(v(x, DECK_Y + 0.4, z0), v(x, y0, z0), 0.05), '#2b2f36'))
              }
            }
          }
          g.add(new THREE.Mesh(mergeParts(parts), painted))
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
        case 'lighthouse': {
          const parts: THREE.BufferGeometry[] = []
          for (let i = 0; i < 5; i++) {
            const r0 = 2.9 - i * 0.22
            const r1 = 2.68 - i * 0.22
            parts.push(paint(new THREE.CylinderGeometry(r1, r0, 3.4, 12), i % 2 ? '#c94f3d' : '#f4f1ea', at(0, 1.7 + i * 3.4, 0)))
          }
          parts.push(paint(new THREE.CylinderGeometry(2.4, 2.4, 0.4, 12), '#2f3a44', at(0, 17.2, 0)))
          parts.push(paint(new THREE.CylinderGeometry(1.5, 1.5, 2.6, 10), '#9fd0e8', at(0, 18.7, 0)))
          parts.push(paint(new THREE.ConeGeometry(1.9, 1.6, 10), '#2f3a44', at(0, 20.8, 0)))
          parts.push(paint(new THREE.BoxGeometry(1.2, 2.2, 0.2), '#2f3a44', at(0, 1.1, -2.85)))
          parts.push(paint(new THREE.BoxGeometry(6, 2.2, 5), '#f4f1ea', at(-4.5, 1.1, 0)))
          parts.push(paint(new THREE.ConeGeometry(4.2, 1.6, 4), '#c94f3d', at(-4.5, 3.0, 0, Math.PI / 4)))
          g.add(new THREE.Mesh(mergeParts(parts), painted))
          g.position.z = BANK_Z + 5
          break
        }
        case 'church': {
          const parts: THREE.BufferGeometry[] = []
          const stone = '#d9d0bd'
          parts.push(paint(new THREE.BoxGeometry(18, 7, 8), stone, at(0, 3.5, 0)))
          const nave = new THREE.ConeGeometry(6.2, 3.4, 4)
          nave.rotateY(Math.PI / 4)
          nave.scale(2.1, 1, 0.95)
          parts.push(paint(nave, '#5b4a44', at(0, 8.7, 0)))
          parts.push(paint(new THREE.BoxGeometry(5, 19, 5), stone, at(-9.5, 9.5, 0)))
          parts.push(paint(new THREE.ConeGeometry(3.4, 9, 4), '#5b4a44', at(-9.5, 23.5, 0, Math.PI / 4)))
          parts.push(paint(new THREE.SphereGeometry(0.5, 6, 5), '#e8c25a', at(-9.5, 28.2, 0)))
          for (const x of [-4, 0, 4]) {
            parts.push(paint(new THREE.BoxGeometry(1.2, 3.2, 0.2), '#5a8db0', at(x, 3.8, -4.05)))
            parts.push(paint(new THREE.ConeGeometry(0.6, 0.8, 4), '#5a8db0', at(x, 5.8, -4.05, Math.PI / 4)))
          }
          parts.push(paint(new THREE.BoxGeometry(1.6, 3.4, 0.2), '#3c3431', at(-9.5, 1.7, -2.55)))
          parts.push(paint(new THREE.CylinderGeometry(0.9, 0.9, 0.2, 12), '#f4f1ea', at(-9.5, 14, -2.55, 0, 0, Math.PI / 2)))
          g.add(new THREE.Mesh(mergeParts(parts), painted))
          g.position.z = BANK_Z + 9
          break
        }
        case 'townhouses': {
          // 폭·높이·색이 다른 집이 어깨를 맞대고 늘어선 강변 마을.
          const parts: THREE.BufferGeometry[] = []
          const colors = ['#e6c9a8', '#c94f3d', '#f4f1ea', '#5a8db0', '#e8b45a', '#8f9aa6', '#d4a5a5']
          let x = -16
          for (let i = 0; i < 6; i++) {
            const width = 4.5 + random() * 2.5
            const height = 7 + random() * 5
            const color = colors[Math.floor(random() * colors.length)]!
            const cx = x + width / 2
            parts.push(paint(new THREE.BoxGeometry(width, height, 7), color, at(cx, height / 2, 0)))
            if (random() < 0.6) {
              const roof = new THREE.ConeGeometry(width * 0.72, 2.6, 4)
              roof.rotateY(Math.PI / 4)
              roof.scale(1, 1, 7 / (width * 1.02))
              parts.push(paint(roof, i % 2 ? '#6f4535' : '#3a3f45', at(cx, height + 1.3, 0)))
            } else {
              parts.push(paint(new THREE.BoxGeometry(width * 0.6, 1.8, 2), '#3a3f45', at(cx, height + 0.9, 0)))
            }
            const rows = Math.floor(height / 2.8)
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < 2; c++) {
                parts.push(paint(new THREE.BoxGeometry(0.9, 1.2, 0.16), '#2f4d63', at(cx - width / 4 + c * (width / 2), 1.9 + r * 2.8, -3.55)))
              }
            }
            parts.push(paint(new THREE.BoxGeometry(1.0, 2.0, 0.16), '#3c3431', at(cx, 1.0, -3.55)))
            x += width
          }
          g.add(new THREE.Mesh(mergeParts(parts), painted))
          g.position.z = BANK_Z + 8
          break
        }
        case 'grandstand': {
          // 물가를 향해 계단식으로 올라가는 관중석과 캔틸레버 지붕.
          const parts: THREE.BufferGeometry[] = []
          const tiers = 6
          for (let i = 0; i < tiers; i++) {
            const depth = 1.6
            const z = i * depth
            parts.push(paint(new THREE.BoxGeometry(24, 0.9 + i * 0.9, depth), '#8f9aa6', at(0, (0.9 + i * 0.9) / 2, z + depth / 2)))
            for (let s = 0; s < 12; s++) {
              parts.push(paint(new THREE.BoxGeometry(1.6, 0.5, 0.7), s % 3 === 0 ? '#c94f3d' : s % 3 === 1 ? '#3f7fd6' : '#e8c25a', at(-11 + s * 2, 0.9 + i * 0.9 + 0.25, z + depth / 2 + 0.3)))
            }
          }
          const roofY = 1.2 + tiers * 0.9 + 3.6
          parts.push(paint(new THREE.BoxGeometry(26, 0.5, 11), '#f4f1ea', at(0, roofY, 4.5, 0, 0, -0.14)))
          for (const x of [-11, 0, 11]) {
            parts.push(paint(new THREE.BoxGeometry(0.6, roofY, 0.6), '#5c5c5c', at(x, roofY / 2, 9.6)))
          }
          parts.push(paint(new THREE.BoxGeometry(24, 1.4, 0.3), '#2f4d63', at(0, roofY - 1.0, -0.6)))
          g.add(new THREE.Mesh(mergeParts(parts), painted))
          g.position.z = BANK_Z + 4
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
          const leafParts: THREE.BufferGeometry[] = []
          for (let i = 0; i < 7; i++) {
            const h = 5 + ((i * 41) % 30) / 10
            const cone = new THREE.ConeGeometry(h * 0.34, h, 6)
            cone.translate(((i * 29) % 18) - 9, h / 2, BANK_Z + 3 + ((i * 17) % 60) / 10)
            leafParts.push(cone)
          }
          g.add(new THREE.Mesh(mergePlain(leafParts), this.foliage[4]!.material))
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
      g.traverse(node => { if (node instanceof THREE.Mesh && lm.kind !== 'buoy') node.castShadow = true })
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
    const wind = weather.windStrength

    // 풍차 날개는 바람 세기에 따라 빨라진다
    const spin = animationTimeSec * (0.35 + wind * 0.9)
    for (const s of this.spinners) s.rotation.z = spin
    this.water.update(animationTimeSec, distance)
    this.sky.position.x = cameraX
    this.nearby.duck.distance = Number.POSITIVE_INFINITY
    this.nearby.duck.pan = 0
    this.nearby.spectator.distance = Number.POSITIVE_INFINITY
    this.nearby.spectator.pan = 0

    // 나무: 종류별로 다르게 흔들린다 — 포플러와 자작나무는 낭창하게, 참나무는 묵직하게
    for (const node of this.treeNodes) {
      const along = wrappedLoopX(node.baseX, distance, node.span, -node.span * 0.35)
      this.placeOnPath(node.obj, distance + along, node.baseZ, node.baseYaw)
      node.obj.position.y = node.baseY
      const supple = node.kind === 'poplar' || node.kind === 'birch' ? 1.8 : node.kind === 'willow' ? 1.3 : 0.8
      node.obj.rotation.z = Math.sin(animationTimeSec * 1.5 + node.phase)
        * (0.02 + wind * 0.04) * supple
    }

    // 덤불은 인스턴스 행렬만 갱신한다
    for (const bushMesh of this.bushes) {
      const which = this.bushes.indexOf(bushMesh)
      for (let i = 0; i < this.bushLayout.length; i++) {
        const item = this.bushLayout[i]!
        // 두 덤불 메시가 같은 자리를 나눠 갖는다 — 절반씩 서로 다른 잎색
        const mine = i % 2 === which
        const along = wrappedLoopX(item.baseX, distance, this.bushSpan, -60)
        const point = offsetPathPoint(this.path, distance + along, item.z)
        _position.set(point.x, mine ? 0.85 : -50, point.z)
        _euler.set(0, item.phase - point.heading, 0)
        _quaternion.setFromEuler(_euler)
        _scale.setScalar(item.scale)
        _matrix.compose(_position, _quaternion, _scale)
        bushMesh.setMatrixAt(i, _matrix)
      }
      bushMesh.instanceMatrix.needsUpdate = true
    }

    // 응원객은 강둑을 따라 반복되고, 서 있는 사람은 팔을 든 채 가볍게 점프한다
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
      const bounce = node.kind === 'cheer' || node.kind === 'wave' ? 0.07 : node.kind === 'clap' ? 0.02 : 0
      node.obj.position.y = node.baseY
        + Math.max(0, Math.sin(animationTimeSec * 3.2 + node.phase)) * bounce
      node.obj.rotation.z = (node.animated ? Math.sin(animationTimeSec * 2.7 + node.phase) * 0.025 : 0)
        + Math.sin(animationTimeSec * 1.2 + node.phase) * wind * 0.018
    }

    // 오리와 백조는 물 위를 천천히 헤엄치며 위아래로 떠오른다
    for (const node of this.ducks) {
      const drift = node.kind === 'swan' ? 0.22 : 0.32
      const along = wrappedLoopX(
        node.baseX, distance - animationTimeSec * drift, node.span, -72,
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
        distance * 0.12 - animationTimeSec * (0.5 + wind * 2.1),
        node.span,
        -145,
      )
      node.obj.position.y = node.baseY - weather.cloudiness * 1.8
        + Math.sin(animationTimeSec * 0.16 + node.phase) * 0.32
      node.obj.position.z = node.baseZ
    }

    // 열기구와 비행선은 바람을 타고 아주 천천히 떠간다. 흐리면 낮게 가라앉는다.
    for (const node of this.skyObjects) {
      const speed = node.kind === 'blimp' ? 1.6 : 0.35 + wind * 0.9
      node.obj.position.x = wrappedLoopX(
        node.baseX, distance * 0.18 - animationTimeSec * speed, node.span, -220,
      )
      node.obj.position.y = node.baseY - weather.cloudiness * 6
        + Math.sin(animationTimeSec * 0.35 + node.phase) * 0.6
      node.obj.position.z = node.baseZ + Math.sin(animationTimeSec * 0.11 + node.phase) * 4
      node.obj.rotation.y = node.kind === 'blimp' ? Math.PI : Math.sin(animationTimeSec * 0.2 + node.phase) * 0.3
      // 비·눈에는 하늘 오브젝트가 사라진다
      node.obj.visible = weather.base.rain + weather.base.snow < 0.6
    }

    // 새떼: V자 대형으로 날며 날개를 젓는다
    if (this.birds) {
      const node = this.birdNode
      const headX = wrappedLoopX(node.baseX, distance * 0.3 - animationTimeSec * 6, node.span, -260)
      for (let i = 0; i < BIRD_COUNT; i++) {
        const rank = Math.ceil(i / 2)
        const wing = i === 0 ? 0 : (i % 2 ? 1 : -1)
        const flap = Math.sin(animationTimeSec * 9 + i * 0.7) * 0.55
        _position.set(headX - rank * 2.2, node.baseY + Math.sin(animationTimeSec * 1.3 + i) * 0.4 - rank * 0.3, node.baseZ + wing * rank * 2.4)
        _euler.set(flap, 0, 0)
        _quaternion.setFromEuler(_euler)
        _scale.setScalar(1.6)
        _matrix.compose(_position, _quaternion, _scale)
        this.birds.setMatrixAt(i, _matrix)
      }
      this.birds.instanceMatrix.needsUpdate = true
      this.birds.visible = weather.base.rain + weather.base.snow < 0.6
    }

    // 깃발은 바람에 펄럭인다
    for (const cloth of this.flagCloths) {
      const position = cloth.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i)
        position.setZ(i, Math.sin(x * 2.2 - animationTimeSec * (4 + wind * 5)) * (0.06 + wind * 0.22) * x)
      }
      position.needsUpdate = true
    }

    // 오두막·저택과 동물은 고정 풀을 재활용한다 — 긴 코스에서도 오브젝트 수가 늘지 않는다
    for (const node of this.bankProps) {
      const along = wrappedLoopX(node.baseX, distance, node.span, -82)
      this.placeOnPath(node.obj, distance + along, node.baseZ, node.baseYaw)
      node.obj.position.y = node.baseY + (node.animated
        ? Math.sin(animationTimeSec * 1.4 + node.phase) * 0.018
        : 0)
      if (node.kind === 'rowboat') node.obj.rotation.z = Math.sin(animationTimeSec * 1.1 + node.phase) * 0.04
    }

    // 원경 언덕과 숲 띠
    for (const node of this.farNodes) {
      const along = wrappedLoopX(node.baseX, distance, node.span, -node.span * 0.4)
      this.placeOnPath(node.obj, distance + along, node.baseZ, node.baseYaw)
      node.obj.position.y = node.baseY
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
