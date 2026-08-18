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

function cacheBustedPrivateCover(url, matchedAt) {
  const value = String(url ?? "");
  if (!value.startsWith(PRIVATE_COVER_PREFIX) || !matchedAt) return value;
  return `${value}?v=${encodeURIComponent(matchedAt)}`;
}

export function coverDisplaySrc(release) {
  return cacheBustedPrivateCover(release?.coverUrl, release?.coverMatchedAt);
}

export function coverDisplayCandidates(release) {
  const seen = new Set();
  const candidates = [];
  const add = (url) => {
    const value = String(url ?? "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  add(coverDisplaySrc(release));
  add(cacheBustedPrivateCover(release?.coverRemoteUrl, release?.coverMatchedAt));
  add(release?.coverRemoteUrl);
  return candidates;
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
