import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { disposeTextures, grassMaps, grassTuftTexture, leafCardTexture, stoneMaps, waterNormalTexture } from './textures'

/** 가로 w 텍스처에서 두 열의 픽셀 차이 평균 (RGB) */
function columnDifference(data: Uint8Array | Uint8ClampedArray, w: number, h: number, x0: number, x1: number) {
  let sum = 0
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(data[(y * w + x0) * 4 + c]! - data[(y * w + x1) * 4 + c]!)
    }
  }
  return sum / (h * 3)
}

describe('절차적 텍스처', () => {
  it('캔버스가 없는 환경(Node)에서도 모든 텍스처를 만들 수 있다', () => {
    disposeTextures()
    expect(typeof document).toBe('undefined')
    for (const texture of [
      grassMaps().map, grassMaps().normalMap, stoneMaps().map, waterNormalTexture(),
      leafCardTexture('broad'), grassTuftTexture(),
    ]) {
      expect(texture).toBeInstanceOf(THREE.Texture)
      expect((texture.image as { width: number }).width).toBeGreaterThan(0)
    }
  })

  it('수면·돌담 텍스처는 양 끝이 이어진다 — 수백 m를 타일링해도 경계가 보이지 않는다', () => {
    disposeTextures()
    for (const texture of [waterNormalTexture(), stoneMaps().map, grassMaps().normalMap]) {
      const { width, height, data } = texture.image as { width: number; height: number; data: Uint8Array }
      expect(texture.wrapS).toBe(THREE.RepeatWrapping)
      const seam = columnDifference(data, width, height, 0, width - 1)
      const interior = columnDifference(data, width, height, 10, width >> 1)
      // 이웃한 열(경계)의 차이가 멀리 떨어진 열의 차이보다 훨씬 작다
      expect(seam).toBeLessThan(interior * 0.5)
    }
  })

  it('같은 텍스처는 한 번만 만들어 재사용한다', () => {
    disposeTextures()
    expect(waterNormalTexture()).toBe(waterNormalTexture())
    expect(grassMaps().map).toBe(grassMaps().map)
  })
})
