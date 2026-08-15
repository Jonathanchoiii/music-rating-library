import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NEODB_OAUTH_CLIENT_KEY } from "../src/lib/sharedStorageKeys.js";
import {
  COVER_ROUTE,
  MOTION_ROUTE,
  getCatalogPath,
  getCoverDirectories,
  getICloudPreviewDirectory,
  getMotionArtworkDirectory,
  getSharedStatePath,
  getSnapshotDirectory,
} from "./paths.mjs";

export const PREVIEW_SCHEMA_VERSION = 1;
const FORBIDDEN_STORAGE_KEYS = new Set([NEODB_OAUTH_CLIENT_KEY]);

export function safePrivateFileName(url, prefix) {
  if (typeof url !== "string" || !url.startsWith(`${prefix}/`)) return null;
  const name = decodeURIComponent(
    url.slice(prefix.length + 1).split("?")[0] ?? "",
  );
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : null;
}

function walkObjects(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  visit(value);
  for (const nested of Object.values(value)) walkObjects(nested, visit);
}

export function collectPrivateMediaNames(values) {
  const covers = new Set();
  const motion = new Set();
  for (const value of values) {
    walkObjects(value, (record) => {
      const cover = safePrivateFileName(record.coverUrl, COVER_ROUTE);
      if (cover) covers.add(cover);
      const local = safePrivateFileName(record.localUrl, MOTION_ROUTE);
      if (local) motion.add(local);
    });
  }
  return { covers, motion };
}

export function sanitizePreviewStorage(storage = {}) {
  return Object.fromEntries(
    Object.entries(storage).filter(
      ([key, value]) =>
        !FORBIDDEN_STORAGE_KEYS.has(key) && typeof value === "string",
    ),
  );
}

function parseJsonObject(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readJsonIfPresent(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(source, destination) {
  if (!(await fileExists(source))) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return true;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function resolveExistingFile(fileName, directories) {
  for (const directory of directories) {
    const candidate = path.join(directory, fileName);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function copyNamedFiles(names, directories, destinationDir) {
  const copied = [];
  const missing = [];
  await fs.mkdir(destinationDir, { recursive: true });
  for (const fileName of names) {
    const source = await resolveExistingFile(fileName, directories);
    if (!source) {
      missing.push(fileName);
      continue;
    }
    const destination = path.join(destinationDir, fileName);
    await fs.copyFile(source, destination);
    copied.push({
      name: fileName,
      bytes: (await fs.stat(destination)).size,
      sha256: await sha256File(destination),
    });
  }
  return { copied, missing };
}

export async function packageRemotePreviewSnapshot(options = {}) {
  const supportDir = options.supportDir;
  const catalogPath = options.catalogPath ?? getCatalogPath();
  const statePath = options.statePath ?? getSharedStatePath(supportDir);
  const snapshotDir =
    options.snapshotDir ?? getSnapshotDirectory(supportDir);
  const coverDirectories =
    options.coverDirectories ?? getCoverDirectories(supportDir);
  const motionDirectory =
    options.motionDirectory ?? getMotionArtworkDirectory(supportDir);

  const catalog = await readJsonIfPresent(catalogPath, []);
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("PREVIEW_CATALOG_MISSING");
  }
  const sharedState = await readJsonIfPresent(statePath, {
    schemaVersion: 1,
    revision: 0,
    updatedAt: null,
    storage: {},
  });
  const storage = sanitizePreviewStorage(sharedState.storage ?? {});
  const parsedStorageValues = Object.values(storage).map((value) =>
    parseJsonObject(value, null),
  );
  const media = collectPrivateMediaNames([catalog, ...parsedStorageValues]);

  await fs.rm(snapshotDir, { recursive: true, force: true });
  await fs.mkdir(snapshotDir, { recursive: true });

  const catalogDestination = path.join(snapshotDir, "catalog.json");
  const stateDestination = path.join(snapshotDir, "state.json");
  await fs.writeFile(
    catalogDestination,
    `${JSON.stringify(catalog)}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    stateDestination,
    `${JSON.stringify({
      schemaVersion: sharedState.schemaVersion ?? 1,
      revision: sharedState.revision ?? 0,
      updatedAt: sharedState.updatedAt ?? null,
      storage,
    })}\n`,
    { mode: 0o600 },
  );

  const editorialCopied = await copyIfPresent(
    path.join(path.dirname(statePath), "apple-music-editorial-notes.json"),
    path.join(snapshotDir, "editorial-notes.json"),
  );
  const guidesCopied = await copyIfPresent(
    path.join(path.dirname(statePath), "listening-guides.json"),
    path.join(snapshotDir, "listening-guides.json"),
  );

  const covers = await copyNamedFiles(
    [...media.covers].sort(),
    coverDirectories,
    path.join(snapshotDir, "covers"),
  );
  const motion = await copyNamedFiles(
    [...media.motion].sort(),
    [motionDirectory],
    path.join(snapshotDir, "motion"),
  );

  const updatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    updatedAt,
    sharedUpdatedAt: sharedState.updatedAt ?? null,
    revision: sharedState.revision ?? 0,
    catalogCount: catalog.length,
    covers: covers.copied,
    motion: motion.copied,
    missingCovers: covers.missing,
    missingMotion: motion.missing,
    editorialNotes: editorialCopied,
    listeningGuides: guidesCopied,
    readOnly: true,
  };
  await fs.writeFile(
    path.join(snapshotDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    snapshotDir,
    manifest,
    catalogCount: catalog.length,
    coverCount: covers.copied.length,
    motionCount: motion.copied.length,
  };
}

export async function copySnapshotToICloud(snapshotDir, options = {}) {
  const destination =
    options.destination ?? path.join(getICloudPreviewDirectory(), "preview");
  try {
    const cloudRoot = path.dirname(destination);
    await fs.mkdir(cloudRoot, { recursive: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { copied: false, reason: "ICLOUD_DRIVE_MISSING" };
    }
    throw error;
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(snapshotDir, destination, { recursive: true });
  return { copied: true, destination };
}
