// examples/utils/mujocoCompat.js
//
// Presents the vendored `dist/mujoco_wasm.js` API on top of the official
// `@mujoco/mujoco` package, so the migration is one import change rather than a
// rewrite of every call site.
//
// WHY MIGRATE AT ALL. The vendored build is MuJoCo **3.3.2** and cannot load an
// image-file texture — every `<texture file="*.png">` fails to compile, with no
// diagnostic at all (see `tools/check-texture-support.mjs`, which pins the
// failure down to something other than size, staging or material references).
// `robotPacks.js:stripFileTextures` exists solely to work around that, and the
// cost is not cosmetic: measured on the inference board, driving one policy over
// one HTTP path and changing only what it is shown, real textures score 4/4
// while flat white scores 0/4, per-texture mean colour 0/4, and procedural
// checkers at best 3/8. Textures are worth roughly +100 points to a vision
// policy and nothing substitutes for them.
//
// The official package is **3.14.0** and loads them. Verified directly: the same
// four texture cases all pass, and all five Meta-World scenes compile with their
// PNGs intact (`ntex=4`, `tex_data` 5,179,392 bytes = 3 bytes/px), at model
// dimensions identical to the board's.
//
// WHAT THIS SHIM ABSORBS. The two bindings agree on far more than they differ:
// every field rs-demo reads is present under the same snake_case name, and every
// array it *writes* — `qpos`, `ctrl`, `mocap_pos`, `mocap_quat`, `body_pos`,
// `site_pos`, `eq_data` — is a writable typed array in both. Coverage checked
// field by field against the list rs-demo actually uses: MjData 22/22, MjModel
// 78/79. Four real differences remain, and they are the whole of this file:
//
//   1. Construction. `Model.load_from_xml(path)` -> `MjModel.from_xml_path`,
//      and `new Simulation(model, state)` -> `new MjData(model)` plus free
//      functions `mj_step(m, d)` rather than methods on a Simulation object.
//   2. `model.tex_rgb` is now `model.tex_data`.
//   3. `model.light_directional` (boolean per light) is now `model.light_type`
//      (an enum), where directional is `mjLIGHT_DIRECTIONAL === 1`.
//   4. `model.getOptions()` is now the `model.opt` object.
//
// Everything else forwards untouched.

import factory from '@mujoco/mujoco';

/** mjtLightType: SPOT 0, DIRECTIONAL 1, POINT 2, IMAGE 3. */
const MJ_LIGHT_DIRECTIONAL = 1;

/**
 * Every `mjtByte` array in the official binding throws on access:
 *
 *   BindingError: _emval_take_value has unknown type
 *                 N10emscripten11memory_viewIbEE
 *
 * `memory_view<bool>` is simply not a registered embind type in the published
 * module, so the getter cannot marshal it. Int32 and Float64 arrays are fine.
 * Confirmed for jnt_limited, actuator_ctrllimited, actuator_forcelimited,
 * tendon_limited, light_castshadow, light_active and eq_active0 — an upstream
 * bug, not a rename, and one the vendored build did not have.
 *
 * The per-element accessors marshal correctly (`model.jnt(0).limited === true`),
 * so each array is rebuilt from those on demand. Rebuilt per access rather than
 * cached because these are model properties a caller may legitimately mutate,
 * and a stale cache would be worse than the cost: they are tiny (one byte per
 * joint or actuator) and read outside hot loops.
 *
 * Maps the flat field name to [accessor, count field, property on the element].
 */
const BOOL_ARRAY_FIELDS = {
  jnt_limited: ['jnt', 'njnt', 'limited'],
  actuator_ctrllimited: ['actuator', 'nu', 'ctrllimited'],
  actuator_forcelimited: ['actuator', 'nu', 'forcelimited'],
  actuator_actlimited: ['actuator', 'nu', 'actlimited'],
  tendon_limited: ['tendon', 'ntendon', 'limited'],
  light_castshadow: ['light', 'nlight', 'castshadow'],
  light_active: ['light', 'nlight', 'active'],
  eq_active0: ['eq', 'neq', 'active0'],
};

/** The MjData fields rs-demo reads, plus the rest, discovered once from the prototype. */
function accessorNames(instance) {
  const proto = Object.getPrototypeOf(instance);
  const out = [];
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    // Read the descriptor rather than the value: touching an embind getter on
    // the prototype itself throws "getter incompatible with this".
    if (desc && typeof desc.get === 'function') out.push(key);
  }
  return out;
}

/**
 * Adds the three renamed/removed members back onto a freshly loaded model.
 *
 * Defined on the instance, not the prototype, because the prototype is shared
 * embind machinery and `tex_data`'s length depends on the model.
 */
