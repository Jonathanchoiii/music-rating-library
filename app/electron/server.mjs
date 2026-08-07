import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { handleSharedStateRequest } from "../shared-state/index.mjs";
import {
  handleLocalCoverEnrichRequest,
  handlePrivateCoverStatic,
} from "../scripts/private-covers-http.mjs";

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
  try {
    const response = await fetch(origin, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok && (await response.text()).includes("<title>RecordShelf");
  } catch {
    return false;
  }
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

export async function startRecordShelfServer(port = 4173) {
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer(async (request, response) => {
    try {
      if (await handlePrivateCoverStatic(request, response)) {
        return;
      }
      if (await handleLocalCoverEnrichRequest(request, response)) {
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
      return {
        origin,
        reusedExistingServer: true,
        close: async () => {},
      };
    }
    throw error;
  }
}
