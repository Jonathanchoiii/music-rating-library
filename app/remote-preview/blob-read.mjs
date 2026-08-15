import { get, list } from "@vercel/blob";
import { blobObjectPath } from "./paths.mjs";

const CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function contentTypeFor(relativePath) {
  const extension = relativePath
    .slice(relativePath.lastIndexOf("."))
    .toLocaleLowerCase();
  return CONTENT_TYPES.get(extension) ?? "application/octet-stream";
}

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readBlobRecord(relativePath) {
  const pathname = blobObjectPath(relativePath);
  const direct = await get(pathname, { access: "private" });
  if (direct?.statusCode === 200) return direct;
  const { blobs } = await list({ prefix: pathname, limit: 5 });
  const match = blobs.find(
    (blob) =>
      blob.pathname === pathname || blob.pathname?.endsWith(`/${relativePath}`),
  );
  if (!match) return null;
  return get(match.url, { access: "private" });
}

export async function readPreviewBlob(relativePath) {
  const record = await readBlobRecord(relativePath);
  if (!record || record.statusCode !== 200 || !record.stream) return null;
  return {
    buffer: await streamToBuffer(record.stream),
    contentType:
      record.blob?.contentType || contentTypeFor(relativePath),
  };
}

export async function readPreviewJson(relativePath) {
  const file = await readPreviewBlob(relativePath);
  if (!file) return null;
  return JSON.parse(file.buffer.toString("utf8"));
}
