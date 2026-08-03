// Minimal stand-in for the 'three' bare specifier so mujocoUtils.js can be
// imported under Node. compileModel() and readModelNames() never touch three,
// but they live in a module whose import graph pulls it in (and Reflector.js
// destructures named exports from it).
class Stub {
  constructor() {}
  set() { return this; }
  clone() { return new Stub(); }
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
