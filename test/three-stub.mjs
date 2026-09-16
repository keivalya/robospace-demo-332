// Minimal stand-in for the 'three' bare specifier so mujocoUtils.js can be
// imported under Node. compileModel() and readModelNames() never touch three,
// but they live in a module whose import graph pulls it in (and Reflector.js
// destructures named exports from it).
class Stub {
  constructor() {
    this.matrix = this;
    this.matrixWorld = this;
    this.position = this;
    this.up = this;
    this.color = this;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.children = [];
  }
  set(x, y, z, w) {
    if (x !== undefined) this.x = x;
    if (y !== undefined) this.y = y;
    if (z !== undefined) this.z = z;
    if (w !== undefined) this.w = w;
    return this;
  }
  setHex() { return this; }
  clone() { return new Stub(); }
  copy() { return this; }
  add(child) {
    if (child && Array.isArray(this.children)) this.children.push(child);
    return this;
  }
  remove(child) {
    if (child && Array.isArray(this.children)) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
    }
    return this;
  }
  multiply() { return this; }
  updateProjectionMatrix() { return this; }
  updateMatrix() { return this; }
  updateMatrixWorld() { return this; }
  lookAt() { return this; }
}
export default Stub;

export const Color = Stub;
export const HalfFloatType = Stub;
export const LinearEncoding = Stub;
export const Matrix4 = Stub;
export const Mesh = Stub;
export const MeshPhysicalMaterial = Stub;
export const NoToneMapping = Stub;
export const PerspectiveCamera = Stub;
export const Plane = Stub;
export const ShaderMaterial = Stub;
export const UniformsUtils = Stub;
export const Vector3 = Stub;
export const Vector4 = Stub;
export const WebGLRenderTarget = Stub;
export const Group = Stub;
export const Vector2 = Stub;
export const Quaternion = Stub;
export const SphereGeometry = Stub;
export const MeshBasicMaterial = Stub;
