import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getBundledPrivateCoverDirectory,
  getPrivateCoverDirectory,
  getPrivateCoverRoutePrefix,
  runCoverEnrichment,
} from "./enrich-cover-art.mjs";

const CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

let enrichQueue = Promise.resolve();
let enrichRunning = false;

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("PAYLOAD_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("INVALID_JSON");
    error.statusCode = 400;
    throw error;
  }
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
  const candidates = [
    path.join(getPrivateCoverDirectory(), fileName),
    getBundledPrivateCoverDirectory()
      ? path.join(getBundledPrivateCoverDirectory(), fileName)
      : null,
  ].filter(Boolean);
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
        releaseIds,
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
