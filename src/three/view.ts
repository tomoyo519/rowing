import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { World, type AmbientPresence } from './world'
import { markReflective, PlanarReflection } from './reflection'
import { initialQuality, QUALITY_PRESETS, QualityGovernor, type QualitySettings, type QualityTier } from './quality'
import { applyAnisotropy } from './textures'
import { Rig, COLORS_PLAYER, COLORS_PACE, COLORS_GHOST, COLORS_RIVALS, type RigBody } from './rig'
import { Shark } from './shark'
import { projectedDistance } from '../game/courses'
import { splitToSpeed } from '../game/physics'
import { StrokeEngine } from '../game/stroke'
import {
  createCoursePath,
  localPathPoint,
  PACE_LANE_OFFSET,
  GHOST_LANE_OFFSET,
  PLAYER_LANE_OFFSET,
  SHARK_LANE_OFFSET,
  type CoursePath,
} from '../game/coursePath'
import type { Session } from '../game/state'
import { SHARK_BITE_REACH } from '../game/modes'

/** 상대 보트·상어는 내 보트에서 이 거리(m) 안에 있을 때만 그린다 */
const ACTOR_VISIBLE_M = 90
/**
 * 상어 시점(상어 모드) 카메라가 보는 레이어. 반사 레이어(1)와 겹치지 않게 2.
 * 추격 카메라는 앞만 보므로 뒤에서 오는 상어는 물릴 때까지 안 보인다 — 가로 화면에서는 왼쪽 절반,
 * 세로 화면에서는 위쪽 띠에 상어 뒤를 따라가는 카메라를 하나 더 그린다.
 * 하늘·물·강둑·나무·언덕·구름·내 보트·상어만 그려서 응원객·소품·랜드마크 몫의 드로우콜을 아낀다.
 */
const SHARK_VIEW_LAYER = 2

interface ViewportRect { x: number; y: number; w: number; h: number }

/** 페이스 보트가 나란히 달리는 옆 레인 간격 (m) */
export const PACE_LANE_Z = PACE_LANE_OFFSET - PLAYER_LANE_OFFSET

const TURN_LOOK_AHEAD_M = 42
const FULL_TURN_YAW = THREE.MathUtils.degToRad(8)
const PLAYER_YAW_MAX = THREE.MathUtils.degToRad(2.2)
const PLAYER_LEAN_MAX = THREE.MathUtils.degToRad(1.7)
const CAMERA_BANK_MAX = THREE.MathUtils.degToRad(3.5)
const CAMERA_OUTSIDE_MAX = 0.9
const CAMERA_LOOK_INSIDE_MAX = 1.5

export interface TurnEffects {
  playerYaw: number
  playerLean: number
  cameraBank: number
  cameraLateral: number
  cameraLookZ: number
}

/** 오브젝트(와 자식)를 보조 카메라 레이어에도 올린다. 메인 카메라에는 그대로 보인다 */
function enableLayer(object: THREE.Object3D, layer: number) {
  object.traverse(node => node.layers.enable(layer))
}

/** 42m 앞의 진행 방향을 기준으로 -1..1 범위의 커브 강도를 만든다. */
export function turnStrengthAt(path: CoursePath, distance: number) {
  const ahead = localPathPoint(
    path, distance, TURN_LOOK_AHEAD_M, PLAYER_LANE_OFFSET, PLAYER_LANE_OFFSET,
  )
  return THREE.MathUtils.clamp(ahead.yaw / FULL_TURN_YAW, -1, 1)
}

/** 커브 강도를 보트의 선회/기울기와 카메라 움직임으로 변환한다. */
export function turnEffects(strength: number): TurnEffects {
  const t = THREE.MathUtils.clamp(strength, -1, 1)
  return {
    playerYaw: -t * PLAYER_YAW_MAX,
    playerLean: t * PLAYER_LEAN_MAX,
    cameraBank: -t * CAMERA_BANK_MAX,
    cameraLateral: -t * CAMERA_OUTSIDE_MAX,
    cameraLookZ: t * CAMERA_LOOK_INSIDE_MAX,
  }
}

/**
 * 페이스 보트의 스트로크 레이트.
 * 구간 강도에 따라 오르내리고, 기준 스플릿이 빠를수록 기본 레이트도 높다 —
 * 1:45 페이스를 24spm으로 젓는 배는 없다.
 */
