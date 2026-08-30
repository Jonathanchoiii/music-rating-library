import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findConfirmedAppleMusicAlbum,
  parseAppleMusicAlbumUrl,
} from "../src/lib/appleMusicUrl.js";

export { findConfirmedAppleMusicAlbum, parseAppleMusicAlbumUrl };

const SCHEMA_VERSION = 1;
const API_BASE = "https://api.music.apple.com";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 4;
const MAX_CONCURRENCY = 5;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const STOREFRONT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOTE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const EQUIVALENT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CACHED_NOTES = 4000;
const MAX_CACHED_EQUIVALENTS = 2000;
const MAX_ALBUM_REQUESTS_PER_SCAN = 200;
const MAX_LANGUAGES_PER_STOREFRONT = 10;
const STORE_LOCK_TIMEOUT_MS = 20_000;
const STORE_LOCK_STALE_MS = 5 * 60 * 1000;

export const QUICK_SCAN_STOREFRONTS = Object.freeze([
  "us",
  "gb",
  "tw",
  "hk",
  "cn",
  "jp",
  "kr",
  "fr",
  "de",
  "es",
  "mx",
  "br",
  "ca",
  "au",
  "sg",
]);

const LOCALE_STOREFRONTS = Object.freeze({
  "zh-cn": "cn",
  "zh-hans": "cn",
  "zh-tw": "tw",
  "zh-hant": "tw",
  "zh-hk": "hk",
  "ja": "jp",
  "ko": "kr",
  "en-gb": "gb",
  "en-us": "us",
  "en": "us",
  "fr": "fr",
  "de": "de",
  "es": "es",
  "pt-br": "br",
});

let storeWriteQueue = Promise.resolve();

function codedError(code, statusCode = 502) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, maxLength = 4000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function getAppleMusicNotesStorePath() {
  if (process.env.RECORDSHELF_APPLE_MUSIC_NOTES_PATH) {
    return path.resolve(process.env.RECORDSHELF_APPLE_MUSIC_NOTES_PATH);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "apple-music-editorial-notes.json",
  );
}

export function getAppleMusicTokenPath() {
  if (process.env.RECORDSHELF_APPLE_MUSIC_TOKEN_PATH) {
    return path.resolve(process.env.RECORDSHELF_APPLE_MUSIC_TOKEN_PATH);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "apple-music-developer-token",
  );
}

export async function resolveAppleMusicDeveloperToken() {
  const fromEnvironment = cleanText(
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN,
    4000,
  );
  if (fromEnvironment) return { token: fromEnvironment, source: "ENVIRONMENT" };
  try {
    const token = cleanText(
      await fs.readFile(getAppleMusicTokenPath(), "utf8"),
      4000,
    );
    return { token, source: token ? "PRIVATE_FILE" : null };
  } catch (error) {
    if (error?.code === "ENOENT") return { token: "", source: null };
    throw error;
  }
}

export function classifyAppleMusicUrl(input) {
  const parsed = parseAppleMusicAlbumUrl(input);
  if (parsed) return { parsed, error: null };
  let hostname = "";
  try {
    hostname = new URL(String(input ?? "").trim()).hostname.toLocaleLowerCase();
  } catch {
    hostname = "";
  }
  return {
    parsed: null,
    error: ["music.apple.com", "www.music.apple.com"].includes(hostname)
      ? "UNSUPPORTED_APPLE_MUSIC_RESOURCE"
      : "INVALID_APPLE_MUSIC_URL",
  };
}

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#39", "'"],
  ["nbsp", "\u00a0"],
  ["hellip", "\u2026"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
]);

