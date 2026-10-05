// Browser storage can throw both on access (blocked third-party storage) and
// on writes (quota). Editing and running code must still work in either case.
export function createEditorStorage(getStorage, onUnavailable = () => {}) {
    const memory = new Map();
    let warned = false;
    function unavailable() {
        if (!warned) {
            warned = true;
            onUnavailable();
        }
    }
    return {
        getItem(key) {
            if (memory.has(key)) return memory.get(key);
            try { return getStorage().getItem(key); }
            catch { unavailable(); return null; }
        },
        setItem(key, value) {
            memory.set(key, String(value));
            try { getStorage().setItem(key, String(value)); }
            catch { unavailable(); }
        },
    };
}
