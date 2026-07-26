import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SHARED_LOCAL_STORAGE_KEYS,
  SHARED_LOCAL_STORAGE_KEY_SET,
} from "../src/lib/sharedStorageKeys.js";

const SCHEMA_VERSION = 1;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const writeQueues = new Map();

export function getSharedStatePath() {
  if (process.env.RECORDSHELF_SHARED_STATE_PATH) {
    return path.resolve(process.env.RECORDSHELF_SHARED_STATE_PATH);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "shared-local-state.json",
  );
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    storage: {},
  };
}

function sanitizeStorage(storage = {}) {
  return Object.fromEntries(
    Object.entries(storage).filter(
      ([key, value]) =>
        SHARED_LOCAL_STORAGE_KEY_SET.has(key) &&
        typeof value === "string" &&
        Buffer.byteLength(value, "utf8") <= MAX_VALUE_BYTES,
    ),
  );
}

export async function readSharedState(
  statePath = getSharedStatePath(),
) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return {
      schemaVersion: SCHEMA_VERSION,
      revision:
        Number.isSafeInteger(parsed.revision) && parsed.revision >= 0
          ? parsed.revision
          : 0,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      storage: sanitizeStorage(parsed.storage),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function atomicWrite(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temporaryPath, statePath);
    await fs.chmod(statePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function enqueueWrite(statePath, task) {
  const previous = writeQueues.get(statePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const queued = next.finally(() => {
    if (writeQueues.get(statePath) === queued) {
      writeQueues.delete(statePath);
    }
  });
  writeQueues.set(statePath, queued);
  return next;
}

export async function applySharedStateChanges(
  changes,
  statePath = getSharedStatePath(),
) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new TypeError("changes must be an object");
  }
  const acceptedChanges = Object.entries(changes).filter(
    ([key, value]) =>
      SHARED_LOCAL_STORAGE_KEY_SET.has(key) &&
      (value === null ||
        (typeof value === "string" &&
          Buffer.byteLength(value, "utf8") <= MAX_VALUE_BYTES)),
  );
  return enqueueWrite(statePath, async () => {
    const current = await readSharedState(statePath);
    const storage = { ...current.storage };
    for (const [key, value] of acceptedChanges) {
      if (value === null) delete storage[key];
      else storage[key] = value;
    }
    if (!acceptedChanges.length) return current;
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      storage,
    };
    await atomicWrite(statePath, next);
    return next;
  });
}

async function readRequestJson(request) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > MAX_BODY_BYTES) {
      const error = new Error("PAYLOAD_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("INVALID_JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

export async function handleSharedStateRequest(
  request,
  response,
  statePath = getSharedStatePath(),
) {
  const pathname = new URL(
    request.url,
    "http://127.0.0.1",
  ).pathname;
  if (pathname !== "/api/local-state") return false;

  try {
    if (request.method === "GET") {
      sendJson(response, 200, await readSharedState(statePath));
      return true;
    }
    if (!["PATCH", "POST"].includes(request.method)) {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    const payload = await readRequestJson(request);
    const state = await applySharedStateChanges(
      payload.changes,
      statePath,
    );
    sendJson(response, 200, state);
    return true;
  } catch (error) {
    sendJson(response, error?.statusCode ?? 500, {
      error: error?.message ?? "LOCAL_STATE_ERROR",
    });
    return true;
  }
}

export { SHARED_LOCAL_STORAGE_KEYS };
