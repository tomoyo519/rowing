import * as THREE from 'three'
import { World } from './world'
import { Rig, COLORS_PLAYER, COLORS_PACE } from './rig'
import { projectedDistance } from '../game/courses'
import { splitToSpeed } from '../game/physics'
import { StrokeEngine } from '../game/stroke'
import {
  createCoursePath,
  localPathPoint,
  PACE_LANE_OFFSET,
  PLAYER_LANE_OFFSET,
  type CoursePath,
} from '../game/coursePath'
import type { Session } from '../game/state'

/** 페이스 보트가 나란히 달리는 옆 레인 간격 (m) */
export const PACE_LANE_Z = -6.4

export function paceStrokeRate(intensity: number) {
  return Math.max(18, Math.min(36, 24 + (intensity - 1) * 45))
}

/**
 * 카메라 프리셋.
 *
 * 정측면은 스트로크 동작이 잘 보이지만 진행감이 죽고,
 * 스턴 뒤 추격은 그 반대다. 기본값은 둘을 절충한 쿼터뷰.
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
  // 정면: 뱃머리 쪽에서 뒤를 돌아본다 — 로어의 뒤통수가 보인다.
  // 로어는 진행 반대편을 보고 앉으므로, 뒤통수를 보려면 카메라가 앞에 있어야 하고
  // 그 대가로 보이는 풍경은 '앞으로 올 코스'가 아니라 '지나온 코스'가 된다.
  // 퍼들과 강둑이 뒤로 멀어지면서 속도감을 만든다.
  { name: '정면', pos: [12.4, 2.8, 0], look: [-1.0, 0.8, 0], fov: 42, fovPortrait: 72 },
  { name: '쿼터', pos: [-9.0, 3.2, 6.5], look: [2.0, 0.55, 0], fov: 48, fovPortrait: 68 },
  { name: '추격', pos: [-10.5, 3.4, 2.4], look: [2.6, 0.55, 0], fov: 46, fovPortrait: 66 },
  { name: '사이드', pos: [-4.4, 4.8, 11.0], look: [0, 0.62, 0], fov: 50, fovPortrait: 70 },
]

export class View {
  readonly renderer: THREE.WebGLRenderer
  private camera: THREE.PerspectiveCamera
  private world: World
  private player: Rig
  private pace: Rig
  private total: number
  private paceStroke = new StrokeEngine()
  private camShake = 0
  private frameZ = 0
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

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 500)

    this.world = new World(session.course, session.weatherSeed)
    this.world.attachWeatherToCamera(this.camera)
    this.total = projectedDistance(session.course, session.baseSplit)
    this.path = createCoursePath(session.course.id)

    this.player = new Rig(COLORS_PLAYER)
    this.world.scene.add(this.player.group)

    this.pace = new Rig(COLORS_PACE, 0.82)
    this.pace.group.position.z = PACE_LANE_Z
    this.world.scene.add(this.pace.group)
    this.paceStroke.onSample(24, undefined, 0)
    this.paceStroke.spm = 24
    this.paceStroke.phase = 0.45

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

    // 페이스 보트는 플레이어와 다른 위상으로 젓는다 — 실루엣이 한 몸처럼 겹치지 않는다
    this.paceStroke.onSample(paceStrokeRate(m.intensity), undefined, timeSec * 1000)
    this.paceStroke.update(dt)
    this.pace.apply(this.paceStroke.pose(), dt, splitToSpeed(m.targetSplit))
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

    this.world.update(timeSec, m.elapsed, m.distance, this.total, 0)

    // ── 카메라 ──────────────────────────────────────────────
    // 드라이브에 맞춰 아주 약간 밀렸다 당겨진다
    const surge = pose.inWater ? Math.sin(pose.driveProgress * Math.PI) : -0.25
    this.camShake += (surge - this.camShake) * (1 - Math.exp(-dt / 0.12))
    const speedK = Math.min(1, session.boat.speed / 5)
    const targetFrameZ = visible ? this.pace.group.position.z / 2 : 0
    this.frameZ += (targetFrameZ - this.frameZ) * (1 - Math.exp(-dt / 0.35))

    const cam = CAMERAS[this.camIndex]!
    // 빨라질수록 카메라가 조금 물러난다 — 보트가 어느 쪽에 있든 멀어지는 방향으로
    const away = Math.sign(cam.pos[0] || 1)
    this.camera.position.set(
      cam.pos[0] + speedK * 0.5 * away + this.camShake * 0.10 * -away,
      cam.pos[1] + this.camShake * 0.04,
      cam.pos[2] + this.frameZ + speedK * 0.25 * Math.sign(cam.pos[2] || 1),
    )
    this.camera.lookAt(
      cam.look[0], cam.look[1] + this.camShake * 0.025, cam.look[2] + this.frameZ,
    )

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

  dispose() {
    this.world.dispose()
    this.renderer.dispose()
  }
}
