import {
  applyMetadataFieldsToUserState,
  readReleaseMetadataRecord,
  sanitizeReleaseMetadataPatch,
} from "../src/lib/releaseMetadataOverlay.js";
import { USER_STATE_KEY } from "../src/lib/sharedStorageKeys.js";
import { readJsonBody, sendJson } from "../scripts/http-json.mjs";
import { applySharedStateChanges, readSharedState } from "./index.mjs";

function safeReleaseId(value) {
  const id = String(value ?? "").trim();
  return /^[a-zA-Z0-9._-]{1,180}$/.test(id) ? id : null;
}

function parseUserState(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export async function persistReleaseMetadataFields(releaseId, fields) {
  const id = safeReleaseId(releaseId);
  const patch = sanitizeReleaseMetadataPatch(fields);
  if (!id || !Object.keys(patch).length) {
    return { previousRelease: {}, nextRelease: {}, userState: {} };
  }

  const shared = await readSharedState();
  const previousText = shared.storage?.[USER_STATE_KEY] ?? null;
  const userState = parseUserState(previousText);
  const previousRelease = readReleaseMetadataRecord(userState, id);
  const nextState = applyMetadataFieldsToUserState(userState, id, patch);
  const nextText = JSON.stringify(nextState);
  if (nextText !== (previousText ?? "{}") && nextText !== previousText) {
    await applySharedStateChanges(
      { [USER_STATE_KEY]: nextText },
      undefined,
      { baseStorage: { [USER_STATE_KEY]: previousText } },
    );
  }
  return {
    previousRelease,
    nextRelease: readReleaseMetadataRecord(nextState, id),
    userState: nextState,
  };
}

export async function handleReleaseMetadataPersistRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:4173");
  if (url.pathname !== "/api/local-release-metadata") return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  try {
    const payload = await readJsonBody(request);
    const releaseId = safeReleaseId(payload.releaseId);
    const fields = sanitizeReleaseMetadataPatch(payload);
    if (!releaseId || !Object.keys(fields).length) {
      sendJson(response, 400, { error: "INVALID_RELEASE_METADATA" });
      return true;
    }
    const { nextRelease } = await persistReleaseMetadataFields(
      releaseId,
      fields,
    );
    sendJson(response, 200, { releaseId, release: nextRelease });
  } catch (error) {
    sendJson(response, error?.statusCode ?? 500, {
      error: error?.message === "INVALID_JSON" ? "INVALID_JSON" : "PERSIST_FAILED",
    });
  }
  return true;
}
