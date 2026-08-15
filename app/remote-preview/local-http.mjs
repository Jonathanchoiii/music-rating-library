import { sendJson } from "../scripts/http-json.mjs";
import { loadPreviewEnv, syncRemotePreview } from "./sync.mjs";

export async function handleRemotePreviewSyncRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:4173");
  if (url.pathname !== "/api/remote-preview/sync") return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const host = request.headers.host ?? "";
  if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) {
    sendJson(response, 403, { error: "PREVIEW_SYNC_LOCAL_ONLY" });
    return true;
  }
  try {
    await loadPreviewEnv();
    const result = await syncRemotePreview();
    sendJson(response, 200, {
      ok: true,
      updatedAt: result.updatedAt,
      catalogCount: result.catalogCount,
      coverCount: result.coverCount,
      motionCount: result.motionCount,
      icloud: result.icloud,
      blob: {
        uploaded: result.blob.uploaded,
        files: result.blob.files,
        reason: result.blob.reason ?? null,
      },
      tokenPresent: result.tokenPresent,
    });
  } catch (error) {
    sendJson(response, error?.message === "PREVIEW_CATALOG_MISSING" ? 409 : 500, {
      error: error?.message ?? "PREVIEW_SYNC_FAILED",
    });
  }
  return true;
}
