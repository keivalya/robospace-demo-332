// URDFConverter.js — Browser-based ROS URDF to MuJoCo MJCF XML Converter & Pre-flight Validator

export class URDFConverter {
    /**
     * Converts a URDF XML string to a MuJoCo MJCF XML string.
     * @param {string} urdfString - Raw URDF XML content
     * @param {string} fallbackName - Default name if <robot name="..."> is missing
     * @returns {{ xml: string, robotName: string, meshes: string[], errors: string[] }}
     */
    static convert(urdfString, fallbackName = 'custom_robot') {
        const errors = [];
        const meshes = [];
        const parser = new DOMParser();
        const doc = parser.parseFromString(urdfString, 'text/xml');

        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            return { xml: '', robotName: fallbackName, meshes: [], errors: [`XML Parse Error: ${parseError.textContent}`] };
        }

        const robotEl = doc.querySelector('robot');
        if (!robotEl) {
            return { xml: '', robotName: fallbackName, meshes: [], errors: ['No <robot> root tag found in URDF file.'] };
        }

        const name = robotEl.getAttribute('name') || fallbackName;

        // Collect links and joints
        const linksMap = new Map();
        const jointsList = [];
        const parentMap = new Map(); // child_link -> { parent_link, joint }

        robotEl.querySelectorAll('link').forEach(link => {
            const linkName = link.getAttribute('name');
            if (linkName) linksMap.set(linkName, link);
        });

        robotEl.querySelectorAll('joint').forEach(joint => {
            const jName = joint.getAttribute('name');
            const parent = joint.querySelector('parent')?.getAttribute('link');
            const child = joint.querySelector('child')?.getAttribute('link');
            const type = joint.getAttribute('type') || 'revolute';

            if (jName && parent && child) {
                jointsList.push({ el: joint, name: jName, parent, child, type });
                parentMap.set(child, { parent, joint });
            }
        });

        // Find root link (link that is not a child of any joint)
        let rootLinkName = null;
        for (const [lName] of linksMap) {
            if (!parentMap.has(lName)) {
                rootLinkName = lName;
                break;
            }
        }
        if (!rootLinkName && linksMap.size > 0) {
            rootLinkName = linksMap.keys().next().value;
        }

        // Build joint tree children map
        const childrenMap = new Map(); // parent_link -> list of joints where parent is this link
        jointsList.forEach(j => {
            if (!childrenMap.has(j.parent)) childrenMap.set(j.parent, []);
            childrenMap.get(j.parent).push(j);
        });

        // Helper: Convert RPY string "r p y" in radians to MJCF euler "r p y" in degrees
        const parseOrigin = (el) => {
            const origin = el?.querySelector('origin');
            const posStr = origin?.getAttribute('xyz') || '0 0 0';
            const rpyStr = origin?.getAttribute('rpy') || '0 0 0';
            const rpy = rpyStr.trim().split(/\s+/).map(Number);
            const euler = rpy.map(v => (v * 180 / Math.PI).toFixed(4)).join(' ');
            return { pos: posStr, euler };
        };

