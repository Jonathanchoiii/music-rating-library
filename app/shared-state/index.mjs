import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SHARED_LOCAL_STORAGE_KEYS,
  SHARED_LOCAL_STORAGE_KEY_SET,
} from "../src/lib/sharedStorageKeys.js";

const SCHEMA_VERSION = 1;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_BACKUPS = 20;
const MAX_NEODB_SNAPSHOTS = 20;
const MAX_NEODB_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const writeQueues = new Map();
const MISSING = Symbol("missing");

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

export function getNeoDbSnapshotDirectory(
  statePath = getSharedStatePath(),
) {
  return path.join(path.dirname(statePath), "neodb-snapshots");
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

function safeSnapshotTimestamp(value) {
  const timestamp = Date.parse(value);
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now())
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-");
}

export async function persistNeoDbCsvSnapshot(
  payload,
  statePath = getSharedStatePath(),
) {
  const csv = typeof payload?.csv === "string" ? payload.csv : "";
  const byteLength = Buffer.byteLength(csv, "utf8");
  if (!csv || byteLength > MAX_NEODB_SNAPSHOT_BYTES) {
    const error = new Error(
      !csv ? "EMPTY_NEODB_SNAPSHOT" : "NEODB_SNAPSHOT_TOO_LARGE",
    );
    error.statusCode = !csv ? 400 : 413;
    throw error;
  }
  const contentHash = createHash("sha256").update(csv).digest("hex");
  const shortHash = contentHash.slice(0, 16);
  const snapshotDirectory = getNeoDbSnapshotDirectory(statePath);
  await fs.mkdir(snapshotDirectory, { recursive: true });
  const existingSnapshots = (await fs.readdir(snapshotDirectory))
    .filter((name) => /^neodb-snapshot-.+-[a-f0-9]{16}\.csv$/.test(name))
    .sort();
  const existingName = existingSnapshots.find((name) =>
    name.endsWith(`-${shortHash}.csv`),
  );
  if (existingName) {
    return {
      fileName: existingName,
      contentHash,
      rowCount: Number(payload.rowCount) || 0,
      reused: true,
      directoryName: "neodb-snapshots",
    };
  }

  const fileName = `neodb-snapshot-${safeSnapshotTimestamp(
    payload.syncedAt,
  )}-${shortHash}.csv`;
  const filePath = path.join(snapshotDirectory, fileName);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, csv, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }

  const snapshots = (await fs.readdir(snapshotDirectory))
    .filter((name) => /^neodb-snapshot-.+-[a-f0-9]{16}\.csv$/.test(name))
    .sort();
  await Promise.all(
    snapshots
      .slice(0, Math.max(0, snapshots.length - MAX_NEODB_SNAPSHOTS))
      .map((name) =>
        fs.rm(path.join(snapshotDirectory, name), { force: true }),
      ),
  );
  return {
    fileName,
    contentHash,
    rowCount: Number(payload.rowCount) || 0,
    reused: false,
    directoryName: "neodb-snapshots",
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isDeletionSetPath(pathParts) {
  return (
    pathParts.at(-1) === "removedReleaseIds" ||
    pathParts.includes("listeningEntryRemovals") ||
    pathParts.includes(
      "recordshelf-dismissed-artist-duplicates-v1",
    )
  );
}

function arrayItemKey(value) {
  return JSON.stringify(value);
}

function mergeEditableSetArray(base, current, incoming) {
  const baseKeys = new Set(base.map(arrayItemKey));
  const currentKeys = new Set(current.map(arrayItemKey));
  const incomingKeys = new Set(incoming.map(arrayItemKey));
  const removedKeys = new Set(
    [...baseKeys].filter(
      (key) => !currentKeys.has(key) || !incomingKeys.has(key),
    ),
  );
  return [...current, ...incoming].filter((item, index, all) => {
    const key = arrayItemKey(item);
    return (
      !removedKeys.has(key) &&
      all.findIndex((candidate) => arrayItemKey(candidate) === key) ===
        index
    );
  });
}

function keyedArrayId(value) {
  if (!isPlainObject(value)) return "";
  return typeof value.id === "string" && value.id ? value.id : "";
}

function mergeKeyedArray(base, current, incoming, pathParts) {
  const baseById = new Map(base.map((item) => [keyedArrayId(item), item]));
  const currentById = new Map(
    current.map((item) => [keyedArrayId(item), item]),
  );
  const incomingById = new Map(
    incoming.map((item) => [keyedArrayId(item), item]),
  );
  const orderedIds = [
    ...new Set([
      ...current.map(keyedArrayId),
      ...incoming.map(keyedArrayId),
      ...base.map(keyedArrayId),
    ]),
  ].filter(Boolean);
  return orderedIds.flatMap((id) => {
    const merged = mergeThreeWay(
      baseById.get(id) ?? MISSING,
      currentById.get(id) ?? MISSING,
      incomingById.get(id) ?? MISSING,
      [...pathParts, id],
    );
    return merged === MISSING ? [] : [merged];
  });
}

function mergeThreeWay(base, current, incoming, pathParts = []) {
  if (isDeepStrictEqual(incoming, base)) return current;
  if (isDeepStrictEqual(current, base)) return incoming;
  if (isDeepStrictEqual(current, incoming)) return current;
  if (current === MISSING) return incoming;
  if (incoming === MISSING) return current;

  if (
    isPlainObject(base === MISSING ? {} : base) &&
    isPlainObject(current) &&
    isPlainObject(incoming)
  ) {
    const baseObject = base === MISSING ? {} : base;
    const keys = new Set([
      ...Object.keys(baseObject),
      ...Object.keys(current),
      ...Object.keys(incoming),
    ]);
    const merged = {};
    for (const key of keys) {
      const value = mergeThreeWay(
        Object.hasOwn(baseObject, key) ? baseObject[key] : MISSING,
        Object.hasOwn(current, key) ? current[key] : MISSING,
        Object.hasOwn(incoming, key) ? incoming[key] : MISSING,
        [...pathParts, key],
      );
      if (value !== MISSING) merged[key] = value;
    }
    return merged;
  }

  if (Array.isArray(current) && Array.isArray(incoming)) {
    if (isDeletionSetPath(pathParts)) {
      return [
        ...new Set(
          [...current, ...incoming].filter(
            (value) => typeof value === "string" && value,
          ),
        ),
      ];
    }
    const baseArray = Array.isArray(base) ? base : [];
    const isKeyed =
      [...baseArray, ...current, ...incoming].some(keyedArrayId) &&
      [...baseArray, ...current, ...incoming].every(
        (item) => Boolean(keyedArrayId(item)),
      );
    if (isKeyed) {
      return mergeKeyedArray(
        baseArray,
        current,
        incoming,
        pathParts,
      );
    }
    if (["aliases", "titleAliases"].includes(pathParts.at(-1))) {
      return mergeEditableSetArray(baseArray, current, incoming);
    }
  }

  // Both sides changed the same scalar or non-keyed list. The value already
  // stored by the newer server revision wins.
  return current;
}

function parseJsonValue(value) {
  if (value === null || value === undefined) return MISSING;
  try {
    return JSON.parse(value);
  } catch {
    return MISSING;
  }
}

function normalizedArtistName(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

function artistIdentityNames(identity) {
  return new Set(
    [
      identity?.canonicalName,
      ...(Array.isArray(identity?.aliases)
        ? identity.aliases.map((alias) => alias?.name)
        : []),
    ]
      .map(normalizedArtistName)
      .filter(Boolean),
  );
}

function artistIdentitiesAreEquivalent(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftMbid =
    typeof left.musicBrainzMbid === "string"
      ? left.musicBrainzMbid.trim()
      : "";
  const rightMbid =
    typeof right.musicBrainzMbid === "string"
      ? right.musicBrainzMbid.trim()
      : "";
  if (leftMbid && rightMbid) return leftMbid === rightMbid;
  const leftCanonical = normalizedArtistName(left.canonicalName);
  const rightCanonical = normalizedArtistName(right.canonicalName);
  if (!leftCanonical || leftCanonical !== rightCanonical) return false;
  const leftNames = artistIdentityNames(left);
  const sharedNames = [...artistIdentityNames(right)].filter((name) =>
    leftNames.has(name),
  );
  // One shared display name can legitimately describe different artists.
  // A second exact shared search alias makes this a duplicated local identity.
  return sharedNames.length >= 2;
}

function preferredArtistSource(left, right) {
  const rank = (value) => {
    if (value === "USER_CONFIRMED_DUPLICATE") return 3;
    if (typeof value === "string" && value.includes("USER")) return 2;
    return value ? 1 : 0;
  };
  return rank(right) > rank(left) ? right : left;
}

function mergeEquivalentArtistIdentities(current, duplicate) {
  const aliases = [
    ...(Array.isArray(current.aliases) ? current.aliases : []),
    ...(Array.isArray(duplicate.aliases) ? duplicate.aliases : []),
  ];
  return {
    ...duplicate,
    ...current,
    id: current.id || duplicate.id,
    canonicalName:
      current.canonicalName || duplicate.canonicalName,
    sortName:
      current.sortName ||
      duplicate.sortName ||
      current.canonicalName ||
      duplicate.canonicalName,
    musicBrainzMbid:
      current.musicBrainzMbid || duplicate.musicBrainzMbid || "",
    source: preferredArtistSource(
      current.source,
      duplicate.source,
    ),
    musicBrainzStatus:
      current.musicBrainzStatus ||
      duplicate.musicBrainzStatus ||
      "",
    musicBrainzCheckedAt:
      current.musicBrainzCheckedAt ||
      duplicate.musicBrainzCheckedAt ||
      "",
    musicBrainzAuditFingerprint:
      current.musicBrainzAuditFingerprint ||
      duplicate.musicBrainzAuditFingerprint ||
      "",
    musicBrainzEvidence:
      current.musicBrainzEvidence ??
      duplicate.musicBrainzEvidence ??
      null,
    musicBrainzCandidates:
      Array.isArray(current.musicBrainzCandidates) &&
      current.musicBrainzCandidates.length
        ? current.musicBrainzCandidates
        : duplicate.musicBrainzCandidates ?? [],
    aliases: [
      ...new Map(
        aliases
          .filter((alias) => normalizedArtistName(alias?.name))
          .map((alias) => [
            normalizedArtistName(alias.name),
            alias,
          ]),
      ).values(),
    ],
  };
}

function coalesceEquivalentArtistIdentities(value) {
  if (!isPlainObject(value) || !Array.isArray(value.identities)) {
    return value;
  }
  const identities = [];
  for (const identity of value.identities) {
    const equivalentIndex = identities.findIndex((candidate) =>
      artistIdentitiesAreEquivalent(candidate, identity),
    );
    if (equivalentIndex < 0) {
      identities.push(identity);
      continue;
    }
    identities[equivalentIndex] = mergeEquivalentArtistIdentities(
      identities[equivalentIndex],
      identity,
    );
  }
  return {
    ...value,
    identities,
  };
}

function mergedStorageValue(key, base, current, incoming) {
  const parsedBase = parseJsonValue(base);
  const parsedCurrent = parseJsonValue(current);
  const parsedIncoming = parseJsonValue(incoming);
  if (
    parsedCurrent === MISSING &&
    parsedIncoming === MISSING
  ) {
    return null;
  }
  if (
    current !== null &&
    parsedCurrent === MISSING
  ) {
    return current;
  }
  if (
    incoming !== null &&
    parsedIncoming === MISSING
  ) {
    return current ?? incoming;
  }
  const merged = mergeThreeWay(
    parsedBase,
    parsedCurrent,
    parsedIncoming,
    [key],
  );
  if (merged === MISSING) return null;
  const normalized =
    key === "recordshelf-artist-identities-v1"
      ? coalesceEquivalentArtistIdentities(merged)
      : merged;
  return JSON.stringify(normalized);
}

async function backupSharedState(statePath, state) {
  if (!state.revision) return;
  const backupDirectory = `${statePath}.backups`;
  await fs.mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `revision-${String(state.revision).padStart(8, "0")}.json`,
  );
  await fs.writeFile(
    backupPath,
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  ).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const backups = (await fs.readdir(backupDirectory))
    .filter((name) => /^revision-\d+\.json$/.test(name))
    .sort();
  await Promise.all(
    backups
      .slice(0, Math.max(0, backups.length - MAX_BACKUPS))
      .map((name) =>
        fs.rm(path.join(backupDirectory, name), { force: true }),
      ),
  );
}

function enqueueWrite(statePath, task) {
  const previous = writeQueues.get(statePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const queued = next.then(
    () => {},
    () => {},
  ).finally(() => {
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
  {
    baseStorage = {},
    mergeMode = "three-way",
  } = {},
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
      const hasBase = Object.hasOwn(baseStorage, key);
      const currentValue = storage[key] ?? null;
      const nextValue =
        hasBase || mergeMode === "preserve-latest"
          ? mergedStorageValue(
              key,
              hasBase ? baseStorage[key] : null,
              currentValue,
              value,
            )
          : value;
      if (nextValue === null) delete storage[key];
      else storage[key] = nextValue;
    }
    if (!acceptedChanges.length) return current;
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      storage,
    };
    await backupSharedState(statePath, current);
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

export function isAuthoritativeSharedStateRequest(request) {
  const host = request.headers?.host ?? "";
  try {
    const url = new URL(`http://${host}`);
    return (
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === "4173"
    );
  } catch {
    return false;
  }
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
  if (
    !["/api/local-state", "/api/local-neodb-snapshot"].includes(
      pathname,
    )
  ) {
    return false;
  }

  try {
    if (pathname === "/api/local-neodb-snapshot") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return true;
      }
      if (!isAuthoritativeSharedStateRequest(request)) {
        sendJson(response, 403, { error: "READ_ONLY_ORIGIN" });
        return true;
      }
      const payload = await readRequestJson(request);
      sendJson(
        response,
        200,
        await persistNeoDbCsvSnapshot(payload, statePath),
      );
      return true;
    }
    if (request.method === "GET") {
      sendJson(response, 200, await readSharedState(statePath));
      return true;
    }
    if (!["PATCH", "POST"].includes(request.method)) {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    if (!isAuthoritativeSharedStateRequest(request)) {
      sendJson(response, 403, { error: "READ_ONLY_ORIGIN" });
      return true;
    }
    const payload = await readRequestJson(request);
    const state = await applySharedStateChanges(
      payload.changes,
      statePath,
      {
        baseStorage:
          payload.baseStorage &&
          typeof payload.baseStorage === "object" &&
          !Array.isArray(payload.baseStorage)
            ? payload.baseStorage
            : {},
        mergeMode:
          payload.mergeMode === "preserve-latest"
            ? "preserve-latest"
            : "three-way",
      },
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
