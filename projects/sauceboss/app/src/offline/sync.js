// Offline saucebook sync orchestration.
//
// Owns the download/refresh lifecycle:
//   - enable():     flip settings, kick off a full sync, set pendingDownload on failure
//   - disable():    wipe cache + reset state
//   - syncAll():    fetch /sauces once, filter to saucebook ids (+ variant family), write
//   - syncAfterChange(): incremental update on add/remove
//   - attachAppStateListener(): retry pending downloads on app foreground
//
// Does not call AsyncStorage directly — delegates to cache.js. Does not own
// reducer state shape — pushes events via the provided dispatch with action
// types defined in AppContext.js.

import { AppState } from 'react-native';
import * as cache from './cache';

export function createOfflineSync({ api, dispatch, getState, actions: A }) {
  let inFlight = false;

  function userId() { return getState()?.currentUser?.user_id || null; }
  function enabled() { return !!getState()?.offline?.enabled; }

  // Fetch /sauces (full envelopes for the entire catalog), filter to the
  // user's saucebook ids + each one's variant family root, write them out.
  // The catalog fetch is wasteful for users with a small saucebook but it's
  // also the only endpoint that returns full step/ingredient data — same
  // call openSauceById uses today.
  async function syncAll(uid) {
    if (!uid) return { ok: false, error: 'no user' };
    if (inFlight) return { ok: false, error: 'busy' };
    inFlight = true;
    dispatch({ type: A.OFFLINE_SYNC_START });

    try {
      const slim = getState()?.saucebook?.items || [];
      // Persist the slim list immediately so the saucebook screen works
      // offline even if the full-recipe fetch fails mid-flight.
      await cache.writeList(uid, slim);

      if (!slim.length) {
        const meta = await cache.writeMeta(uid, {
          lastSyncedAt: new Date().toISOString(),
          pendingDownload: false,
        });
        dispatch({ type: A.OFFLINE_SYNC_DONE, meta });
        return { ok: true };
      }

      const all = await api.allSauces();

      // Bail if the toggle flipped off between the network call and the write.
      if (!enabled()) {
        dispatch({ type: A.OFFLINE_SYNC_DONE, meta: await cache.readMeta(uid) });
        return { ok: true };
      }

      const saucebookIds = new Set(slim.map((s) => s.id));
      const families = new Set(saucebookIds);
      // Include variant siblings + parents so opening a variant from the
      // saucebook doesn't miss its family for the variant picker.
      for (const s of all) {
        if (saucebookIds.has(s.id) && s.parentSauceId) families.add(s.parentSauceId);
      }
      for (const s of all) {
        if (families.has(s.id) || families.has(s.parentSauceId)) families.add(s.id);
      }

      const toWrite = all.filter((s) => families.has(s.id));
      // Drop any cached sauces that fell out of the saucebook (or family).
      const existingList = await cache.readList(uid);
      const previousIds = new Set((existingList || []).map((s) => s.id));
      const droppedIds = [];
      for (const id of previousIds) {
        if (!saucebookIds.has(id)) droppedIds.push(id);
      }
      for (const id of droppedIds) await cache.deleteSauce(uid, id);

      // Batch the writes so multiSet does the heavy lifting. 50 sauces per
      // batch keeps the single JSON.stringify call bounded.
      const BATCH = 50;
      let done = 0;
      for (let i = 0; i < toWrite.length; i += BATCH) {
        if (!enabled()) break; // user flipped the toggle off — bail clean.
        const batch = toWrite.slice(i, i + BATCH);
        await cache.writeSauces(uid, batch);
        done += batch.length;
        dispatch({ type: A.OFFLINE_SYNC_PROGRESS, done, total: toWrite.length });
      }

      const meta = await cache.writeMeta(uid, {
        lastSyncedAt: new Date().toISOString(),
        pendingDownload: false,
      });
      dispatch({ type: A.OFFLINE_SYNC_DONE, meta });
      return { ok: true };
    } catch (e) {
      // Most common failure: offline. Mark pendingDownload so the AppState
      // listener retries on next foreground.
      await cache.writeMeta(uid, { pendingDownload: true });
      dispatch({ type: A.OFFLINE_SYNC_ERROR, error: e.message || String(e) });
      return { ok: false, error: e.message || String(e) };
    } finally {
      inFlight = false;
    }
  }

  // Called by addToSaucebook / removeFromSaucebook after the API succeeds.
  async function syncAfterChange(uid, { addedSauceId = null, removedSauceId = null } = {}) {
    if (!uid || !enabled()) return;
    try {
      // Mirror the new slim list to disk so list-only reads stay current.
      await cache.writeList(uid, getState()?.saucebook?.items || []);

      if (removedSauceId) {
        await cache.deleteSauce(uid, removedSauceId);
      }
      if (addedSauceId) {
        // We don't have a per-sauce GET endpoint; piggy-back on allSauces.
        // Same cost as syncAll's catalog fetch, but worth it to keep the
        // newly-added recipe available offline immediately.
        const all = await api.allSauces();
        const target = all.find((s) => s.id === addedSauceId);
        if (target) {
          const rootId = target.parentSauceId || target.id;
          const family = all.filter((s) => s.id === rootId || s.parentSauceId === rootId);
          await cache.writeSauces(uid, family);
        }
      }

      const meta = await cache.writeMeta(uid, { lastSyncedAt: new Date().toISOString() });
      dispatch({ type: A.OFFLINE_META_LOADED, meta });
    } catch {
      // Don't surface this — the saucebook change itself succeeded; the cache
      // will catch up on the next syncAll (app foreground or relaunch).
      await cache.writeMeta(uid, { pendingDownload: true });
      dispatch({ type: A.OFFLINE_SET_PENDING, value: true });
    }
  }

  async function enable() {
    const settings = await cache.saveSettings({ enabled: true });
    dispatch({ type: A.OFFLINE_SET_ENABLED, value: true });
    const uid = userId();
    if (uid) await syncAll(uid);
    return settings;
  }

  async function disable() {
    const uid = userId();
    await cache.saveSettings({ enabled: false });
    if (uid) await cache.clearAll(uid);
    dispatch({ type: A.OFFLINE_SET_ENABLED, value: false });
  }

  function attachAppStateListener() {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      const uid = userId();
      if (!uid || !enabled()) return;
      const pending = !!getState()?.offline?.pendingDownload;
      if (pending) syncAll(uid);
    });
    return () => {
      // RN 0.65+ returns a subscription with .remove(); older fallback is removeEventListener.
      if (sub && typeof sub.remove === 'function') sub.remove();
    };
  }

  return { syncAll, syncAfterChange, enable, disable, attachAppStateListener };
}
