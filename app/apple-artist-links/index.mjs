import OpenCCCnToTraditional from "opencc-js/cn2t";
import OpenCCTraditionalToCn from "opencc-js/t2cn";
import { resolveAppleMusicDeveloperToken } from "../apple-music-notes/index.mjs";
import { persistResearchedArtistProfile } from "../artist-research/index.mjs";
import { readJsonBody, sendJson } from "../scripts/http-json.mjs";
import { getSharedStatePath, readSharedState } from "../shared-state/index.mjs";
import {
  canonicalAppleArtistUrl,
  identityNameKeys,
  matchingAppleArtistFromAlbum,
  MAX_APPLE_ALBUMS_PER_ARTIST,
  resolveAppleArtistLink,
} from "../src/lib/appleArtistLinkMatch.js";
import {
  getArtistProfile,
  normalizeArtistPlatformUrl,
  sanitizeArtistProfileState,
} from "../src/lib/artistProfiles.js";
import { ARTIST_PROFILE_STORAGE_KEY } from "../src/lib/sharedStorageKeys.js";

const API_PATH = "/api/artists/apple-links";
const API_BASE = "https://api.music.apple.com";
const APPLE_WEB_ORIGIN = "https://music.apple.com";
const APPLE_CATALOG_ORIGIN = "https://amp-api.music.apple.com";
const APPLE_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 4;
const MAX_ARTISTS_PER_REQUEST = 80;
const MAX_ALBUM_REQUESTS_PER_REQUEST = 200;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const toSimplifiedChinese = OpenCCTraditionalToCn.Converter({
  from: "tw",
  to: "cn",
});
const toTraditionalChinese = OpenCCCnToTraditional.Converter({
  from: "cn",
  to: "tw",
});

function cleanText(value, limit = 1_000) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, limit);
}

function requestError(code, statusCode, safeMessage) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.safeMessage = safeMessage;
  return error;
}

function containsHanCharacters(value = "") {
  return /\p{Script=Han}/u.test(value);
}

export function expandArtistNameKeys(names = []) {
  const expanded = [];
  for (const name of names) {
    const cleaned = cleanText(name, 240);
    if (!cleaned) continue;
    expanded.push(cleaned);
    if (!containsHanCharacters(cleaned)) continue;
    expanded.push(toSimplifiedChinese(cleaned), toTraditionalChinese(cleaned));
  }
  return identityNameKeys(expanded);
}

function appleGuestToken(scriptText) {
  const match = String(scriptText ?? "").match(
    /eyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/,
  );
  return match?.[0] ?? "";
}

function appleAssetUrls(html) {
  const urls = [];
  const seen = new Set();
  const pattern = /(?:src|href)="(https:\/\/music\.apple\.com\/assets\/[^"]+)"/g;
  for (const match of String(html ?? "").matchAll(pattern)) {
    try {
      const url = new URL(match[1], APPLE_WEB_ORIGIN);
      if (url.origin !== APPLE_WEB_ORIGIN || seen.has(url.href)) continue;
      seen.add(url.href);
      urls.push(url.href);
    } catch {
      // Ignore malformed asset URLs in the Apple Music page.
    }
  }
  return urls;
}

function retryAfterDelay(response, attempt) {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 15_000);
    }
  }
  return Math.min(250 * 2 ** (attempt - 1), 4_000);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function authorizedCatalogGet(requestPath, context) {
  const url = new URL(requestPath, context.apiOrigin);
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await context.fetchImpl(url, {
        headers: context.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      lastError = requestError(
        "APPLE_MUSIC_UPSTREAM_ERROR",
        502,
        "Apple Music 目录暂时无法读取，请稍后重试。",
      );
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await context.sleepImpl(retryAfterDelay(null, attempt));
      continue;
    }
    if (response.ok) return await response.json();
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw requestError(
        "APPLE_MUSIC_UNAUTHORIZED",
        502,
        "Apple Music 目录授权失败，请稍后重试。",
      );
    }
    if (RETRY_STATUSES.has(response.status)) {
      lastError = requestError(
        response.status === 429
          ? "APPLE_MUSIC_RATE_LIMITED"
          : "APPLE_MUSIC_UPSTREAM_ERROR",
        502,
        "Apple Music 目录暂时无法读取，请稍后重试。",
      );
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await context.sleepImpl(retryAfterDelay(response, attempt));
      continue;
    }
    throw requestError(
      "APPLE_MUSIC_UPSTREAM_ERROR",
      502,
      "Apple Music 目录暂时无法读取，请稍后重试。",
    );
  }
  throw lastError;
}

