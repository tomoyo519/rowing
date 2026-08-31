import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COURSES } from '../game/courses'
import { createSceneryLayout, World, wrappedLoopX } from './world'

describe('강변 배경 배치', () => {
  it('같은 코스는 같은 배치, 다른 코스는 다른 배치를 만든다', () => {
    const first = createSceneryLayout('henley-steady-30')
    expect(createSceneryLayout('henley-steady-30')).toEqual(first)
    expect(createSceneryLayout('bosbaan-steady-40')).not.toEqual(first)
  })

  it('응원객·오리·구름과 건물/동물을 항상 포함한다', () => {
    const layout = createSceneryLayout('henley-steady-30')
    expect(layout.spectators.length).toBeGreaterThanOrEqual(6)
    expect(layout.ducks.length).toBeGreaterThanOrEqual(4)
    expect(layout.clouds.length).toBeGreaterThanOrEqual(4)
    expect(layout.props.some(p => p.kind === 'cottage')).toBe(true)
    expect(layout.props.some(p => p.kind !== 'cottage')).toBe(true)
  })

  it('오브젝트를 강둑·물·하늘의 안전한 영역에 놓는다', () => {
    const layout = createSceneryLayout('bosbaan-wave-40')
    for (const item of layout.spectators) {
      expect(Math.abs(item.z)).toBeGreaterThan(16)
      expect(Math.abs(item.z)).toBeLessThan(18)
    }
    for (const item of layout.ducks) {
      expect(Math.abs(item.z)).toBeGreaterThanOrEqual(10.6)
      expect(Math.abs(item.z)).toBeLessThanOrEqual(12.6)
    }
    for (const item of layout.clouds) expect(Math.abs(item.z)).toBeLessThanOrEqual(45)
    for (const item of [...layout.spectators, ...layout.ducks, ...layout.clouds, ...layout.props]) {
      expect(Number.isFinite(item.baseX)).toBe(true)
      expect(Number.isFinite(item.z)).toBe(true)
      expect(item.scale).toBeGreaterThan(0)
    }
  })

  it('반복 좌표는 긴 거리에서도 유한하고 같은 간격마다 정확히 순환한다', () => {
    const base = 37.25, span = 230, min = -72
    const x = wrappedLoopX(base, 12_345.67, span, min)
    expect(x).toBeGreaterThanOrEqual(min)
    expect(x).toBeLessThan(min + span)
    expect(wrappedLoopX(base, 12_345.67 + span, span, min)).toBeCloseTo(x, 9)
  })

  it('긴 코스에서도 고정 오브젝트 풀을 재사용한다', () => {
    const world = new World(COURSES[0]!)
    const before: THREE.Object3D[] = []
    world.scene.traverse(node => before.push(node))

    for (const [index, distance] of [0, 250, 5_000, 20_000].entries()) {
      world.update(12.5 + index, index * 180, distance, 10_000, 0)
    }

    const after: THREE.Object3D[] = []
    world.scene.traverse(node => {
      after.push(node)
      expect(node.position.toArray().every(Number.isFinite)).toBe(true)
    })
    expect(after).toEqual(before)
    expect(after.filter(node => node instanceof THREE.Mesh).length).toBeLessThan(230)
    expect(after.filter(node => (
      node instanceof THREE.Mesh
      || node instanceof THREE.Points
      || node instanceof THREE.LineSegments
    )).length).toBeLessThan(240)
    world.dispose()
  })

  it('가장 가까운 오리와 관중의 거리·좌우 위치를 오디오에 제공한다', () => {
    const world = new World(COURSES[0]!)
    world.update(35, 35, 280, 3_000, 0)
    const nearby = world.getAmbientPresence()
    for (const source of [nearby.duck, nearby.spectator]) {
      expect(Number.isFinite(source.distance)).toBe(true)
      expect(source.distance).toBeGreaterThanOrEqual(0)
      expect(source.pan).toBeGreaterThanOrEqual(-1)
      expect(source.pan).toBeLessThanOrEqual(1)
    }
    world.dispose()
  })
})
