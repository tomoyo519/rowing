import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COURSES } from '../game/courses'
import { StrokeEngine } from '../game/stroke'
import { COLORS_PACE, COLORS_PLAYER, Rig } from './rig'
import { PACE_LANE_Z, paceStrokeRate } from './view'
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
    expect(paceStrokeRate(1.4)).toBe(36)
  })

  it('두 보트와 날씨를 합쳐도 iPad용 drawable 예산을 넘지 않는다', () => {
    const world = new World(COURSES[0]!)
    const player = new Rig(COLORS_PLAYER)
    const pace = new Rig(COLORS_PACE, 0.82)
    world.scene.add(player.group, pace.group)

    const drawables: THREE.Object3D[] = []
    world.scene.traverse(node => {
      if (
        node instanceof THREE.Mesh
        || node instanceof THREE.Points
        || node instanceof THREE.LineSegments
      ) drawables.push(node)
    })
    expect(drawables.length).toBeLessThan(290)
    world.dispose()
  })
})
