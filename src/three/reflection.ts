import * as THREE from 'three'

/**
 * 수면 평면 반사.
 *
 * 카메라를 수면(y=0)에 대칭으로 뒤집은 반사 카메라로 장면을 한 번 더 그려 텍스처에 담는다.
 * 물 셰이더가 이 텍스처를 화면 좌표로 투영해 샘플링하면 나무·다리·보트가 물에 비친다 —
 * 강 장면이 "진짜"로 보이는 데 가장 큰 단서다.
 *
 * - 수면 아래 부분이 반사에 섞이지 않도록 사선 절단(oblique near plane)으로 near 평면을 수면에 맞춘다.
 * - REFLECT_LAYER가 켜진 오브젝트만 그린다. 작은 소품·입자·수면 자체는 빼서 드로우콜을 아낀다.
 * - 해상도는 화면의 절반 이하 — 물결에 왜곡되므로 흐릿해도 티가 나지 않는다.
 */
export const REFLECT_LAYER = 1

const _normal = new THREE.Vector3(0, 1, 0)
const _cameraPos = new THREE.Vector3()
const _view = new THREE.Vector3()
const _target = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _rotation = new THREE.Matrix4()
const _plane = new THREE.Plane()
const _clip = new THREE.Vector4()
const _q = new THREE.Vector4()

export class PlanarReflection {
  target: THREE.WebGLRenderTarget
  readonly textureMatrix = new THREE.Matrix4()
  readonly camera = new THREE.PerspectiveCamera()
  /** 화면 해상도 대비 반사 텍스처 배율 */
  scale = 0.5
  enabled = true
  private width = 1
  private height = 1

  constructor(renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    })
    this.camera.layers.set(REFLECT_LAYER)
    this.resize(renderer)
  }

  get texture() { return this.target.texture }

  resize(renderer: THREE.WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const w = Math.max(64, Math.round(size.x * this.scale))
    const h = Math.max(64, Math.round(size.y * this.scale))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.target.setSize(w, h)
  }

  /**
   * 반사 텍스처를 갱신한다. 메인 렌더 **전에** 호출한다.
   * @param planeY 수면 높이 (월드)
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, planeY = 0) {
    if (!this.enabled) return
    this.resize(renderer)
    const reflection = this.camera

    _cameraPos.setFromMatrixPosition(camera.matrixWorld)
    if (_cameraPos.y <= planeY + 0.02) return   // 수면 아래에서는 반사가 없다

    // 카메라 위치를 평면에 대칭 이동
    _view.copy(_cameraPos)
    _view.y = 2 * planeY - _cameraPos.y
    _rotation.extractRotation(camera.matrixWorld)
    _lookAt.set(0, 0, -1).applyMatrix4(_rotation).add(_cameraPos)
    _target.copy(_lookAt)
    _target.y = 2 * planeY - _lookAt.y

    reflection.position.copy(_view)
    reflection.up.set(0, 1, 0).applyMatrix4(_rotation)
    reflection.up.reflect(_normal)
    reflection.lookAt(_target)
    reflection.near = camera.near
    reflection.far = camera.far
    reflection.updateMatrixWorld()
    reflection.projectionMatrix.copy(camera.projectionMatrix)

    // 텍스처 행렬: 월드 → 반사 클립 → [0,1]
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    )
    this.textureMatrix.multiply(reflection.projectionMatrix)
    this.textureMatrix.multiply(reflection.matrixWorldInverse)

    // 사선 near 평면 (Lengyel) — 수면 아래 지오메트리를 잘라낸다
    _plane.setFromNormalAndCoplanarPoint(_normal, new THREE.Vector3(0, planeY, 0))
    _plane.applyMatrix4(reflection.matrixWorldInverse)
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant)
    const p = reflection.projectionMatrix
    _q.x = (Math.sign(_clip.x) + p.elements[8]!) / p.elements[0]!
    _q.y = (Math.sign(_clip.y) + p.elements[9]!) / p.elements[5]!
    _q.z = -1.0
    _q.w = (1.0 + p.elements[10]!) / p.elements[14]!
    _clip.multiplyScalar(2.0 / _clip.dot(_q))
    p.elements[2] = _clip.x
    p.elements[6] = _clip.y
    // 약간의 bias — 수면 바로 위 물체(오리·퍼들)가 지글거리지 않게
    p.elements[10] = _clip.z + 1.0 - 0.002
    p.elements[14] = _clip.w

    const previousTarget = renderer.getRenderTarget()
    const previousXr = renderer.xr.enabled
    renderer.xr.enabled = false
    renderer.setRenderTarget(this.target)
    renderer.state.buffers.depth.setMask(true)
    renderer.clear()
    renderer.render(scene, reflection)
    renderer.setRenderTarget(previousTarget)
    renderer.xr.enabled = previousXr
  }

  dispose() {
    this.target.dispose()
  }
}

/** 오브젝트(와 자식)를 반사에 포함시킨다. 메인 카메라에는 그대로 보인다. */
export function markReflective(object: THREE.Object3D, on = true) {
  object.traverse(node => {
    if (on) node.layers.enable(REFLECT_LAYER)
    else node.layers.disable(REFLECT_LAYER)
  })
}
