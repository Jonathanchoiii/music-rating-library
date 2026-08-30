import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeNeoDbUrls,
  verifyArtistIdentities,
  verifyReleaseTypes,
} from "./worker/index.js";
import { handleSharedStateRequest } from "./shared-state/index.mjs";
import { handleListeningGuideRequest } from "./listening-guides/index.mjs";
import { handleAppleMusicEditorialRequest } from "./apple-music-notes/index.mjs";
import {
  handleLocalCoverEnrichRequest,
  handlePrivateCoverStatic,
} from "./scripts/private-covers-http.mjs";
import {
  handleAppleMotionArtworkRequest,
  handleMotionArtworkFileRequest,
} from "./scripts/apple-motion-artwork.mjs";
import { handleExternalRatingsRequest } from "./external-ratings/index.mjs";
import { handleTracklistRequest } from "./tracklists/index.mjs";
import { handleReleaseMetadataPersistRequest } from "./shared-state/release-metadata.mjs";
import { handleRemotePreviewSyncRequest } from "./remote-preview/local-http.mjs";
import { handleArtistResearchRequest } from "./artist-research/index.mjs";
import { handleAppleArtistLinksRequest } from "./apple-artist-links/index.mjs";
import { handleArtistCatalogRequest } from "./artist-catalog/index.mjs";
import { handleRoamCountryRefreshRequest } from "./roam-country-refresh/index.mjs";

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
        return `export default ${library}`;
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

async function handleWorkerPost(request, response, pathname, handler) {
  if (request.method !== "POST") {
    response.statusCode = 405;
    response.end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const apiResponse = await handler(
    new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks),
    }),
    {},
  );
  response.statusCode = apiResponse.status;
  apiResponse.headers.forEach((value, key) =>
    response.setHeader(key, value),
  );
  response.end(Buffer.from(await apiResponse.arrayBuffer()));
}

function localMetadataApi() {
  return {
    name: "recordshelf-read-only-metadata-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (await handlePrivateCoverStatic(request, response)) return;
        if (await handleLocalCoverEnrichRequest(request, response)) return;
        if (await handleAppleMotionArtworkRequest(request, response)) return;
        if (await handleMotionArtworkFileRequest(request, response)) return;
        if (await handleExternalRatingsRequest(request, response)) return;
        if (await handleTracklistRequest(request, response)) return;
        if (await handleReleaseMetadataPersistRequest(request, response)) {
          return;
        }
        if (await handleRemotePreviewSyncRequest(request, response)) {
          return;
        }
        if (await handleListeningGuideRequest(request, response)) return;
        if (await handleAppleMusicEditorialRequest(request, response)) return;
        if (await handleArtistResearchRequest(request, response)) return;
        if (await handleArtistCatalogRequest(request, response)) return;
        if (await handleAppleArtistLinksRequest(request, response)) return;
        if (await handleRoamCountryRefreshRequest(request, response)) return;
        if (await handleSharedStateRequest(request, response)) return;
        next();
      });
      server.middlewares.use("/api/neodb/canonicalize", (request, response) =>
        handleWorkerPost(
          request,
          response,
          "/api/neodb/canonicalize",
          canonicalizeNeoDbUrls,
        ),
      );
      server.middlewares.use(
        "/api/metadata/release-types",
        (request, response) =>
          handleWorkerPost(
            request,
            response,
            "/api/metadata/release-types",
            verifyReleaseTypes,
          ),
      );
      server.middlewares.use(
        "/api/metadata/artist-identities",
        (request, response) =>
          handleWorkerPost(
            request,
            response,
            "/api/metadata/artist-identities",
            verifyArtistIdentities,
          ),
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
  plugins: [privacySafeLibrary(command), react(), localMetadataApi()],
}));
