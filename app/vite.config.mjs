import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import {
  verifyArtistIdentities,
  verifyReleaseTypes,
} from "./worker/index.js";
import { handleSharedStateRequest } from "./shared-state/index.mjs";

const VIRTUAL_LIBRARY_ID = "virtual:recordshelf-library";
const RESOLVED_VIRTUAL_LIBRARY_ID = `\0${VIRTUAL_LIBRARY_ID}`;
const PRIVATE_LIBRARY_PATH = path.resolve(
  import.meta.dirname,
  ".private/neodb-library.local.json",
);
const INCLUDE_PRIVATE_DESKTOP_LIBRARY =
  process.env.RECORDSHELF_LOCAL_DESKTOP === "1";

function privacySafeLibrary(command) {
  return {
    name: "recordshelf-privacy-safe-library",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL_LIBRARY_ID ? RESOLVED_VIRTUAL_LIBRARY_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_LIBRARY_ID) return null;
      if (command !== "serve" && !INCLUDE_PRIVATE_DESKTOP_LIBRARY) {
        return "export default [];";
      }
      try {
        const library = await fs.readFile(PRIVATE_LIBRARY_PATH, "utf8");
        this.addWatchFile(PRIVATE_LIBRARY_PATH);
        return `export default ${library};`;
      } catch (error) {
        if (INCLUDE_PRIVATE_DESKTOP_LIBRARY && error?.code === "ENOENT") {
          throw new Error(
            "Desktop build requires .private/neodb-library.local.json",
          );
        }
        if (error?.code !== "ENOENT") throw error;
        return "export default [];";
      }
    },
  };
}

function normalizeNeoDbUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    if (!(host === "neodb.social" || host.startsWith("neodb."))) return null;
    url.protocol = "https:";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function resolveNeoDbUrl(sourceUrl) {
  const normalized = normalizeNeoDbUrl(sourceUrl);
  if (!normalized) return null;
  try {
    let response = await fetch(normalized, {
      method: "HEAD",
      redirect: "follow",
      headers: { accept: "text/html" },
    });
    if (response.status === 405) {
      response = await fetch(normalized, {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html" },
      });
    }
    return normalizeNeoDbUrl(response.url) ?? normalized;
  } catch {
    return normalized;
  }
}

function neoDbCanonicalizeDevApi() {
  return {
    name: "recordshelf-read-only-metadata-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (await handleSharedStateRequest(request, response)) return;
        next();
      });
      server.middlewares.use(
        "/api/neodb/canonicalize",
        async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            response.statusCode = 400;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ error: "INVALID_JSON" }));
            return;
          }
          const urls = [
            ...new Set(
              (payload.urls ?? []).map(normalizeNeoDbUrl).filter(Boolean),
            ),
          ].slice(0, 100);
          const canonicalUrls = {};
          for (let offset = 0; offset < urls.length; offset += 10) {
            const batch = urls.slice(offset, offset + 10);
            const results = await Promise.all(batch.map(resolveNeoDbUrl));
            batch.forEach((url, index) => {
              canonicalUrls[url] = results[index] ?? url;
            });
          }
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify({ canonicalUrls }));
        },
      );
      server.middlewares.use(
        "/api/metadata/release-types",
        async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const apiResponse = await verifyReleaseTypes(
            new Request("http://localhost/api/metadata/release-types", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Buffer.concat(chunks),
            }),
          );
          response.statusCode = apiResponse.status;
          apiResponse.headers.forEach((value, key) =>
            response.setHeader(key, value),
          );
          response.end(Buffer.from(await apiResponse.arrayBuffer()));
        },
      );
      server.middlewares.use(
        "/api/metadata/artist-identities",
        async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const apiResponse = await verifyArtistIdentities(
            new Request("http://localhost/api/metadata/artist-identities", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Buffer.concat(chunks),
            }),
          );
          response.statusCode = apiResponse.status;
          apiResponse.headers.forEach((value, key) =>
            response.setHeader(key, value),
          );
          response.end(Buffer.from(await apiResponse.arrayBuffer()));
        },
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [privacySafeLibrary(command), react(), neoDbCanonicalizeDevApi()],
}));
