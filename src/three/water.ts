import * as THREE from 'three'
import { waterNormalTexture } from './textures'
import type { PlanarReflection } from './reflection'

/**
 * 물 표면.
 *
 * MeshStandardMaterial에 onBeforeCompile로 얹는다.
 *  - 정점: 낮은 파도의 변위 (조정 수로는 잔잔해서 파고 10cm 아래)
 *  - 프래그먼트 노멀: 같은 파도의 해석적 기울기 + 잔물결 노멀맵 두 겹(서로 다른 방향·속도로 흐름)
 *    → 햇빛 하이라이트가 한 덩어리로 번지지 않고 물결을 따라 잘게 부서진다
 *  - 반사: 평면 반사 텍스처(나무·다리·보트가 물에 비친다)를 노멀로 흔들어 샘플링하고, 프레넬로
 *    섞는다 — 발밑은 깊은 물색, 비스듬히 볼수록 반사가 강해진다. 반사가 꺼지면 하늘 그라데이션으로 대신한다.
 *  - 햇빛 정반사는 재질의 GGX가 맡는다 (노멀이 잘게 흔들려 자연스러운 반짝임이 난다).
 * three의 조명·안개·그림자 파이프라인은 그대로 쓴다.
 */
export class Water {
  readonly mesh: THREE.Mesh
  private material: THREE.MeshStandardMaterial
  private reflection: PlanarReflection | null = null
  private uniforms = {
    uTime: { value: 0 },
    uScroll: { value: 0 },
    uDeep: { value: new THREE.Color('#0d2a3d') },
    uWind: { value: 0 },
    uRain: { value: 0 },
    uSparkle: { value: 0 },
    uSkyTop: { value: new THREE.Color('#3a8fe2') },
    uSkyBottom: { value: new THREE.Color('#dcefff') },
    /** 하늘 반사의 세기. 흐린 날은 물이 하늘을 덜 비친다(빛이 산란되어 대비가 낮다) */
    uReflect: { value: 0.85 },
    tNormal: { value: waterNormalTexture() },
    tReflection: { value: null as THREE.Texture | null },
    uReflectMatrix: { value: new THREE.Matrix4() },
    /** 0이면 하늘 그라데이션만, 1이면 평면 반사 텍스처 */
    uPlanar: { value: 0 },
  }