export function paceStrokeRate(intensity: number, baseSplit = 145) {
  const base = 24 + (145 - baseSplit) * 0.2
  return Math.max(18, Math.min(38, base + (intensity - 1) * 45))
}

/**
 * 카메라 프리셋. 기본값은 첨부 레퍼런스처럼 선미 뒤 중앙에서 따라가는 시점이다.
 */
export interface CamPreset {
  name: string
  pos: [number, number, number]
  look: [number, number, number]
  fov: number
  /** 세로 화면에서 쓸 화각 */
  fovPortrait: number
}

export const CAMERAS: CamPreset[] = [
  { name: '추격', pos: [-11.5, 2.65, 0], look: [2.0, 0.62, 0], fov: 44, fovPortrait: 66 },
  { name: '쿼터', pos: [-9.0, 3.2, 6.5], look: [2.0, 0.55, 0], fov: 48, fovPortrait: 68 },
  // 정면: 뱃머리 쪽에서 뒤를 돌아본다 — 로어의 뒤통수가 보인다.
  // 로어는 진행 반대편을 보고 앉으므로, 뒤통수를 보려면 카메라가 앞에 있어야 하고
  // 그 대가로 보이는 풍경은 '앞으로 올 코스'가 아니라 '지나온 코스'가 된다.
  // 퍼들과 강둑이 뒤로 멀어지면서 속도감을 만든다.
  { name: '정면', pos: [12.4, 2.8, 0], look: [-1.0, 0.8, 0], fov: 42, fovPortrait: 72 },
  { name: '사이드', pos: [-4.4, 4.8, 11.0], look: [0, 0.62, 0], fov: 50, fovPortrait: 70 },
]

export class View {
  readonly renderer: THREE.WebGLRenderer
  private camera: THREE.PerspectiveCamera
  private world: World
  private player: Rig
  /** 클래식 모드의 페이스 보트. 상어·추월 모드에서는 상어·라이벌이 그 자리를 맡아 만들지 않는다 */
  private pace: Rig | null = null
  /** 지난 최고 기록이 있을 때만 만든다 */
  private ghost: Rig | null = null
  private ghostStroke = new StrokeEngine(3)
  private ghostSpeed = 0
  private total: number
  private paceStroke = new StrokeEngine(2)
  /** 상어 추격 모드 */
  private shark: Shark | null = null
  /** 마지막으로 본 물린 횟수 — 늘어나면 무는 연출을 시작한다 */
  private sharkCaught = 0
  /** 상어 시점 카메라 (상어 모드). 상어 뒤에서 상어와 그 앞의 내 보트를 본다 */
  private sharkCamera: THREE.PerspectiveCamera | null = null
  /** 상어 시점을 그릴 화면 영역 (CSS px, 좌상단 기준). HUD의 틀 요소를 재서 정한다 */
  private sharkRect: ViewportRect | null = null
  private sharkFrame: HTMLElement | null = null
  /**
   * 메인 카메라가 차지하는 영역. 가로 화면의 좌우 분할에서는 오른쪽 절반이고,
   * null이면 캔버스 전체다 (세로 화면에서는 상어 시점이 위쪽 띠로 덮일 뿐이다).
   */
  private mainRect: ViewportRect | null = null
  /**
   * 추월 레이스의 라이벌 두 벌. 추월하면 지나간 배는 제 속도로 뒤로 멀어지고
   * 다른 벌이 새 라이벌로 앞에 선다 — 한 벌로 순간이동시키면 눈에 띈다.
   */
  private rivals: Rig[] = []
  private rivalStrokes: StrokeEngine[] = []
  private rivalSpeeds: number[] = []
  /** 지금 라이벌이 쓰는 벌 (0/1). 추월할 때마다 바뀐다 */
  private rivalSlot = 0
  private rivalIndex = -1
  private camShake = 0
  private frameZ = 0
  private turnStrength = 0
  private camIndex = 0
  private path: CoursePath
  /** 수면 평면 반사 — 메인 렌더 전에 장면을 한 번 더 그린다 */
  private reflection: PlanarReflection
  /** 프레임 시간을 보고 품질 티어를 내린다 */
  private governor: QualityGovernor
  private quality: QualitySettings
  /** 블룸·SMAA 후처리 체인. low 티어에서는 없고 렌더러가 화면에 직접 그린다 */
  private composer: EffectComposer | null = null
  private composerTarget: THREE.WebGLRenderTarget | null = null

