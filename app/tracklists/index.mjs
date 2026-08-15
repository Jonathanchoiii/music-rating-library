import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findConfirmedAppleMusicCatalogAlbum } from "../src/lib/appleMusicUrl.js";
import { findConfirmedSpotifyAlbum } from "../src/lib/spotifyUrl.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REQUEST_BYTES = 64_000;
const ITUNES_LOOKUP_ORIGIN = "https://itunes.apple.com";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_ORIGIN = "https://api.spotify.com";
const DEFAULT_SPOTIFY_MARKET = "hk";

let cachedSpotifyToken = null;

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

export function getSpotifyCredentialsPath() {
  if (process.env.RECORDSHELF_SPOTIFY_CREDENTIALS_PATH) {
    return path.resolve(process.env.RECORDSHELF_SPOTIFY_CREDENTIALS_PATH);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "spotify-client-credentials",
  );
}

export async function resolveSpotifyClientCredentials() {
  const clientId = cleanText(process.env.SPOTIFY_CLIENT_ID, 200);
  const clientSecret = cleanText(process.env.SPOTIFY_CLIENT_SECRET, 200);
  if (clientId && clientSecret) {
    return { clientId, clientSecret, source: "ENVIRONMENT" };
  }
  try {
    const raw = cleanText(await fs.readFile(getSpotifyCredentialsPath(), "utf8"), 2000);
    if (!raw) return { clientId: "", clientSecret: "", source: null };
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      const fileId = cleanText(parsed.clientId ?? parsed.client_id, 200);
      const fileSecret = cleanText(parsed.clientSecret ?? parsed.client_secret, 200);
      return {
        clientId: fileId,
        clientSecret: fileSecret,
        source: fileId && fileSecret ? "PRIVATE_FILE" : null,
      };
    }
    const lines = Object.fromEntries(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          if (separator <= 0) return null;
          return [
            line.slice(0, separator).trim().toLowerCase(),
            line.slice(separator + 1).trim(),
          ];
        })
        .filter(Boolean),
    );
    const fileId = cleanText(lines.client_id ?? lines.clientid, 200);
    const fileSecret = cleanText(lines.client_secret ?? lines.clientsecret, 200);
    return {
      clientId: fileId,
      clientSecret: fileSecret,
      source: fileId && fileSecret ? "PRIVATE_FILE" : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { clientId: "", clientSecret: "", source: null };
    throw error;
  }
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

