import * as THREE from 'three'
import { World, type AmbientPresence } from './world'
import { Rig, COLORS_PLAYER, COLORS_PACE, COLORS_GHOST } from './rig'
import { projectedDistance } from '../game/courses'
import { splitToSpeed } from '../game/physics'
import { StrokeEngine } from '../game/stroke'
import {
  createCoursePath,
  localPathPoint,
  PACE_LANE_OFFSET,
  GHOST_LANE_OFFSET,
  PLAYER_LANE_OFFSET,
  type CoursePath,
} from '../game/coursePath'
import type { Session } from '../game/state'

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
  private pace: Rig
  /** 지난 최고 기록이 있을 때만 만든다 */
  private ghost: Rig | null = null
  private ghostStroke = new StrokeEngine()
  private ghostSpeed = 0
  private total: number
  private paceStroke = new StrokeEngine()
  private camShake = 0
  private frameZ = 0
  private turnStrength = 0
  private camIndex = 0
  private path: CoursePath

  constructor(canvas: HTMLCanvasElement, session: Session) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    })
    // 고해상도 iPad에서도 투명 날씨 효과가 프레임을 과도하게 채우지 않게 제한한다.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    // 보트·로어·나무가 수면과 강둑에 그림자를 떨어뜨린다. 그림자 카메라는 보트 주변 ±26m만 덮는다.
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 500)

    this.world = new World(session.course, session.weatherSeed)
    this.world.attachWeatherToCamera(this.camera)
    this.total = projectedDistance(session.course, session.baseSplit)
    this.path = createCoursePath(session.course.id)

    this.player = new Rig(COLORS_PLAYER)
    this.world.scene.add(this.player.group)

    this.pace = new Rig(COLORS_PACE, 0.82, 1.7)
    this.pace.group.position.z = PACE_LANE_Z
    this.world.scene.add(this.pace.group)
    this.paceStroke.onSample(24, undefined, 0)
    this.paceStroke.spm = 24
    this.paceStroke.phase = 0.45

    if (session.ghost) {
      this.ghost = new Rig(COLORS_GHOST, 0.72, 3.9)
      this.world.scene.add(this.ghost.group)
      this.ghostStroke.onSample(25, undefined, 0)
      this.ghostStroke.spm = 25
      // 세 보트가 같은 위상으로 젓으면 한 덩어리로 보인다 — 위상을 흩뜨린다
      this.ghostStroke.phase = 0.8
    }

    this.resize()
  }

  resize() {
    const c = this.renderer.domElement
    const w = c.clientWidth || 1, h = c.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    const cam = CAMERAS[this.camIndex]!
    // 세로 화면에서는 화각을 넓혀 보트가 잘리지 않게 한다
    this.camera.fov = w / h < 1 ? cam.fovPortrait : cam.fov
    this.camera.updateProjectionMatrix()
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

    // 페이스 보트는 플레이어와 다른 위상으로 젓는다 — 실루엣이 한 몸처럼 겹치지 않는다
    if (running) this.paceStroke.onSample(paceStrokeRate(m.intensity, session.baseSplit), undefined, timeSec * 1000)
    else this.paceStroke.coast()
    this.paceStroke.update(dt)
    this.pace.apply(this.paceStroke.pose(), dt, running ? m.paceSpeed : 0)
    const pacePoint = localPathPoint(
      this.path,
      m.distance,
      -m.gap,
      PACE_LANE_OFFSET,
      PLAYER_LANE_OFFSET,
    )
    this.pace.group.position.x = pacePoint.x
    this.pace.group.position.z = pacePoint.z
    this.pace.group.rotation.y = -pacePoint.yaw
    const visible = Math.abs(m.gap) < 90
    this.pace.group.visible = visible

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
    const zs = [0]
    if (visible) zs.push(this.pace.group.position.z)
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

    this.renderer.render(this.world.scene, this.camera)
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
    this.world.dispose()
    this.renderer.dispose()
  }
}
