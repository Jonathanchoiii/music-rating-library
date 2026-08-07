import { SHARED_LOCAL_STORAGE_KEYS } from "./sharedStorageKeys.js";

const LOCAL_STATE_ENDPOINT = "/api/local-state";
const MIGRATION_MARKER_KEY = "recordshelf-shared-state-migrated-v1";
const SYNC_INTERVAL_MS = 600;
const sourceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
let knownRevision = 0;
let lastSnapshot = {};
let syncTimer = null;
let syncInFlight = null;
let immediateFlushQueued = false;

export function isAuthoritativeSharedStateWriter({
  hostname,
  port,
  userAgent,
}) {
  return (
    userAgent.includes("Electron/") ||
    (["127.0.0.1", "localhost"].includes(hostname) &&
      port === "4173")
  );
}

function isDesktopShell() {
  return navigator.userAgent.includes("Electron/");
}

function isAuthoritativeWebOrigin() {
  return (
    !isDesktopShell() &&
    isAuthoritativeSharedStateWriter({
      hostname: window.location.hostname,
      port: window.location.port,
      userAgent: navigator.userAgent,
    })
  );
}

function canWriteSharedState() {
  return isAuthoritativeSharedStateWriter({
    hostname: window.location.hostname,
    port: window.location.port,
    userAgent: navigator.userAgent,
  });
}

function localSnapshot() {
  return Object.fromEntries(
    SHARED_LOCAL_STORAGE_KEYS.flatMap((key) => {
      const value = window.localStorage.getItem(key);
      return value === null ? [] : [[key, value]];
    }),
  );
}

function changedValues(previous, next) {
  const changes = {};
  for (const key of SHARED_LOCAL_STORAGE_KEYS) {
    const previousValue = previous[key] ?? null;
    const nextValue = next[key] ?? null;
    if (previousValue !== nextValue) changes[key] = nextValue;
  }
  return changes;
}

export function reconcileSharedStateResponse(
  requestStorage,
  currentStorage,
  authoritativeStorage,
) {
  const storage = {};
  let appliedRemoteChanges = false;

  for (const key of SHARED_LOCAL_STORAGE_KEYS) {
    const requestedValue = requestStorage[key] ?? null;
    const currentValue = currentStorage[key] ?? null;
    const authoritativeValue = authoritativeStorage[key] ?? null;
    const changedDuringRequest = currentValue !== requestedValue;
    const nextValue = changedDuringRequest
      ? currentValue
      : authoritativeValue;

    if (!changedDuringRequest && nextValue !== currentValue) {
      appliedRemoteChanges = true;
    }
    if (typeof nextValue === "string") storage[key] = nextValue;
  }

  return {
    storage,
    appliedRemoteChanges,
    hasPendingChanges:
      Object.keys(changedValues(authoritativeStorage, storage)).length > 0,
  };
}

function applyRemoteStorage(storage = {}) {
  for (const key of SHARED_LOCAL_STORAGE_KEYS) {
    const value = storage[key];
    if (typeof value === "string") {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  }
}

async function requestSharedState(options) {
  const response = await fetch(LOCAL_STATE_ENDPOINT, {
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    throw new Error(`共享数据服务暂时不可用（${response.status}）`);
  }
  return response.json();
}

async function pushChanges(
  changes,
  {
    baseStorage = {},
    mergeMode = "three-way",
  } = {},
) {
  if (!Object.keys(changes).length) return null;
  const state = await requestSharedState({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceId,
      changes,
      baseStorage,
      mergeMode,
      baseRevision: knownRevision,
    }),
  });
  knownRevision = state.revision ?? knownRevision;
  return state;
}

function reconcileWithAuthoritativeState(
  state,
  requestStorage = null,
) {
  if (!state?.storage) return false;
  const current = localSnapshot();
  if (requestStorage) {
    const reconciliation = reconcileSharedStateResponse(
      requestStorage,
      current,
      state.storage,
    );
    applyRemoteStorage(reconciliation.storage);
    lastSnapshot = { ...state.storage };
    return reconciliation.appliedRemoteChanges;
  }
  if (!Object.keys(changedValues(current, state.storage)).length) {
    lastSnapshot = current;
    return false;
  }
  applyRemoteStorage(state.storage);
  lastSnapshot = localSnapshot();
  return true;
}

