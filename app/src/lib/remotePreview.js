import { installRuntimeSeedLibrary } from "./libraryUserState.js";
import {
  NEODB_OAUTH_CLIENT_KEY,
  SHARED_LOCAL_STORAGE_KEYS,
} from "./sharedStorageKeys.js";

let previewMeta = {
  available: false,
  updatedAt: null,
  catalogCount: 0,
  status: "idle",
};

export function getRemotePreviewMeta() {
  return previewMeta;
}

function applyPreviewStorage(storage = {}) {
  for (const key of SHARED_LOCAL_STORAGE_KEYS) {
    if (key === NEODB_OAUTH_CLIENT_KEY) continue;
    const value = storage[key];
    if (typeof value === "string") {
      window.localStorage.setItem(key, value);
    }
  }
}

export async function loginRemotePreview(password) {
  const response = await fetch("/api/preview/login", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "PREVIEW_LOGIN_FAILED");
  }
}

export async function bootstrapRemotePreview() {
  try {
    const response = await fetch("/api/preview/snapshot", {
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) {
      previewMeta = { ...previewMeta, status: "login" };
      return { status: "login" };
    }
    if (response.status === 503) {
      previewMeta = { ...previewMeta, status: "setup" };
      return { status: "setup" };
    }
    if (response.status === 404) {
      previewMeta = { ...previewMeta, status: "empty" };
      return { status: "empty" };
    }
    if (!response.ok) {
      previewMeta = { ...previewMeta, status: "error" };
      return { status: "error" };
    }
    const payload = await response.json();
    if (Array.isArray(payload.catalog) && payload.catalog.length) {
      installRuntimeSeedLibrary(payload.catalog);
    }
    applyPreviewStorage(payload.storage ?? {});
    previewMeta = {
      available: true,
      updatedAt: payload.updatedAt ?? null,
      catalogCount: payload.catalogCount ?? payload.catalog?.length ?? 0,
      status: "ready",
    };
    return { status: "ready", meta: previewMeta };
  } catch (error) {
    console.warn("RecordShelf 远程预览快照无法读取", error);
    previewMeta = { ...previewMeta, status: "error" };
    return { status: "error" };
  }
}
