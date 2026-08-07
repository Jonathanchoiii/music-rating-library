const failedCoverReleaseIds = new Set();

export function markCoverLoadFailed(releaseId) {
  if (releaseId) failedCoverReleaseIds.add(releaseId);
}

export function clearCoverLoadFailures(releaseIds = []) {
  for (const releaseId of releaseIds) failedCoverReleaseIds.delete(releaseId);
}

export function getFailedCoverReleaseIds() {
  return [...failedCoverReleaseIds];
}
