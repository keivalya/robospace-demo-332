// Node module-resolution hook: point the 'three' bare specifier at test/three-stub.mjs.
// Registered via test/register.mjs; see test/README.md.
const STUB = new URL('./three-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three' || specifier.startsWith('three/')) {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