  /** @param body 플레이어(와 지난 기록의 고스트) 아바타 체형 */
  constructor(canvas: HTMLCanvasElement, session: Session, body: RigBody = 'male') {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    // 보트·로어·나무가 수면과 강둑에 그림자를 떨어뜨린다. 그림자 카메라는 보트 주변 ±30m만 덮는다.
    this.renderer.shadowMap.enabled = true
    // 부드러운 그림자 가장자리 — 딱딱한 계단 그림자는 장난감처럼 보인다 (반경은 sun.shadow.radius)
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    // 드로우콜·삼각형 통계를 반사·메인·후처리 패스를 합쳐 프레임 단위로 센다 (render()에서 reset)
    this.renderer.info.autoReset = false
    // 반사 패스와 메인 패스가 같은 그림자 맵을 쓴다 — 프레임마다 한 번만 굽는다 (render()에서 needsUpdate)
    this.renderer.shadowMap.autoUpdate = false

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 500)

    this.world = new World(session.course, session.weatherSeed)
    this.world.attachWeatherToCamera(this.camera)
    this.reflection = new PlanarReflection(this.renderer)
    const initial = initialQuality()
    this.governor = new QualityGovernor(initial.tier, initial.locked, tier => this.applyQuality(QUALITY_PRESETS[tier]))
    this.quality = this.governor.settings
    this.total = projectedDistance(session.course, session.baseSplit)
    this.path = createCoursePath(session.course.id)

    this.player = new Rig(COLORS_PLAYER, 1, 0, body)
    this.world.scene.add(this.player.group)

    if (session.mode === 'classic') {
      this.pace = new Rig(COLORS_PACE, 0.82, 1.7)
      this.pace.group.position.z = PACE_LANE_Z
      this.world.scene.add(this.pace.group)
      this.paceStroke.onSample(24, undefined, 0)
      this.paceStroke.spm = 24
      this.paceStroke.phase = 0.45
    } else if (session.mode === 'shark') {
      this.shark = new Shark()
      this.world.scene.add(this.shark.group)
      // 상어 시점: 상어 뒤 위에서 상어와 그 앞의 내 보트를 함께 본다. 자리는 render()에서 매 프레임 상어를 따라간다.
      // 먼 평면은 하늘 돔(반지름 400)을 넘겨야 한다
      this.sharkCamera = new THREE.PerspectiveCamera(48, 1, 0.1, 700)
      this.sharkCamera.layers.set(SHARK_VIEW_LAYER)
      this.world.enableLayer(SHARK_VIEW_LAYER)
      enableLayer(this.player.group, SHARK_VIEW_LAYER)
      enableLayer(this.shark.group, SHARK_VIEW_LAYER)
    } else if (session.mode === 'chase') {
      // 라이벌은 체형도 번갈아 다르다 — 추월할 때마다 다른 사람이 나타난다
      for (let i = 0; i < 2; i++) {
        const rig = new Rig(COLORS_RIVALS[i]!, 1, 5.3 + i * 1.8, i === 0 ? 'female' : 'male')
        rig.group.visible = false
        this.world.scene.add(rig.group)
        this.rivals.push(rig)
        const stroke = new StrokeEngine(11 + i)
        stroke.onSample(26, undefined, 0)
        stroke.spm = 26
        stroke.phase = 0.3 + i * 0.45
        this.rivalStrokes.push(stroke)
        this.rivalSpeeds.push(0)
      }
    }

    if (session.ghost) {
      // 고스트는 지난 나 — 같은 체형이다
      this.ghost = new Rig(COLORS_GHOST, 0.72, 3.9, body)
      this.world.scene.add(this.ghost.group)
      this.ghostStroke.onSample(25, undefined, 0)
      this.ghostStroke.spm = 25
      // 세 보트가 같은 위상으로 젓으면 한 덩어리로 보인다 — 위상을 흩뜨린다
      this.ghostStroke.phase = 0.8
    }