function decorateModel(model) {
  if (!('tex_rgb' in model)) {
    Object.defineProperty(model, 'tex_rgb', {
      get() { return model.tex_data; }, configurable: true,
    });
  }
  if (!('light_directional' in model)) {
    Object.defineProperty(model, 'light_directional', {
      get() {
        const t = model.light_type;
        const out = new Uint8Array(t.length);
        for (let i = 0; i < t.length; i++) out[i] = t[i] === MJ_LIGHT_DIRECTIONAL ? 1 : 0;
        return out;
      },
      configurable: true,
    });
  }
  for (const [field, [accessor, countField, prop]] of Object.entries(BOOL_ARRAY_FIELDS)) {
    if (typeof model[accessor] !== 'function') continue;
    Object.defineProperty(model, field, {
      get() {
        const n = model[countField] ?? 0;
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const el = model[accessor](i);
          out[i] = el && el[prop] ? 1 : 0;
        }
        return out;
      },
      configurable: true,
    });
  }

  if (typeof model.getOptions !== 'function') {
    Object.defineProperty(model, 'getOptions', {
      // The old binding returned a plain object; `opt` is an embind handle, so
      // copy the scalars callers actually read rather than hand back the handle.
      value: () => {
        const o = model.opt;
        const out = {};
        for (const k of ['timestep', 'apirate', 'impratio', 'tolerance', 'noslip_tolerance',
                         'density', 'viscosity', 'o_margin', 'integrator', 'cone', 'jacobian',
                         'solver', 'iterations', 'noslip_iterations', 'disableflags',
                         'enableflags']) {
          if (o[k] !== undefined) out[k] = o[k];
        }
        return out;
      },
      configurable: true,
    });
  }
  return model;
}

/**
 * The old `Simulation`: one object carrying every MjData array plus the stepping
 * methods. The new binding splits those into `MjData` and free `mj_*` functions.
 */
function makeSimulationClass(mj, dataAccessors) {
  class Simulation {
    constructor(model, state) {
      this._model = model;
      // The old API took (model, state) where state came from `new State(model)`.
      // Here State already *is* the MjData, so reuse it rather than allocating a
      // second one — two MjData for one model is a silent divergence, not an error.
      this._data = state ?? new mj.MjData(model);
    }

    model() { return this._model; }
    state() { return this._data; }

    step() { mj.mj_step(this._model, this._data); }
    forward() { mj.mj_forward(this._model, this._data); }
    kinematics() { mj.mj_kinematics(this._model, this._data); }
    resetData() { mj.mj_resetData(this._model, this._data); }
    resetDataKeyframe(key) { mj.mj_resetDataKeyframe(this._model, this._data, key); }

    applyForce(fx, fy, fz, tx, ty, tz, px, py, pz, bodyId) {
      mj.mj_applyFT(this._model, this._data, [fx, fy, fz], [tx, ty, tz], [px, py, pz],
                    bodyId, this._data.qfrc_applied);
    }

    free() {
      // embind handles are freed explicitly; delete() is the ClassHandle method.
      try { this._data?.delete?.(); } catch { /* already gone */ }
      try { this._model?.delete?.(); } catch { /* already gone */ }
    }
  }

  // Forward every MjData array by name, so a field rs-demo reads today and one
  // it reads tomorrow both work without editing this file.
  for (const name of dataAccessors) {
    if (name in Simulation.prototype) continue;
    Object.defineProperty(Simulation.prototype, name, {
      get() { return this._data[name]; },
      set(v) { this._data[name] = v; },
      configurable: true,
    });
  }
  return Simulation;
}

/**
 * Drop-in for the vendored `load_mujoco(hooks)`.
 *
 * @param {{print?: Function, printErr?: Function}} [hooks] Emscripten output
 *   hooks — `mujocoLog.js` passes these to recover the XML compiler's diagnostic.
 */
export default async function load_mujoco(hooks = {}) {
  const mj = await factory(hooks);

  // A throwaway model is the only way to enumerate MjData's accessors, and it
  // has to happen once before any Simulation is constructed.
  mj.FS.mkdir('/__probe');
  mj.FS.writeFile('/__probe/m.xml',
    '<mujoco><worldbody><body name="b"><joint name="j" type="slide" axis="0 0 1"/>' +
    '<geom type="box" size=".1 .1 .1"/></body></worldbody>' +
    '<actuator><motor joint="j"/></actuator></mujoco>');
  const probeModel = mj.MjModel.from_xml_path('/__probe/m.xml');
  const probeData = new mj.MjData(probeModel);
  const dataAccessors = accessorNames(probeData);
  try { probeData.delete?.(); probeModel.delete?.(); } catch { /* fine */ }

  mj.Model = {
    load_from_xml: (path) => decorateModel(mj.MjModel.from_xml_path(path)),
    load_from_xml_string: (xml) => decorateModel(mj.MjModel.from_xml_string(xml)),
  };
  mj.State = function State(model) { return new mj.MjData(model); };
  mj.Simulation = makeSimulationClass(mj, dataAccessors);

  return mj;
}
