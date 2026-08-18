import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistReleaseMetadataFields } from "../shared-state/release-metadata.mjs";
import { readJsonBody, sendJson } from "./http-json.mjs";

const DEFAULT_ARTWORK_API = "https://artwork.m8tec.top";
const MOTION_ARTWORK_ROUTE = "/private-motion-artwork";
const ARTIST_STATIC_SIZES = Object.freeze([1400, 1000, 600]);
const ARTIST_FALLBACK_STATIC_SIZE = 600;
const ARTIST_MOTION_KEYS = Object.freeze([
  "motionArtistSquare1x1",
  "motionDetailSquare",
  "motionSquareVideo1x1",
  "motionArtistFullscreen16x9",
  "motionArtistWide16x9",
  "motionDetailTall",
  "motionTallVideo3x4",
]);
const APPLE_HOST_RE = /(^|\.)music\.apple\.com$/i;
const APPLE_MOTION_HOST_RE = /(^|\.)itunes\.apple\.com$/i;
const APPLE_STOREFRONT_RE = /^[a-z]{2}$/i;
const APPLE_WEB_ORIGIN = "https://music.apple.com";
const APPLE_CATALOG_ORIGIN = "https://amp-api.music.apple.com";
const APPLE_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const ALLOWED_RELEASE_STATUSES = new Set(["CONFIRMED", "AUTO_CONFIRMED"]);
const MOTION_ARTWORK_PROFILE_VERSION = 2;
const ARTIST_MOTION_MP4_PROFILE_VERSION = 2;
const ARTIST_MOTION_CROP_Y_BIAS = 0.5;
const ARTIST_MOTION_MAX_BYTES = 8 * 1024 * 1024;
const ARTIST_MOTION_MAX_DURATION_SECONDS = 8;
const ARTIST_MOTION_MIN_DURATION_SECONDS = 1;
const ARTIST_MOTION_DURATION_STEPS = Object.freeze([8, 6, 5, 4, 3, 2, 1]);
const ARTIST_MOTION_MP4_PROFILES = Object.freeze([
  {
    id: "ARTIST_CLEAR_1080_30",
    width: 1080,
    fps: 30,
    durationSeconds: ARTIST_MOTION_MAX_DURATION_SECONDS,
    crf: 18,
    maxBytes: ARTIST_MOTION_MAX_BYTES,
  },
  {
    id: "ARTIST_CLEAR_1080_24",
    width: 1080,
    fps: 24,
    durationSeconds: ARTIST_MOTION_MAX_DURATION_SECONDS,
    crf: 20,
    maxBytes: ARTIST_MOTION_MAX_BYTES,
  },
  {
    id: "ARTIST_CLEAR_960_24",
    width: 960,
    fps: 24,
    durationSeconds: ARTIST_MOTION_MAX_DURATION_SECONDS,
    crf: 21,
    maxBytes: ARTIST_MOTION_MAX_BYTES,
  },
  {
    id: "ARTIST_BALANCED_800_24",
    width: 800,
    fps: 24,
    durationSeconds: ARTIST_MOTION_MAX_DURATION_SECONDS,
    crf: 23,
    maxBytes: ARTIST_MOTION_MAX_BYTES,
  },
]);
const MOTION_ARTWORK_PROFILES = Object.freeze([
  {
    id: "CLEAR_960",
    width: 960,
    fps: 10,
    durationSeconds: 8,
    crf: 30,
    quality: 80,
    maxBytes: 6 * 1024 * 1024,
  },
  {
    id: "BALANCED_800",
    width: 800,
    fps: 10,
    durationSeconds: 8,
    crf: 32,
    quality: 76,
    maxBytes: 6 * 1024 * 1024,
  },
  {
    id: "COMPACT_720",
    width: 720,
    fps: 8,
    durationSeconds: 8,
    crf: 34,
    quality: 72,
    maxBytes: 8 * 1024 * 1024,
  },
]);

function motionCoverCropFilter(profile, yBias = 0.28) {
  const width = profile.width;
  return `fps=${profile.fps},scale=${width}:${width}:force_original_aspect_ratio=increase,crop=${width}:${width}:(iw-${width})/2:(ih-${width})*${yBias},setsar=1`;
}

function normalizeAppleAlbumUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "https:" || !APPLE_HOST_RE.test(url.hostname)) {
      return null;
    }
    const id =
      url.searchParams.get("i") ||
      url.pathname.match(/\/id(\d+)/i)?.[1] ||
      url.pathname.match(/\/album\/(\d+)(?:\/|$)/i)?.[1] ||
      url.pathname.match(/\/(\d+)(?:\/|$)/)?.[1];
    if (!id || !/^\d+$/.test(id)) return null;
    const pathParts = url.pathname.split("/").filter(Boolean);
    const albumIndex = pathParts.findIndex(
      (part) => part.toLocaleLowerCase() === "album",
    );
    const possibleStorefront = albumIndex > 0 ? pathParts[albumIndex - 1] : "";
    const storefront = APPLE_STOREFRONT_RE.test(possibleStorefront)
      ? possibleStorefront.toLocaleLowerCase()
      : null;
    return storefront
      ? `https://music.apple.com/${storefront}/album/${id}`
      : `https://music.apple.com/album/${id}`;
  } catch {
    return null;
  }
}

function appleAlbumIdentity(value) {
  const normalizedUrl = normalizeAppleAlbumUrl(value);
  if (!normalizedUrl) return null;
  const url = new URL(normalizedUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const albumIndex = parts.indexOf("album");
  const albumId = parts[albumIndex + 1];
  const storefront = albumIndex > 0 ? parts[albumIndex - 1] : "us";
  if (!/^\d+$/.test(albumId) || !APPLE_STOREFRONT_RE.test(storefront)) {
    return null;
  }
  return { albumId, storefront: storefront.toLocaleLowerCase(), normalizedUrl };
}

function appleArtistIdentity(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "https:" || !APPLE_HOST_RE.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const artistIndex = parts.findIndex(
      (part) => part.toLocaleLowerCase() === "artist",
    );
    if (artistIndex < 0) return null;
    const artistId = parts.slice(artistIndex + 1).find((part) => /^\d+$/.test(part));
    if (!artistId) return null;
    const possibleStorefront = artistIndex > 0 ? parts[artistIndex - 1] : "";
    const storefront = APPLE_STOREFRONT_RE.test(possibleStorefront)
      ? possibleStorefront.toLocaleLowerCase()
      : "us";
    return {
      storefront,
      artistId,
      normalizedUrl: `https://music.apple.com/${storefront}/artist/${artistId}`,
    };
  } catch {
    return null;
  }
}

