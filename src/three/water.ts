import * as THREE from 'three'

/**
 * 물 표면.
 *
 * MeshStandardMaterial에 onBeforeCompile로 세 가지를 얹는다.
 *  - 정점: 낮은 파도의 변위 (조정 수로는 잔잔해서 파고 10cm 아래)
 *  - 프래그먼트: 같은 파도의 해석적 기울기 + 잔물결 세 겹으로 노멀을 흔든다 →
 *    햇빛 하이라이트가 한 덩어리로 번지지 않고 물결을 따라 잘게 부서진다
 *  - 프래그먼트: 프레넬 — 비스듬히 볼수록 하늘이 비친다. 발밑은 깊은 물색, 멀리는 지평선 하늘색.
 * three의 조명·안개·그림자 파이프라인은 그대로 쓴다.
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
    uSkyTop: { value: new THREE.Color('#3a8fe2') },
    uSkyBottom: { value: new THREE.Color('#dcefff') },
    /** 하늘 반사의 세기. 흐린 날은 물이 하늘을 덜 비춘다(빛이 산란되어 대비가 낮다) */
    uReflect: { value: 0.85 },
  }

  constructor(color: THREE.ColorRepresentation, deep: THREE.ColorRepresentation) {
    const geo = new THREE.PlaneGeometry(600, 500, 220, 140)
    geo.rotateX(-Math.PI / 2)

    const mat = new THREE.MeshStandardMaterial({
      // 노멀을 잔물결로 흔들어 하이라이트가 흩어지므로 예전(0.5)보다 매끈해도 화면이 하얗게 덮이지 않는다
      color, roughness: 0.42, metalness: 0.04,
    })
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
        // 변위 없는 잔물결 네 겹 — 노멀만 흔든다. 파면을 저주파 sin으로 휘고 느린 얼룩 마스크로 세기를
        // 군데군데 바꿔서 평행 줄무늬(골판지)로 읽히지 않게 한다.
        vec2 rippleGrad(vec2 p) {
          float amp = 0.009 + uWind * 0.012 + uRain * 0.010;
          float m1 = 0.55 + 0.45 * sin(p.x * 0.23 + p.y * 0.31 + uTime * 0.40);
          float m2 = 0.55 + 0.45 * sin(p.x * -0.17 + p.y * 0.27 - uTime * 0.30);
          float m3 = 0.55 + 0.45 * sin(p.x * 0.29 - p.y * 0.19 + uTime * 0.50);
          float a1 = p.x * 4.1 + p.y * 2.7 + uTime * 2.9 + sin(p.y * 0.50 + uTime * 0.2) * 2.0;
          float a2 = p.x * -2.9 + p.y * 5.3 - uTime * 2.3 + sin(p.x * 0.45 - uTime * 0.15) * 2.0;
          float a3 = p.x * 7.5 + p.y * -6.1 + uTime * 4.2 + sin(p.x * 0.7 + p.y * 0.6) * 1.5;
          float a4 = p.x * 6.3 + p.y * 6.9 - uTime * 3.6 + sin(p.y * 0.8 - p.x * 0.3) * 1.2;
          return (vec2(4.1, 2.7) * cos(a1) * 0.50 * m1
                + vec2(-2.9, 5.3) * cos(a2) * 0.45 * m2
                + vec2(7.5, -6.1) * cos(a3) * 0.22 * m3
                + vec2(6.3, 6.9) * cos(a4) * 0.18 * m1) * amp;
        }
      `

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uScroll;
          ${waveGlsl}
          varying float vWave;
          varying vec2 vXZ;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vec2 wp = vec2(transformed.x + uScroll, transformed.z);
          float w = waveHeight(wp);
          transformed.y += w;
          vWave = w;
          vXZ = wp;
        `)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec3 uDeep;
          uniform float uSparkle;
          uniform vec3 uSkyTop;
          uniform vec3 uSkyBottom;
          uniform float uReflect;
          ${waveGlsl}
          varying float vWave;
          varying vec2 vXZ;
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          // 파고가 낮은 골은 깊은 색, 마루는 밝게 — 노멀 없이도 물결이 읽힌다
          float t = clamp(vWave * 5.0 + 0.5, 0.0, 1.0);
          diffuseColor.rgb = mix(mix(uDeep, diffuseColor.rgb, 0.45), diffuseColor.rgb, t);
          diffuseColor.rgb += pow(t, 7.0) * 0.12;
        `)
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          {
            // 멀리서는 잔물결이 픽셀보다 잘아 반짝거리기만 하므로 거리에 따라 눕힌다
            float dist = length(vViewPosition);
            float fade = 1.0 / (1.0 + dist * 0.045);
            vec2 g = waveGrad(vXZ) + rippleGrad(vXZ) * fade;
            vec3 nWorld = normalize(vec3(-g.x, 1.0, -g.y));
            normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
          }
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          {
            // 프레넬: 비스듬히 볼수록 물색 대신 하늘이 비친다. 반사 방향이 높을수록 천정색, 낮을수록 지평선색.
            vec3 V = normalize(vViewPosition);
            float NoV = clamp(dot(normal, V), 0.0, 1.0);
            float fresnel = 0.03 + 0.97 * pow(1.0 - NoV, 5.0);
            vec3 R = reflect(-V, normal);
            float ry = dot(viewMatrix[1].xyz, R);
            vec3 skyReflection = mix(uSkyBottom, uSkyTop, smoothstep(-0.05, 0.6, ry));
            diffuseColor.rgb = mix(diffuseColor.rgb, skyReflection, clamp(fresnel * uReflect, 0.0, 0.82));
          }
          // 햇빛 반짝임 — 잔물결 마루에서만 잠깐씩 튀는 하이라이트.
          // 두 주파수의 곱이라 규칙적인 격자로 보이지 않는다
          // (GLSL ES 예약어인 patch/sample 같은 이름은 쓰면 안 된다)
          float g1 = sin(vXZ.x * 3.1 + uTime * 1.7) * sin(vXZ.y * 2.7 - uTime * 1.3);
          float g2 = sin(vXZ.x * 7.9 - uTime * 2.9 + vXZ.y * 1.9) * sin(vXZ.y * 6.3 + uTime * 2.2);
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
    ;(this.mesh.material as THREE.MeshStandardMaterial).roughness = 0.42 + rain * 0.2 - sparkle * 0.06
  }
}
