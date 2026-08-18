import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, get } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { handleSharedStateRequest } from "../shared-state/index.mjs";
import { handleListeningGuideRequest } from "../listening-guides/index.mjs";
import { handleAppleMusicEditorialRequest } from "../apple-music-notes/index.mjs";
import {
  handleCoverPaletteImageRequest,
  handleLocalCoverEnrichRequest,
  handlePrivateCoverStatic,
} from "../scripts/private-covers-http.mjs";
import {
  handleAppleMotionArtworkRequest,
  handleMotionArtworkFileRequest,
} from "../scripts/apple-motion-artwork.mjs";
import { handleExternalRatingsRequest } from "../external-ratings/index.mjs";
import { handleTracklistRequest } from "../tracklists/index.mjs";
import { handleReleaseMetadataPersistRequest } from "../shared-state/release-metadata.mjs";
import { handleRemotePreviewSyncRequest } from "../remote-preview/local-http.mjs";
import { handleArtistResearchRequest } from "../artist-research/index.mjs";
import { handleAppleArtistLinksRequest } from "../apple-artist-links/index.mjs";

const CLIENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/desktop-client",
);

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function writeResponse(response, status, body = "") {
  response.statusCode = status;
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handleApi(request, response, origin) {
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : await requestBody(request);
  const apiResponse = await worker.fetch(
    new Request(new URL(request.url, origin), {
      method: request.method,
      headers: request.headers,
      body,
    }),
    {},
  );
  response.statusCode = apiResponse.status;
  apiResponse.headers.forEach((value, key) =>
    response.setHeader(key, value),
  );
  response.end(Buffer.from(await apiResponse.arrayBuffer()));
}

async function existingRecordShelf(origin) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = get(
      origin,
      { headers: { accept: "text/html" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 256_000) body += chunk;
        });
        response.on("end", () => {
          finish(
            (response.statusCode ?? 500) < 400 &&
              body.includes("<title>RecordShelf"),
          );
        });
      },
    );
    request.setTimeout(1_500, () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => finish(false));
  });
}

function safeStaticPath(pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const resolved = path.resolve(CLIENT_ROOT, relativePath || "index.html");
  return resolved === CLIENT_ROOT ||
    resolved.startsWith(`${CLIENT_ROOT}${path.sep}`)
    ? resolved
    : null;
}

async function existingFile(filePath) {
  try {
    const details = await stat(filePath);
    return details.isFile();
  } catch {
    return false;
  }
}

async function handleStatic(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    writeResponse(response, 405);
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  let filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    writeResponse(response, 403);
    return;
  }
  if (!(await existingFile(filePath))) {
    if (path.extname(url.pathname)) {
      writeResponse(response, 404);
      return;
    }
    filePath = path.join(CLIENT_ROOT, "index.html");
  }
  response.statusCode = 200;
  response.setHeader(
    "content-type",
    CONTENT_TYPES.get(path.extname(filePath).toLocaleLowerCase()) ??
      "application/octet-stream",
  );
  response.setHeader(
    "cache-control",
    filePath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath)
    .on("error", () => writeResponse(response, 500))
    .pipe(response);
}

export async function startRecordShelfServer(port = 4173, options = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer(async (request, response) => {
    try {
      if (await handlePrivateCoverStatic(request, response)) {
        return;
      }
      if (await handleCoverPaletteImageRequest(request, response, options)) {
        return;
      }
      if (await handleLocalCoverEnrichRequest(request, response)) {
        return;
      }
      if (await handleAppleMotionArtworkRequest(request, response, options)) {
        return;
      }
      if (await handleMotionArtworkFileRequest(request, response, options)) {
        return;
      }
      if (await handleExternalRatingsRequest(request, response, options)) {
        return;
      }
      if (await handleTracklistRequest(request, response, options)) {
        return;
      }
      if (await handleReleaseMetadataPersistRequest(request, response)) {
        return;
      }
      if (await handleRemotePreviewSyncRequest(request, response)) {
        return;
      }
      if (await handleListeningGuideRequest(request, response)) {
        return;
      }
      if (await handleAppleMusicEditorialRequest(request, response)) {
        return;
      }
      if (await handleArtistResearchRequest(request, response, options)) {
        return;
      }
      if (await handleAppleArtistLinksRequest(request, response, options)) {
        return;
      }
      if (await handleSharedStateRequest(request, response)) {
        return;
      }
      if (request.url?.startsWith("/api/")) {
        await handleApi(request, response, origin);
      } else {
        await handleStatic(request, response);
      }
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        response.setHeader("content-type", "application/json");
      }
      writeResponse(
        response,
        500,
        JSON.stringify({ error: "DESKTOP_SERVER_ERROR" }),
      );
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return {
      origin,
      reusedExistingServer: false,
      close: () =>
        new Promise((resolve) => server.close(() => resolve())),
    };
  } catch (error) {
    if (error?.code === "EADDRINUSE" && (await existingRecordShelf(origin))) {
      const occupiedError = new Error(
        `检测到另一个 RecordShelf 正在占用 ${origin}。请先完全退出旧客户端（包括废纸篓里仍在运行的副本），再重新打开当前版本。`,
      );
      occupiedError.code = "RECORDSHELF_ALREADY_RUNNING";
      throw occupiedError;
    }
    throw error;
  }
}
