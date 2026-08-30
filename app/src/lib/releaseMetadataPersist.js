import { patchPersistedReleaseMetadata } from "./libraryUserState.js";
import { notifySharedLocalStateChanged } from "./sharedLocalState.js";
import { sanitizeReleaseMetadataPatch } from "./releaseMetadataOverlay.js";

export function persistReleaseOverlay(releaseId, fields) {
  const patch = sanitizeReleaseMetadataPatch(fields);
  if (!releaseId || !Object.keys(patch).length) return;
  if (patchPersistedReleaseMetadata(releaseId, patch)) {
    notifySharedLocalStateChanged();
  }
  void fetch("/api/local-release-metadata", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ releaseId, ...patch }),
    cache: "no-store",
  }).catch((error) => {
    console.warn("RecordShelf 发行增量暂时无法写入共享数据库", error);
  });
}