function exactAppleLink(release) {
  const link = (release.externalLinks ?? []).find(
    (item) =>
      item?.provider === "APPLE_MUSIC" &&
      ALLOWED_RELEASE_STATUSES.has(item.status),
  );
  return normalizeAppleAlbumUrl(link?.canonicalUrl || link?.url);
}

function looksLikeAppleMotionStill(value) {
  const href = String(value ?? "");
  return (
    /nonvideo|previewimage|preview[_-]?image|\/image\/thumb\//i.test(href) ||
    /\.(webp|png|jpe?g|gif)(?:$|[/?#])/i.test(href)
  );
}

function motionCandidateStrings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const out = [];
  for (const key of ["video", "url", "hlsUrl", "hls", "motionVideo"]) {
    if (typeof value[key] === "string") out.push(value[key]);
    else if (value[key] && typeof value[key] === "object") {
      out.push(...motionCandidateStrings(value[key]));
    }
  }
  return out;
}

function safeMotionUrl(value) {
  if (looksLikeAppleMotionStill(value)) return null;
  try {
    const url = new URL(String(value ?? ""));
    if (
      url.protocol !== "https:" ||
      !APPLE_MOTION_HOST_RE.test(url.hostname) ||
      !url.pathname.toLocaleLowerCase().endsWith(".m3u8")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function playableAppleHlsUrl(value) {
  return safeMotionUrl(value) ?? "";
}

function decodeJwtPayload(token) {
  try {
    const encoded = String(token ?? "").split(".")[1];
    if (!encoded) return null;
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(encoded.length / 4) * 4,
      "=",
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function appleGuestToken(scriptText) {
  const tokens = String(scriptText ?? "").match(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  );
  return (
    tokens?.find((token) => decodeJwtPayload(token)?.iss === "AMPWebPlay") ??
    null
  );
}

function appleAssetUrls(html) {
  const matches = String(html ?? "").matchAll(
    /(?:src|href)=["']([^"']*\/assets\/[^"']+\.js(?:\?[^"']*)?)["']/gi,
  );
  const urls = [];
  for (const match of matches) {
    try {
      const url = new URL(match[1], APPLE_WEB_ORIGIN);
      if (url.origin !== APPLE_WEB_ORIGIN) continue;
      urls.push(url.toString());
    } catch {
      // Ignore malformed asset references from the public page.
    }
  }
  return [...new Set(urls)].sort((left, right) => {
    const priority = (value) =>
      /\/(?:index|web-client|apple-music)[^/]*\.js/i.test(value) ? 0 : 1;
    return priority(left) - priority(right);
  });
}

async function lookupAppleCatalogMotionArtwork(appleMusicUrl, fetchImpl = fetch) {
  const identity = appleAlbumIdentity(appleMusicUrl);
  if (!identity) throw new Error("INVALID_APPLE_MUSIC_ALBUM_URL");
  const commonHeaders = {
    accept: "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
    "user-agent": APPLE_WEB_USER_AGENT,
  };
  const pageResponse = await fetchImpl(identity.normalizedUrl, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(20_000),
  });
  if (!pageResponse.ok) {
    throw new Error(`APPLE_PAGE_HTTP_${pageResponse.status}`);
  }
  const assetUrls = appleAssetUrls(await pageResponse.text()).slice(0, 8);
  let token = null;
  for (const assetUrl of assetUrls) {
    const assetResponse = await fetchImpl(assetUrl, {
      headers: commonHeaders,
      signal: AbortSignal.timeout(20_000),
    });
    if (!assetResponse.ok) continue;
    token = appleGuestToken(await assetResponse.text());
    if (token) break;
  }
  if (!token) throw new Error("APPLE_WEB_TOKEN_NOT_FOUND");

  const catalogUrl = new URL(
    `/v1/catalog/${identity.storefront}/albums/${identity.albumId}`,
    APPLE_CATALOG_ORIGIN,
  );
  catalogUrl.searchParams.set("extend", "editorialVideo");
  catalogUrl.searchParams.set("platform", "web");
  const catalogResponse = await fetchImpl(catalogUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      origin: APPLE_WEB_ORIGIN,
      referer: `${APPLE_WEB_ORIGIN}/`,
      "user-agent": APPLE_WEB_USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!catalogResponse.ok) {
    throw new Error(`APPLE_CATALOG_HTTP_${catalogResponse.status}`);
  }
  const payload = await catalogResponse.json();
  const editorialVideo = payload?.data?.[0]?.attributes?.editorialVideo ?? {};
  const squareUrl = safeMotionUrl(
    editorialVideo.motionDetailSquare?.video ??
      editorialVideo.motionSquareVideo1x1?.video,
  );
  const tallUrl = safeMotionUrl(
    editorialVideo.motionDetailTall?.video ??
      editorialVideo.motionTallVideo3x4?.video,
  );
  return { squareUrl, tallUrl };
}

function appleArtworkUrl(artwork, width = 1400, height = width) {
  const template = String(artwork?.url ?? "");
  if (!template.startsWith("https://")) return "";
  const resolvedWidth = String(Math.max(1, Math.round(Number(width) || 1400)));
  const resolvedHeight = String(
    Math.max(1, Math.round(Number(height) || Number(width) || 1400)),
  );
  return template
    .replace(/\{w\}/g, resolvedWidth)
    .replace(/\{h\}/g, resolvedHeight)
    .replace(/\{c\}/g, "bb")
    .replace(/\{f\}/g, "jpg");
}

function artworkLongEdgeSize(artwork, longEdge) {
  const sourceWidth = Number(artwork?.width) || longEdge;
  const sourceHeight = Number(artwork?.height) || longEdge;
  const sourceLongEdge = Math.max(sourceWidth, sourceHeight, 1);
  const scale = longEdge / sourceLongEdge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function resolvedArtistArtworkUrl(artwork, sizes = ARTIST_STATIC_SIZES) {
  if (!artwork?.url) return "";
  for (const size of sizes) {
    const { width, height } = artworkLongEdgeSize(artwork, size);
    const url = appleArtworkUrl(artwork, width, height);
    if (url) return url;
  }
  return "";
}

function itunesScaledArtworkUrl(value, size = ARTIST_FALLBACK_STATIC_SIZE) {
  const url = String(value ?? "").trim();
  if (!url.startsWith("https://")) return "";
  return url.replace(
    /\/\d+x\d+([a-z]*)(\.[a-z0-9]+)?$/i,
    `/${size}x${size}$1$2`,
  );
}

function firstArtistArtworkUrl(attributes) {
  const editorial = attributes?.editorialArtwork ?? {};
  const candidates = [
    editorial.staticDetailSquare,
    attributes?.artwork,
    editorial.staticDetailTall,
    editorial.centeredFullscreenBackground,
    editorial.subscriptionHero,
    editorial.bannerUber,
    editorial.subscriptionFullScreen,
    editorial.storeFlowcase,
  ];
  for (const artwork of candidates) {
    const url = resolvedArtistArtworkUrl(artwork);
    if (url) return url;
  }
  return "";
}

function findMotionVideo(value) {
  if (typeof value === "string") return safeMotionUrl(value);
  if (!value || typeof value !== "object") return null;
  for (const nested of Object.values(value)) {
    const found = findMotionVideo(nested);
    if (found) return found;
  }
  return null;
}

function findArtistMotionVideo(editorialVideo) {
  const root =
    editorialVideo && typeof editorialVideo === "object" ? editorialVideo : {};
  for (const key of ARTIST_MOTION_KEYS) {
    for (const candidate of motionCandidateStrings(root[key])) {
      const url = safeMotionUrl(candidate);
      if (url) return url;
    }
  }
  return findMotionVideo(root);
}

async function lookupItunesArtistArtwork(identity, fetchImpl = fetch) {
  const lookupUrl = new URL("https://itunes.apple.com/lookup");
  lookupUrl.searchParams.set("id", identity.artistId);
  lookupUrl.searchParams.set("country", identity.storefront);
  try {
    const response = await fetchImpl(lookupUrl, {
      headers: {
        accept: "application/json",
        "user-agent": APPLE_WEB_USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return "";
    const results = (await response.json())?.results;
    const artist = Array.isArray(results)
      ? results.find(
          (item) =>
            String(item?.wrapperType ?? "") === "artist" ||
            String(item?.artistId ?? "") === identity.artistId,
        )
      : null;
    return itunesScaledArtworkUrl(
      artist?.artworkUrl600 || artist?.artworkUrl100,
      ARTIST_FALLBACK_STATIC_SIZE,
    );
  } catch {
    return "";
  }
}

export async function lookupAppleArtistMedia(appleMusicUrl, fetchImpl = fetch) {
  const identity = appleArtistIdentity(appleMusicUrl);
  if (!identity) throw new Error("INVALID_APPLE_MUSIC_ARTIST_URL");
  const commonHeaders = {
    accept: "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
    "user-agent": APPLE_WEB_USER_AGENT,
  };
  const pageResponse = await fetchImpl(identity.normalizedUrl, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(20_000),
  });
  if (!pageResponse.ok) throw new Error(`APPLE_PAGE_HTTP_${pageResponse.status}`);
  const assetUrls = appleAssetUrls(await pageResponse.text()).slice(0, 8);
  let token = null;
  for (const assetUrl of assetUrls) {
    const response = await fetchImpl(assetUrl, {
      headers: commonHeaders,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) continue;
    token = appleGuestToken(await response.text());
    if (token) break;
  }
  if (!token) throw new Error("APPLE_WEB_TOKEN_NOT_FOUND");
  const catalogUrl = new URL(
    `/v1/catalog/${identity.storefront}/artists/${identity.artistId}`,
    APPLE_CATALOG_ORIGIN,
  );
  catalogUrl.searchParams.set("extend", "editorialArtwork,editorialVideo");
  catalogUrl.searchParams.set("platform", "web");
  const catalogResponse = await fetchImpl(catalogUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      origin: APPLE_WEB_ORIGIN,
      referer: `${APPLE_WEB_ORIGIN}/`,
      "user-agent": APPLE_WEB_USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!catalogResponse.ok) throw new Error(`APPLE_CATALOG_HTTP_${catalogResponse.status}`);
  const attributes = (await catalogResponse.json())?.data?.[0]?.attributes ?? {};
  const imageUrl =
    firstArtistArtworkUrl(attributes) ||
    (await lookupItunesArtistArtwork(identity, fetchImpl));
  return {
    imageUrl,
    sourceVideoUrl: findArtistMotionVideo(attributes.editorialVideo) ?? "",
    normalizedUrl: identity.normalizedUrl,
  };
}

async function preferredMotionStreamUrl(sourceUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(sourceUrl, {
      headers: { accept: "application/vnd.apple.mpegurl" },
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return sourceUrl;
    const lines = (await response.text()).split(/\r?\n/);
    const candidates = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const uri = lines[index + 1]?.trim();
      if (!uri || uri.startsWith("#")) continue;
      const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const codecs = line.match(/CODECS="([^"]+)"/i)?.[1] ?? "";
      const width = Number(resolution?.[1] ?? 0);
      const height = Number(resolution?.[2] ?? 0);
      if (!width || !height || !/avc1/i.test(codecs)) continue;
      candidates.push({
        url: new URL(uri, sourceUrl).toString(),
        // Preserve enough source detail for the 960 px clear profile without
        // always pulling Apple's largest (and most expensive) rendition.
        score: Math.abs(Math.max(width, height) - 1080),
      });
    }
    candidates.sort((a, b) => a.score - b.score);
    return safeMotionUrl(candidates[0]?.url) ?? sourceUrl;
  } catch {
    return sourceUrl;
  }
}

function playlistMediaUrl(playlistText, playlistUrl) {
  const lines = String(playlistText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const mapUri = lines
    .find((line) => line.startsWith("#EXT-X-MAP:"))
    ?.match(/URI="([^"]+)"/i)?.[1];
  const segmentUris = lines.filter((line) => !line.startsWith("#"));
  const candidate = mapUri || segmentUris[0];
  if (!candidate) return null;
  try {
    const url = new URL(candidate, playlistUrl);
    if (url.protocol !== "https:" || !APPLE_MOTION_HOST_RE.test(url.hostname)) {
      return null;
    }
    const uniqueSegments = new Set(
      segmentUris.map((value) => new URL(value, playlistUrl).toString()),
    );
    if (uniqueSegments.size > 1) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function transientFetchError(error) {
  return ["AbortError", "TimeoutError", "TypeError"].includes(error?.name);
}

async function fetchWithRetries(url, options, fetchImpl, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return response;
      lastError = new Error(`MOTION_SOURCE_HTTP_${response.status}`);
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (!transientFetchError(error) && !String(error?.message).startsWith("MOTION_SOURCE_HTTP_")) {
        throw error;
      }
    }
  }
  throw new Error(
    transientFetchError(lastError)
      ? "MOTION_CDN_UNREACHABLE"
      : lastError?.message || "MOTION_SOURCE_DOWNLOAD_FAILED",
  );
}

async function downloadMotionSource(sourceUrl, destinationPath, fetchImpl = fetch) {
  let variantUrl;
  let playlist;
  try {
    variantUrl = await preferredMotionStreamUrl(sourceUrl, fetchImpl);
    const playlistResponse = await fetchWithRetries(
      variantUrl,
      {
        headers: {
          accept: "application/vnd.apple.mpegurl",
          "user-agent": "Mozilla/5.0 AppleWebKit/537.36 RecordShelf/1",
        },
      },
      fetchImpl,
    );
    playlist = await playlistResponse.text();
  } catch (error) {
    if (String(error?.message).startsWith("MOTION_")) throw error;
    throw new Error("MOTION_CDN_UNREACHABLE");
  }
  const mediaUrl = playlistMediaUrl(playlist, variantUrl);
  if (!mediaUrl) throw new Error("MOTION_PLAYLIST_UNSUPPORTED");
  let response;
  try {
    response = await fetchWithRetries(
      mediaUrl,
      {
        headers: {
          accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
          "user-agent": "Mozilla/5.0 AppleWebKit/537.36 RecordShelf/1",
        },
      },
      fetchImpl,
    );
  } catch (error) {
    if (String(error?.message).startsWith("MOTION_")) throw error;
    throw new Error("MOTION_CDN_UNREACHABLE");
  }
  if (!response.body) throw new Error("MOTION_SOURCE_DOWNLOAD_FAILED");
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of response.body) {
    byteLength += chunk.length;
    if (byteLength > 32 * 1024 * 1024) {
      throw new Error("MOTION_SOURCE_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (!byteLength) throw new Error("MOTION_SOURCE_DOWNLOAD_FAILED");
  await fs.writeFile(destinationPath, Buffer.concat(chunks), { mode: 0o600 });
  return { byteLength, mediaUrl, variantUrl };
}

function artworkApiBase() {
  const configured = String(
    process.env.RECORDSHELF_MOTION_ARTWORK_API ?? DEFAULT_ARTWORK_API,
  ).trim();
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return DEFAULT_ARTWORK_API;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_ARTWORK_API;
  }
}

async function lookupMotionArtwork(release, fetchImpl = fetch) {
  const appleMusicUrl = exactAppleLink(release);
  if (!appleMusicUrl) {
    return { id: release.id, skipped: true, reason: "NO_EXACT_APPLE_LINK" };
  }
  let squareUrl;
  let tallUrl;
  let lookupProvider = "APPLE_MUSIC_PUBLIC_CATALOG";
  try {
    ({ squareUrl, tallUrl } = await lookupAppleCatalogMotionArtwork(
      appleMusicUrl,
      fetchImpl,
    ));
  } catch (appleError) {
    // The open-source adapter is a compatibility fallback for temporary
    // changes in Apple's web client. Keep the storefront in the input URL.
    const requestUrl = new URL("/api/v1/artwork/url", artworkApiBase());
    requestUrl.searchParams.set("url", appleMusicUrl);
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
    } catch (adapterError) {
      throw new Error(
        adapterError?.name === "TimeoutError"
          ? "LOOKUP_TIMEOUT"
          : "MOTION_LOOKUP_UNREACHABLE",
      );
    }
    if (!response.ok) {
      throw new Error(`MOTION_LOOKUP_HTTP_${response.status}`);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      throw new Error("MOTION_LOOKUP_INVALID_RESPONSE");
    }
    squareUrl = safeMotionUrl(payload.url);
    tallUrl = safeMotionUrl(payload.url_tall);
    lookupProvider = "APPLE_MUSIC_OPEN_SOURCE_ADAPTER";
  }
  const checkedAt = new Date().toISOString();
  return {
    id: release.id,
    motionArtwork: {
      status: squareUrl || tallUrl ? "AVAILABLE" : "UNAVAILABLE",
      provider: lookupProvider,
      sourceAlbumUrl: appleMusicUrl,
      squareUrl,
      tallUrl,
      checkedAt,
      storage: "REMOTE_HLS",
    },
  };
}

async function persistMotionArtwork(releaseId, motionArtwork) {
  const { previousRelease, nextRelease } = await persistReleaseMetadataFields(
    releaseId,
    { motionArtwork },
  );
  const previousLocalUrl = previousRelease.motionArtwork?.localUrl;
  const mergedMotionArtwork = nextRelease.motionArtwork ?? {
    ...(previousRelease.motionArtwork ?? {}),
    ...motionArtwork,
  };
  if (
    motionArtwork.localUrl &&
    previousLocalUrl &&
    previousLocalUrl !== motionArtwork.localUrl &&
    previousLocalUrl.startsWith(`${MOTION_ARTWORK_ROUTE}/`)
  ) {
    const previousFileName = path.basename(previousLocalUrl);
    if (/^[a-zA-Z0-9._-]+\.webp$/.test(previousFileName)) {
      await fs
        .rm(path.join(motionArtworkDirectory(), previousFileName), {
          force: true,
        })
        .catch(() => {});
    }
  }
  return mergedMotionArtwork;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await mapper(items[index]);
        } catch (error) {
          const message = String(error?.message ?? "LOOKUP_FAILED");
          results[index] = {
            id: items[index].id,
            error:
              error?.name === "TimeoutError"
                ? "LOOKUP_TIMEOUT"
                : /^[A-Z][A-Z0-9_]*(?:_\d{3})?$/.test(message)
                  ? message
                  : "LOOKUP_FAILED",
          };
        }
      }
    }),
  );
  return results;
}

export async function handleAppleMotionArtworkRequest(
  request,
  response,
  { fetchImpl = fetch } = {},
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/apple-motion-artwork") return false;

  if (request.method === "GET") {
    sendJson(response, 200, {
      available: true,
      maxBatchSize: 1,
      sends: "CONFIRMED_APPLE_MUSIC_ALBUM_URL_ONLY",
    });
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  try {
    const payload = await readJsonBody(request);
    const releases = (Array.isArray(payload.releases) ? payload.releases : [])
      .filter((release) => release && typeof release === "object" && release.id)
      .slice(0, 1)
      .map((release) => ({
        id: String(release.id),
        externalLinks: Array.isArray(release.externalLinks)
          ? release.externalLinks.map((link) => ({
              provider: String(link?.provider ?? ""),
              url: String(link?.url ?? ""),
              canonicalUrl: String(link?.canonicalUrl ?? ""),
              status: String(link?.status ?? ""),
            }))
          : [],
      }));
    if (!releases.length) {
      sendJson(response, 400, { error: "NO_RELEASES" });
      return true;
    }
    const results = await mapWithConcurrency(releases, 2, (release) =>
      lookupMotionArtwork(release, fetchImpl),
    );
    const updates = results.filter((result) => result.motionArtwork);
    const failedResult = results.find((result) => result.error);
    if (failedResult && updates.length === 0) {
      sendJson(response, 502, { error: failedResult.error });
      return true;
    }
    for (const update of updates) {
      update.motionArtwork = await persistMotionArtwork(
        update.id,
        update.motionArtwork,
      );
    }
    sendJson(response, 200, {
      checked: releases.length,
      available: updates.filter(
        (update) => update.motionArtwork.status === "AVAILABLE",
      ).length,
      unavailable: updates.filter(
        (update) => update.motionArtwork.status === "UNAVAILABLE",
      ).length,
      failed: results.filter((result) => result.error).length,
      updates,
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "INVALID_REQUEST" });
  }
  return true;
}

function safeReleaseId(value) {
  const id = String(value ?? "").trim();
  return /^[a-zA-Z0-9._-]{1,180}$/.test(id) ? id : null;
}

function safeArtistMotionId(artistId) {
  const raw = String(artistId ?? "").trim();
  if (!raw) return null;
  const slug = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  const digest = createHash("sha1").update(raw).digest("hex").slice(0, 10);
  const cacheId = slug === raw ? slug : `${slug || "id"}-${digest}`;
  return safeReleaseId(`artist-${cacheId}`.slice(0, 180));
}

function motionArtworkDirectory() {
  if (process.env.RECORDSHELF_MOTION_ARTWORK_DIR) {
    return path.resolve(process.env.RECORDSHELF_MOTION_ARTWORK_DIR);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "motion-artwork",
  );
}

function motionRuntimeDirectory() {
  return path.join(
    path.dirname(motionArtworkDirectory()),
    "motion-runtime",
    "ffmpeg-installer",
  );
}

const FFMPEG_RUNTIME_PACKAGES = {
  arm64: {
    version: "4.1.5",
    url: "https://registry.npmjs.org/@ffmpeg-installer/darwin-arm64/-/darwin-arm64-4.1.5.tgz",
    integrity:
      "hYqTiP63mXz7wSQfuqfFwfLOfwwFChUedeCVKkBtl/cliaTM7/ePI9bVzfZ2c+dWu3TqCwLDRWNSJ5pqZl8otA==",
    maxBytes: 40 * 1024 * 1024,
  },
  x64: {
    version: "4.1.0",
    url: "https://registry.npmjs.org/@ffmpeg-installer/darwin-x64/-/darwin-x64-4.1.0.tgz",
    integrity:
      "Z4EyG3cIFjdhlY8wI9aLUXuH8nVt7E9SlMVZtWvSPnm2sm37/yC2CwjUzyCQbJbySnef1tQwGG2Sx+uWhd9IAw==",
    maxBytes: 75 * 1024 * 1024,
  },
};

async function runCommand(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error("FFMPEG_TIMEOUT"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 24_000) errorText += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFMPEG_FAILED:${errorText.slice(-2000)}`));
    });
  });
}

async function ensureFfmpegBinary() {
  if (process.platform !== "darwin") {
    throw new Error("UNSUPPORTED_MOTION_ARTWORK_PLATFORM");
  }
  const descriptor = FFMPEG_RUNTIME_PACKAGES[process.arch];
  if (!descriptor) throw new Error("UNSUPPORTED_MOTION_ARTWORK_ARCH");
  const directory = motionRuntimeDirectory();
  const filePath = path.join(
    directory,
    `${process.arch}-${descriptor.version}`,
    "ffmpeg",
  );
  try {
    const details = await fs.stat(filePath);
    if (details.isFile() && details.size > 0) return filePath;
  } catch {}
  const versionDirectory = path.dirname(filePath);
  await fs.mkdir(versionDirectory, { recursive: true });
  const upstream = await fetch(descriptor.url, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error("MOTION_RUNTIME_DOWNLOAD_FAILED");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > descriptor.maxBytes) {
      throw new Error("MOTION_RUNTIME_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  const digest = createHash("sha512").update(archive).digest("base64");
  if (digest !== descriptor.integrity) {
    throw new Error("MOTION_RUNTIME_INTEGRITY_FAILED");
  }
  const archivePath = path.join(
    versionDirectory,
    `runtime-${process.pid}-${Date.now()}.tgz`,
  );
  const extractDirectory = path.join(
    versionDirectory,
    `extract-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(archivePath, archive, { mode: 0o600 });
  await fs.mkdir(extractDirectory);
  try {
    await runCommand("/usr/bin/tar", ["-xzf", archivePath, "-C", extractDirectory]);
    await fs.rename(path.join(extractDirectory, "package", "ffmpeg"), filePath);
    await fs.chmod(filePath, 0o700);
  } finally {
    await fs.rm(archivePath, { force: true });
    await fs.rm(extractDirectory, { recursive: true, force: true });
  }
  return filePath;
}

function writeUint24LE(buffer, value, offset) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
}

function webpChunk(fourCC, payload) {
  const padding = payload.length % 2;
  const chunk = Buffer.alloc(8 + payload.length + padding);
  chunk.write(fourCC, 0, 4, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function readIvfFrames(ivf) {
  if (ivf.length < 32 || ivf.subarray(0, 4).toString("ascii") !== "DKIF") {
    throw new Error("INVALID_MOTION_ARTWORK_STREAM");
  }
  const frames = [];
  let offset = 32;
  while (offset + 12 <= ivf.length) {
    const frameSize = ivf.readUInt32LE(offset);
    offset += 12;
    if (!frameSize || offset + frameSize > ivf.length) {
      throw new Error("INVALID_MOTION_ARTWORK_STREAM");
    }
    frames.push(ivf.subarray(offset, offset + frameSize));
    offset += frameSize;
  }
  if (!frames.length || offset !== ivf.length) {
    throw new Error("INVALID_MOTION_ARTWORK_STREAM");
  }
  return frames;
}

function createAnimatedWebpFromIvf(ivf, width, height, frameDurationMs) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  writeUint24LE(vp8x, width - 1, 4);
  writeUint24LE(vp8x, height - 1, 7);
  const animation = Buffer.alloc(6);
  animation.writeUInt16LE(0, 4);
  const frameChunks = readIvfFrames(ivf).map((frame) => {
    const frameHeader = Buffer.alloc(16);
    writeUint24LE(frameHeader, width - 1, 6);
    writeUint24LE(frameHeader, height - 1, 9);
    writeUint24LE(frameHeader, frameDurationMs, 12);
    return webpChunk(
      "ANMF",
      Buffer.concat([frameHeader, webpChunk("VP8 ", frame)]),
    );
  });
  const payload = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    webpChunk("VP8X", vp8x),
    webpChunk("ANIM", animation),
    ...frameChunks,
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}

async function cacheMotionArtworkFile(cacheId, sourceUrl, fetchImpl = fetch) {
  const ffmpeg = await ensureFfmpegBinary();
  await fs.mkdir(motionArtworkDirectory(), { recursive: true });
  const fileName = `${cacheId}-${Date.now()}.webp`;
  const filePath = path.join(motionArtworkDirectory(), fileName);
  const ivfPath = `${filePath}.${process.pid}.tmp.ivf`;
  const temporaryPath = `${filePath}.${process.pid}.tmp.webp`;
  const sourcePath = `${filePath}.${process.pid}.tmp.mp4`;
  try {
    await downloadMotionSource(sourceUrl, sourcePath, fetchImpl);
    let selected = null;
    for (const profile of MOTION_ARTWORK_PROFILES) {
      await fs.rm(ivfPath, { force: true });
      await runCommand(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        "15000000",
        "-t",
        String(profile.durationSeconds),
        "-i",
        sourcePath,
        "-an",
        "-vf",
        motionCoverCropFilter(profile),
        "-c:v",
        "libvpx",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "1",
        "-keyint_min",
        "1",
        "-deadline",
        "good",
        "-cpu-used",
        "3",
        "-crf",
        String(profile.crf),
        "-b:v",
        "0",
        "-f",
        "ivf",
        "-y",
        ivfPath,
      ], 180_000);
      const webp = createAnimatedWebpFromIvf(
        await fs.readFile(ivfPath),
        profile.width,
        profile.width,
        Math.round(1000 / profile.fps),
      );
      if (webp.length <= profile.maxBytes) {
        selected = { profile, webp };
        break;
      }
    }
    if (!selected) throw new Error("MOTION_ARTWORK_TOO_LARGE");
    await fs.writeFile(temporaryPath, selected.webp, { mode: 0o600 });
    const details = await fs.stat(temporaryPath);
    if (!details.size || details.size > 8 * 1024 * 1024) {
      throw new Error(
        details.size ? "MOTION_ARTWORK_TOO_LARGE" : "EMPTY_MOTION_ARTWORK_FILE",
      );
    }
    await fs.rename(temporaryPath, filePath);
    const motionArtwork = {
      status: "AVAILABLE",
      sourceUrl,
      localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`,
      format: "WEBP",
      byteLength: details.size,
      width: selected.profile.width,
      fps: selected.profile.fps,
      quality: selected.profile.quality,
      durationSeconds: selected.profile.durationSeconds,
      compressionProfile: selected.profile.id,
      profileVersion: MOTION_ARTWORK_PROFILE_VERSION,
      cachedAt: new Date().toISOString(),
      storage: "LOCAL_WEBP",
    };
    return { localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`, motionArtwork };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await fs.rm(ivfPath, { force: true });
    await fs.rm(sourcePath, { force: true });
  }
}

async function convertMotionArtwork(releaseId, sourceUrl, fetchImpl = fetch) {
  const converted = await cacheMotionArtworkFile(releaseId, sourceUrl, fetchImpl);
  converted.motionArtwork = await persistMotionArtwork(releaseId, converted.motionArtwork);
  return converted;
}

function nextArtistMotionDuration(
  currentSeconds,
  encodedBytes,
  maxBytes = ARTIST_MOTION_MAX_BYTES,
) {
  const current = Number(currentSeconds);
  const bytes = Number(encodedBytes);
  if (
    !Number.isFinite(current) ||
    current <= ARTIST_MOTION_MIN_DURATION_SECONDS
  ) {
    return null;
  }
  if (!Number.isFinite(bytes) || bytes <= maxBytes) return null;
  const estimated = ((current * maxBytes) / bytes) * 0.92;
  const shorter = ARTIST_MOTION_DURATION_STEPS.filter((step) => step < current);
  if (!shorter.length) return null;
  return shorter.find((step) => step <= estimated) ?? shorter.at(-1);
}

function artistMotionFfmpegArgs(
  sourcePath,
  outputPath,
  profile,
  durationSeconds,
  { forceByteCap = false } = {},
) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-rw_timeout",
    "15000000",
    "-t",
    String(durationSeconds),
    "-i",
    sourcePath,
    "-an",
    "-vf",
    motionCoverCropFilter(profile, ARTIST_MOTION_CROP_Y_BIAS),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "fast",
  ];
  if (forceByteCap) {
    const maxrate = Math.max(
      250_000,
      Math.floor((ARTIST_MOTION_MAX_BYTES * 8 * 0.72) / durationSeconds),
    );
    args.push("-maxrate", String(maxrate), "-bufsize", String(maxrate * 2));
  }
  args.push(
    "-crf",
    String(forceByteCap ? Math.max(profile.crf, 28) : profile.crf),
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  );
  return args;
}

async function encodeArtistMotionMp4({
  ffmpeg,
  sourcePath,
  temporaryPath,
  profile,
  durationSeconds,
  forceByteCap = false,
  encodeImpl,
}) {
  if (encodeImpl) {
    await encodeImpl({
      profile,
      durationSeconds,
      outputPath: temporaryPath,
      forceByteCap,
    });
    return;
  }
  await runCommand(
    ffmpeg,
    artistMotionFfmpegArgs(sourcePath, temporaryPath, profile, durationSeconds, {
      forceByteCap,
    }),
    180_000,
  );
}

async function cacheArtistMotionMp4File(
  cacheId,
  sourceUrl,
  fetchImpl = fetch,
  options = {},
) {
  await fs.mkdir(motionArtworkDirectory(), { recursive: true });
  const fileName = `${cacheId}-${Date.now()}.mp4`;
  const filePath = path.join(motionArtworkDirectory(), fileName);
  const temporaryPath = `${filePath}.${process.pid}.tmp.mp4`;
  const sourcePath = options.sourcePath ?? `${filePath}.${process.pid}.tmp.src`;
  const ownsSourcePath = !options.sourcePath;
  try {
    if (ownsSourcePath) {
      await downloadMotionSource(sourceUrl, sourcePath, fetchImpl);
    }
    const ffmpeg = options.encodeImpl ? "" : await ensureFfmpegBinary();
    let selected = null;
    let lastError = null;
    for (const profile of ARTIST_MOTION_MP4_PROFILES) {
      let durationSeconds = ARTIST_MOTION_MAX_DURATION_SECONDS;
      while (durationSeconds != null) {
        await fs.rm(temporaryPath, { force: true });
        try {
          await encodeArtistMotionMp4({
            ffmpeg,
            sourcePath,
            temporaryPath,
            profile,
            durationSeconds,
            encodeImpl: options.encodeImpl,
          });
          const details = await fs.stat(temporaryPath);
          if (!details.size) throw new Error("EMPTY_MOTION_ARTWORK_FILE");
          if (details.size <= ARTIST_MOTION_MAX_BYTES) {
            selected = {
              profile,
              size: details.size,
              durationSeconds,
              truncated: durationSeconds < ARTIST_MOTION_MAX_DURATION_SECONDS,
            };
            break;
          }
          durationSeconds = nextArtistMotionDuration(
            durationSeconds,
            details.size,
          );
        } catch (error) {
          lastError = error;
          durationSeconds =
            ARTIST_MOTION_DURATION_STEPS.find((step) => step < durationSeconds) ??
            null;
        }
      }
      if (selected) break;
    }
    if (!selected) {
      const profile = ARTIST_MOTION_MP4_PROFILES.at(-1);
      await fs.rm(temporaryPath, { force: true });
      try {
        await encodeArtistMotionMp4({
          ffmpeg,
          sourcePath,
          temporaryPath,
          profile,
          durationSeconds: ARTIST_MOTION_MIN_DURATION_SECONDS,
          forceByteCap: true,
          encodeImpl: options.encodeImpl,
        });
        const details = await fs.stat(temporaryPath);
        if (!details.size) throw new Error("EMPTY_MOTION_ARTWORK_FILE");
        if (details.size > ARTIST_MOTION_MAX_BYTES) {
          throw new Error("MOTION_ARTWORK_TOO_LARGE");
        }
        selected = {
          profile,
          size: details.size,
          durationSeconds: ARTIST_MOTION_MIN_DURATION_SECONDS,
          truncated: true,
        };
      } catch (error) {
        throw lastError ?? error;
      }
    }
    await fs.rename(temporaryPath, filePath);
    const motionArtwork = {
      status: "AVAILABLE",
      sourceUrl,
      localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`,
      format: "MP4",
      byteLength: selected.size,
      width: selected.profile.width,
      fps: selected.profile.fps,
      quality: selected.profile.crf,
      durationSeconds: selected.durationSeconds,
      truncated: selected.truncated === true,
      compressionProfile: selected.profile.id,
      profileVersion: ARTIST_MOTION_MP4_PROFILE_VERSION,
      cachedAt: new Date().toISOString(),
      storage: "LOCAL_MP4",
    };
    return { localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`, motionArtwork };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  } finally {
    if (ownsSourcePath) await fs.rm(sourcePath, { force: true });
  }
}

export async function cacheArtistMotionArtwork(
  artistId,
  sourceUrl,
  fetchImpl = fetch,
  options = {},
) {
  const safeId = safeArtistMotionId(artistId);
  const safeSource = safeMotionUrl(sourceUrl);
  if (!safeSource) throw new Error("INVALID_ARTIST_MOTION_SOURCE");
  if (!safeId) throw new Error("INVALID_ARTIST_MOTION_ID");
  return cacheArtistMotionMp4File(safeId, safeSource, fetchImpl, options);
}

export async function handleMotionArtworkFileRequest(
  request,
  response,
  { fetchImpl = fetch } = {},
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/apple-motion-artwork/convert") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    try {
      const payload = await readJsonBody(request, 64_000);
      const releaseId = safeReleaseId(payload.releaseId);
      const sourceUrl = safeMotionUrl(payload.sourceUrl);
      if (!releaseId || !sourceUrl) {
        sendJson(response, 400, { error: "INVALID_MOTION_ARTWORK_REQUEST" });
        return true;
      }
      sendJson(
        response,
        200,
        await convertMotionArtwork(releaseId, sourceUrl, fetchImpl),
      );
    } catch (error) {
      const message = String(
        error?.message ?? "MOTION_ARTWORK_CONVERSION_FAILED",
      );
      sendJson(response, 500, {
        error: message.split(":")[0],
        detail: message.startsWith("FFMPEG_FAILED:")
          ? message.slice("FFMPEG_FAILED:".length, 1000)
          : undefined,
      });
    }
    return true;
  }
  if (url.pathname.startsWith(`${MOTION_ARTWORK_ROUTE}/`)) {
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      response.statusCode = 405;
      response.end();
      return true;
    }
    const fileName = decodeURIComponent(
      url.pathname.slice(MOTION_ARTWORK_ROUTE.length + 1),
    );
    if (!/^[a-zA-Z0-9._-]+\.(webp|mp4)$/.test(fileName)) {
      response.statusCode = 403;
      response.end();
      return true;
    }
    const filePath = path.join(motionArtworkDirectory(), fileName);
    try {
      const details = await fs.stat(filePath);
      response.statusCode = 200;
      response.setHeader(
        "content-type",
        fileName.toLowerCase().endsWith(".mp4") ? "video/mp4" : "image/webp",
      );
      response.setHeader("content-length", String(details.size));
      response.setHeader("cache-control", "private, max-age=31536000, immutable");
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end();
    }
    return true;
  }
  if (url.pathname !== "/api/apple-motion-artwork/file") return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const releaseId = safeReleaseId(request.headers["x-recordshelf-release-id"]);
  const sourceUrl = safeMotionUrl(request.headers["x-recordshelf-source-url"]);
  const contentType = String(request.headers["content-type"] ?? "").split(";")[0];
  if (!releaseId || !sourceUrl || contentType !== "image/webp") {
    sendJson(response, 400, { error: "INVALID_MOTION_ARTWORK_FILE" });
    return true;
  }
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > 16 * 1024 * 1024) {
      sendJson(response, 413, { error: "MOTION_ARTWORK_TOO_LARGE" });
      return true;
    }
    chunks.push(chunk);
  }
  if (!byteLength) {
    sendJson(response, 400, { error: "EMPTY_MOTION_ARTWORK_FILE" });
    return true;
  }
  const fileBuffer = Buffer.concat(chunks);
  if (
    fileBuffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    fileBuffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    sendJson(response, 400, { error: "INVALID_WEBP_FILE" });
    return true;
  }
  await fs.mkdir(motionArtworkDirectory(), { recursive: true });
  const fileName = `${releaseId}-${Date.now()}.webp`;
  const filePath = path.join(motionArtworkDirectory(), fileName);
  const temporaryPath = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, fileBuffer, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  const motionArtwork = await persistMotionArtwork(releaseId, {
    status: "AVAILABLE",
    sourceUrl,
    localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`,
    format: "WEBP",
    byteLength,
    width: 720,
    fps: 15,
    quality: 72,
    cachedAt: new Date().toISOString(),
    storage: "LOCAL_WEBP",
  });
  sendJson(response, 200, {
    localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`,
    byteLength,
    motionArtwork,
  });
  return true;
}

