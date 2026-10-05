// test/fetch-retry.test.mjs
//
// Pack downloads are 16-73 MB over up to ~97 files and had neither a timeout nor a
// retry: one attempt per URL, and a socket that opened and then delivered nothing left
// the await pending forever, taking the whole robot load with it.
//
// The timeout is on STALLING, not total duration -- menagerie's largest single file is
// a 21 MB mesh, so any fixed deadline generous enough for that on a slow link is far
// too long to catch a hang. These assertions pin that distinction: a slow-but-moving
// download must SURVIVE, which is the half that a naive timeout gets wrong.

import { fetchBytesOnce, fetchBytesWithRetry } from '../examples/utils/fetchRetry.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);

/** A response whose body yields `chunks`, pausing `gapMs` before each. */
function streamingResponse(chunks, gapMs, signal) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let i = 0;
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, gapMs);
              if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
            });
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  };
}

console.log('a stalled download is abandoned, not awaited forever');
{
  // Never resolves and never errors: the exact failure this exists to catch.
  const hang = (url, init) => new Promise((_resolve, reject) => {
    if (init?.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const started = Date.now();
  let threw = null;
  try {
    await fetchBytesOnce(hang, 'https://example/x', { stallMs: 60 });
  } catch (e) { threw = e; }
  const elapsed = Date.now() - started;
  check(threw !== null, 'it rejects instead of hanging');
  check(threw?.name === 'StallError', `the error names the cause (got ${threw?.name})`);
  check(elapsed < 2000, `it gives up promptly (${elapsed} ms)`);
  check(threw?.retryable === true, 'a stall is treated as retryable');
}

console.log('\na slow but PROGRESSING download survives');
{
  // Positive control for the assertion above: without this, a timeout that simply
  // fired on total duration would pass every stall test and still break real users
  // on a 21 MB mesh over a slow link.
  const chunks = [bytes(10), bytes(10), bytes(10), bytes(10), bytes(10)];
  let signal = null;
  const slow = (url, init) => { signal = init?.signal ?? null; return Promise.resolve(streamingResponse(chunks, 25, signal)); };
  const out = await fetchBytesOnce(slow, 'https://example/big', { stallMs: 80 });
  check(out.length === 50, `all ${out.length} bytes arrive despite taking longer than the stall window`);
  check(out.every((b) => b === 7), 'and the bytes are intact');
}

console.log('\nretries and the URL fallback chain');
{
  let calls = [];
  const flaky = (url) => {
    calls.push(url);
    if (calls.length < 3) return Promise.resolve({ ok: false, status: 503 });
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => bytes(4).buffer });
  };
  const out = await fetchBytesWithRetry(flaky, ['https://cdn/a', 'https://raw/a'], { retries: 2, sleep: async () => {} });
  check(out.length === 4, 'a transient 503 is retried and eventually succeeds');
  check(calls.length === 3, `it stopped as soon as it worked (${calls.length} attempts)`);
}
{
  let calls = 0;
  const gone = () => { calls++; return Promise.resolve({ ok: false, status: 404 }); };
  let threw = null;
  try {
    await fetchBytesWithRetry(gone, ['https://cdn/a', 'https://raw/a'], { retries: 5, sleep: async () => {} });
  } catch (e) { threw = e; }
  check(threw !== null, 'a 404 everywhere still fails');
  // Each URL is tried once; a definitive answer is not retried five more times.
  check(calls === 2, `a 404 is not retried (${calls} calls for 2 URLs, not 12)`);
}
{
  // The real fallback shape: missing on the CDN, present on the raw host.
  const chain = (url) => url.includes('cdn')
    ? Promise.resolve({ ok: false, status: 404 })
    : Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => bytes(9).buffer });
  const out = await fetchBytesWithRetry(chain, ['https://cdn/a', 'https://raw/a'], { sleep: async () => {} });
  check(out.length === 9, 'a 404 on the CDN still falls through to the raw host');
}
{
  let threw = null;
  try { await fetchBytesWithRetry(() => Promise.resolve({ ok: true }), [], { sleep: async () => {} }); }
  catch (e) { threw = e; }
  check(threw !== null, 'an empty URL list is rejected rather than returning undefined');
}
{
  const seen = [];
  const dead = () => Promise.reject(new Error('ECONNREFUSED'));
  try {
    await fetchBytesWithRetry(dead, ['https://cdn/a'], {
      retries: 1, sleep: async () => {}, onAttemptFailed: (i) => seen.push(i.attempt),
    });
  } catch (_) { /* expected */ }
  check(seen.length === 2, `every failed attempt is reported (${seen.length})`);
  check(seen[0] === 0 && seen[1] === 1, 'with the attempt number, so callers can report progress');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
