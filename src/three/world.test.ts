import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COURSES } from '../game/courses'
import { GHOST_LANE_OFFSET } from '../game/coursePath'
import { DIMS } from './rig'
import { createSceneryLayout, shoreHeightAt, SHORELINE_INSET, World, wrappedLoopX } from './world'

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
    expect(layout.clouds.length).toBeGreaterThanOrEqual(7)
    expect(layout.props.some(p => p.kind === 'cottage')).toBe(true)
    expect(layout.props.some(p => p.kind === 'manor')).toBe(true)
    expect(layout.props.some(p => p.kind !== 'cottage')).toBe(true)
  })

  it('나무·관중·소품이 획일적이지 않다 — 종류와 간격이 다양하다', () => {
    const layout = createSceneryLayout('henley-steady-30')
    expect(new Set(layout.trees.map(t => t.kind)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(layout.trees.map(t => t.leaf)).size).toBeGreaterThanOrEqual(4)
    const gaps = layout.trees.slice(1).map((t, i) => t.baseX - layout.trees[i]!.baseX)
    expect(new Set(gaps.map(g => g.toFixed(1))).size).toBeGreaterThan(gaps.length * 0.7)
    expect(layout.trees.some(t => t.side === 1) && layout.trees.some(t => t.side === -1)).toBe(true)

    expect(new Set(layout.spectators.map(s => s.pose)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(layout.spectators.map(s => s.skinIndex)).size).toBeGreaterThanOrEqual(2)
    expect(layout.spectators.some(s => s.hat > 0)).toBe(true)

    expect(new Set(layout.props.map(p => p.kind)).size).toBeGreaterThanOrEqual(15)
    expect(layout.swans.length).toBeGreaterThanOrEqual(2)
    expect(layout.bushes.length).toBeGreaterThanOrEqual(20)
    expect(layout.sky.filter(s => s.kind === 'balloon').length).toBeGreaterThanOrEqual(3)
    expect(layout.sky.some(s => s.kind === 'blimp')).toBe(true)
    expect(layout.sky.some(s => s.kind === 'birds')).toBe(true)
  })

  it('열댓 명이 모인 군중이 가끔 나타나고, 개별 관중보다 훨씬 긴 주기로 되풀이된다', () => {
    let seenTwo = false
    let seenBanner = false
    for (const course of COURSES) {
      const layout = createSceneryLayout(course.id)
      expect(layout.crowds.length).toBeGreaterThanOrEqual(1)
      expect(layout.crowds.length).toBeLessThanOrEqual(2)
      if (layout.crowds.length === 2) seenTwo = true
      for (const crowd of layout.crowds) {
        expect(crowd.people.length).toBeGreaterThanOrEqual(12)
        expect(crowd.span).toBeGreaterThan(500)
        expect(Math.abs(crowd.z)).toBeGreaterThan(16)
        expect(new Set(crowd.people.map(p => p.pose)).size).toBeGreaterThanOrEqual(2)
        if (crowd.banner) seenBanner = true
        // 사람들이 한 점에 겹치지 않는다
        const spots = new Set(crowd.people.map(p => `${p.dx.toFixed(1)}:${p.dz.toFixed(1)}`))
        expect(spots.size).toBe(crowd.people.length)
      }
    }
    expect(seenTwo).toBe(true)
    expect(seenBanner).toBe(true)
  })

  it('나무 수관은 매끈한 구가 아니다 — 정점 반지름이 흩어져 있다', () => {
    const world = new World(COURSES[0]!)
    const tree = world.scene.getObjectByName('scenery:tree:oak')!
    const foliage = tree.getObjectByName('foliage') as THREE.Mesh
    expect(foliage).toBeDefined()
    const material = foliage.material as THREE.MeshStandardMaterial
    expect(material.flatShading).toBe(false)
    const position = foliage.geometry.getAttribute('position')
    expect(position.count).toBeGreaterThan(300)
    world.dispose()
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
    const manor = layout.props.find(item => item.kind === 'manor')!
    expect(Math.abs(manor.z)).toBeGreaterThanOrEqual(23)
    expect(manor.scale).toBeGreaterThanOrEqual(0.94)
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
    // 소품이 열 종류 넘게 늘었지만 정점 색을 구워 메시 하나로 합쳤으므로 draw call은 제한된다
    expect(after.filter(node => node instanceof THREE.Mesh).length).toBeLessThan(300)
    expect(after.filter(node => (
      node instanceof THREE.Mesh
      || node instanceof THREE.Points
      || node instanceof THREE.LineSegments
    )).length).toBeLessThan(310)
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

  it('구름 7덩이의 조각 전부를 빌보드 인스턴스 메시 하나로 그리고 큰 저택을 포함한다', () => {
    const world = new World(COURSES[0]!)
    const clouds: THREE.Object3D[] = []
    world.scene.traverse(node => { if (node.name === 'scenery:clouds') clouds.push(node) })
    expect(clouds).toHaveLength(1)
    const puffs = clouds[0] as THREE.InstancedMesh
    expect(puffs).toBeInstanceOf(THREE.InstancedMesh)
    // 덩이마다 11조각 — 윗조각은 희고 밑조각은 그늘지게 인스턴스 색을 굽는다
    expect(puffs.count).toBe(7 * 11)
    expect(puffs.instanceColor).not.toBeNull()
    const shade = new THREE.Color()
    const shades = new Set<string>()
    for (let i = 0; i < 11; i++) { puffs.getColorAt(i, shade); shades.add(shade.getHexString()) }
    expect(shades.size).toBeGreaterThan(2)

    const manor = world.scene.getObjectByName('scenery:manor')
    expect(manor).toBeDefined()
    const size = new THREE.Box3().setFromObject(manor!).getSize(new THREE.Vector3())
    expect(Math.max(size.x, size.z)).toBeGreaterThan(14)
    expect(size.y).toBeGreaterThan(7)
    world.dispose()
  })

  it('하늘에 열기구·비행선·새떼·달이 있고 원경에 언덕과 숲이 있다', () => {
    const world = new World(COURSES[0]!)
    const names = new Set<string>()
    world.scene.traverse(node => { if (node.name) names.add(node.name) })
    for (const name of ['scenery:balloon', 'scenery:blimp', 'scenery:birds', 'scenery:moon', 'scenery:hills', 'scenery:treeline', 'scenery:swan', 'scenery:bushes', 'scenery:crowd']) {
      expect(names.has(name), name).toBe(true)
    }
    const treeKinds = [...names].filter(name => name.startsWith('scenery:tree:'))
    expect(treeKinds.length).toBeGreaterThanOrEqual(5)
    const poses = [...names].filter(name => name.startsWith('scenery:spectator:'))
    expect(poses.length).toBeGreaterThanOrEqual(5)
    // 새 랜드마크 종류도 코스에 실제로 배치된다
    const landmarks = [...names].filter(name => name.startsWith('landmark:'))
    expect(landmarks).toEqual(expect.arrayContaining(['landmark:church', 'landmark:townhouses', 'landmark:footbridge', 'landmark:suspension']))
    world.dispose()
  })

  it('강둑은 절벽이 아니라 물속으로 이어지는 비탈이고, 갈대는 물가선에 걸터앉는다', () => {
    // 잔디 가장자리에서 물가선까지 비탈이 단조롭게 내려가 수면(0)을 지난다
    expect(shoreHeightAt(0)).toBeCloseTo(0.85, 6)
    expect(shoreHeightAt(SHORELINE_INSET)).toBeCloseTo(0, 6)
    expect(shoreHeightAt(SHORELINE_INSET + 5)).toBeLessThan(-0.5)
    let previous = shoreHeightAt(0)
    for (let inset = 0.05; inset < 3; inset += 0.05) {
      const h = shoreHeightAt(inset)
      expect(h).toBeLessThanOrEqual(previous)
      previous = h
    }

    const world = new World(COURSES[0]!)
    world.update(5, 5, 120, 10_000, 0)
    const reeds = world.scene.getObjectByName('scenery:reeds') as THREE.InstancedMesh
    const tufts = world.scene.getObjectByName('scenery:tufts') as THREE.InstancedMesh
    expect(reeds).toBeInstanceOf(THREE.InstancedMesh)
    expect(tufts).toBeInstanceOf(THREE.InstancedMesh)
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    let wet = 0, dry = 0
    for (let i = 0; i < reeds.count; i++) {
      reeds.getMatrixAt(i, matrix)
      position.setFromMatrixPosition(matrix)
      // 뿌리는 수면 근처 — 비탈 위(얕은 물 또는 젖은 진흙)
      expect(position.y).toBeGreaterThan(-0.7)
      expect(position.y).toBeLessThan(0.4)
      if (position.y < -0.06) wet++
      else dry++
    }
    expect(wet).toBeGreaterThan(reeds.count * 0.25)
    expect(dry).toBeGreaterThan(reeds.count * 0.25)
    // 물가 거품 띠가 양쪽 강둑에 하나씩 있다
    const shores: THREE.Object3D[] = []
    world.scene.traverse(node => { if (node.name === 'scenery:shore') shores.push(node) })
    expect(shores).toHaveLength(2)
    // 강둑 리본은 잔디 텍스처용 uv를 갖고 법선이 위를 본다
    const bank = world.scene.getObjectByName('scenery:bank') as THREE.Mesh
    expect(bank.geometry.getAttribute('uv')).toBeDefined()
    const normal = bank.geometry.getAttribute('normal')
    let up = 0
    for (let i = 0; i < normal.count; i++) up += normal.getY(i)
    expect(up).toBeGreaterThan(0)
    world.dispose()
  })

  it('품질 티어가 낮으면 풀포기 일부를 화면 밖으로 치운다', () => {
    const world = new World(COURSES[0]!)
    world.setVegetationScale(0.3)
    world.update(5, 5, 120, 10_000, 0)
    const tufts = world.scene.getObjectByName('scenery:tufts') as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    let visible = 0
    for (let i = 0; i < tufts.count; i++) {
      tufts.getMatrixAt(i, matrix)
      if (matrix.elements[13]! > -10) visible++
    }
    expect(visible).toBe(Math.round(tufts.count * 0.3))
    world.dispose()
  })

  it('목조 다리와 현수교도 가장 바깥 레인의 노 끝까지 통과시킨다', () => {
    const world = new World(COURSES[0]!)
    world.scene.updateMatrixWorld(true)
    const outerGhostOar = GHOST_LANE_OFFSET + 0.85 + DIMS.outboard
    for (const kind of ['footbridge', 'suspension']) {
      const bridge = world.scene.getObjectByName(`landmark:${kind}`)!
      expect(bridge).toBeDefined()
      for (const lateral of [outerGhostOar, -outerGhostOar, 0]) {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(-8, 2.4, lateral), new THREE.Vector3(1, 0, 0), 0, 16,
        )
        expect(ray.intersectObject(bridge, true), `${kind} @ ${lateral}`).toHaveLength(0)
      }
    }
    world.dispose()
  })

  it('성은 크고 다리는 강 전체를 가로지르며 둘 다 저비용 메시로 구성된다', () => {
    const world = new World(COURSES[0]!)
    const castle = world.scene.getObjectByName('landmark:castle')!
    const bridge = world.scene.getObjectByName('landmark:bridge')!
    const castleSize = new THREE.Box3().setFromObject(castle).getSize(new THREE.Vector3())
    const bridgeSize = new THREE.Box3().setFromObject(bridge).getSize(new THREE.Vector3())
    expect(Math.max(castleSize.x, castleSize.z)).toBeGreaterThan(35)
    expect(castleSize.y).toBeGreaterThan(15)
    expect(Math.max(bridgeSize.x, bridgeSize.z)).toBeGreaterThan(45)
    expect(bridgeSize.y).toBeGreaterThan(8)
    expect(bridge.children.filter(node => node instanceof THREE.Mesh)).toHaveLength(1)
    expect(castle.children.filter(node => node instanceof THREE.Mesh).length).toBeLessThanOrEqual(2)
    world.dispose()
  })

  it('성의 둔덕은 물을 침범하지 않고 다리는 고스트의 노 끝까지 통과시킨다', () => {
    const world = new World(COURSES[0]!)
    const castle = world.scene.getObjectByName('landmark:castle')!
    const bridge = world.scene.getObjectByName('landmark:bridge')!
    world.scene.updateMatrixWorld(true)

    const castleBounds = new THREE.Box3().setFromObject(castle)
    expect(castleBounds.min.z).toBeGreaterThanOrEqual(15)

    const outerGhostOar = GHOST_LANE_OFFSET + 0.85 + DIMS.outboard
    const ray = new THREE.Raycaster(
      new THREE.Vector3(-8, 2, outerGhostOar),
      new THREE.Vector3(1, 0, 0),
      0,
      16,
    )
    expect(ray.intersectObject(bridge, true)).toHaveLength(0)
    world.dispose()
  })
})