function decodeEntities(value = "") {
  return value.replace(/&(#x?[0-9a-f]+|[a-z0-9#]+);/gi, (match, entity) => {
    const key = entity.toLocaleLowerCase();
    if (NAMED_ENTITIES.has(key)) return NAMED_ENTITIES.get(key);
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const ALLOWED_TAGS = new Set(["b", "i", "br"]);

export function sanitizeEditorialHtml(raw = "") {
  const input = typeof raw === "string" ? raw : "";
  // Drop script/style bodies before tokenizing so their text never survives.
  const source = input.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>|<[^>]*>/g;
  const openTags = [];
  let html = "";
  let text = "";
  let lastIndex = 0;
  let match;

  const appendText = (chunk) => {
    if (!chunk) return;
    const decoded = decodeEntities(chunk);
    html += escapeHtml(decoded);
    text += decoded;
  };

  while ((match = tagPattern.exec(source)) !== null) {
    appendText(source.slice(lastIndex, match.index));
    const tag = (match[1] ?? "").toLocaleLowerCase();
    if (ALLOWED_TAGS.has(tag)) {
      if (tag === "br") {
        html += "<br />";
        text += "\n";
      } else if (match[0].startsWith("</")) {
        if (openTags.at(-1) === tag) {
          openTags.pop();
          html += `</${tag}>`;
        }
      } else {
        openTags.push(tag);
        html += `<${tag}>`;
      }
    }
    lastIndex = tagPattern.lastIndex;
  }
  appendText(source.slice(lastIndex));
  while (openTags.length) html += `</${openTags.pop()}>`;

  return {
    html: html.replace(/[ \t\u00a0]+/g, " ").trim(),
    plainText: text
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^[ \n]+|[ \n]+$/g, ""),
  };
}

export function editorialNoteHash(plainText = "") {
  const normalized = String(plainText)
    .normalize("NFKC")
    .replaceAll("\u00a0", " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

function noteTypeRank(noteType) {
  return noteType === "standard" ? 0 : 1;
}

export function buildEditorialVersions(entries = []) {
  const byHash = new Map();
  for (const entry of entries) {
    const id = editorialNoteHash(entry?.plainText);
    if (!id) continue;
    const source = {
      storefront: entry.storefront,
      regionName: entry.regionName || entry.storefront,
      languageTag: entry.languageTag,
      albumId: entry.albumId,
    };
    const existing = byHash.get(id);
    if (!existing) {
      byHash.set(id, {
        id,
        html: entry.html,
        plainText: entry.plainText,
        noteType: entry.noteType,
        languageTags: [entry.languageTag],
        sources: [source],
      });
      continue;
    }
    if (!existing.languageTags.includes(entry.languageTag)) {
      existing.languageTags.push(entry.languageTag);
    }
    if (
      !existing.sources.some(
        (candidate) =>
          candidate.storefront === source.storefront &&
          candidate.languageTag === source.languageTag,
      )
    ) {
      existing.sources.push(source);
    }
    // The same prose can arrive as `short` in one region and `standard` in
    // another; keep the fuller label so the UI never mislabels it.
    if (noteTypeRank(entry.noteType) < noteTypeRank(existing.noteType)) {
      existing.noteType = entry.noteType;
      existing.html = entry.html;
    }
  }

  return [...byHash.values()]
    .map((version) => ({
      ...version,
      languageTags: [...version.languageTags].sort(),
      sources: [...version.sources].sort(
        (left, right) =>
          left.storefront.localeCompare(right.storefront) ||
          left.languageTag.localeCompare(right.languageTag),
      ),
    }))
    .sort(
      (left, right) =>
        noteTypeRank(left.noteType) - noteTypeRank(right.noteType) ||
        right.sources.length - left.sources.length ||
        left.languageTags[0].localeCompare(right.languageTags[0]) ||
        left.id.localeCompare(right.id),
    );
}

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: null,
    storefronts: null,
    equivalents: {},
    notes: {},
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export async function readAppleMusicNotesStore(
  storePath = getAppleMusicNotesStorePath(),
) {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    if (parsed?.schemaVersion !== SCHEMA_VERSION) return emptyStore();
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      storefronts: plainObject(parsed.storefronts).items
        ? parsed.storefronts
        : null,
      equivalents: plainObject(parsed.equivalents),
      notes: plainObject(parsed.notes),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    return emptyStore();
  }
}

function pruneCacheSection(section, maxEntries) {
  const keys = Object.keys(section);
  if (keys.length <= maxEntries) return section;
  const ordered = keys
    .map((key) => [key, Date.parse(section[key]?.fetchedAt ?? 0) || 0])
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxEntries)
    .map(([key]) => key);
  return Object.fromEntries(ordered.map((key) => [key, section[key]]));
}

async function acquireStoreLock(storePath) {
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  while (Date.now() - startedAt < STORE_LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const details = await fs.stat(lockPath);
        if (Date.now() - details.mtimeMs > STORE_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw codedError("APPLE_MUSIC_CACHE_BUSY", 503);
}

async function writeAppleMusicNotesStore(storePath, store) {
  const run = async () => {
    const release = await acquireStoreLock(storePath);
    try {
      const next = {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        storefronts: store.storefronts,
        equivalents: pruneCacheSection(
          store.equivalents,
          MAX_CACHED_EQUIVALENTS,
        ),
        notes: pruneCacheSection(store.notes, MAX_CACHED_NOTES),
      };
      const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(
          temporaryPath,
          `${JSON.stringify(next, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await fs.rename(temporaryPath, storePath);
        await fs.chmod(storePath, 0o600);
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
      }
    } finally {
      await release();
    }
  };
  const pending = storeWriteQueue.then(run, run);
  storeWriteQueue = pending.catch(() => {});
  return pending;
}

function isFresh(entry, ttlMs, now) {
  const fetchedAt = Date.parse(entry?.fetchedAt ?? "");
  return Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs;
}

function retryAfterDelay(response, attempt) {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 15_000);
    }
    const retryDate = Date.parse(header);
    if (Number.isFinite(retryDate)) {
      return Math.min(Math.max(retryDate - Date.now(), 0), 15_000);
    }
  }
  const base = Math.min(250 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 250);
}

const defaultSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function appleMusicRequest(
  requestPath,
  { token, fetchImpl, sleepImpl, onEvent },
) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetchImpl(`${API_BASE}${requestPath}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      lastError = codedError("APPLE_MUSIC_UPSTREAM_ERROR", 502);
      onEvent?.({ requestPath, attempt, status: 0, latency: Date.now() - startedAt });
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await sleepImpl(retryAfterDelay(null, attempt));
      continue;
    }

    onEvent?.({
      requestPath,
      attempt,
      status: response.status,
      latency: Date.now() - startedAt,
    });

    if (response.ok) return await response.json();
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw codedError("APPLE_MUSIC_UNAUTHORIZED", 502);
    }
    if (RETRY_STATUSES.has(response.status)) {
      lastError = codedError(
        response.status === 429
          ? "APPLE_MUSIC_RATE_LIMITED"
          : "APPLE_MUSIC_UPSTREAM_ERROR",
        502,
      );
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await sleepImpl(retryAfterDelay(response, attempt));
      continue;
    }
    throw codedError("APPLE_MUSIC_UPSTREAM_ERROR", 502);
  }
  throw lastError ?? codedError("APPLE_MUSIC_UPSTREAM_ERROR", 502);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function normalizedStorefronts(payload) {
  return (payload?.data ?? [])
    .map((entry) => ({
      id: cleanText(entry?.id, 10).toLocaleLowerCase(),
      name: cleanText(entry?.attributes?.name, 120),
      defaultLanguageTag: cleanText(
        entry?.attributes?.defaultLanguageTag,
        30,
      ),
      supportedLanguageTags: Array.isArray(
        entry?.attributes?.supportedLanguageTags,
      )
        ? entry.attributes.supportedLanguageTags
            .map((tag) => cleanText(tag, 30))
            .filter(Boolean)
        : [],
    }))
    .filter((entry) => entry.id);
}

async function loadStorefronts(store, context) {
  if (
    !context.refresh &&
    isFresh(store.storefronts, STOREFRONT_TTL_MS, context.now)
  ) {
    return store.storefronts.items;
  }
  const payload = await appleMusicRequest("/v1/storefronts?limit=200", context);
  const items = normalizedStorefronts(payload);
  if (items.length) {
    store.storefronts = {
      fetchedAt: new Date(context.now).toISOString(),
      items,
    };
    context.storeChanged = true;
  }
  return items;
}

function storefrontLanguages(storefront) {
  return [
    ...new Set(
      [
        storefront.defaultLanguageTag,
        ...storefront.supportedLanguageTags,
      ].filter(Boolean),
    ),
  ].slice(0, MAX_LANGUAGES_PER_STOREFRONT);
}

function localeStorefront(locale) {
  const normalized = cleanText(locale, 35).toLocaleLowerCase();
  if (!normalized) return "";
  return (
    LOCALE_STOREFRONTS[normalized] ??
    LOCALE_STOREFRONTS[normalized.split("-")[0]] ??
    ""
  );
}

async function resolveTargetAlbumId(target, context) {
  const { sourceStorefront, sourceAlbumId } = context.album;
  if (target === sourceStorefront) return sourceAlbumId;
  const key = `${sourceStorefront}:${sourceAlbumId}>${target}`;
  const cached = context.store.equivalents[key];
  if (!context.refresh && isFresh(cached, EQUIVALENT_TTL_MS, context.now)) {
    return cached.albumId || null;
  }
  const payload = await appleMusicRequest(
    `/v1/catalog/${encodeURIComponent(target)}/albums?filter%5Bequivalents%5D=${encodeURIComponent(sourceAlbumId)}`,
    context,
  );
  const albumId = cleanText(payload?.data?.[0]?.id, 40) || null;
  context.store.equivalents[key] = {
    fetchedAt: new Date(context.now).toISOString(),
    albumId,
  };
  context.storeChanged = true;
  return albumId;
}

function noteFromAttributes(attributes) {
  const standard = cleanText(attributes?.editorialNotes?.standard, 20_000);
  const short = cleanText(attributes?.editorialNotes?.short, 20_000);
  const raw = standard || short;
  if (!raw) return null;
  const { html, plainText } = sanitizeEditorialHtml(raw);
  if (!plainText) return null;
  return {
    noteType: standard ? "standard" : "short",
    html,
    plainText,
  };
}

function albumFacts(attributes) {
  return {
    name: cleanText(attributes?.name, 300),
    artistName: cleanText(attributes?.artistName, 300),
    appleMusicUrl: cleanText(attributes?.url, 1000),
    artworkUrl: cleanText(attributes?.artwork?.url, 1000),
  };
}

async function loadLocalizedNote(target, languageTag, albumId, context) {
  const key = `${SCHEMA_VERSION}|${context.album.sourceAlbumId}|${target}|${languageTag}`;
  const cached = context.store.notes[key];
  if (!context.refresh && isFresh(cached, NOTE_TTL_MS, context.now)) {
    context.cacheHits += 1;
    return cached.empty ? null : cached;
  }
  const payload = await appleMusicRequest(
    `/v1/catalog/${encodeURIComponent(target)}/albums/${encodeURIComponent(albumId)}?l=${encodeURIComponent(languageTag)}`,
    context,
  );
  const attributes = payload?.data?.[0]?.attributes;
  if (!attributes) {
    context.store.notes[key] = {
      fetchedAt: new Date(context.now).toISOString(),
      empty: true,
    };
    context.storeChanged = true;
    return null;
  }
  const note = noteFromAttributes(attributes);
  const facts = albumFacts(attributes);
  if (!context.albumFacts.name && facts.name) context.albumFacts = facts;
  if (!note) {
    context.store.notes[key] = {
      fetchedAt: new Date(context.now).toISOString(),
      empty: true,
      ...facts,
    };
    context.storeChanged = true;
    return null;
  }
  const entry = {
    fetchedAt: new Date(context.now).toISOString(),
    albumId,
    ...note,
    ...facts,
  };
  context.store.notes[key] = entry;
  context.storeChanged = true;
  return entry;
}

export async function scanAppleMusicEditorialNotes({
  url = "",
  album = null,
  mode = "quick",
  locale = "",
  refresh = false,
  storePath = getAppleMusicNotesStorePath(),
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  token = null,
  now = Date.now(),
  onEvent = null,
} = {}) {
  const parsedAlbum = album ?? parseAppleMusicAlbumUrl(url);
  if (!parsedAlbum) {
    throw codedError(classifyAppleMusicUrl(url).error, 400);
  }

  const resolvedToken =
    token ?? (await resolveAppleMusicDeveloperToken()).token;
  if (!resolvedToken) throw codedError("APPLE_MUSIC_NOT_CONFIGURED", 503);

  const store = await readAppleMusicNotesStore(storePath);
  const context = {
    album: parsedAlbum,
    token: resolvedToken,
    fetchImpl,
    sleepImpl,
    onEvent,
    refresh,
    now,
    store,
    storeChanged: false,
    cacheHits: 0,
    albumFacts: {
      name: "",
      artistName: "",
      appleMusicUrl: "",
      artworkUrl: "",
    },
  };

  let failedRequests = 0;
  const storefronts = await loadStorefronts(store, context);
  const storefrontsById = new Map(
    storefronts.map((storefront) => [storefront.id, storefront]),
  );

  const requestedTargets =
    mode === "full"
      ? [
          parsedAlbum.sourceStorefront,
          ...storefronts.map((storefront) => storefront.id),
        ]
      : [
          parsedAlbum.sourceStorefront,
          localeStorefront(locale),
          ...QUICK_SCAN_STOREFRONTS,
        ];
  const targets = [
    ...new Set(requestedTargets.filter(Boolean)),
  ].filter(
    (target) =>
      storefrontsById.has(target) ||
      target === parsedAlbum.sourceStorefront,
  );

  const albumIds = await mapWithConcurrency(
    targets,
    MAX_CONCURRENCY,
    async (target) => {
      try {
        return await resolveTargetAlbumId(target, context);
      } catch (error) {
        if (error?.code === "APPLE_MUSIC_UNAUTHORIZED") throw error;
        failedRequests += 1;
        return null;
      }
    },
  );

  const tasks = [];
  targets.forEach((target, index) => {
    const albumId = albumIds[index];
    if (!albumId) return;
    const storefront =
      storefrontsById.get(target) ??
      ({ id: target, name: target, defaultLanguageTag: "", supportedLanguageTags: [] });
    const languages = storefrontLanguages(storefront);
    for (const languageTag of languages.length ? languages : [""]) {
      if (!languageTag) continue;
      tasks.push({ target, storefront, languageTag, albumId });
    }
  });

  const budgetedTasks = tasks.slice(0, MAX_ALBUM_REQUESTS_PER_SCAN);
  const localizedEntries = [];
  await mapWithConcurrency(
    budgetedTasks,
    MAX_CONCURRENCY,
    async ({ target, storefront, languageTag, albumId }) => {
      try {
        const entry = await loadLocalizedNote(
          target,
          languageTag,
          albumId,
          context,
        );
        if (!entry) return;
        localizedEntries.push({
          storefront: target,
          regionName: storefront.name || target,
          languageTag,
          albumId,
          noteType: entry.noteType,
          html: entry.html,
          plainText: entry.plainText,
        });
      } catch (error) {
        if (error?.code === "APPLE_MUSIC_UNAUTHORIZED") throw error;
        failedRequests += 1;
      }
    },
  );

  if (context.storeChanged) {
    await writeAppleMusicNotesStore(storePath, store).catch(() => {});
  }

  const sourceAlbumFound = albumIds.some(Boolean);
  if (!sourceAlbumFound && !failedRequests) {
    throw codedError("APPLE_MUSIC_ALBUM_NOT_FOUND", 404);
  }

  const versions = buildEditorialVersions(localizedEntries);
  return {
    provider: "appleMusic",
    album: {
      sourceAlbumId: parsedAlbum.sourceAlbumId,
      sourceStorefront: parsedAlbum.sourceStorefront,
      name: context.albumFacts.name,
      artistName: context.albumFacts.artistName,
      artworkUrl: context.albumFacts.artworkUrl || undefined,
      appleMusicUrl:
        context.albumFacts.appleMusicUrl || parsedAlbum.canonicalUrl,
    },
    versions,
    emptyReason: versions.length ? null : "APPLE_MUSIC_NO_EDITORIAL_NOTES",
    scan: {
      mode: mode === "full" ? "full" : "quick",
      status: failedRequests || budgetedTasks.length < tasks.length
        ? "partial"
        : "complete",
      storefrontsChecked: targets.length,
      localizedResultsFound: localizedEntries.length,
      uniqueVersionsFound: versions.length,
      failedRequests,
    },
  };
}

const SAFE_ERROR_CODES = new Set([
  "INVALID_APPLE_MUSIC_URL",
  "UNSUPPORTED_APPLE_MUSIC_RESOURCE",
  "APPLE_MUSIC_NOT_CONFIGURED",
  "APPLE_MUSIC_UNAUTHORIZED",
  "APPLE_MUSIC_RATE_LIMITED",
  "APPLE_MUSIC_ALBUM_NOT_FOUND",
  "APPLE_MUSIC_NO_EDITORIAL_NOTES",
  "APPLE_MUSIC_UPSTREAM_ERROR",
  "APPLE_MUSIC_CACHE_BUSY",
]);

function json(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

export async function handleAppleMusicEditorialRequest(request, response) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname !== "/api/apple-music/editorial-notes") return false;
  if (request.method !== "GET") {
    json(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  try {
    const result = await scanAppleMusicEditorialNotes({
      url: url.searchParams.get("url") ?? "",
      mode: url.searchParams.get("mode") === "full" ? "full" : "quick",
      locale: url.searchParams.get("locale") ?? "",
      refresh: url.searchParams.get("refresh") === "1",
      onEvent: ({ requestPath, attempt, status, latency }) => {
        if (status && status < 400) return;
        console.warn(
          `[apple-music] ${requestPath.split("?")[0]} status=${status} attempt=${attempt} latency=${latency}ms`,
        );
      },
    });
    json(response, 200, result);
    return true;
  } catch (error) {
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : "APPLE_MUSIC_UPSTREAM_ERROR";
    json(response, error?.statusCode ?? 502, { error: code });
    return true;
  }
}
