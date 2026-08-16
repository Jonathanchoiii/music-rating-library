const failedCoverReleaseIds = new Set();
const PRIVATE_COVER_PREFIX = "/private-covers/";

export function coverLookupRecord(release, loadFailed = false) {
  return {
    id: release.id,
    title: release.title,
    artists: release.artists,
    coverUrl: loadFailed ? "" : release.coverUrl ?? "",
    coverRemoteUrl: release.coverRemoteUrl ?? "",
    coverSource: release.coverSource ?? "",
    coverMatchedFrom: release.coverMatchedFrom ?? "",
    externalLinks: (release.externalLinks ?? []).filter((link) =>
      ["CONFIRMED", "AUTO_CONFIRMED"].includes(link.status),
    ),
  };
}

export function coverDisplaySrc(release) {
  const url = String(release?.coverUrl ?? "");
  if (!url.startsWith(PRIVATE_COVER_PREFIX) || !release?.coverMatchedAt) {
    return url;
  }
  return `${url}?v=${encodeURIComponent(release.coverMatchedAt)}`;
}

export function markCoverLoadFailed(releaseId) {
  if (releaseId) failedCoverReleaseIds.add(releaseId);
}

export function clearCoverLoadFailures(releaseIds = []) {
  for (const releaseId of releaseIds) failedCoverReleaseIds.delete(releaseId);
}

export function getFailedCoverReleaseIds() {
  return [...failedCoverReleaseIds];
}
