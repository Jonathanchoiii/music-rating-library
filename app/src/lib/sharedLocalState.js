import { SHARED_LOCAL_STORAGE_KEYS } from "./sharedStorageKeys.js";

const LOCAL_STATE_ENDPOINT = "/api/local-state";
const MIGRATION_MARKER_KEY = "recordshelf-shared-state-migrated-v1";
const SYNC_INTERVAL_MS = 600;
const sourceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
let knownRevision = 0;
let lastSnapshot = {};
let syncTimer = null;
let syncInFlight = null;

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

async function pushChanges(changes) {
  if (!Object.keys(changes).length) return null;
  const state = await requestSharedState({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId, changes }),
  });
  knownRevision = state.revision ?? knownRevision;
  return state;
}

export async function bootstrapSharedLocalState() {
  try {
    const remote = await requestSharedState();
    const local = localSnapshot();
    const isDesktopShell = navigator.userAgent.includes("Electron/");
    const migrationCompleted =
      window.localStorage.getItem(MIGRATION_MARKER_KEY) === "1";
    const remoteIsEmpty =
      (remote.revision ?? 0) === 0 &&
      !Object.keys(remote.storage ?? {}).length;
    const shouldMigrateExistingWebState =
      !isDesktopShell &&
      !migrationCompleted &&
      Object.keys(local).length > 0;
    if (
      (remoteIsEmpty || shouldMigrateExistingWebState) &&
      Object.keys(local).length
    ) {
      const seeded = await pushChanges(
        changedValues(remote.storage ?? {}, local),
      );
      knownRevision = seeded?.revision ?? 0;
      lastSnapshot = localSnapshot();
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
  if (syncInFlight) return syncInFlight;
  const nextSnapshot = localSnapshot();
  const changes = changedValues(lastSnapshot, nextSnapshot);
  if (!Object.keys(changes).length) return Promise.resolve();
  const previousSnapshot = lastSnapshot;
  lastSnapshot = nextSnapshot;
  syncInFlight = pushChanges(changes)
    .catch((error) => {
      console.warn("RecordShelf 本地修改将在稍后重试", error);
      lastSnapshot = previousSnapshot;
    })
    .finally(() => {
      syncInFlight = null;
    });
  return syncInFlight;
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
  const nextSnapshot = localSnapshot();
  const changes = changedValues(lastSnapshot, nextSnapshot);
  if (!Object.keys(changes).length) return;
  const body = new Blob(
    [JSON.stringify({ sourceId, changes })],
    { type: "application/json" },
  );
  navigator.sendBeacon?.(LOCAL_STATE_ENDPOINT, body);
}

export function startSharedLocalStateSync() {
  if (syncTimer) return;
  syncTimer = window.setInterval(
    flushSharedLocalState,
    SYNC_INTERVAL_MS,
  );
  window.addEventListener("focus", refreshFromSharedState);
  document.addEventListener("visibilitychange", refreshFromSharedState);
  window.addEventListener("pagehide", sendPendingChanges);
}