async function obtainGuestCatalogContext(seedAlbum, fetchImpl) {
  const pageUrl = `https://music.apple.com/${seedAlbum.storefront}/album/${seedAlbum.albumId}`;
  const commonHeaders = {
    accept: "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
    "user-agent": APPLE_WEB_USER_AGENT,
  };
  const pageResponse = await fetchImpl(pageUrl, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(20_000),
  });
  if (!pageResponse.ok) {
    throw requestError(
      "APPLE_MUSIC_UNAUTHORIZED",
      502,
      "没有可用的 MusicKit 令牌，也无法读取 Apple Music 页面授权。",
    );
  }
  let token = "";
  for (const assetUrl of appleAssetUrls(await pageResponse.text()).slice(0, 8)) {
    const response = await fetchImpl(assetUrl, {
      headers: commonHeaders,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) continue;
    token = appleGuestToken(await response.text());
    if (token) break;
  }
  if (!token) {
    throw requestError(
      "APPLE_MUSIC_UNAUTHORIZED",
      502,
      "没有可用的 MusicKit 令牌，也无法读取 Apple Music 页面授权。",
    );
  }
  return {
    apiOrigin: APPLE_CATALOG_ORIGIN,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      origin: APPLE_WEB_ORIGIN,
      referer: `${APPLE_WEB_ORIGIN}/`,
      "user-agent": APPLE_WEB_USER_AGENT,
    },
  };
}

async function createCatalogContext(artists, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const resolved = await resolveAppleMusicDeveloperToken();
  if (resolved.token) {
    return {
      fetchImpl,
      sleepImpl,
      apiOrigin: API_BASE,
      headers: {
        authorization: `Bearer ${resolved.token}`,
        accept: "application/json",
      },
      cache: new Map(),
      albumRequests: 0,
    };
  }
  const seedAlbum = artists
    .flatMap((artist) => artist.albums ?? [])
    .find((album) => album?.storefront && album?.albumId);
  if (!seedAlbum) {
    throw requestError(
      "APPLE_MUSIC_TOKEN_MISSING",
      400,
      "匹配 Apple Music 艺人需要 MusicKit Developer Token，或至少一张已确认的 Apple Music 专辑链接。",
    );
  }
  const guest = await obtainGuestCatalogContext(seedAlbum, fetchImpl);
  return {
    fetchImpl,
    sleepImpl,
    ...guest,
    cache: new Map(),
    albumRequests: 0,
  };
}

