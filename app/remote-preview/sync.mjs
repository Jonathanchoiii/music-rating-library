import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  copySnapshotToICloud,
  packageRemotePreviewSnapshot,
} from "./package-snapshot.mjs";
import { getApplicationSupportDir } from "./paths.mjs";
import { blobTokenPresent, uploadSnapshotToBlob } from "./upload-blob.mjs";

const ENV_FILES = [
  path.resolve(import.meta.dirname, "../.env.local"),
  path.resolve(import.meta.dirname, "../.env"),
];

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function applyEnvText(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export async function loadPreviewEnv(supportDir = getApplicationSupportDir()) {
  for (const filePath of ENV_FILES) {
    applyEnvText(await readTextIfPresent(filePath));
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const token = (await readTextIfPresent(
      path.join(supportDir, "blob-read-write-token"),
    )).trim();
    if (token) process.env.BLOB_READ_WRITE_TOKEN = token;
  }
  if (!process.env.RECORDSHELF_PREVIEW_PASSWORD) {
    const password = (await readTextIfPresent(
      path.join(supportDir, "preview-password"),
    )).trim();
    if (password) process.env.RECORDSHELF_PREVIEW_PASSWORD = password;
  }
}

export async function syncRemotePreview(options = {}) {
  const packed = await packageRemotePreviewSnapshot(options);
  let icloud = { copied: false, reason: "SKIPPED" };
  if (options.skipICloud !== true && os.platform() === "darwin") {
    try {
      icloud = await copySnapshotToICloud(packed.snapshotDir, options);
    } catch (error) {
      icloud = {
        copied: false,
        reason: error?.code === "ENOENT" ? "ICLOUD_DRIVE_MISSING" : "ICLOUD_COPY_FAILED",
      };
    }
  }
  let blob = { uploaded: false, reason: "SKIPPED", files: 0 };
  if (options.skipBlob !== true) {
    blob = await uploadSnapshotToBlob(packed.snapshotDir, options);
  }
  return {
    ok: true,
    updatedAt: packed.manifest.updatedAt,
    catalogCount: packed.catalogCount,
    coverCount: packed.coverCount,
    motionCount: packed.motionCount,
    snapshotDir: packed.snapshotDir,
    icloud,
    blob,
    tokenPresent: blobTokenPresent(),
  };
}
