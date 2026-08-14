import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applySharedStateChanges,
  readSharedState,
} from "../shared-state/index.mjs";
import { USER_STATE_KEY } from "../src/lib/sharedStorageKeys.js";
import { readJsonBody, sendJson } from "./http-json.mjs";

const DEFAULT_ARTWORK_API = "https://artwork.m8tec.top";
const MOTION_ARTWORK_ROUTE = "/private-motion-artwork";
const APPLE_HOST_RE = /(^|\.)music\.apple\.com$/i;
const APPLE_MOTION_HOST_RE = /(^|\.)itunes\.apple\.com$/i;
const ALLOWED_RELEASE_STATUSES = new Set(["CONFIRMED", "AUTO_CONFIRMED"]);
const MOTION_ARTWORK_PROFILE_VERSION = 2;
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
    return `https://music.apple.com/album/${id}`;
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

function safeMotionUrl(value) {
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
  const requestUrl = new URL("/api/v1/artwork/url", artworkApiBase());
  requestUrl.searchParams.set("url", appleMusicUrl);
  const response = await fetchImpl(requestUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  const squareUrl = safeMotionUrl(payload.url);
  const tallUrl = safeMotionUrl(payload.url_tall);
  const checkedAt = new Date().toISOString();
  return {
    id: release.id,
    motionArtwork: {
      status: squareUrl || tallUrl ? "AVAILABLE" : "UNAVAILABLE",
      provider: "APPLE_MUSIC_UNDOCUMENTED",
      sourceAlbumUrl: appleMusicUrl,
      squareUrl,
      tallUrl,
      checkedAt,
      storage: "REMOTE_HLS",
    },
  };
}

async function persistMotionArtwork(releaseId, motionArtwork) {
  const shared = await readSharedState();
  const previousText = shared.storage?.[USER_STATE_KEY] ?? null;
  let userState = {};
  try {
    userState = previousText ? JSON.parse(previousText) : {};
  } catch {
    userState = {};
  }
  const previousOverrides = userState.releaseMetadataOverrides ?? {};
  const userReleaseIndex = (userState.userReleases ?? []).findIndex(
    (release) => release?.id === releaseId,
  );
  const previousRelease =
    userReleaseIndex >= 0
      ? userState.userReleases[userReleaseIndex]
      : previousOverrides[releaseId] ?? {};
  const previousLocalUrl = previousRelease.motionArtwork?.localUrl;
  const mergedMotionArtwork = {
    ...(previousRelease.motionArtwork ?? {}),
    ...motionArtwork,
  };
  const nextState = { ...userState };
  if (userReleaseIndex >= 0) {
    nextState.userReleases = [...userState.userReleases];
    nextState.userReleases[userReleaseIndex] = {
      ...previousRelease,
      motionArtwork: mergedMotionArtwork,
    };
  } else {
    nextState.releaseMetadataOverrides = {
      ...previousOverrides,
      [releaseId]: {
        ...previousRelease,
        motionArtwork: mergedMotionArtwork,
      },
    };
  }
  await applySharedStateChanges(
    { [USER_STATE_KEY]: JSON.stringify(nextState) },
    undefined,
    { baseStorage: { [USER_STATE_KEY]: previousText } },
  );
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
          results[index] = {
            id: items[index].id,
            error: error?.name === "TimeoutError" ? "LOOKUP_TIMEOUT" : "LOOKUP_FAILED",
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

async function convertMotionArtwork(releaseId, sourceUrl, fetchImpl = fetch) {
  const ffmpeg = await ensureFfmpegBinary();
  await fs.mkdir(motionArtworkDirectory(), { recursive: true });
  const fileName = `${releaseId}-${Date.now()}.webp`;
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
        `fps=${profile.fps},scale=${profile.width}:${profile.width}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.width}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
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
    const motionArtwork = await persistMotionArtwork(releaseId, {
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
    });
    return { localUrl: `${MOTION_ARTWORK_ROUTE}/${fileName}`, motionArtwork };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await fs.rm(ivfPath, { force: true });
    await fs.rm(sourcePath, { force: true });
  }
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
    if (!/^[a-zA-Z0-9._-]+\.webp$/.test(fileName)) {
      response.statusCode = 403;
      response.end();
      return true;
    }
    const filePath = path.join(motionArtworkDirectory(), fileName);
    try {
      const details = await fs.stat(filePath);
      response.statusCode = 200;
      response.setHeader("content-type", "image/webp");
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
  createAnimatedWebpFromIvf,
  downloadMotionSource,
  playlistMediaUrl,
  preferredMotionStreamUrl,
  exactAppleLink,
  normalizeAppleAlbumUrl,
  persistMotionArtwork,
  safeMotionUrl,
};
