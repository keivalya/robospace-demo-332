// The simulator's analytics relay: queue ordering, drain, drop, and the WASM
// failure classifier.
//
//   npm run test:analytics
//
// The queue is the part worth testing. The simulator emits its boot events at
// module top level, before ParentBridge exists and long before the HELLO
// handshake lands, and ParentBridge._send() silently returns when there is no
// parent origin. Get the ordering wrong and every event is dropped with no
// error anywhere — which is the exact failure mode this whole project exists to
// eliminate. Every "must not send" assertion below has a "must send" control
// next to it, because an emitter that never emits would otherwise pass.

import assert from 'node:assert/strict';

let failures = 0;
let passes = 0;
function test(name, fn) {
  try { fn(); passes++; console.log(`  ok    ${name}`); }
  catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
  configurable: true, writable: true,
});
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => 100, getEntriesByName: () => [], getEntriesByType: () => [] },
  configurable: true, writable: true,
});

const mod = await import('../examples/utils/analytics.js');

// Fresh module state per case, since the queue is module-scoped.
async function fresh() {
  return import(`../examples/utils/analytics.js?t=${Math.random()}`);
}

console.log('\nqueue ordering (the failure mode that loses everything)');

await (async () => {
  const a = await fresh();
  a.emitAnalytics('wasm_load_completed', { load_ms: 10 });
  a.emitAnalytics('wasm_load_failed', { reason: 'oom' });
  test('events emitted before any sink exists are retained, not dropped', () => {
    assert.equal(a._queueLength(), 2);
  });

  const sent = [];
  a.attachAnalyticsSink((n, p) => { sent.push([n, p]); return true; });
  test('attaching a connected sink drains the whole queue in order', () => {
    assert.equal(sent.length, 2, 'positive control: the sink really is reached');
    assert.equal(sent[0][0], 'wasm_load_completed');
    assert.equal(sent[1][0], 'wasm_load_failed');
    assert.equal(a._queueLength(), 0);
  });
})();

await (async () => {
  const a = await fresh();
  const sent = [];
  // A bridge that exists but has not completed the handshake: sendAnalytics
  // returns false, exactly as ParentBridge does before parentOrigin is set.
  let connected = false;
  a.attachAnalyticsSink((n, p) => { if (!connected) return false; sent.push([n, p]); return true; });

  a.emitAnalytics('wasm_load_completed', { load_ms: 10 });
  test('an unconnected sink leaves the event queued rather than losing it', () => {
    assert.equal(sent.length, 0);
    assert.equal(a._queueLength(), 1);
  });

  connected = true;
  a.flushAnalytics();
  test('flush after connect delivers it (positive control)', () => {
    assert.equal(sent.length, 1);
    assert.equal(a._queueLength(), 0);
  });
})();

await (async () => {
  const a = await fresh();
  const sent = [];
  a.attachAnalyticsSink((n) => { sent.push(n); return true; });
  a.emitAnalytics('after_connect', {});
  test('events emitted after connect go straight out', () => {
    assert.deepEqual(sent, ['after_connect']);
  });
})();

await (async () => {
  const a = await fresh();
  a.emitAnalytics('x', {});
  a.dropAnalyticsQueue();
  const sent = [];
  a.attachAnalyticsSink((n) => { sent.push(n); return true; });
  test('standalone drop discards the queue', () => {
    assert.equal(a._queueLength(), 0);
    assert.equal(sent.length, 0, 'nothing should arrive after a drop');
  });
})();

await (async () => {
  const a = await fresh();
  for (let i = 0; i < 80; i++) a.emitAnalytics('e' + i, {});
  const sent = [];
  a.attachAnalyticsSink((n) => { sent.push(n); return true; });
  test('queue is bounded at 50, evicting oldest first', () => {
    assert.equal(sent.length, 50);
    assert.equal(sent[0], 'e30', 'oldest evicted, newest kept');
    assert.equal(sent[49], 'e79');
  });
})();

await (async () => {
  const a = await fresh();
  a.emitAnalytics('a', {});
  a.emitAnalytics('b', {});
  let calls = 0;
  a.attachAnalyticsSink(() => { calls++; if (calls === 1) throw new Error('boom'); return true; });
  test('a throwing sink drops that event and keeps going', () => {
    assert.equal(calls, 2, 'must not wedge the queue on one bad event');
    assert.equal(a._queueLength(), 0);
  });
})();

