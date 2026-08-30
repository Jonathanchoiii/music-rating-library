import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getCoverFileLookupDirectories,
  getPrivateCoverDirectory,
  getPrivateCoverRoutePrefix,
  runCoverEnrichment,
} from "./enrich-cover-art.mjs";
import { readJsonBody, sendJson } from "./http-json.mjs";

const CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const COVER_PALETTE_PROXY_PATH = "/api/cover-palette-image";
const MAX_PALETTE_IMAGE_BYTES = 15 * 1024 * 1024;
const TRUSTED_COVER_HOSTS = [
  "archive.org",
  "coverartarchive.org",
  "doubanio.com",
  "mzstatic.com",
  "neodb.social",
  "scdn.co",
  "spotifycdn.com",
];
const PROXIED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

let enrichQueue = Promise.resolve();
let enrichRunning = false;

export function isTrustedCoverPaletteUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return false;
    }
    const hostname = url.hostname.toLocaleLowerCase().replace(/\.$/, "");
    return TRUSTED_COVER_HOSTS.some(
      (trustedHost) =>
        hostname === trustedHost || hostname.endsWith(`.${trustedHost}`),
    );
  } catch {
    return false;
  }
}

function proxiedImageType(response) {
  return String(response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLocaleLowerCase();
}

export async function handleCoverPaletteImageRequest(
  request,
  response,
  options = {},
) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname !== COVER_PALETTE_PROXY_PATH) return false;

  if (!['GET', 'HEAD'].includes(request.method ?? "GET")) {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  const sourceUrl = requestUrl.searchParams.get("url") ?? "";
  if (!isTrustedCoverPaletteUrl(sourceUrl)) {
    sendJson(response, 403, { error: "UNTRUSTED_COVER_URL" });
    return true;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    sendJson(response, 503, { error: "FETCH_UNAVAILABLE" });
    return true;
  }

  let upstream;
  try {
    upstream = await fetchImpl(sourceUrl, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "follow",
    });
  } catch {
    sendJson(response, 502, { error: "COVER_FETCH_FAILED" });
    return true;
  }

  if (!upstream.ok || !isTrustedCoverPaletteUrl(upstream.url || sourceUrl)) {
    sendJson(response, 502, { error: "COVER_FETCH_REJECTED" });
    return true;
  }

  const contentType = proxiedImageType(upstream);
  const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
  if (
    !PROXIED_IMAGE_TYPES.has(contentType) ||
    (declaredLength > 0 && declaredLength > MAX_PALETTE_IMAGE_BYTES)
  ) {
    sendJson(response, 415, { error: "UNSUPPORTED_COVER_RESPONSE" });
    return true;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > MAX_PALETTE_IMAGE_BYTES) {
    sendJson(response, 413, { error: "COVER_TOO_LARGE" });
    return true;
  }

  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", String(body.length));
  response.setHeader("cache-control", "private, max-age=86400");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function safeCoverFileName(pathname) {
  const prefix = `${getPrivateCoverRoutePrefix()}/`;
  if (!pathname.startsWith(prefix)) return null;
  const fileName = decodeURIComponent(pathname.slice(prefix.length));
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    return null;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return null;
  return fileName;
}

async function resolveCoverFilePath(pathname) {
  const fileName = safeCoverFileName(pathname);
  if (!fileName) return { fileName: null, filePath: null };
  const candidates = getCoverFileLookupDirectories().map((directory) =>
    path.join(directory, fileName),
  );
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { fileName, filePath: candidate };
    } catch {
      // try next location
    }
  }
  return { fileName, filePath: null };
}

export async function handlePrivateCoverStatic(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith(`${getPrivateCoverRoutePrefix()}/`)) {
    return false;
  }
  if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
    response.statusCode = 405;
    response.end();
    return true;
  }
  const { fileName, filePath } = await resolveCoverFilePath(url.pathname);
  if (!fileName) {
    response.statusCode = 403;
    response.end();
    return true;
  }
  if (!filePath) {
    response.statusCode = 404;
    response.end();
    return true;
  }
  response.statusCode = 200;
  response.setHeader(
    "content-type",
    CONTENT_TYPES.get(path.extname(filePath).toLocaleLowerCase()) ??
      "application/octet-stream",
  );
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  createReadStream(filePath)
    .on("error", () => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    })
    .pipe(response);
  return true;
}

export async function handleLocalCoverEnrichRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/local-enrich-covers") return false;

  if (request.method === "GET") {
    sendJson(response, 200, {
      running: enrichRunning,
      coverDirectory: "covers",
      routePrefix: getPrivateCoverRoutePrefix(),
    });
    return true;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  let payload = {};
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode ?? 400, {
      error: error.message ?? "INVALID_JSON",
    });
    return true;
  }

  const releaseIds = Array.isArray(payload.releaseIds)
    ? payload.releaseIds.map(String).filter(Boolean).slice(0, 500)
    : null;
  const releases = Array.isArray(payload.releases)
    ? payload.releases
        .filter((release) => release && typeof release === "object")
        .slice(0, 500)
        .map((release) => ({
          id: String(release.id ?? ""),
          title: String(release.title ?? ""),
          artists: Array.isArray(release.artists)
            ? release.artists.map(String).filter(Boolean)
            : [],
          coverUrl: String(release.coverUrl ?? ""),
          coverRemoteUrl: String(release.coverRemoteUrl ?? ""),
          coverSource: String(release.coverSource ?? ""),
          coverMatchedFrom: String(release.coverMatchedFrom ?? ""),
          externalLinks: Array.isArray(release.externalLinks)
            ? release.externalLinks
                .filter((link) => link && typeof link === "object")
                .map((link) => ({
                  provider: String(link.provider ?? ""),
                  url: String(link.url ?? ""),
                  canonicalUrl: String(link.canonicalUrl ?? ""),
                  status: String(link.status ?? ""),
                }))
            : [],
        }))
        .filter((release) => release.id)
    : null;
  const force = Boolean(payload.force);
  const cacheLocal = payload.cacheLocal !== false;
  const limit = Number.isInteger(payload.limit) ? payload.limit : null;
  const wait = Boolean(payload.wait);

  const job = async () => {
    enrichRunning = true;
    try {
      return await runCoverEnrichment({
        force,
        cacheLocal,
        limit,
        concurrency: 4,
        releaseIds: releases?.length ? null : releaseIds,
        libraryReleases: releases?.length ? releases : null,
        coverDirectory: getPrivateCoverDirectory(),
      });
    } finally {
      enrichRunning = false;
    }
  };

  if (wait) {
    try {
      const result = await job();
      sendJson(response, 200, { ...result, started: true, waited: true });
    } catch (error) {
      sendJson(response, 500, {
        error: error.message ?? "COVER_ENRICH_FAILED",
      });
    }
    return true;
  }

  enrichQueue = enrichQueue.catch(() => {}).then(job).catch((error) => {
    console.error("Cover enrichment failed", error);
  });
  sendJson(response, 202, {
    started: true,
    waited: false,
    running: true,
    releaseIds: releaseIds?.length ?? null,
  });
  return true;
}
