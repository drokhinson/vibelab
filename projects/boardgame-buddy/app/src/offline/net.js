// @ts-check
// net.js — connectivity state. The single answer to "are we offline?".
//
// Native port of web/domain/net.js. Offline mode exists because board games
// get played in basements, cabins and pub back rooms: the host still needs to
// run Gather → Play → Settle and record the result, and the play uploads on
// the next online session (see playOutbox.js).
//
// Entirely automatic — there is no "play offline" switch. The signal that
// actually catches a dead venue is consecutive request failures, because a
// connection that resolves and then times out looks online to every OS-level
// flag. Two in a row, not one: a single request can fail for reasons that have
// nothing to do with the link (a cold dyno, one dropped packet), and flipping
// the whole app to offline on that would be worse than the problem.
//
// A completed response outranks the strikes — see isOffline(). Without that,
// nothing could ever clear the flag, since the probe meant to correct it would
// be judged by the very state it is trying to correct.
//
// Deliberately NOT wired to anything that tears down user state. Going offline
// must never sign the user out, abandon a lobby, or re-mint a session code —
// it only gates NEW behaviour. usePlaySession's lobby-blip handling already
// follows this rule and is intentionally left alone.

// No imports on purpose. api/client.js reports into this module, so importing
// the client back would close a cycle; the probe and the reconnect handler are
// injected by AppContext instead, which is where both halves are already known.

const FAILURE_THRESHOLD = 2;

let _failures = 0;
// 'ok' once a request has demonstrably completed, 'fail' after a network
// error, null when we have no evidence either way.
let _lastOutcome = null;
let _probing = null;
// Last value published to subscribers, so we only notify on real edges.
let _published = null;
const _listeners = new Set();
// Both set by AppContext. See the no-imports note above.
let _onReconnect = null;
let _probeFn = null;

/** @returns {boolean} */
export function isOffline() {
  // A completed HTTP response is direct proof of reachability, so it beats the
  // learned strikes.
  if (_lastOutcome === 'ok') return false;
  return _failures >= FAILURE_THRESHOLD;
}

/** True while a user-triggered connectivity check is in flight. */
export function isProbing() {
  return !!_probing;
}

/** Subscribe to offline-state edges. Returns unsubscribe. */
export function subscribeNet(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Register the offline→online handler (AppContext wires the outbox flush). */
export function onReconnect(fn) {
  _onReconnect = fn;
}

/** Register the reachability check probe() runs (AppContext wires GET /health). */
export function setProbe(fn) {
  _probeFn = fn;
}

/** A request failed at the network layer (not an HTTP error). */
export function noteFailure() {
  _failures++;
  _lastOutcome = 'fail';
  _publish();
}

/** A request completed — the link demonstrably works. */
export function noteSuccess() {
  if (_failures === 0 && _lastOutcome === 'ok') return;
  _failures = 0;
  _lastOutcome = 'ok';
  _publish();
}

/**
 * Clear the learned strikes without claiming reachability. Called when the app
 * returns to the foreground: whatever we learned before the phone went in a
 * pocket is stale, and the next real request re-decides.
 */
export function resetEvidence() {
  _failures = 0;
  _lastOutcome = null;
  _publish();
}

/**
 * Actively test the connection. Backs the offline banner's "Try again".
 *
 * Everything else here is passive — it learns from requests the app was making
 * anyway. This is the one path that asks on purpose, for when the user can see
 * they have signal and the app hasn't noticed (walked out of the dead zone,
 * joined the wifi, turned off airplane mode).
 *
 * Runs the injected probe (GET /health) so the client's own bookkeeping does
 * the work: a response calls noteSuccess, a network error calls noteFailure.
 * Any status counts as reachable — a 500 still proves we got there.
 *
 * @returns {Promise<boolean>} true when the connection came back
 */
export function probe() {
  if (_probing) return _probing;
  if (!_probeFn) return Promise.resolve(!isOffline());
  _probing = (async () => {
    try {
      await _probeFn();
    } catch {
      // Swallowed: the client already recorded the outcome, and the caller
      // reads the answer from the return value rather than a rejection.
    }
    return !isOffline();
  })().finally(() => {
    _probing = null;
  });
  return _probing;
}

// Edge-triggered: computing isOffline() once here keeps every subscriber from
// re-deriving the same inputs.
function _publish() {
  const next = isOffline();
  if (next === _published) return;
  const wasOffline = _published === true;
  _published = next;
  for (const fn of _listeners) {
    try {
      fn(next);
    } catch {}
  }
  // The single place connectivity is regained, whatever caused it — a probe or
  // an ordinary background request clearing the strikes. Push whatever the
  // host recorded while disconnected.
  if (wasOffline && !next && _onReconnect) _onReconnect();
}