export const __test = {
  FFMPEG_RUNTIME_PACKAGES,
  MOTION_ARTWORK_PROFILES,
  MOTION_ARTWORK_PROFILE_VERSION,
  ARTIST_MOTION_MP4_PROFILES,
  ARTIST_MOTION_MP4_PROFILE_VERSION,
  ARTIST_MOTION_CROP_Y_BIAS,
  ARTIST_MOTION_MAX_BYTES,
  ARTIST_MOTION_DURATION_STEPS,
  ARTIST_MOTION_MAX_DURATION_SECONDS,
  artistMotionFfmpegArgs,
  cacheArtistMotionMp4File,
  nextArtistMotionDuration,
  createAnimatedWebpFromIvf,
  downloadMotionSource,
  playlistMediaUrl,
  preferredMotionStreamUrl,
  exactAppleLink,
  appleAlbumIdentity,
  appleArtistIdentity,
  appleArtworkUrl,
  firstArtistArtworkUrl,
  appleAssetUrls,
  appleGuestToken,
  findArtistMotionVideo,
  motionCoverCropFilter,
  itunesScaledArtworkUrl,
  lookupAppleArtistMedia,
  looksLikeAppleMotionStill,
  lookupAppleCatalogMotionArtwork,
  lookupMotionArtwork,
  normalizeAppleAlbumUrl,
  persistMotionArtwork,
  playableAppleHlsUrl,
  safeArtistMotionId,
  safeMotionUrl,
  cacheArtistMotionArtwork,
};
