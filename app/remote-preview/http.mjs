import {
  isPreviewAuthorized,
  previewPassword,
  readJsonBody,
  sendJson,
  unauthorized,
} from "./auth.mjs";
import { readPreviewBlob, readPreviewJson } from "./blob-read.mjs";

const SAFE_NAME = /^[a-zA-Z0-9._-]{1,180}$/;

export function requirePreviewAuth(req, res) {
  if (!previewPassword()) {
    sendJson(res, 503, { error: "PREVIEW_PASSWORD_REQUIRED" });
    return false;
  }
  if (!isPreviewAuthorized(req)) {
    unauthorized(res);
    return false;
  }
  return true;
}

export async function serveSnapshot(req, res) {
  if (!requirePreviewAuth(req, res)) return;
  const [manifest, catalog, state] = await Promise.all([
    readPreviewJson("manifest.json"),
    readPreviewJson("catalog.json"),
    readPreviewJson("state.json"),
  ]);
  if (!manifest || !Array.isArray(catalog) || !state?.storage) {
    sendJson(res, 404, { error: "PREVIEW_SNAPSHOT_MISSING" });
    return;
  }
  sendJson(res, 200, {
    schemaVersion: manifest.schemaVersion ?? 1,
    updatedAt: manifest.updatedAt,
    catalogCount: catalog.length,
    coverCount: manifest.covers?.length ?? 0,
    motionCount: manifest.motion?.length ?? 0,
    catalog,
    storage: state.storage,
  });
}

export async function serveMedia(req, res, url) {
  if (!requirePreviewAuth(req, res)) return;
  const kind = url.searchParams.get("kind");
  const name = url.searchParams.get("name") ?? "";
  if (!SAFE_NAME.test(name) || !["cover", "motion"].includes(kind)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const relativePath = `${kind === "cover" ? "covers" : "motion"}/${name}`;
  const file = await readPreviewBlob(relativePath);
  if (!file) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", file.contentType);
  res.setHeader("cache-control", "private, max-age=86400");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(file.buffer);
}

export async function serveEditorialNotes(req, res, url) {
  if (!requirePreviewAuth(req, res)) return;
  const albumUrl = url.searchParams.get("url") ?? "";
  const store = (await readPreviewJson("editorial-notes.json")) ?? {};
  const notes = store.notes ?? store;
  const match =
    notes?.[albumUrl] ??
    Object.values(notes).find((entry) => entry?.album?.appleMusicUrl === albumUrl);
  sendJson(res, 200, match?.result ?? match ?? { versions: [], scan: { mode: "quick" } });
}

export async function serveGuides(req, res, url) {
  if (!requirePreviewAuth(req, res)) return;
  const store = (await readPreviewJson("listening-guides.json")) ?? {
    guides: {},
    updatedAt: null,
  };
  const guides = store.guides ?? {};
  const kind = url.searchParams.get("kind");
  const releaseId = url.searchParams.get("id");
  if (kind === "statuses" || !releaseId) {
    sendJson(res, 200, {
      updatedAt: store.updatedAt ?? null,
      statuses: Object.fromEntries(
        Object.entries(guides).map(([id, guide]) => [id, guide.status ?? "EMPTY"]),
      ),
    });
    return;
  }
  sendJson(res, 200, {
    status: guides[releaseId]?.status ?? "EMPTY",
    guide: guides[releaseId] ?? null,
    codexJob: null,
    phase: "PREVIEW_CACHE",
  });
}

export { readJsonBody, sendJson };
