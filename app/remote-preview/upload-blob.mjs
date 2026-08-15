import fs from "node:fs/promises";
import path from "node:path";
import { blobObjectPath } from "./paths.mjs";

async function walkFiles(directory, relative = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextRelative = relative
      ? `${relative}/${entry.name}`
      : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath, nextRelative)));
    } else if (entry.isFile()) {
      files.push({ relativePath: nextRelative, fullPath });
    }
  }
  return files;
}

export function blobTokenPresent() {
  return Boolean(String(process.env.BLOB_READ_WRITE_TOKEN ?? "").trim());
}

export async function uploadSnapshotToBlob(snapshotDir, options = {}) {
  if (!blobTokenPresent() && !options.token) {
    return { uploaded: false, reason: "BLOB_TOKEN_MISSING", files: 0 };
  }
  let put;
  try {
    ({ put } = await import("@vercel/blob"));
  } catch {
    return { uploaded: false, reason: "BLOB_SDK_MISSING", files: 0 };
  }
  const files = await walkFiles(snapshotDir);
  const uploaded = [];
  for (const file of files) {
    const pathname = blobObjectPath(file.relativePath);
    const body = await fs.readFile(file.fullPath);
    const blob = await put(pathname, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      token: options.token,
      contentType: file.relativePath.endsWith(".json")
        ? "application/json; charset=utf-8"
        : undefined,
    });
    uploaded.push({
      path: file.relativePath,
      url: blob.url,
      contentType: blob.contentType,
    });
  }
  return { uploaded: true, files: uploaded.length, objects: uploaded };
}
