import * as THREE from 'three'

/**
 * 물 표면.
 *
 * MeshStandardMaterial에 onBeforeCompile로 파도 변위만 주입한다.
 * 이렇게 하면 three의 조명/안개 파이프라인을 그대로 쓰면서 셰이더만 얹을 수 있다.
 */
export class Water {
  readonly mesh: THREE.Mesh
  private uniforms = {
    uTime: { value: 0 },
    uScroll: { value: 0 },
    uDeep: { value: new THREE.Color('#0d2a3d') },
  }

  constructor(color: THREE.ColorRepresentation, deep: THREE.ColorRepresentation) {
    const geo = new THREE.PlaneGeometry(600, 500, 220, 140)
    geo.rotateX(-Math.PI / 2)

    const mat = new THREE.MeshStandardMaterial({
      // 거칠기를 올려 정면(태양 방향)에서 반사가 화면을 하얗게 덮는 걸 막는다
      color, roughness: 0.5, metalness: 0.04,
    })
    this.uniforms.uDeep.value = new THREE.Color(deep)

    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = this.uniforms.uTime
      shader.uniforms.uScroll = this.uniforms.uScroll
      shader.uniforms.uDeep = this.uniforms.uDeep

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uTime;
          uniform float uScroll;
          varying float vWave;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          float wx = transformed.x + uScroll;
          float wz = transformed.z;
          // 조정 수로는 잔잔하다 — 파고는 최대 7cm 정도로 억제
          float w =
              sin(wx * 0.32 + uTime * 1.15) * 0.030
            + sin(wx * 0.87 - wz * 0.41 + uTime * 1.75) * 0.016
            + sin(wz * 0.55 + uTime * 0.72) * 0.020
            + sin(wx * 2.1 + wz * 1.3 - uTime * 2.6) * 0.007;
          transformed.y += w;
          vWave = w;
        `)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec3 uDeep;
          varying float vWave;
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          // 파고가 낮은 골은 깊은 색, 마루는 밝게 — 노멀 없이도 물결이 읽힌다
          float t = clamp(vWave * 5.0 + 0.5, 0.0, 1.0);
          diffuseColor.rgb = mix(mix(uDeep, diffuseColor.rgb, 0.45), diffuseColor.rgb, t);
          diffuseColor.rgb += pow(t, 7.0) * 0.16;
        `)
    }

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.receiveShadow = false
    this.mesh.position.y = 0
  }

  /** distance는 코스 진행 거리(m) — 물결이 뒤로 흐른다 */
  update(timeSec: number, distance: number) {
    this.uniforms.uTime.value = timeSec
    this.uniforms.uScroll.value = distance
  }

  setPalette(color: THREE.ColorRepresentation, deep: THREE.ColorRepresentation) {
    ;(this.mesh.material as THREE.MeshStandardMaterial).color.set(color)
    this.uniforms.uDeep.value.set(deep)
  }
}