    // 보트들은 수면에 비친다 — 강 장면이 진짜로 보이는 가장 큰 단서
    markReflective(this.player.group)
    if (this.pace) markReflective(this.pace.group)
    if (this.ghost) markReflective(this.ghost.group)
    if (this.shark) markReflective(this.shark.group)
    for (const rival of this.rivals) markReflective(rival.group)
    if (this.ghost && this.sharkCamera) enableLayer(this.ghost.group, SHARK_VIEW_LAYER)
    applyAnisotropy(this.renderer)
    this.applyQuality(this.quality)
  }

  get qualityTier(): QualityTier { return this.quality.tier }

  /** 품질 티어를 적용한다 — 픽셀 비율, 그림자 해상도, 반사 해상도, 풀포기 밀도, 후처리 체인 */
  private applyQuality(settings: QualitySettings) {
    this.quality = settings
    // 고해상도 iPad에서도 투명 날씨 효과가 프레임을 과도하게 채우지 않게 제한한다.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatioCap))
    this.world.setShadowMapSize(settings.shadowMapSize)
    this.world.setVegetationScale(settings.vegetation)
    this.reflection.enabled = settings.reflectionScale > 0
    this.reflection.scale = Math.max(0.1, settings.reflectionScale)
    this.world.water.setReflection(this.reflection.enabled ? this.reflection : null)
    this.buildComposer(settings)
    this.resize()
  }

  /**
   * 후처리 체인: 장면(HDR) → 블룸 → 톤매핑·sRGB 출력 → SMAA.
   * 블룸은 문턱이 높아 햇빛 반짝임과 태양 주변만 번진다. SMAA가 꺼진 티어는 렌더 타깃 MSAA로 대신한다.
   */
  private buildComposer(settings: QualitySettings) {
    this.composer?.dispose()
    this.composerTarget?.dispose()
    this.composer = null
    this.composerTarget = null
    if (!settings.bloom && !settings.smaa) return
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.composerTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: settings.smaa ? 0 : 4,
    })
    const composer = new EffectComposer(this.renderer, this.composerTarget)
    composer.addPass(new RenderPass(this.world.scene, this.camera))
    // 문턱 1.0: 톤매핑 전 HDR에서 1을 넘는 곳(해·햇빛 반짝임)만 번진다. 더 낮추면 해를 마주 볼 때 화면이 날아간다
    if (settings.bloom) composer.addPass(new UnrealBloomPass(size.clone(), 0.22, 0.45, 1.0))
    composer.addPass(new OutputPass())
    if (settings.smaa) composer.addPass(new SMAAPass())
    this.composer = composer
  }

  resize() {
    const c = this.renderer.domElement
    const w = c.clientWidth || 1, h = c.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.reflection.resize(this.renderer)
    this.measureViews(w, h)
  }

  /**
   * 상어 시점을 그릴 자리를 HUD 틀 요소로 알려준다 (상어 모드가 아니면 무시된다).
   * 캔버스가 화면 전체를 덮으므로 요소의 화면 좌표가 곧 캔버스 좌표다.
   */
  attachSharkView(frame: HTMLElement | null) {
    this.sharkFrame = frame
    const c = this.renderer.domElement
    this.measureViews(c.clientWidth || 1, c.clientHeight || 1)
  }

  /**
   * 메인 카메라와 상어 시점 카메라의 화면 영역을 정한다.
   *
   * 상어 시점 틀이 캔버스 높이를 거의 다 차지하면(가로 화면) 좌우 분할이다 — 메인 카메라는 나머지 오른쪽을 맡는다.
   * 메인 렌더(반사·블룸·SMAA 체인)는 캔버스 전체에 그대로 그리되, setViewOffset으로 투영을 옮겨
   * 오른쪽 영역에 '그 영역 비율의 카메라가 본 그림'이 정확히 들어오게 한다. 왼쪽에 그려진 것은 상어 시점이 덮는다.
   * 그렇지 않으면(세로 화면의 위쪽 띠) 메인은 캔버스 전체고 띠만 덮어 그린다.
   */
  private measureViews(w: number, h: number) {
    const cam = CAMERAS[this.camIndex]!
    this.sharkRect = null
    this.mainRect = null
    if (this.sharkCamera && this.sharkFrame) {
      const r = this.sharkFrame.getBoundingClientRect()
      if (r.width >= 8 && r.height >= 8) {
        // 틀의 테두리(2px) 안쪽에 그린다
        const inset = 2
        this.sharkRect = { x: r.left + inset, y: r.top + inset, w: r.width - inset * 2, h: r.height - inset * 2 }
        const sideBySide = r.height >= h * 0.9
        if (sideBySide) {
          const x = r.left + r.width
          this.mainRect = { x, y: 0, w: Math.max(1, w - x), h }
        }
        this.sharkCamera.aspect = this.sharkRect.w / this.sharkRect.h
        this.sharkCamera.fov = this.sharkCamera.aspect < 1 ? 62 : 44
        this.sharkCamera.updateProjectionMatrix()
      }
    }
    if (this.mainRect) {
      const m = this.mainRect
      this.camera.aspect = m.w / m.h
      this.camera.setViewOffset(m.w, m.h, -m.x, -m.y, w, h)
    } else {
      this.camera.aspect = w / h
      this.camera.clearViewOffset()
    }
    // 세로(또는 반쪽) 화면에서는 화각을 넓혀 보트가 잘리지 않게 한다
    this.camera.fov = this.camera.aspect < 1 ? cam.fovPortrait : cam.fov
    this.camera.updateProjectionMatrix()
  }

  /** 상어 시점 카메라를 상어 뒤 위에 둔다 — 상어가 앞에, 내 보트가 그 너머에 들어온다 */
  private placeSharkCamera() {
    if (!this.sharkCamera || !this.shark) return
    const s = this.shark.group.position
    // 상어가 내 보트 쪽(원점)으로 가는 방향이 +X다. 옆으로 조금 비켜서 지느러미가 날로 보이지 않게 한다
    this.sharkCamera.position.set(s.x - 9.5, 3.4, s.z + 2.6)
    this.sharkCamera.lookAt(s.x + 9, 0.2, s.z * 0.5)
  }

  /** 상어 시점 — 메인 렌더 뒤에 왼쪽 절반(또는 위쪽 띠)에 한 번 더 그린다. 평면 반사는 메인 카메라 기준이라 여기선 끈다 */
  private renderSharkView() {
    if (!this.sharkCamera || !this.sharkRect) return
    const renderer = this.renderer
    const size = renderer.getSize(new THREE.Vector2())
    const { x, y, w, h } = this.sharkRect
    // WebGL 뷰포트 원점은 좌하단
    const vy = size.y - y - h
    renderer.setScissorTest(true)
    renderer.setScissor(x, vy, w, h)
    renderer.setViewport(x, vy, w, h)
    this.world.water.setReflection(null)
    renderer.render(this.world.scene, this.sharkCamera)
    this.world.water.setReflection(this.reflection.enabled ? this.reflection : null)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, size.x, size.y)
  }

  render(session: Session, timeSec: number, dt: number) {
    const m = session.metrics()
    const pose = session.stroke.pose()

    this.player.apply(pose, dt, session.boat.speed)
    const turnTarget = turnStrengthAt(this.path, m.distance)
    this.turnStrength = THREE.MathUtils.damp(
      this.turnStrength, turnTarget, 4, Math.min(dt, 0.1),
    )
    const turn = turnEffects(this.turnStrength)
    this.player.setCourseAttitude(turn.playerYaw, turn.playerLean)

    // 출발 전(대기)과 종료 후에는 페이스 보트·고스트가 노를 놓고 기다린다.
    // 사용자가 첫 스트로크를 넣어야 함께 출발한다.
    const running = session.phase === 'running'

    // 화면에 들어오는 상대들의 z — 카메라가 모두를 프레임에 넣도록 가운데를 잡는다
    const zs = [0]

    // ── 페이스 보트 (클래식) ─────────────────────────────────
    if (this.pace) {
      // 페이스 보트는 플레이어와 다른 위상으로 젓는다 — 실루엣이 한 몸처럼 겹치지 않는다
      if (running) this.paceStroke.onSample(paceStrokeRate(m.intensity, session.baseSplit), undefined, timeSec * 1000)
      else this.paceStroke.coast()
      this.paceStroke.update(dt)
      this.pace.apply(this.paceStroke.pose(), dt, running ? m.paceSpeed : 0)
      const pacePoint = localPathPoint(this.path, m.distance, -m.gap, PACE_LANE_OFFSET, PLAYER_LANE_OFFSET)
      this.pace.group.position.x = pacePoint.x
      this.pace.group.position.z = pacePoint.z
      this.pace.group.rotation.y = -pacePoint.yaw
      this.pace.group.visible = Math.abs(m.gap) < ACTOR_VISIBLE_M
      if (this.pace.group.visible) zs.push(this.pace.group.position.z)
    }

    // ── 상어 (상어 추격) ─────────────────────────────────────
    if (this.shark && m.shark) {
      const sv = m.shark
      if (sv.caught > this.sharkCaught) this.shark.bite()
      this.sharkCaught = sv.caught
      this.shark.update(dt, running ? sv.speed : 0, sv.state)
      // 그룹 원점이 코끝: 선미(보트 중심 − SHARK_BITE_REACH)에서 gap만큼 뒤
      const along = -(sv.gap + SHARK_BITE_REACH)
      const point = localPathPoint(this.path, m.distance, along, SHARK_LANE_OFFSET, PLAYER_LANE_OFFSET)
      this.shark.group.position.x = point.x
      this.shark.group.position.z = point.z
      this.shark.group.rotation.y = -point.yaw
      this.shark.group.visible = sv.gap < ACTOR_VISIBLE_M
      if (this.shark.group.visible) zs.push(this.shark.group.position.z)
      this.placeSharkCamera()
    }

    // ── 라이벌 (추월 레이스) ─────────────────────────────────
    if (this.rivals.length && m.rival) {
      const rv = m.rival
      if (rv.index !== this.rivalIndex) {
        // 새 라이벌 — 다른 벌을 쓴다. 지나간 벌은 previous로 뒤에 남는다
        if (this.rivalIndex >= 0) this.rivalSlot = 1 - this.rivalSlot
        this.rivalIndex = rv.index
        this.rivalSpeeds[this.rivalSlot] = 0
      }
      const place = (slot: number, gap: number, speed: number) => {
        const rig = this.rivals[slot]!
        const stroke = this.rivalStrokes[slot]!
        // 출발·추월 직후의 속도 변화는 평활한다 — 물결·항적이 튀지 않게
        const prev = this.rivalSpeeds[slot] ?? 0
        const v = prev + (speed - prev) * (1 - Math.exp(-dt / 0.6))
        this.rivalSpeeds[slot] = v
        if (running && v > 0.3) {
          stroke.onSample(paceStrokeRate(v / splitToSpeed(session.baseSplit), session.baseSplit), undefined, timeSec * 1000)
        } else {
          stroke.coast()
        }
        stroke.update(dt)
        rig.apply(stroke.pose(), dt, v)
        const point = localPathPoint(this.path, m.distance, -gap, PACE_LANE_OFFSET, PLAYER_LANE_OFFSET)
        rig.group.position.x = point.x
        rig.group.position.z = point.z
        rig.group.rotation.y = -point.yaw
        rig.group.visible = Math.abs(gap) < ACTOR_VISIBLE_M
        if (rig.group.visible) zs.push(rig.group.position.z)
      }
      place(this.rivalSlot, rv.gap, running ? rv.speed : 0)
      const other = 1 - this.rivalSlot
      if (rv.previous) place(other, rv.previous.gap, rv.previous.speed)
      else this.rivals[other]!.group.visible = false
    }

    let ghostVisible = false
    let ghostZ = 0

    // ── 고스트: 지난 내 최고 기록 ────────────────────────────
    if (this.ghost && m.ghostGap !== null) {
      const ghostSplit = session.ghost!.splitAt(m.elapsed)
      if (running) {
        this.ghostStroke.onSample(
          paceStrokeRate(isFinite(ghostSplit) && ghostSplit > 0 ? session.baseSplit / ghostSplit : 1),
          undefined, timeSec * 1000,
        )
      } else {
        this.ghostStroke.coast()
      }
      this.ghostStroke.update(dt)
      // 기록에서 읽은 스플릿은 초 단위로 계단처럼 바뀐다 — 물결·항적이 튀지 않게 평활한다
      const ghostTarget = running && isFinite(ghostSplit) ? splitToSpeed(ghostSplit) : 0
      this.ghostSpeed += (ghostTarget - this.ghostSpeed) * (1 - Math.exp(-dt / 0.9))
      this.ghost.apply(this.ghostStroke.pose(), dt, this.ghostSpeed)
      const gp = localPathPoint(
        this.path,
        m.distance,
        -m.ghostGap,
        GHOST_LANE_OFFSET,
        PLAYER_LANE_OFFSET,
      )
      this.ghost.group.position.x = gp.x
      this.ghost.group.position.z = gp.z
      this.ghost.group.rotation.y = -gp.yaw
      this.ghost.group.visible = Math.abs(m.ghostGap) < 90
      ghostVisible = this.ghost.group.visible
      ghostZ = this.ghost.group.position.z
    }

    this.world.update(timeSec, m.elapsed, m.distance, this.total, 0)
    this.world.setSegmentBoundary(m.distance, running ? m.boundaryAlong : null)

    // ── 카메라 ──────────────────────────────────────────────
    // 드라이브에 맞춰 아주 약간 밀렸다 당겨진다
    const surge = pose.inWater ? Math.sin(pose.driveProgress * Math.PI) : -0.25
    this.camShake += (surge - this.camShake) * (1 - Math.exp(-dt / 0.12))
    const speedK = Math.min(1, session.boat.speed / 5)
    // 페이스 보트만 따라가면 반대편 고스트가 화면 밖으로 밀린다.
    // 보이는 보트들의 z 범위 중앙을 잡아야 셋 다 프레임에 들어온다.
    if (ghostVisible) zs.push(ghostZ)
    const targetFrameZ = (Math.min(...zs) + Math.max(...zs)) / 2
    this.frameZ += (targetFrameZ - this.frameZ) * (1 - Math.exp(-dt / 0.35))

    const cam = CAMERAS[this.camIndex]!
    // 빨라질수록 카메라가 조금 물러난다 — 보트가 어느 쪽에 있든 멀어지는 방향으로
    const away = Math.sign(cam.pos[0] || 1)
    this.camera.position.set(
      cam.pos[0] + speedK * 0.5 * away + this.camShake * 0.10 * -away,
      cam.pos[1] + this.camShake * 0.04,
      cam.pos[2] + this.frameZ + speedK * 0.25 * Math.sign(cam.pos[2] || 1)
        + turn.cameraLateral,
    )
    this.camera.lookAt(
      cam.look[0], cam.look[1] + this.camShake * 0.025,
      cam.look[2] + this.frameZ + turn.cameraLookZ,
    )
    // lookAt 이후 카메라 로컬 전방축을 기준으로 뱅킹해야 곡선에서 화면이 기운다.
    this.camera.rotateZ(turn.cameraBank)
    this.camera.updateMatrixWorld()

    // ── 렌더 ────────────────────────────────────────────────
    this.renderer.info.reset()
    this.governor.update(dt)
    // 하늘 환경맵은 날씨가 바뀔 때만 다시 굽는다
    this.world.updateEnvironment(this.renderer)
    // 그림자 맵은 프레임당 한 번 — 먼저 오는 패스(반사 또는 메인)가 굽고 나머지는 재사용한다
    this.renderer.shadowMap.needsUpdate = true
    this.reflection.render(this.renderer, this.world.scene, this.camera)
    if (this.composer) this.composer.render(dt)
    else this.renderer.render(this.world.scene, this.camera)
    this.renderSharkView()
  }

  /** 다음 카메라 프리셋으로. 이름을 돌려준다. */
  cycleCamera(): string {
    this.camIndex = (this.camIndex + 1) % CAMERAS.length
    this.resize()
    return CAMERAS[this.camIndex]!.name
  }

  get cameraName(): string { return CAMERAS[this.camIndex]!.name }

  nearestLandmark(session: Session) {
    return this.world.nearestLandmark(session.boat.distance, this.total)
  }

  getAmbientPresence(): Readonly<AmbientPresence> {
    return this.world.getAmbientPresence()
  }

  dispose() {
    this.composer?.dispose()
    this.composerTarget?.dispose()
    this.shark?.dispose()
    this.reflection.dispose()
    this.world.dispose()
    this.renderer.dispose()
  }
}
