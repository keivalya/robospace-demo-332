// examples/utils/metaworldManifest.js
//
// Meta-World scene packs, kept separate from robotManifests.js because that file
// is generated from mujoco_menagerie and this comes from a different repository.
//
// Why Meta-World is here at all: RoboSpace needs real physics in the browser, and
// Meta-World's controller is a mocap body welded to the hand -- eight lines --
// where LIBERO's is robosuite's 413-line OSC_POSE. See
// vla_model/docs/metaworld.md and test/metaworld-parity.test.mjs, which shows
// this build agreeing with native MuJoCo to 4.17e-7 over 300 physics steps.
//
// The file list is the transitive closure of <include> and <mesh file> for the
// entry XML. Two resolution rules that are easy to get wrong and were checked
// against a real compile:
//
//   * <include file=".."> resolves relative to the *including* file.
//   * <mesh file=".."> resolves relative to the *main model file's* directory
//     (optionally via <compiler meshdir>), NOT the file that declares the mesh.
//     xyz_base.xml sits in objects/assets/ and declares
//     file="../objects/meshes/xyz_base/l0.stl", which only resolves from
//     sawyer_xyz/. Resolving it locally gives objects/objects/... and 14 of the
//     16 meshes silently go missing.
//
// The three <texture file=> references in scene/basic_scene.xml (wood2.png,
// floor2.png, metal.png) ARE fetched now. They were not, while the build was
// the vendored MuJoCo 3.3.2, which could not load an image-file texture at all
// and had stripFileTextures() remove the references. On @mujoco/mujoco 3.14.0
// they load, and they matter more than their 1.6 MB suggests: measured on the
// inference board, a policy shown the real textures scores 4/4 where flat white
// scores 0/4.

export const METAWORLD_COMMIT = "master";
export const METAWORLD_REPO = "Farama-Foundation/Metaworld";

export const METAWORLD_MANIFESTS = {
  metaworld_drawer: {
    repo: METAWORLD_REPO,
    commit: METAWORLD_COMMIT,
    upstreamDir: "metaworld/assets",
    entry: "sawyer_xyz/sawyer_drawer.xml",
    // One MJCF, two opposite instructions: "Open a drawer" (task 19) and
    // "Push and close a drawer" (task 18). Measured on the board: 6/6 with
    // the matching sentence, 0/6 with the other, Fisher p = 0.00216.
    tasks: [
      { id: 19, text: "Open a drawer" },
      { id: 18, text: "Push and close a drawer" },
    ],
    totalBytes: 5043074,   // 5.04 MB
    files: [
      { path: "textures/wood2.png", size: 381795 },
      { path: "textures/floor2.png", size: 1044587 },
      { path: "textures/metal.png", size: 196878 },
      { path: "sawyer_xyz/sawyer_drawer.xml", size: 808 },
      { path: "scene/basic_scene.xml", size: 3259 },
      { path: "objects/assets/drawer_dependencies.xml", size: 1371 },
      { path: "objects/assets/xyz_base_dependencies.xml", size: 1638 },
      { path: "objects/assets/xyz_base.xml", size: 19656 },
      { path: "objects/assets/drawer.xml", size: 1988 },
      { path: "objects/meshes/drawer/drawer.stl", size: 4684 },
      { path: "objects/meshes/drawer/drawercase.stl", size: 5484 },
      { path: "objects/meshes/drawer/drawerhandle.stl", size: 36884 },
      { path: "objects/meshes/table/tablebody.stl", size: 15484 },
      { path: "objects/meshes/table/tabletop.stl", size: 684 },
      { path: "objects/meshes/xyz_base/base.stl", size: 264934 },
      { path: "objects/meshes/xyz_base/eGripperBase.stl", size: 618984 },
      { path: "objects/meshes/xyz_base/head.stl", size: 276234 },
      { path: "objects/meshes/xyz_base/l0.stl", size: 675584 },
      { path: "objects/meshes/xyz_base/l1.stl", size: 511884 },
      { path: "objects/meshes/xyz_base/l2.stl", size: 133734 },
      { path: "objects/meshes/xyz_base/l3.stl", size: 160034 },
      { path: "objects/meshes/xyz_base/l4.stl", size: 208284 },
      { path: "objects/meshes/xyz_base/l5.stl", size: 176534 },
      { path: "objects/meshes/xyz_base/l6.stl", size: 183034 },
      { path: "objects/meshes/xyz_base/pedestal.stl", size: 118634 },
    ],
  },
};