export function normalizeSpotifyTracklistPayload(payload, albumId) {
  if (!albumId) return [];
  const seen = new Set();
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  return items
    .map((item) => {
      if (!item || item.is_local) return null;
      const trackId = cleanText(item.id, 64);
      const trackNumber = positiveInteger(item.track_number);
      const title = cleanText(item.name);
      const durationMs = nonNegativeInteger(item.duration_ms);
      if (!trackId || !trackNumber || !title || durationMs == null) return null;
      return {
        id: `spotify:${trackId}`,
        discNumber: positiveInteger(item.disc_number) ?? 1,
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

async function fetchJson(url, fetchImpl, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
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

async function getSpotifyAccessToken(fetchImpl) {
  const now = Date.now();
  if (
    cachedSpotifyToken?.accessToken &&
    cachedSpotifyToken.expiresAt > now + 30_000
  ) {
    return cachedSpotifyToken.accessToken;
  }
  const credentials = await resolveSpotifyClientCredentials();
  if (!credentials.clientId || !credentials.clientSecret) {
    throw requestError("SPOTIFY_CREDENTIALS_REQUIRED", 503);
  }
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const tokenPayload = await fetchJson(SPOTIFY_TOKEN_URL, fetchImpl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(
        `${credentials.clientId}:${credentials.clientSecret}`,
      ).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const accessToken = cleanText(tokenPayload.access_token, 4000);
  const expiresIn = positiveInteger(tokenPayload.expires_in) ?? 3600;
  if (!accessToken) {
    throw requestError("TRACKLIST_UPSTREAM_UNAVAILABLE", 502);
  }
  cachedSpotifyToken = {
    accessToken,
    expiresAt: now + expiresIn * 1000,
  };
  return accessToken;
}

export function clearSpotifyAccessTokenCache() {
  cachedSpotifyToken = null;
}

async function fetchAppleTracklist(release, fetchImpl) {
  const album = findConfirmedAppleMusicCatalogAlbum(release);
  if (!album) return null;

  const lookupUrl = new URL("/lookup", ITUNES_LOOKUP_ORIGIN);
  lookupUrl.searchParams.set("id", album.sourceAlbumId);
  lookupUrl.searchParams.set("entity", "song");
  if (album.sourceStorefront) {
    lookupUrl.searchParams.set("country", album.sourceStorefront);
  }
  const payload = await fetchJson(lookupUrl, fetchImpl);
  const tracks = normalizeAppleTracklistPayload(payload, album);
  if (!tracks.length) {
    throw requestError("NO_EXACT_TRACKLIST", 404);
  }

  return {
    version: 1,
    provider: "APPLE_MUSIC",
    status: "SUCCESS",
    sourceAlbumId: album.sourceAlbumId,
    sourceStorefront: album.sourceStorefront,
    sourceUrl: album.canonicalUrl,
    checkedAt: new Date().toISOString(),
    trackCount: tracks.length,
    tracks,
  };
}

async function fetchSpotifyTracklist(release, fetchImpl) {
  const album = findConfirmedSpotifyAlbum(release);
  if (!album) return null;

  const accessToken = await getSpotifyAccessToken(fetchImpl);
  const market =
    cleanText(process.env.SPOTIFY_MARKET, 8).toLocaleLowerCase() ||
    DEFAULT_SPOTIFY_MARKET;
  const items = [];
  let nextUrl = new URL(
    `/v1/albums/${album.sourceAlbumId}/tracks`,
    SPOTIFY_API_ORIGIN,
  );
  nextUrl.searchParams.set("limit", "50");
  nextUrl.searchParams.set("market", market);

  while (nextUrl) {
    const payload = await fetchJson(nextUrl, fetchImpl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (Array.isArray(payload?.items)) items.push(...payload.items);
    nextUrl = payload?.next ? new URL(payload.next) : null;
  }

  const tracks = normalizeSpotifyTracklistPayload(items, album.sourceAlbumId);
  if (!tracks.length) {
    throw requestError("NO_EXACT_TRACKLIST", 404);
  }

  return {
    version: 1,
    provider: "SPOTIFY",
    status: "SUCCESS",
    sourceAlbumId: album.sourceAlbumId,
    sourceStorefront: null,
    sourceUrl: album.canonicalUrl,
    checkedAt: new Date().toISOString(),
    trackCount: tracks.length,
    tracks,
  };
}

export async function fetchExactTracklist(release, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appleAlbum = findConfirmedAppleMusicCatalogAlbum(release);
  if (appleAlbum) {
    return fetchAppleTracklist(release, fetchImpl);
  }

  const spotifyAlbum = findConfirmedSpotifyAlbum(release);
  if (spotifyAlbum) {
    return fetchSpotifyTracklist(release, fetchImpl);
  }

  throw requestError("EXACT_ALBUM_LINK_REQUIRED", 400);
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
      "EXACT_ALBUM_LINK_REQUIRED",
      "EXACT_APPLE_MUSIC_LINK_REQUIRED",
      "NO_EXACT_TRACKLIST",
      "PAYLOAD_TOO_LARGE",
      "SPOTIFY_CREDENTIALS_REQUIRED",
      "TRACKLIST_UPSTREAM_UNAVAILABLE",
    ]);
    const code = error?.code ?? error?.message;
    json(response, error?.statusCode ?? 502, {
      error: safeErrors.has(code) ? code : "TRACKLIST_UNAVAILABLE",
    });
  }
  return true;
}
