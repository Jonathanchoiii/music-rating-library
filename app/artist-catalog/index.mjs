import { resolveAppleMusicDeveloperToken } from "../apple-music-notes/index.mjs";
import { readJsonBody, sendJson } from "../scripts/http-json.mjs";
import { parseAppleMusicArtistUrl } from "../src/lib/appleMusicUrl.js";

const API_PATH = "/api/artists/catalog";
const APPLE_API_ORIGIN = "https://api.music.apple.com";
const APPLE_CATALOG_ORIGIN = "https://amp-api.music.apple.com";
const APPLE_WEB_ORIGIN = "https://music.apple.com";
const APPLE_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ALBUMS = 400;
const MAX_PAGES = 8;
const ALBUM_BATCH_SIZE = 25;

function cleanText(value, limit = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function requestError(code, statusCode, safeMessage) {
  return Object.assign(new Error(code), { code, statusCode, safeMessage });
}

function decodeJwtPayload(token) {
  try {
    const encoded = String(token ?? "").split(".")[1];
    if (!encoded) return null;
    const padded = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function appleGuestToken(scriptText) {
  const tokens = String(scriptText ?? "").match(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  );
  return tokens?.find((token) => decodeJwtPayload(token)?.iss === "AMPWebPlay") ?? "";
}

function appleAssetUrls(html) {
  const urls = [];
  for (const match of String(html ?? "").matchAll(
    /(?:src|href)=["']([^"']*\/assets\/[^"']+\.js(?:\?[^"']*)?)["']/gi,
  )) {
    try {
      const url = new URL(match[1], APPLE_WEB_ORIGIN);
      if (url.origin === APPLE_WEB_ORIGIN) urls.push(url.toString());
    } catch {
      // Ignore malformed public page assets.
    }
  }
  return [...new Set(urls)].slice(0, 8);
}

async function fetchResponse(url, options, fetchImpl) {
  try {
    return await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw requestError(
      "APPLE_MUSIC_CATALOG_UNAVAILABLE",
      502,
      "Apple Music 艺人目录暂时无法读取，请稍后重试。",
    );
  }
}

async function guestCatalogToken(identity, fetchImpl) {
  const commonHeaders = {
    accept: "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
    "user-agent": APPLE_WEB_USER_AGENT,
  };
  const pageResponse = await fetchResponse(
    identity.canonicalUrl,
    { headers: commonHeaders },
    fetchImpl,
  );
  if (!pageResponse.ok) {
    throw requestError(
      "APPLE_MUSIC_CATALOG_UNAVAILABLE",
      502,
      "Apple Music 艺人目录暂时无法读取，请稍后重试。",
    );
  }
  for (const assetUrl of appleAssetUrls(await pageResponse.text())) {
    const response = await fetchResponse(
      assetUrl,
      { headers: commonHeaders },
      fetchImpl,
    );
    if (!response.ok) continue;
    const token = appleGuestToken(await response.text());
    if (token) return token;
  }
  throw requestError(
    "APPLE_MUSIC_CATALOG_AUTH_UNAVAILABLE",
    502,
    "Apple Music 目录授权暂时不可用，请稍后重试。",
  );
}

async function catalogContext(identity, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const configured = options.developerToken
    ? { token: options.developerToken }
    : await resolveAppleMusicDeveloperToken();
  const token = configured.token || (await guestCatalogToken(identity, fetchImpl));
  const apiOrigin = configured.token ? APPLE_API_ORIGIN : APPLE_CATALOG_ORIGIN;
  return {
    fetchImpl,
    apiOrigin,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(configured.token
        ? {}
        : {
            origin: APPLE_WEB_ORIGIN,
            referer: `${APPLE_WEB_ORIGIN}/`,
            "user-agent": APPLE_WEB_USER_AGENT,
          }),
    },
  };
}

function safeCatalogUrl(value, context, storefront) {
  const url = new URL(value, context.apiOrigin);
  if (
    url.origin !== context.apiOrigin ||
    !url.pathname.startsWith(`/v1/catalog/${storefront}/`)
  ) {
    throw requestError(
      "APPLE_MUSIC_CATALOG_INVALID_PAGE",
      502,
      "Apple Music 返回了无法识别的目录分页。",
    );
  }
  return url;
}

async function catalogJson(value, context, storefront) {
  const url = safeCatalogUrl(value, context, storefront);
  const response = await fetchResponse(
    url,
    { headers: context.headers },
    context.fetchImpl,
  );
  if (!response.ok) {
    throw requestError(
      response.status === 404
        ? "APPLE_MUSIC_ARTIST_NOT_FOUND"
        : "APPLE_MUSIC_CATALOG_UNAVAILABLE",
      response.status === 404 ? 404 : 502,
      response.status === 404
        ? "这条 Apple Music 艺人主页没有对应的目录记录。"
        : "Apple Music 艺人目录暂时无法读取，请稍后重试。",
    );
  }
  return await response.json();
}

function artworkUrl(artwork, size = 600) {
  const template = cleanText(artwork?.url);
  if (!template.startsWith("https://")) return "";
  return template
    .replace(/\{w\}/g, String(size))
    .replace(/\{h\}/g, String(size))
    .replace(/\{c\}/g, "bb")
    .replace(/\{f\}/g, "jpg");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function releaseType(attributes) {
  const title = cleanText(attributes?.name, 500);
  if (/\s[-–—]\s*ep$/i.test(title)) return "EP";
  if (attributes?.isSingle === true || /\s[-–—]\s*single$/i.test(title)) {
    return "SINGLE";
  }
  return "LP";
}

function normalizeTrack(track) {
  if (track?.type !== "songs") return null;
  const attributes = track.attributes ?? {};
  const id = cleanText(track.id, 100);
  const title = cleanText(attributes.name, 500);
  if (!id || !title) return null;
  return {
    id,
    isrc: cleanText(attributes.isrc, 40),
    title,
    artistName: cleanText(attributes.artistName, 500),
    durationMs: Math.max(0, Math.round(Number(attributes.durationInMillis) || 0)),
    discNumber: positiveInteger(attributes.discNumber) ?? 1,
    trackNumber: positiveInteger(attributes.trackNumber) ?? 1,
    url: cleanText(attributes.url),
  };
}

export function normalizeAppleArtistAlbum(album) {
  const attributes = album?.attributes ?? {};
  const id = cleanText(album?.id, 100);
  const title = cleanText(attributes.name, 500);
  if (!id || !title) return null;
  const seenTracks = new Set();
  const tracks = (album?.relationships?.tracks?.data ?? [])
    .map(normalizeTrack)
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.discNumber - right.discNumber ||
        left.trackNumber - right.trackNumber,
    )
    .filter((track) => {
      if (seenTracks.has(track.id)) return false;
      seenTracks.add(track.id);
      return true;
    });
  return {
    id,
    title,
    artistName: cleanText(attributes.artistName, 500),
    releaseType: releaseType(attributes),
    releaseDate: cleanText(attributes.releaseDate, 20),
    artworkUrl: artworkUrl(attributes.artwork),
    url: cleanText(attributes.url),
    trackCount: positiveInteger(attributes.trackCount) ?? tracks.length,
    upc: cleanText(attributes.upc, 40),
    isCompilation: attributes.isCompilation === true,
    tracks,
  };
}

async function fetchArtist(identity, context) {
  const path = `/v1/catalog/${identity.sourceStorefront}/artists/${identity.sourceArtistId}`;
  const payload = await catalogJson(path, context, identity.sourceStorefront);
  const artist = payload?.data?.[0];
  if (!artist?.id || String(artist.id) !== identity.sourceArtistId) {
    throw requestError(
      "APPLE_MUSIC_ARTIST_NOT_FOUND",
      404,
      "这条 Apple Music 艺人主页没有对应的目录记录。",
    );
  }
  return artist;
}

async function fetchArtistAlbums(identity, context) {
  let next =
    `/v1/catalog/${identity.sourceStorefront}/artists/` +
    `${identity.sourceArtistId}/albums?limit=100&include=tracks`;
  const albums = [];
  for (let page = 0; next && page < MAX_PAGES && albums.length < MAX_ALBUMS; page += 1) {
    const payload = await catalogJson(next, context, identity.sourceStorefront);
    albums.push(...(Array.isArray(payload?.data) ? payload.data : []));
    next = cleanText(payload?.next, 2_000);
  }
  return albums.slice(0, MAX_ALBUMS);
}

async function hydrateMissingTracks(albums, identity, context) {
  const missing = albums.filter(
    (album) => !Array.isArray(album?.relationships?.tracks?.data),
  );
  if (!missing.length) return albums;
  const hydrated = new Map();
  for (let index = 0; index < missing.length; index += ALBUM_BATCH_SIZE) {
    const ids = missing
      .slice(index, index + ALBUM_BATCH_SIZE)
      .map((album) => cleanText(album?.id, 100))
      .filter(Boolean);
    if (!ids.length) continue;
    const path =
      `/v1/catalog/${identity.sourceStorefront}/albums?ids=` +
      `${encodeURIComponent(ids.join(","))}&include=tracks`;
    const payload = await catalogJson(path, context, identity.sourceStorefront);
    for (const album of payload?.data ?? []) hydrated.set(String(album.id), album);
  }
  return albums.map((album) => hydrated.get(String(album.id)) ?? album);
}

export async function fetchArtistExplorationCatalog(payload, options = {}) {
  const identity = parseAppleMusicArtistUrl(payload?.appleMusicUrl);
  if (!identity?.sourceStorefront) {
    throw requestError(
      "EXACT_APPLE_MUSIC_ARTIST_URL_REQUIRED",
      400,
      "请先添加包含地区的精确 Apple Music 艺人主页链接。",
    );
  }
  const context = await catalogContext(identity, options);
  const artist = await fetchArtist(identity, context);
  const rawAlbums = await fetchArtistAlbums(identity, context);
  const hydrated = await hydrateMissingTracks(rawAlbums, identity, context);
  const releases = [...new Map(
    hydrated
      .map(normalizeAppleArtistAlbum)
      .filter(Boolean)
      .map((release) => [release.id, release]),
  ).values()].sort(
    (left, right) =>
      String(right.releaseDate).localeCompare(String(left.releaseDate)) ||
      left.title.localeCompare(right.title),
  );
  return {
    status: "READY",
    source: "Apple Music",
    artistId: identity.sourceArtistId,
    storefront: identity.sourceStorefront,
    artistName: cleanText(artist?.attributes?.name, 500),
    artistUrl: identity.canonicalUrl,
    checkedAt: new Date().toISOString(),
    releases,
    error: "",
  };
}

export async function handleArtistCatalogRequest(request, response, options = {}) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname !== API_PATH) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  try {
    const payload = await readJsonBody(request, 32_000);
    const catalog = await fetchArtistExplorationCatalog(payload, options);
    sendJson(response, 200, { catalog });
  } catch (error) {
    const safeCodes = new Set([
      "EXACT_APPLE_MUSIC_ARTIST_URL_REQUIRED",
      "APPLE_MUSIC_ARTIST_NOT_FOUND",
      "APPLE_MUSIC_CATALOG_AUTH_UNAVAILABLE",
      "APPLE_MUSIC_CATALOG_INVALID_PAGE",
      "APPLE_MUSIC_CATALOG_UNAVAILABLE",
      "INVALID_JSON",
      "PAYLOAD_TOO_LARGE",
    ]);
    const code = safeCodes.has(error?.code ?? error?.message)
      ? error?.code ?? error?.message
      : "APPLE_MUSIC_CATALOG_UNAVAILABLE";
    sendJson(response, error?.statusCode ?? 502, {
      error: code,
      message:
        error?.safeMessage || "Apple Music 艺人目录暂时无法读取，请稍后重试。",
    });
  }
  return true;
}

export const __test = {
  appleAssetUrls,
  appleGuestToken,
  artworkUrl,
  releaseType,
};
