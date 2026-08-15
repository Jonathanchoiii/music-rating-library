import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BLOB_PREFIX = "recordshelf-preview";
export const COVER_ROUTE = "/private-covers";
export const MOTION_ROUTE = "/private-motion-artwork";
export const AUTH_COOKIE = "recordshelf_preview_auth";
export const AUTH_COOKIE_PAYLOAD = "recordshelf-preview-v1";

export function getAppRoot() {
  return appRoot;
}

export function getApplicationSupportDir() {
  if (process.env.RECORDSHELF_SUPPORT_DIR) {
    return path.resolve(process.env.RECORDSHELF_SUPPORT_DIR);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
  );
}

export function getCatalogPath() {
  if (process.env.RECORDSHELF_CATALOG_PATH) {
    return path.resolve(process.env.RECORDSHELF_CATALOG_PATH);
  }
  return path.join(appRoot, ".private", "neodb-library.local.json");
}

export function getSharedStatePath(supportDir = getApplicationSupportDir()) {
  if (process.env.RECORDSHELF_SHARED_STATE_PATH) {
    return path.resolve(process.env.RECORDSHELF_SHARED_STATE_PATH);
  }
  return path.join(supportDir, "shared-local-state.json");
}

export function getCoverDirectories(supportDir = getApplicationSupportDir()) {
  return [
    process.env.RECORDSHELF_COVER_DIRECTORY
      ? path.resolve(process.env.RECORDSHELF_COVER_DIRECTORY)
      : path.join(appRoot, ".private", "covers"),
    path.join(supportDir, "covers"),
  ];
}

export function getMotionArtworkDirectory(
  supportDir = getApplicationSupportDir(),
) {
  if (process.env.RECORDSHELF_MOTION_ARTWORK_DIR) {
    return path.resolve(process.env.RECORDSHELF_MOTION_ARTWORK_DIR);
  }
  return path.join(supportDir, "motion-artwork");
}

export function getSnapshotDirectory(supportDir = getApplicationSupportDir()) {
  return path.join(supportDir, "remote-preview");
}

export function getICloudPreviewDirectory() {
  if (process.env.RECORDSHELF_ICLOUD_DIR) {
    return path.resolve(process.env.RECORDSHELF_ICLOUD_DIR);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "RecordShelf",
  );
}

export function blobObjectPath(relativePath) {
  return `${BLOB_PREFIX}/${relativePath.replace(/^\/+/, "")}`;
}
