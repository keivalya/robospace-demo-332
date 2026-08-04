// examples/utils/disposeThree.js
//
// Releases the GPU resources a scene graph owns. Called when a scene is replaced.
//
// The version this replaces disposed only `geometry` and `material`, and only for
// nodes matching `isMesh || isLine || isPoints`. Everything it missed is recreated on
// every single scene reload, and the agent's repair loop reloads repeatedly by
// design:
//
//   * THREE.DataTexture per textured material. `material.dispose()` does NOT dispose
//     `material.map`, so each reload abandoned live GPU textures.
//   * Reflector's WebGLRenderTarget — 512x512, 4x MSAA, half-float, so roughly 8 MB
//     of GPU memory per ground plane. Reflector defines its own dispose() that
//     releases it, and nothing ever called it.
//   * 1024x1024 shadow maps, one per light. Lights are neither meshes nor lines, so
//     the old filter skipped them entirely.
//
// Returns counts so a reload-lifecycle test can assert that generation N's resources
// are gone by generation N+1, rather than trusting that they are.

/** @returns {{disposables:number, geometries:number, materials:number, textures:number, shadowMaps:number}} */
export function disposeSceneGraph(root) {
  const counts = { disposables: 0, geometries: 0, materials: 0, textures: 0, shadowMaps: 0 };
  if (!root) return counts;

  // The loader deliberately shares one material across geoms and one geometry per
  // meshID, so without de-duplication the counts are meaningless (and doubly-disposed
  // resources, while harmless in three, make a test impossible to write).
  const seenGeometry = new Set();
  const seenMaterial = new Set();
  const seenTexture = new Set();

  const disposeTexture = (value) => {
    if (!value || !value.isTexture || seenTexture.has(value)) return;
    seenTexture.add(value);
    try { value.dispose(); counts.textures++; } catch (e) {
      console.warn('[disposeThree] texture dispose failed:', e);
    }
  };

  const disposeMaterial = (material) => {
    if (!material || seenMaterial.has(material)) return;
    seenMaterial.add(material);
    // Direct texture slots: map, normalMap, roughnessMap, envMap, ...
    for (const key of Object.keys(material)) disposeTexture(material[key]);
    // ShaderMaterial keeps its textures in uniforms instead — this is where
    // Reflector holds the DataTexture handed to it as options.texture.
    if (material.uniforms) {
      for (const name of Object.keys(material.uniforms)) {
        disposeTexture(material.uniforms[name]?.value);
      }
    }
    try { material.dispose(); counts.materials++; } catch (e) {
      console.warn('[disposeThree] material dispose failed:', e);
    }
  };

  root.traverse((node) => {
    // Objects that own resources the generic paths below cannot see. Reflector is
    // the one that matters — its dispose() releases the render target. InstancedMesh
    // also has one (its instance attributes). Skip the root itself: removing it from
    // its parent is handled at the end.
    if (node !== root && typeof node.dispose === 'function') {
      try { node.dispose(); counts.disposables++; } catch (e) {
        console.warn('[disposeThree] node dispose failed:', e);
      }
    }

    if (node.geometry && !seenGeometry.has(node.geometry)) {
      seenGeometry.add(node.geometry);
      try { node.geometry.dispose(); counts.geometries++; } catch (e) {
        console.warn('[disposeThree] geometry dispose failed:', e);
      }
    }

    if (Array.isArray(node.material)) node.material.forEach(disposeMaterial);
    else if (node.material) disposeMaterial(node.material);

    // Shadow maps are render targets allocated lazily by the renderer and hung off
    // the light, not off any material.
    if (node.isLight && node.shadow && node.shadow.map) {
      try {
        node.shadow.map.dispose();
        node.shadow.map = null;
        counts.shadowMaps++;
      } catch (e) {
        console.warn('[disposeThree] shadow map dispose failed:', e);
      }
    }
  });

  if (root.parent) root.parent.remove(root);
  return counts;
}
