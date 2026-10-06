import * as THREE from 'three'

/**
 * 하늘 돔과 이미지 기반 조명(IBL).
 *
 * 하늘은 셰이더 하나로 그린다: 지평선→천정 대기 그라데이션, 지평선 헤이즈, 태양 주위의 미 산란(Mie),
 * 두 층의 절차적 구름(뭉게구름 + 높은 새털구름). 구름은 두꺼운 곳의 밑면이 그늘지고 해 쪽 가장자리가
 * 빛을 받아 밝다 — 평면 얼룩이 아니라 부피로 읽힌다.
 *
 * 같은 재질을 작은 구에 씌워 PMREM으로 구워 scene.environment에 넣는다. 그러면 모든 PBR 재질이
 * 하늘색·햇빛·구름을 반사하고, 그늘이 하늘빛으로 차오른다. 날씨가 바뀔 때만 다시 굽는다.
 */

export interface SkyUniforms {
  uTop: { value: THREE.Color }
  uBottom: { value: THREE.Color }
  uHaze: { value: THREE.Color }
  uCloud: { value: THREE.Color }
  uSunColor: { value: THREE.Color }
  uSunDir: { value: THREE.Vector3 }
  uSunGlow: { value: number }
  uCloudCover: { value: number }
  /** 구름 밑면의 어둡기 배율 (0.5 흐린 날 ~ 0.72 맑은 날) */
  uCloudShade: { value: number }
  uTime: { value: number }
}

export function createSkyUniforms(): SkyUniforms {
  return {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uHaze: { value: new THREE.Color() },
    uCloud: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(-105, 52, -20).normalize() },
    uSunGlow: { value: 0 },
    uCloudCover: { value: 0.2 },
    uCloudShade: { value: 0.66 },
    uTime: { value: 0 },
  }
}

const VERTEX = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT = /* glsl */`
  uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uHaze; uniform vec3 uCloud; uniform vec3 uSunColor;
  uniform vec3 uSunDir; uniform float uSunGlow; uniform float uCloudCover; uniform float uCloudShade; uniform float uTime;
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm5(vec2 p) {
    float v = 0.0; float a = 0.5;
    for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.02 + 19.3; a *= 0.5; }
    return v;
  }
  float fbm3(vec2 p) {
    float v = 0.0; float a = 0.5;
    for (int k = 0; k < 3; k++) { v += a * vnoise(p); p = p * 2.07 + 11.7; a *= 0.5; }
    return v;
  }
  // 구름 밀도장 — 조명 계산을 위해 두 번 부른다
  float cloudField(vec2 p, float cover) {
    float n = fbm5(p * 1.25) * 0.78 + fbm3(p * 4.1 + 7.0) * 0.22;
    float edge0 = 0.72 - cover * 0.42;
    return smoothstep(edge0, edge0 + 0.20, n);
  }

  void main() {
    vec3 d = normalize(vDir);
    float y = d.y;
    // 대기: 지평선에서 천정으로 지수적으로 짙어진다 (레일리 산란의 두께 근사)
    float t = 1.0 - exp(-max(y, 0.0) * 3.4);
    vec3 col = mix(uBottom, uTop, t);
    // 지평선 헤이즈 — 낮은 각도는 대기가 두꺼워 밝고 뿌옇다
    float haze = exp(-max(y, 0.0) * 8.0);
    col = mix(col, uHaze, haze * 0.64);
    // 지평선 아래(수면 아래로 이어지는 돔)는 헤이즈 색으로 고정
    col = mix(col, uHaze, smoothstep(0.0, -0.08, y) * 0.6);

    // 태양: 넓은 미 산란 + 좁은 코로나. 지평선 근처에서는 산란이 더 퍼진다.
    float sd = max(dot(d, uSunDir), 0.0);
    // 해를 마주 보는 카메라(정면)에서 화면이 하얗게 날아가지 않도록 넓은 산란은 절제한다
    float mie = pow(sd, 6.0) * 0.11 + pow(sd, 48.0) * 0.26 + pow(sd, 700.0) * 0.55;
    mie *= 1.0 + haze * 0.8;
    col += uSunColor * uSunGlow * mie;

    if (y > 0.005) {
      vec2 uv = d.xz / (y + 0.12);
      float cover = clamp(uCloudCover, 0.0, 1.0);
      vec2 p = uv * 0.5 + vec2(uTime * 0.0035, uTime * 0.0012);
      float cloud = cloudField(p, cover);
      // 해 쪽으로 조금 밀어 다시 샘플링 — 밀도 차이가 곧 조명 방향의 두께 차이다
      float toward = cloudField(p + uSunDir.xz * 0.045, cover);
      float thick = smoothstep(0.35, 1.0, cloud);
      float horizonFade = smoothstep(0.005, 0.10, y);
      cloud *= horizonFade;
      // 위·해 쪽 면은 밝고 아래·반대쪽은 그늘진다
      float lit = clamp(0.55 + (cloud * horizonFade - toward) * 2.2, 0.0, 1.0);
      vec3 shade = uCloud * uCloudShade;
      vec3 bright = uCloud * (1.0 + 0.10 * sd);
      vec3 cloudCol = mix(shade, bright, lit);
      cloudCol = mix(cloudCol, shade, thick * 0.35);
      // 은빛 가장자리: 태양 근처 얇은 구름은 빛이 통과한다
      cloudCol += uSunColor * uSunGlow * pow(sd, 5.0) * 0.45 * (1.0 - thick);
      col = mix(col, cloudCol, cloud * 0.96);

      // 새털구름: 높고 얇게 한 방향으로 늘어진 결
      vec2 c = uv * vec2(0.22, 1.5) + vec2(uTime * 0.0018, 0.0);
      float cir = fbm3(c * 1.6 + 31.0);
      float cirrus = smoothstep(0.60, 0.82, cir) * (0.22 + cover * 0.30) * smoothstep(0.04, 0.22, y);
      col = mix(col, mix(uCloud, uHaze, 0.25), cirrus * (1.0 - cloud));
    }
    gl_FragColor = vec4(col, 1.0);
  }
`

export function createSkyMaterial(uniforms: SkyUniforms) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  })
}

/**
 * 하늘을 환경맵으로 굽는다. 날씨 전환 중에만 다시 굽고, 그 밖에는 처음 것을 쓴다.
 * (PMREM 한 번에 수 ms — 매 프레임 굽으면 iPad에서 프레임이 튄다.)
 */
export class SkyEnvironment {
  private generator: THREE.PMREMGenerator | null = null
  private envScene = new THREE.Scene()
  private current: THREE.WebGLRenderTarget | null = null
  private lastKey = ''

  constructor(material: THREE.ShaderMaterial) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 14), material)
    this.envScene.add(dome)
  }

  /**
   * @param key 날씨 상태를 요약한 문자열 — 바뀌었을 때만 굽는다
   */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, key: string) {
    if (key === this.lastKey && this.current) return false
    this.lastKey = key
    if (!this.generator) {
      this.generator = new THREE.PMREMGenerator(renderer)
      this.generator.compileCubemapShader()
    }
    const next = this.generator.fromScene(this.envScene, 0.04, 1, 100)
    scene.environment = next.texture
    this.current?.dispose()
    this.current = next
    return true
  }

  dispose() {
    this.current?.dispose()
    this.generator?.dispose()
    const dome = this.envScene.children[0] as THREE.Mesh | undefined
    dome?.geometry.dispose()
  }
}