        // Extract geometry from link
        const extractGeom = (linkEl) => {
            const geoms = [];
            const visuals = linkEl.querySelectorAll('visual');
            visuals.forEach((v) => {
                const geomOrigin = parseOrigin(v);
                const meshEl = v.querySelector('geometry > mesh');
                const boxEl = v.querySelector('geometry > box');
                const sphereEl = v.querySelector('geometry > sphere');
                const cylEl = v.querySelector('geometry > cylinder');

                if (meshEl) {
                    let meshFile = meshEl.getAttribute('filename') || '';
                    meshFile = meshFile.replace(/^package:\/\/[^\/]+\//, '').replace(/^file:\/\//, '');
                    const meshName = meshFile.split('/').pop().replace(/\.(stl|obj|dae)$/i, '');
                    if (meshFile) meshes.push(meshFile);
                    geoms.push(`<geom type="mesh" mesh="${meshName}" pos="${geomOrigin.pos}" euler="${geomOrigin.euler}"/>`);
                } else if (boxEl) {
                    const size = boxEl.getAttribute('size') || '0.1 0.1 0.1';
                    const half = size.trim().split(/\s+/).map(v => (parseFloat(v) / 2).toFixed(4)).join(' ');
                    geoms.push(`<geom type="box" size="${half}" pos="${geomOrigin.pos}" euler="${geomOrigin.euler}"/>`);
                } else if (sphereEl) {
                    const radius = sphereEl.getAttribute('radius') || '0.05';
                    geoms.push(`<geom type="sphere" size="${radius}" pos="${geomOrigin.pos}"/>`);
                } else if (cylEl) {
                    const r = cylEl.getAttribute('radius') || '0.05';
                    const l = (parseFloat(cylEl.getAttribute('length') || '0.1') / 2).toFixed(4);
                    geoms.push(`<geom type="cylinder" size="${r} ${l}" pos="${geomOrigin.pos}" euler="${geomOrigin.euler}"/>`);
                }
            });
            return geoms;
        };

        // Recursively build MJCF body tree
        const buildBodyXml = (linkName, isRoot = false) => {
            const linkEl = linksMap.get(linkName);
            const geoms = linkEl ? extractGeom(linkEl) : [];
            const childJoints = childrenMap.get(linkName) || [];

            let xml = `<body name="${linkName}">\n`;
            geoms.forEach(g => { xml += `  ${g}\n`; });

            // Attach site on tip link if it's a leaf node without children
            if (childJoints.length === 0 && !isRoot) {
                xml += `  <site name="attachment_site" pos="0 0 0"/>\n`;
            }

            childJoints.forEach(j => {
                const jOrigin = parseOrigin(j.el);
                const axisStr = j.el.querySelector('axis')?.getAttribute('xyz') || '0 0 1';
                const limitEl = j.el.querySelector('limit');
                let rangeStr = '';
                if (limitEl) {
                    const lowerRad = parseFloat(limitEl.getAttribute('lower') || '-3.14');
                    const upperRad = parseFloat(limitEl.getAttribute('upper') || '3.14');
                    const lowerDeg = (lowerRad * 180 / Math.PI).toFixed(1);
                    const upperDeg = (upperRad * 180 / Math.PI).toFixed(1);
                    rangeStr = `range="${lowerDeg} ${upperDeg}"`;
                }

                xml += `<body name="${j.child}" pos="${jOrigin.pos}" euler="${jOrigin.euler}">\n`;
                if (j.type !== 'fixed') {
                    const jType = j.type === 'prismatic' ? 'slide' : 'hinge';
                    xml += `  <joint name="${j.name}" type="${jType}" axis="${axisStr}" ${rangeStr}/>\n`;
                }
                xml += buildBodyXml(j.child, false);
                xml += `</body>\n`;
            });

            xml += `</body>\n`;
            return xml;
        };

        // Collect all non-fixed joint names for position actuators
        const actuatorJoints = jointsList.filter(j => j.type !== 'fixed').map(j => j.name);

        let mjcfXml = `<mujoco model="${name}">\n`;
        mjcfXml += `  <compiler angle="degree" coordinate="local"/>\n`;
        mjcfXml += `  <option timestep="0.002"/>\n`;

        if (meshes.length > 0) {
            mjcfXml += `  <asset>\n`;
            const uniqueMeshes = new Set(meshes);
            uniqueMeshes.forEach(mFile => {
                const mName = mFile.split('/').pop().replace(/\.(stl|obj|dae)$/i, '');
                const mPath = mFile.startsWith('assets/') ? mFile : `assets/${mFile.split('/').pop()}`;
                mjcfXml += `    <mesh name="${mName}" file="${mPath}"/>\n`;
            });
            mjcfXml += `  </asset>\n`;
        }

        mjcfXml += `  <worldbody>\n`;
        mjcfXml += `    <light pos="0 0 3" dir="0 0 -1" directional="true"/>\n`;
        mjcfXml += `    <geom type="plane" size="5 5 0.1" rgba="0.15 0.15 0.18 1"/>\n`;
        if (rootLinkName) {
            mjcfXml += buildBodyXml(rootLinkName, true);
        }
        mjcfXml += `  </worldbody>\n`;

        if (actuatorJoints.length > 0) {
            mjcfXml += `  <actuator>\n`;
            actuatorJoints.forEach(jName => {
                mjcfXml += `    <position name="${jName}_pos" joint="${jName}" kp="100"/>\n`;
            });
            mjcfXml += `  </actuator>\n`;
        }

        mjcfXml += `</mujoco>\n`;

        return { xml: mjcfXml, robotName: name, meshes, errors };
    }
}
