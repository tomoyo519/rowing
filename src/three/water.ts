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
    uWind: { value: 0 },
    uRain: { value: 0 },
    uSparkle: { value: 0 },
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
      shader.uniforms.uWind = this.uniforms.uWind
      shader.uniforms.uRain = this.uniforms.uRain
      shader.uniforms.uSparkle = this.uniforms.uSparkle

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uTime;
          uniform float uScroll;
          uniform float uWind;
          uniform float uRain;
          varying float vWave;
          varying vec2 vXZ;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          float wx = transformed.x + uScroll;
          float wz = transformed.z;
          float windScale = 1.0 + uWind * 0.35;
          // 조정 수로는 잔잔하다 — 강풍과 비가 와도 파고는 약 10cm 아래로 억제
          float w =
              sin(wx * 0.32 + uTime * 1.15) * 0.030 * windScale
            + sin(wx * 0.87 - wz * 0.41 + uTime * 1.75) * 0.016 * windScale
            + sin(wz * 0.55 + uTime * 0.72) * 0.020 * windScale
            + sin(wx * 2.1 + wz * 1.3 - uTime * 2.6) * 0.007
            + sin(wx * 7.8 - wz * 5.6 + uTime * 8.4) * 0.003 * uRain;
          transformed.y += w;
          vWave = w;
          vXZ = vec2(wx, wz);
        `)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec3 uDeep;
          uniform float uTime;
          uniform float uSparkle;
          varying float vWave;
          varying vec2 vXZ;
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          // 파고가 낮은 골은 깊은 색, 마루는 밝게 — 노멀 없이도 물결이 읽힌다
          float t = clamp(vWave * 5.0 + 0.5, 0.0, 1.0);
          diffuseColor.rgb = mix(mix(uDeep, diffuseColor.rgb, 0.45), diffuseColor.rgb, t);
          diffuseColor.rgb += pow(t, 7.0) * 0.16;
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          // 햇빛 반짝임 — 잔물결 마루에서만 잠깐씩 튀는 하이라이트.
          // 두 주파수의 곱이라 규칙적인 격자로 보이지 않는다.
          float g1 = sin(vXZ.x * 3.1 + uTime * 1.7) * sin(vXZ.y * 2.7 - uTime * 1.3);
          float g2 = sin(vXZ.x * 7.9 - uTime * 2.9 + vXZ.y * 1.9) * sin(vXZ.y * 6.3 + uTime * 2.2);
          // 느리게 흐르는 마스크로 반짝임이 군데군데 무리지어 나타나게 한다
          // (GLSL ES 예약어인 patch/sample 같은 이름은 쓰면 안 된다)
          float cluster = sin(vXZ.x * 0.11 + uTime * 0.21) * sin(vXZ.y * 0.17 - uTime * 0.13) * 0.5 + 0.5;
          float mask = smoothstep(0.45, 0.95, cluster);
          float glint = pow(max(0.0, g1), 22.0) * pow(max(0.0, g2), 9.0) * mask;
          float crest = clamp(vWave * 5.0 + 0.5, 0.0, 1.0);
          totalEmissiveRadiance += vec3(1.0, 0.97, 0.88) * glint * uSparkle * (0.2 + crest * 1.4);
        `)
    }

    this.mesh = new THREE.Mesh(geo, mat)
    // 보트와 로어의 그림자가 수면에 떨어져야 배가 물 위에 떠 있는 것처럼 보인다.
    this.mesh.receiveShadow = true
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

  setWeather(wind: number, rain: number, sparkle = 0) {
    this.uniforms.uWind.value = Math.max(0, Math.min(1, wind))
    this.uniforms.uRain.value = Math.max(0, Math.min(1, rain))
    this.uniforms.uSparkle.value = Math.max(0, Math.min(1, sparkle))
    // 비가 오면 표면이 거칠어진다. 맑을 때도 0.45 아래로 내리지 않는다 —
    // 더 매끈하면 정면 카메라(태양 방향)에서 반사가 화면을 하얗게 덮는다. 반짝임은 셰이더의 글린트가 맡는다.
    ;(this.mesh.material as THREE.MeshStandardMaterial).roughness = 0.5 + rain * 0.16 - sparkle * 0.05
  }
}