function sanitizeArtistPayload(value) {
  const artistId = cleanText(value?.artistId, 240);
  const names = Array.isArray(value?.names)
    ? value.names.map((name) => cleanText(name, 240)).filter(Boolean)
    : [];
  const albums = [];
  const seen = new Set();
  for (const album of Array.isArray(value?.albums) ? value.albums : []) {
    const storefront = cleanText(album?.storefront, 8).toLocaleLowerCase();
    const albumId = cleanText(album?.albumId, 40);
    if (!/^[a-z]{2}$/.test(storefront) || !/^\d+$/.test(albumId)) continue;
    const key = `${storefront}:${albumId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    albums.push({ storefront, albumId });
    if (albums.length >= MAX_APPLE_ALBUMS_PER_ARTIST) break;
  }
  if (!artistId || !names.length || !albums.length) return null;
  return { artistId, names, albums };
}

async function fetchAlbumPayload(album, context) {
  const cacheKey = `${album.storefront}:${album.albumId}`;
  if (context.cache.has(cacheKey)) return context.cache.get(cacheKey);
  if (context.albumRequests >= MAX_ALBUM_REQUESTS_PER_REQUEST) {
    return null;
  }
  context.albumRequests += 1;
  const payload = await authorizedCatalogGet(
    `/v1/catalog/${encodeURIComponent(album.storefront)}/albums/${encodeURIComponent(album.albumId)}?include=artists`,
    context,
  );
  context.cache.set(cacheKey, payload);
  return payload;
}

export async function matchAppleArtistLink(artist, context) {
  const nameKeys = expandArtistNameKeys(artist.names);
  const albumResults = [];
  for (const album of artist.albums) {
    let payload = null;
    try {
      payload = await fetchAlbumPayload(album, context);
    } catch (error) {
      if (error?.code === "APPLE_MUSIC_RATE_LIMITED") throw error;
      albumResults.push({ status: "UPSTREAM" });
      continue;
    }
    const result = matchingAppleArtistFromAlbum(payload, nameKeys);
    if (result.status === "MATCHED") {
      const appleMusicUrl = normalizeArtistPlatformUrl(
        "appleMusic",
        canonicalAppleArtistUrl(result.artist.url, album.storefront),
      );
      if (!appleMusicUrl) {
        albumResults.push({ status: "NAME_MISMATCH" });
        continue;
      }
      albumResults.push({
        status: "MATCHED",
        artist: { ...result.artist, url: appleMusicUrl },
      });
    } else {
      albumResults.push(result);
    }
    const resolved = resolveAppleArtistLink(albumResults);
    if (resolved.status === "AMBIGUOUS") return resolved;
    const matchedCount = albumResults.filter(
      (item) => item.status === "MATCHED",
    ).length;
    if (resolved.status === "MATCHED" && matchedCount >= 2) return resolved;
  }
  return resolveAppleArtistLink(albumResults);
}

async function currentArtistProfiles(statePath) {
  const sharedState = await readSharedState(statePath);
  return sanitizeArtistProfileState(
    JSON.parse(sharedState.storage[ARTIST_PROFILE_STORAGE_KEY] || "null"),
  );
}

export async function matchAppleArtistLinks(payload, options = {}) {
  const artists = (Array.isArray(payload?.artists) ? payload.artists : [])
    .map(sanitizeArtistPayload)
    .filter(Boolean)
    .slice(0, MAX_ARTISTS_PER_REQUEST);
  if (!artists.length) {
    return {
      matched: [],
      skipped: [],
      matchedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  const statePath = options.statePath ?? getSharedStatePath();
  const profiles = await currentArtistProfiles(statePath);
  const pending = [];
  const skipped = [];
  for (const artist of artists) {
    const existing = normalizeArtistPlatformUrl(
      "appleMusic",
      getArtistProfile(profiles, artist.artistId, artist.names)?.platformLinks
        ?.appleMusic,
    );
    if (existing) {
      skipped.push({ artistId: artist.artistId, reason: "ALREADY_LINKED" });
      continue;
    }
    pending.push(artist);
  }

  const context = pending.length
    ? await createCatalogContext(pending, options)
    : null;
  const matched = [];
  let failedCount = 0;
  for (const artist of pending) {
    let resolved;
    try {
      resolved = await matchAppleArtistLink(artist, context);
    } catch (error) {
      if (
        error?.code === "APPLE_MUSIC_UNAUTHORIZED" ||
        error?.code === "APPLE_MUSIC_TOKEN_MISSING"
      ) {
        throw error;
      }
      skipped.push({ artistId: artist.artistId, reason: "UPSTREAM" });
      failedCount += 1;
      continue;
    }
    if (resolved.status !== "MATCHED") {
      skipped.push({
        artistId: artist.artistId,
        reason: resolved.status === "AMBIGUOUS" ? "AMBIGUOUS" : "NO_EVIDENCE",
      });
      continue;
    }
    const appleMusicUrl = normalizeArtistPlatformUrl(
      "appleMusic",
      resolved.artist.url,
    );
    if (!appleMusicUrl) {
      skipped.push({ artistId: artist.artistId, reason: "NO_EVIDENCE" });
      continue;
    }
    if (payload?.persist !== false) {
      await persistResearchedArtistProfile(
        artist.artistId,
        { platformLinks: { appleMusic: appleMusicUrl } },
        statePath,
      );
    }
    matched.push({ artistId: artist.artistId, appleMusicUrl });
  }

  return {
    matched,
    skipped,
    matchedCount: matched.length,
    skippedCount: skipped.length,
    failedCount,
  };
}

export async function handleAppleArtistLinksRequest(
  request,
  response,
  options = {},
) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname !== API_PATH) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  try {
    const payload = await readJsonBody(request, 1_000_000);
    const result = await matchAppleArtistLinks(payload, options);
    sendJson(response, 200, result);
  } catch (error) {
    const safeCodes = new Set([
      "APPLE_MUSIC_TOKEN_MISSING",
      "APPLE_MUSIC_UNAUTHORIZED",
      "APPLE_MUSIC_RATE_LIMITED",
      "APPLE_MUSIC_UPSTREAM_ERROR",
      "INVALID_JSON",
      "PAYLOAD_TOO_LARGE",
    ]);
    const code = safeCodes.has(error?.code ?? error?.message)
      ? error?.code ?? error?.message
      : "APPLE_ARTIST_LINKS_UNAVAILABLE";
    sendJson(response, error?.statusCode ?? 502, {
      error: code,
      message:
        error?.safeMessage || "Apple Music 艺人主页暂时无法匹配，请稍后重试。",
    });
  }
  return true;
}
