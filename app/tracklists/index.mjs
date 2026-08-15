import { findConfirmedAppleMusicCatalogAlbum } from "../src/lib/appleMusicUrl.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REQUEST_BYTES = 64_000;
const ITUNES_LOOKUP_ORIGIN = "https://itunes.apple.com";

export const APPLE_TRACKLIST_STOREFRONTS = Object.freeze([
  "us",
  "gb",
  "hk",
  "tw",
  "jp",
  "cn",
  "kr",
  "au",
  "ca",
  "de",
  "fr",
  "sg",
]);

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function trackIdentity(track) {
  return `${track.discNumber}:${track.trackNumber}:${track.id}`;
}

function requestError(code, statusCode) {
  return Object.assign(new Error(code), { code, statusCode });
}

export function appleTracklistStorefrontsToTry(preferred) {
  const seen = new Set();
  const order = [];
  const add = (value) => {
    const country = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!/^[a-z]{2}$/.test(country) || seen.has(country)) return;
    seen.add(country);
    order.push(country);
  };
  add(preferred);
  for (const country of APPLE_TRACKLIST_STOREFRONTS) add(country);
  return order;
}

export function normalizeAppleTracklistPayload(payload, album) {
  if (!album?.sourceAlbumId) return [];
  const seen = new Set();
  return (Array.isArray(payload?.results) ? payload.results : [])
    .filter(
      (item) =>
        item?.wrapperType === "track" &&
        item?.kind === "song" &&
        String(item.collectionId ?? "") === String(album.sourceAlbumId),
    )
    .map((item) => {
      const trackId = positiveInteger(item.trackId);
      const trackNumber = positiveInteger(item.trackNumber);
      const title = cleanText(item.trackName);
      const durationMs = nonNegativeInteger(item.trackTimeMillis);
      if (!trackId || !trackNumber || !title || durationMs == null) return null;
      return {
        id: `apple:${trackId}`,
        discNumber: positiveInteger(item.discNumber) ?? 1,
        trackNumber,
        title,
        durationMs,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.discNumber - right.discNumber ||
        left.trackNumber - right.trackNumber,
    )
    .filter((track) => {
      const identity = trackIdentity(track);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

async function fetchJson(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw requestError("TRACKLIST_UPSTREAM_UNAVAILABLE", 502);
    }
    return await response.json();
  } catch (error) {
    if (error?.code) throw error;
    throw requestError("TRACKLIST_UPSTREAM_UNAVAILABLE", 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupAppleSongs(album, country, fetchImpl) {
  const lookupUrl = new URL("/lookup", ITUNES_LOOKUP_ORIGIN);
  lookupUrl.searchParams.set("id", album.sourceAlbumId);
  lookupUrl.searchParams.set("entity", "song");
  lookupUrl.searchParams.set("limit", "200");
  lookupUrl.searchParams.set("country", country);
  const payload = await fetchJson(lookupUrl, fetchImpl);
  return normalizeAppleTracklistPayload(payload, album);
}

async function fetchAppleTracklist(release, fetchImpl) {
  const album = findConfirmedAppleMusicCatalogAlbum(release);
  if (!album) return null;

  const countries = appleTracklistStorefrontsToTry(album.sourceStorefront);
  let sawEmptyExactList = false;
  let sawUnavailable = false;

  for (const country of countries) {
    try {
      const tracks = await lookupAppleSongs(album, country, fetchImpl);
      if (!tracks.length) {
        sawEmptyExactList = true;
        continue;
      }
      return {
        version: 1,
        provider: "APPLE_MUSIC",
        status: "SUCCESS",
        sourceAlbumId: album.sourceAlbumId,
        sourceStorefront: country,
        sourceUrl: album.canonicalUrl,
        checkedAt: new Date().toISOString(),
        trackCount: tracks.length,
        tracks,
      };
    } catch (error) {
      const code = error?.code ?? error?.message;
      if (code !== "TRACKLIST_UPSTREAM_UNAVAILABLE") throw error;
      sawUnavailable = true;
    }
  }

  throw requestError(
    sawEmptyExactList || !sawUnavailable
      ? "NO_EXACT_TRACKLIST"
      : "TRACKLIST_UPSTREAM_UNAVAILABLE",
    sawEmptyExactList || !sawUnavailable ? 404 : 502,
  );
}

export async function fetchExactTracklist(release, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appleAlbum = findConfirmedAppleMusicCatalogAlbum(release);
  if (!appleAlbum) {
    throw requestError("EXACT_APPLE_MUSIC_LINK_REQUIRED", 400);
  }
  return fetchAppleTracklist(release, fetchImpl);
}

function json(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

export async function handleTracklistRequest(request, response, options = {}) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname !== "/api/tracklists/refresh") return false;
  if (request.method !== "POST") {
    json(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        throw requestError("PAYLOAD_TOO_LARGE", 413);
      }
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const tracklist = await fetchExactTracklist(payload.release, options);
    json(response, 200, { tracklist });
  } catch (error) {
    const safeErrors = new Set([
      "EXACT_APPLE_MUSIC_LINK_REQUIRED",
      "NO_EXACT_TRACKLIST",
      "PAYLOAD_TOO_LARGE",
      "TRACKLIST_UPSTREAM_UNAVAILABLE",
    ]);
    const code = error?.code ?? error?.message;
    json(response, error?.statusCode ?? 502, {
      error: safeErrors.has(code) ? code : "TRACKLIST_UNAVAILABLE",
    });
  }
  return true;
}