console.log('\nWASM failure classification');

const cases = [
  [{ name: 'CompileError', message: 'bad magic' }, 'compile', 'compile_error', 'compile'],
  [{ name: 'LinkError', message: 'import not found' }, 'compile', 'compile_error', 'instantiate'],
  [{ name: 'TypeError', message: 'Failed to fetch' }, 'compile', 'fetch_error', 'fetch'],
  [{ name: 'Error', message: 'net::ERR_CONNECTION_RESET' }, 'compile', 'fetch_error', 'fetch'],
  [{ name: 'RuntimeError', message: 'Aborted(OOM)' }, 'compile', 'oom', 'instantiate'],
  [{ name: 'RangeError', message: 'WebAssembly.Memory buffer allocation failed' }, 'compile', 'oom', 'compile'],
  [{ name: 'Error', message: 'operation timed out' }, 'compile', 'timeout', 'compile'],
  [{ name: 'ReferenceError', message: 'WebAssembly is not defined' }, 'compile', 'unsupported', 'compile'],
  [{ name: 'Error', message: 'something nobody predicted' }, 'compile', 'unknown', 'compile'],
];

for (const [err, hint, reason, stage] of cases) {
  test(`${err.name}: "${err.message}" -> ${reason} / ${stage}`, () => {
    const r = mod.classifyWasmError(err, hint);
    assert.equal(r.reason, reason);
    assert.equal(r.stage, stage);
    assert.equal(r.error_name, err.name);
  });
}

test('OOM is matched before compile_error, so an OOM is not misfiled', () => {
  // Ordering matters: an out-of-memory abort often mentions compilation, and
  // filing it as a compile error would point at the wrong fix entirely.
  const r = mod.classifyWasmError(
    { name: 'CompileError', message: 'out of memory during compile' }, 'compile');
  assert.equal(r.reason, 'oom');
});

test('first_step hint is never overridden by error-shape inference', () => {
  const r = mod.classifyWasmError({ name: 'CompileError', message: 'x' }, 'first_step');
  assert.equal(r.stage, 'first_step');
});

test('every reason and stage is inside the documented enum', () => {
  const REASONS = ['fetch_error', 'compile_error', 'oom', 'timeout', 'unsupported', 'unknown'];
  const STAGES = ['fetch', 'compile', 'instantiate', 'first_step'];
  for (const [err, hint] of cases) {
    const r = mod.classifyWasmError(err, hint);
    assert.ok(REASONS.includes(r.reason), `${r.reason} not in enum`);
    assert.ok(STAGES.includes(r.stage), `${r.stage} not in enum`);
  }
});

console.log('\nresource timing and browser label');

test('missing Resource Timing yields -1 sentinels, never null', () => {
  const r = mod.wasmResourceTiming('https://example/x.wasm');
  assert.equal(r.wasm_bytes, -1);
  assert.equal(r.ttfb_ms, -1);
  assert.equal(r.cache_state, 'cold');
});

test('a real entry is read, and a cached one reports warm', () => {
  Object.defineProperty(globalThis, 'performance', {
    value: {
      now: () => 100,
      getEntriesByName: () => [{ transferSize: 0, decodedBodySize: 2380000, responseStart: 120, startTime: 100 }],
      getEntriesByType: () => [{ transferSize: 0 }, { transferSize: 4096 }],
    },
    configurable: true, writable: true,
  });
  const r = mod.wasmResourceTiming('https://example/x.wasm');
  assert.equal(r.wasm_bytes, 0, 'cached transferSize is 0');
  assert.equal(r.cache_state, 'warm');
  assert.equal(r.ttfb_ms, 20);
  assert.equal(r.total_bytes, 4096);
});

test('browserLabel is short, non-empty and not a raw UA string', () => {
  const b = mod.browserLabel();
  assert.ok(b.length <= 100);
  assert.ok(!b.includes('Mozilla'), 'must not be the raw UA');
  assert.equal(b, 'Chrome/120');
});

console.log(`\n${passes} passed, ${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
