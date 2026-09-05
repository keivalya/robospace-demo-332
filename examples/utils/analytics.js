// examples/utils/analytics.js
//
// Analytics emitter for the simulator.
//
// WHY THIS BUFFERS
//
// The simulator has no analytics of its own and cannot get any: it is served
// from GitHub Pages inside a cross-origin iframe, so the parent's GA4 tag
// cannot see it and it has no bundler to add one. Events are therefore relayed
// to the parent over the existing postMessage bridge, and the parent emits them.
//
// But the ordering does not cooperate. The WASM module is loaded at main.js's
// top level, and ParentBridge is not constructed until RoboSpaceDemo's
// constructor runs — hundreds of lines later. The HELLO handshake lands later
// still. `ParentBridge._send()` silently returns when `parentOrigin` is null, so
// without a queue every boot-time event would be dropped and Phase 3 would emit
// nothing at all, with no error to notice.
//
// So events accumulate here from first import and drain once the bridge is both
// constructed and connected.
//
// STANDALONE MODE: a direct visitor to demo.robospace.app has no parent. The
// queue is dropped when the handshake times out — standalone traffic is
// deliberately unmeasured in v1.

const MAX_QUEUED = 50;

const queue = [];
let sink = null;

/**
 * @param {string} name   GA4 event name
 * @param {object} params
 */
export function emitAnalytics(name, params = {}) {
  queue.push({ name, params });
  // Bounded: if the handshake never completes we must not grow without limit.
  // Oldest-first eviction keeps the boot events, which are the interesting ones.
  if (queue.length > MAX_QUEUED) queue.shift();
  flushAnalytics();
}

/**
 * @param {(name: string, params: object) => boolean} fn
 *   Returns true when the event was actually sent. Returning false leaves it
 *   queued, which is what happens between bridge construction and handshake.
 */
export function attachAnalyticsSink(fn) {
  sink = fn;
  flushAnalytics();
}

export function flushAnalytics() {
  if (!sink) return;
  while (queue.length) {
    const item = queue[0];
    let sent = false;
    try {
      sent = sink(item.name, item.params) === true;
    } catch (e) {
      console.warn('[analytics] sink threw:', e);
      queue.shift();
      continue;
    }
    if (!sent) return; // not connected yet — try again on the next flush
    queue.shift();
  }
}

/** Standalone mode: no parent to relay through, so discard. */
export function dropAnalyticsQueue() {
  queue.length = 0;
}

/** Test seam. */
export function _queueLength() {
  return queue.length;
}

// ─── helpers used by the WASM instrumentation ────────────────────────────────

/**
 * Compact browser label, e.g. "Chrome/120". Deliberately not the full UA
 * string: GA4 caps parameter values at 100 characters and a raw UA is both
 * longer and higher-cardinality than anything we would group by.
 */
export function browserLabel() {
  try {
    const ua = navigator.userAgent || '';
    const m =
      /(Firefox)\/(\d+)/.exec(ua) ||
      /(Edg)\/(\d+)/.exec(ua) ||
      /(OPR)\/(\d+)/.exec(ua) ||
      /(Chrome)\/(\d+)/.exec(ua) ||
      /Version\/(\d+).*(Safari)/.exec(ua);
    if (!m) return 'unknown';
    // The Safari branch captures version first, name second.
    return m[2] && /^\d+$/.test(m[2]) ? `${m[1]}/${m[2]}` : `${m[2]}/${m[1]}`;
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Classify a WASM failure into the reporting enums.
 *
 * `reason` and `stage` are what GA4 gets — low cardinality, groupable. The raw
 * error and stack go to the parent separately for Sentry: GA4 tells us how many
 * failed, only a stack tells us why.
 *
 * Order matters. An out-of-memory abort often mentions compilation, so it is
 * tested first; matching on "compile" earlier would misfile every OOM as a
 * compile error and point at the wrong fix.
 */
export function classifyWasmError(err, stageHint) {
  const name = (err && err.name) || 'Error';
  const msg = String((err && err.message) || err || '');

  let reason = 'unknown';
  if (/out of memory|oom|cannot enlarge memory|allocation failed|memory access out of bounds/i.test(msg)) {
    reason = 'oom';
  } else if (name === 'RangeError' && /memory|buffer/i.test(msg)) {
    reason = 'oom';
  } else if (name === 'CompileError' || /compileerror|magic|invalid wasm|bad magic/i.test(msg)) {
    reason = 'compile_error';
  } else if (name === 'LinkError') {
    reason = 'compile_error';
  } else if (/timeout|timed out/i.test(msg)) {
    reason = 'timeout';
  } else if (/failed to fetch|networkerror|load failed|net::|err_|404|403|abort/i.test(msg)) {
    reason = 'fetch_error';
  } else if (/not supported|unsupported|webassembly is not defined|is not a function/i.test(msg)) {
    reason = 'unsupported';
  }

  let stage = stageHint;
  if (stageHint !== 'first_step') {
    if (name === 'CompileError') stage = 'compile';
    else if (name === 'LinkError' || name === 'RuntimeError') stage = 'instantiate';
    else if (reason === 'fetch_error') stage = 'fetch';
  }

  return { reason, stage, error_name: String(name).slice(0, 100) };
}

/**
 * Byte and timing facts from the Resource Timing entry for the .wasm.
 *
 * `load_ms` alone cannot separate a slow network from a slow CPU, and those
 * have opposite fixes — CDN and compression versus shrinking the payload. With
 * a large share of users in India this is the split that confirms or kills the
 * payload hypothesis, so the bytes are read rather than guessed.
 *
 * Same-origin resource, so transferSize and responseStart are populated. They
 * would be zeroed for a cross-origin fetch without Timing-Allow-Origin, which
 * is why -1 sentinels exist rather than nulls.
 */
export function wasmResourceTiming(wasmUrl) {
  const out = { wasm_bytes: -1, ttfb_ms: -1, total_bytes: -1, cache_state: 'cold' };
  try {
    const entry = performance.getEntriesByName(wasmUrl)[0];
    if (entry) {
      out.wasm_bytes = typeof entry.transferSize === 'number' ? entry.transferSize : -1;
      const ttfb = entry.responseStart - entry.startTime;
      out.ttfb_ms = Number.isFinite(ttfb) && ttfb > 0 ? Math.round(ttfb) : -1;
      // A cached response transfers no bytes but still decodes a body. This is
      // specifically "was the WASM cached", which is more useful here than the
      // document's own cache state.
      if (entry.transferSize === 0 && entry.decodedBodySize > 0) out.cache_state = 'warm';
    }
    out.total_bytes = performance
      .getEntriesByType('resource')
      .reduce((sum, r) => sum + (r.transferSize || 0), 0);
  } catch (_) {
    /* Resource Timing unavailable — keep the sentinels */
  }
  return out;
}