  constructor(color: THREE.ColorRepresentation, deep: THREE.ColorRepresentation) {
    const geo = new THREE.PlaneGeometry(600, 500, 220, 140)
    geo.rotateX(-Math.PI / 2)

    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.22, metalness: 0.0,
      // 반사는 평면 반사 텍스처가 맡는다. 환경맵까지 겹치면 하늘이 두 번 비친다.
      envMapIntensity: 0.35,
    })
    this.material = mat
    this.uniforms.uDeep.value = new THREE.Color(deep)

    mat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms)

      // 파도 높이 — 정점(변위)과 프래그먼트(기울기)가 같은 식을 쓴다
      const waveGlsl = /* glsl */`
        uniform float uTime;
        uniform float uWind;
        uniform float uRain;
        float waveHeight(vec2 p) {
          float ws = 1.0 + uWind * 0.35;
          return sin(p.x * 0.32 + uTime * 1.15) * 0.030 * ws
               + sin(p.x * 0.87 - p.y * 0.41 + uTime * 1.75) * 0.016 * ws
               + sin(p.y * 0.55 + uTime * 0.72) * 0.020 * ws
               + sin(p.x * 2.1 + p.y * 1.3 - uTime * 2.6) * 0.007
               + sin(p.x * 7.8 - p.y * 5.6 + uTime * 8.4) * 0.003 * uRain;
        }
        // ∂h/∂x, ∂h/∂z — 위 식의 해석적 미분
        vec2 waveGrad(vec2 p) {
          float ws = 1.0 + uWind * 0.35;
          float c1 = cos(p.x * 0.32 + uTime * 1.15) * 0.030 * ws;
          float c2 = cos(p.x * 0.87 - p.y * 0.41 + uTime * 1.75) * 0.016 * ws;
          float c3 = cos(p.y * 0.55 + uTime * 0.72) * 0.020 * ws;
          float c4 = cos(p.x * 2.1 + p.y * 1.3 - uTime * 2.6) * 0.007;
          float c5 = cos(p.x * 7.8 - p.y * 5.6 + uTime * 8.4) * 0.003 * uRain;
          return vec2(
            c1 * 0.32 + c2 * 0.87 + c4 * 2.1 + c5 * 7.8,
            c2 * -0.41 + c3 * 0.55 + c4 * 1.3 + c5 * -5.6
          );
        }
      `

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uScroll;
          uniform mat4 uReflectMatrix;
          ${waveGlsl}
          varying float vWave;
          varying vec2 vXZ;
          varying vec4 vReflect;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vec2 wp = vec2(transformed.x + uScroll, transformed.z);
          float w = waveHeight(wp);
          transformed.y += w;
          vWave = w;
          vXZ = wp;
          vReflect = uReflectMatrix * (modelMatrix * vec4(transformed, 1.0));
        `)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec3 uDeep;
          uniform float uSparkle;
          uniform vec3 uSkyTop;
          uniform vec3 uSkyBottom;
          uniform float uReflect;
          uniform sampler2D tNormal;
          uniform sampler2D tReflection;
          uniform float uPlanar;
          ${waveGlsl}
          varying float vWave;
          varying vec2 vXZ;
          varying vec4 vReflect;
          vec3 waterNormalWorld;
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          // 물은 빛을 흡수한다 — 반사가 그림을 만들고 표면색 자체는 어둡고 깊다.
          // 파고가 낮은 골은 깊은 색, 마루는 조금 밝다 (얕은 물의 산란)
          float t = clamp(vWave * 5.0 + 0.5, 0.0, 1.0);
          diffuseColor.rgb = mix(uDeep, diffuseColor.rgb, 0.35 + t * 0.3) * 0.62;
        `)
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          {
            float dist = length(vViewPosition);
            // 멀리서는 잔물결이 픽셀보다 잘아 반짝거리기만 하므로 거리에 따라 눕힌다
            float fade = 1.0 / (1.0 + dist * 0.030);
            vec2 g = waveGrad(vXZ);
            // 잔물결 노멀맵 두 겹: 바람 방향으로 흐르는 큰 결 + 반대로 비껴 흐르는 잔결
            float amp = 0.55 + uWind * 0.55 + uRain * 0.6;
            vec3 n1 = texture2D(tNormal, vXZ * 0.085 + vec2(uTime * 0.020, uTime * 0.011)).xyz * 2.0 - 1.0;
            vec3 n2 = texture2D(tNormal, vXZ * 0.23 * vec2(1.0, -1.0) + vec2(-uTime * 0.031, uTime * 0.017)).xyz * 2.0 - 1.0;
            vec3 n3 = texture2D(tNormal, vXZ * 0.52 + vec2(uTime * 0.05, -uTime * 0.04)).xyz * 2.0 - 1.0;
            vec2 detail = (n1.xy * 0.55 + n2.xy * 0.32 + n3.xy * 0.13 * (1.0 + uRain * 2.0)) * amp * fade * 0.55;
            vec3 nWorld = normalize(vec3(-g.x + detail.x, 1.0, -g.y + detail.y));
            waterNormalWorld = nWorld;
            normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
          }
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          // 햇빛 반짝임 — 잔물결 마루에서만 잠깐씩 튀는 하이라이트 (GGX 정반사에 얹는 보조 효과)
          float g1 = sin(vXZ.x * 3.1 + uTime * 1.7) * sin(vXZ.y * 2.7 - uTime * 1.3);
          float g2 = sin(vXZ.x * 7.9 - uTime * 2.9 + vXZ.y * 1.9) * sin(vXZ.y * 6.3 + uTime * 2.2);
          float cluster = sin(vXZ.x * 0.11 + uTime * 0.21) * sin(vXZ.y * 0.17 - uTime * 0.13) * 0.5 + 0.5;
          float mask = smoothstep(0.45, 0.95, cluster);
          float glint = pow(max(0.0, g1), 22.0) * pow(max(0.0, g2), 9.0) * mask;
          float crest = clamp(vWave * 5.0 + 0.5, 0.0, 1.0);
          totalEmissiveRadiance += vec3(1.0, 0.97, 0.88) * glint * uSparkle * (0.1 + crest * 0.7);
        `)
        .replace('#include <opaque_fragment>', /* glsl */`
          {
            // 프레넬: 비스듬히 볼수록 물색 대신 반사가 보인다.
            vec3 V = normalize(vViewPosition);
            float NoV = clamp(dot(normal, V), 0.0, 1.0);
            float fresnel = 0.025 + 0.975 * pow(1.0 - NoV, 5.0);
            vec3 R = reflect(-V, normal);
            float ry = dot(viewMatrix[1].xyz, R);
            vec3 skyRef = mix(uSkyBottom, uSkyTop, smoothstep(-0.05, 0.6, ry));
            vec3 reflection = skyRef;
            float cap = 0.9;
            if (uPlanar > 0.001) {
              float dist = length(vViewPosition);
              // 가까운 물결은 반사를 크게 흔들고, 멀리서는 화면 공간에서 작게 흔든다
              vec2 distort = waterNormalWorld.xz * (0.12 / (1.0 + dist * 0.06));
              vec2 uv = clamp(vReflect.xy / vReflect.w + distort, 0.002, 0.998);
              vec3 planar = texture2D(tReflection, uv).rgb;
              reflection = mix(skyRef, planar, uPlanar);
            } else {
              // 반사 텍스처가 없으면(low 티어) 밝은 지평선색이 그대로 비쳐 물이 우유처럼 하얘진다 —
              // 하늘을 더 깊은 색으로 섞고 반사 상한도 낮춘다
              reflection = mix(uSkyBottom * 0.6, uSkyTop, smoothstep(0.0, 0.4, ry));
              cap = 0.68;
            }
            float k = clamp(fresnel * uReflect, 0.0, cap);
            // 확산·발광은 프레넬만큼 반사로 바뀌고, 햇빛 정반사는 그대로 얹는다
            outgoingLight = mix(totalDiffuse + totalEmissiveRadiance, reflection, k)
              + reflectedLight.directSpecular
              + reflectedLight.indirectSpecular * (1.0 - k);
          }
          #include <opaque_fragment>
        `)
    }

    this.mesh = new THREE.Mesh(geo, mat)
    // 보트와 로어의 그림자가 수면에 떨어져야 배가 물 위에 떠 있는 것처럼 보인다.
    this.mesh.receiveShadow = true
    this.mesh.position.y = 0
  }

  /** 평면 반사를 연결한다 (null이면 하늘 그라데이션만 쓴다). */
  setReflection(reflection: PlanarReflection | null) {
    this.reflection = reflection
    this.uniforms.tReflection.value = reflection ? reflection.texture : null
    this.uniforms.uPlanar.value = reflection && reflection.enabled ? 1 : 0
    // 반사가 꺼지면 환경맵이 하늘을 대신 비춘다 (너무 세면 지평선색이 물을 덮는다)
    this.material.envMapIntensity = reflection && reflection.enabled ? 0.35 : 0.5
  }

  /** distance는 코스 진행 거리(m) — 물결이 뒤로 흐른다 */
  update(timeSec: number, distance: number) {
    this.uniforms.uTime.value = timeSec
    this.uniforms.uScroll.value = distance
    if (this.reflection) {
      this.uniforms.uReflectMatrix.value.copy(this.reflection.textureMatrix)
      this.uniforms.tReflection.value = this.reflection.texture
      this.uniforms.uPlanar.value = this.reflection.enabled ? 1 : 0
    }
  }

  setPalette(color: THREE.ColorRepresentation, deep: THREE.ColorRepresentation) {
    this.material.color.set(color)
    this.uniforms.uDeep.value.set(deep)
  }

  /** 물에 비칠 하늘색. 날씨가 바뀌면 함께 바꾼다. */
  setSky(top: THREE.Color, bottom: THREE.Color, reflect = 0.85) {
    this.uniforms.uSkyTop.value.copy(top)
    this.uniforms.uSkyBottom.value.copy(bottom)
    this.uniforms.uReflect.value = reflect
  }

  setWeather(wind: number, rain: number, sparkle = 0) {
    this.uniforms.uWind.value = Math.max(0, Math.min(1, wind))
    this.uniforms.uRain.value = Math.max(0, Math.min(1, rain))
    this.uniforms.uSparkle.value = Math.max(0, Math.min(1, sparkle))
    // 비가 오면 표면이 거칠어진다. 맑고 반짝이는 날은 조금 더 매끈하다.
    this.material.roughness = 0.22 + rain * 0.25 + wind * 0.08 - sparkle * 0.05
  }
}
