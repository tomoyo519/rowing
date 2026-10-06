import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COURSES } from '../game/courses'
import { createCoursePath, type CoursePath } from '../game/coursePath'
import { StrokeEngine } from '../game/stroke'
import { COLORS_GHOST, COLORS_PACE, COLORS_PLAYER, Rig } from './rig'
import { CAMERAS, PACE_LANE_Z, paceStrokeRate, turnEffects, turnStrengthAt } from './view'
import { World } from './world'

describe('페이스메이커 레이스 배치', () => {
  it('동률이어도 서로 다른 모든 스트로크 위상에서 두 리그가 겹치지 않는다', () => {
    const player = new Rig(COLORS_PLAYER)
    const pace = new Rig(COLORS_PACE, 0.75)
    pace.group.position.z = PACE_LANE_Z
    const engine = new StrokeEngine()
    engine.spm = 26
    const playerBounds = new THREE.Box3().makeEmpty()
    const paceBounds = new THREE.Box3().makeEmpty()

    for (let i = 0; i < 60; i++) {
      engine.phase = i / 60
      player.apply(engine.pose(), 1 / 60, 4)
      playerBounds.union(new THREE.Box3().setFromObject(player.group))

      engine.phase = i / 60
      pace.apply(engine.pose(), 1 / 60, 4)
      paceBounds.union(new THREE.Box3().setFromObject(pace.group))
    }

    expect(playerBounds.intersectsBox(paceBounds)).toBe(false)
    expect(playerBounds.min.z - paceBounds.max.z).toBeGreaterThan(0.25)
  })

  it('구간 강도에 따라 페이스메이커 레이트가 오르되 안전 범위를 지킨다', () => {
    expect(paceStrokeRate(0.8)).toBe(18)
    expect(paceStrokeRate(1)).toBe(24)
    expect(paceStrokeRate(1.4)).toBe(38)
  })

  it('기준 스플릿이 빠를수록 페이스메이커가 더 높은 레이트로 젓는다', () => {
    expect(paceStrokeRate(1, 135)).toBeCloseTo(26, 6)
    expect(paceStrokeRate(1, 105)).toBeCloseTo(32, 6)
    expect(paceStrokeRate(1.3, 105)).toBe(38)
    expect(paceStrokeRate(1, 150)).toBeCloseTo(23, 6)
  })

  it('고스트까지 세 보트와 날씨를 합쳐도 iPad용 drawable 예산을 넘지 않는다', () => {
    const world = new World(COURSES[0]!)
    const player = new Rig(COLORS_PLAYER)
    const pace = new Rig(COLORS_PACE, 0.82)
    const ghost = new Rig(COLORS_GHOST, 0.72)
    world.scene.add(player.group, pace.group, ghost.group)

    const drawables: THREE.Object3D[] = []
    world.scene.traverse(node => {
      if (
        node instanceof THREE.Mesh
        || node instanceof THREE.Points
        || node instanceof THREE.LineSegments
      ) drawables.push(node)
    })
    // 나무마다 잎사귀 카드 메시가 하나씩 더 붙어 예전(430)보다 늘었다 — 대부분은 절두체 밖이라 그려지지 않는다
    expect(drawables.length).toBeLessThan(480)
    world.dispose()
  })
})

describe('커브 체감', () => {
  it('앞쪽 굽이를 양방향 -1..1 강도로 안정적으로 읽는다', () => {
    const path = createCoursePath('curve-feel-test')
    const strengths = Array.from({ length: 101 }, (_, i) => turnStrengthAt(path, i * 12))
    expect(strengths.every(Number.isFinite)).toBe(true)
    expect(strengths.every(value => Math.abs(value) <= 1)).toBe(true)
    expect(strengths.some(value => value > 0.15)).toBe(true)
    expect(strengths.some(value => value < -0.15)).toBe(true)
  })

  it('좌우 커브 효과가 같은 크기와 반대 방향이다', () => {
    const left = turnEffects(0.72)
    const right = turnEffects(-0.72)
    for (const key of Object.keys(left) as (keyof typeof left)[]) {
      expect(left[key]).toBeCloseTo(-right[key], 10)
    }
    expect(Math.abs(turnEffects(99).cameraBank)).toBeLessThanOrEqual(Math.PI / 45)
  })

  it('직선 코스에서는 보트와 카메라를 기울이지 않는다', () => {
    const straight: CoursePath = {
      primaryAmplitude: 0, primaryWavelength: 500, primaryPhase: 0,
      secondaryAmplitude: 0, secondaryWavelength: 300, secondaryPhase: 0,
    }
    expect(turnStrengthAt(straight, 800)).toBeCloseTo(0, 12)
    expect(Object.values(turnEffects(0)).every(value => value === 0)).toBe(true)
  })

  it('기본 카메라는 첨부 레퍼런스와 같은 중앙 추격 시점이다', () => {
    expect(CAMERAS[0]!.name).toBe('추격')
    expect(CAMERAS[0]!.pos[2]).toBe(0)
  })
})
