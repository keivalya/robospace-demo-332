// examples/utils/fetchRetry.js
//
// Download helpers for the robot packs, which are 16-73 MB spread over up to ~97
// files fetched from jsDelivr and raw.githubusercontent.
//
// Before this, nothing in that path had a timeout or a retry: fetchBytes tried the CDN
// once and the raw host once, and a connection that STALLS rather than errors -- the
// common failure on hotel or mobile networks, where the socket opens and then nothing
// arrives -- left the await pending forever. The user saw the last progress line and a
// status that still read "Simulation Ready", with no way to tell a slow download from a
// dead one and no Stop button for it.
//
// The timeout is on STALLING, not on total duration, and that distinction is the whole
// design. Menagerie's largest single file is a 21 MB mesh; a fixed per-request deadline
// generous enough for that on a slow link would be far too long to catch a hang, and
// one short enough to catch a hang would break the legitimate download. So the clock
// measures time since the last byte arrived and is reset by progress. It is the same
// reasoning as the bridge's idle APPLY_SCENE timeout.
//
// Pure except for fetch itself, with every dependency injectable, so Node can test the
// stall and retry behaviour without a network.

/** No data for this long and the attempt is considered dead. */
export const DEFAULT_STALL_MS = 20000;

/** Extra passes over the URL list after the first. */
export const DEFAULT_RETRIES = 2;

/**
 * HTTP statuses worth trying again. Everything else 4xx is a definitive answer --
 * retrying a 404 just multiplies the wait before the user is told the truth.
 */
function retryableStatus(status) {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryableStatus(status);
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One download attempt, aborted if no bytes arrive for `stallMs`.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytesOnce(fetchImpl, url, options = {}) {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const AbortCtor = options.AbortCtor ?? globalThis.AbortController;
  const controller = AbortCtor ? new AbortCtor() : null;

  let timer = null;
  let stalled = false;
  const arm = () => {
    if (!controller) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      try { controller.abort(); } catch (_) { /* already settled */ }
    }, stallMs);
  };

  arm();
  try {
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!res || !res.ok) throw new HttpError(res ? res.status : 0, url);

    // Stream when we can, so each chunk resets the stall clock. A test stub or any
    // response without a readable body falls back to arrayBuffer(), still covered by
    // the timer armed above -- it just cannot distinguish slow from stalled.
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) return new Uint8Array(await res.arrayBuffer());

    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      if (value && value.length) {
        chunks.push(value);
        total += value.length;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  } catch (err) {
    if (stalled) {
      const e = new Error(`no data for ${stallMs} ms from ${url}`);
      e.name = 'StallError';
      e.retryable = true;
      throw e;
    }
    // A network-level failure (DNS, refused, dropped) is worth another go.
    if (err && err.retryable === undefined) err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try each URL in turn, then repeat the whole list `retries` more times with backoff.
 *
 * The list is the fallback chain (CDN first, then the raw host); the repeats are for
 * transient failures. A definitive answer -- a 404, say -- stops that URL being retried
 * but still lets the next URL in the chain be tried, because "missing on the CDN,
 * present upstream" is a real and expected case here.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytesWithRetry(fetchImpl, urls, options = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (!list.length) throw new Error('fetchBytesWithRetry: no URLs given');

  const retries = options.retries ?? DEFAULT_RETRIES;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const backoffMs = options.backoffMs ?? ((attempt) => 400 * Math.pow(2, attempt));
  const onAttemptFailed = options.onAttemptFailed;
  const AbortCtor = options.AbortCtor;

  let lastError = null;
  const permanentlyFailed = new Set();

  for (let attempt = 0; attempt <= retries; attempt++) {
    let triedSomething = false;
    for (const url of list) {
      if (permanentlyFailed.has(url)) continue;
      triedSomething = true;
      try {
        return await fetchBytesOnce(fetchImpl, url, { stallMs, AbortCtor });
      } catch (err) {
        lastError = err;
        if (err && err.retryable === false) permanentlyFailed.add(url);
        if (onAttemptFailed) onAttemptFailed({ url, attempt, error: err });
      }
    }
    // Every URL has answered definitively; more passes cannot change that.
    if (!triedSomething) break;
    if (attempt < retries) await sleep(backoffMs(attempt));
  }

  const detail = lastError ? lastError.message : 'unknown error';
  const err = new Error(detail);
  err.name = 'DownloadFailedError';
  err.cause = lastError;
  throw err;
}