export async function bootstrapSharedLocalState() {
  try {
    const remote = await requestSharedState();
    const local = localSnapshot();
    const migrationCompleted =
      window.localStorage.getItem(MIGRATION_MARKER_KEY) === "1";
    const remoteIsEmpty =
      (remote.revision ?? 0) === 0 &&
      !Object.keys(remote.storage ?? {}).length;
    const shouldSeedExistingWebState =
      isAuthoritativeWebOrigin() &&
      remoteIsEmpty &&
      !migrationCompleted &&
      Object.keys(local).length > 0;
    if (
      shouldSeedExistingWebState &&
      Object.keys(local).length
    ) {
      const seeded = await pushChanges(
        changedValues(remote.storage ?? {}, local),
        {
          baseStorage: remote.storage ?? {},
          mergeMode: "three-way",
        },
      );
      knownRevision = seeded?.revision ?? 0;
      reconcileWithAuthoritativeState(seeded);
      window.localStorage.setItem(MIGRATION_MARKER_KEY, "1");
      return { migrated: true, available: true };
    }
    applyRemoteStorage(remote.storage);
    knownRevision = remote.revision ?? 0;
    lastSnapshot = localSnapshot();
    window.localStorage.setItem(MIGRATION_MARKER_KEY, "1");
    return { migrated: false, available: true };
  } catch (error) {
    console.warn("RecordShelf 共享本地数据暂时不可用", error);
    lastSnapshot = localSnapshot();
    return { migrated: false, available: false };
  }
}

export function flushSharedLocalState() {
  if (!canWriteSharedState()) return Promise.resolve();
  if (syncInFlight) return syncInFlight;

  let shouldReload = false;
  syncInFlight = (async () => {
    while (true) {
      const requestSnapshot = localSnapshot();
      const changes = changedValues(lastSnapshot, requestSnapshot);
      const changedKeys = Object.keys(changes);
      if (!changedKeys.length) break;

      const previousSnapshot = lastSnapshot;
      try {
        const state = await pushChanges(changes, {
          baseStorage: Object.fromEntries(
            changedKeys.map((key) => [
              key,
              previousSnapshot[key] ?? null,
            ]),
          ),
        });
        shouldReload =
          reconcileWithAuthoritativeState(state, requestSnapshot) ||
          shouldReload;
      } catch (error) {
        lastSnapshot = previousSnapshot;
        throw error;
      }
    }

    if (shouldReload) window.location.reload();
  })()
    .catch((error) => {
      console.warn("RecordShelf 本地修改将在稍后重试", error);
    })
    .finally(() => {
      syncInFlight = null;
    });
  return syncInFlight;
}

export function notifySharedLocalStateChanged() {
  if (!canWriteSharedState() || immediateFlushQueued) return;
  immediateFlushQueued = true;
  queueMicrotask(() => {
    immediateFlushQueued = false;
    void flushSharedLocalState();
  });
}

async function refreshFromSharedState() {
  if (document.visibilityState !== "visible") return;
  await flushSharedLocalState();
  try {
    const remote = await requestSharedState();
    if ((remote.revision ?? 0) <= knownRevision) return;
    applyRemoteStorage(remote.storage);
    knownRevision = remote.revision ?? knownRevision;
    lastSnapshot = localSnapshot();
    window.location.reload();
  } catch (error) {
    console.warn("RecordShelf 无法读取另一端的最新修改", error);
  }
}

function sendPendingChanges() {
  if (!canWriteSharedState()) return;
  const nextSnapshot = localSnapshot();
  const changes = changedValues(lastSnapshot, nextSnapshot);
  if (!Object.keys(changes).length) return;
  const body = new Blob(
    [
      JSON.stringify({
        sourceId,
        changes,
        baseStorage: Object.fromEntries(
          Object.keys(changes).map((key) => [
            key,
            lastSnapshot[key] ?? null,
          ]),
        ),
        baseRevision: knownRevision,
      }),
    ],
    { type: "application/json" },
  );
  navigator.sendBeacon?.(LOCAL_STATE_ENDPOINT, body);
}

export function startSharedLocalStateSync() {
  if (syncTimer) return;
  if (!canWriteSharedState()) {
    window.addEventListener("focus", refreshFromSharedState);
    document.addEventListener(
      "visibilitychange",
      refreshFromSharedState,
    );
    return;
  }
  syncTimer = window.setInterval(
    flushSharedLocalState,
    SYNC_INTERVAL_MS,
  );
  window.addEventListener("focus", refreshFromSharedState);
  document.addEventListener("visibilitychange", refreshFromSharedState);
  window.addEventListener("pagehide", sendPendingChanges);
}
