export const PERSISTED_RELEASE_METADATA_FIELDS = Object.freeze([
  "albumIntroduction",
  "tracklist",
  "motionArtwork",
]);

function hasReleaseShape(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyFieldsToRelease(previous, patch) {
  const next = { ...previous };
  for (const [field, value] of Object.entries(patch)) {
    if (
      value == null ||
      (field === "albumIntroduction" && String(value).trim() === "")
    ) {
      delete next[field];
      continue;
    }
    if (
      field === "motionArtwork" &&
      hasReleaseShape(previous.motionArtwork) &&
      hasReleaseShape(value)
    ) {
      next.motionArtwork = { ...previous.motionArtwork, ...value };
    } else {
      next[field] = value;
    }
  }
  return next;
}

export function sanitizeReleaseMetadataPatch(fields = {}) {
  return Object.fromEntries(
    PERSISTED_RELEASE_METADATA_FIELDS.filter((field) =>
      Object.hasOwn(fields, field),
    ).map((field) => [field, fields[field]]),
  );
}

export function applyMetadataFieldsToUserState(
  userState = {},
  releaseId,
  fields,
) {
  const patch = sanitizeReleaseMetadataPatch(fields);
  if (!releaseId || !Object.keys(patch).length) return userState;

  const nextState = { ...userState };
  const userReleaseIndex = (userState.userReleases ?? []).findIndex(
    (release) => release?.id === releaseId,
  );
  if (userReleaseIndex >= 0) {
    nextState.userReleases = [...(userState.userReleases ?? [])];
    nextState.userReleases[userReleaseIndex] = applyFieldsToRelease(
      nextState.userReleases[userReleaseIndex],
      patch,
    );
    return nextState;
  }

  const previousOverrides = userState.releaseMetadataOverrides ?? {};
  const nextRelease = applyFieldsToRelease(
    previousOverrides[releaseId] ?? {},
    patch,
  );
  nextState.releaseMetadataOverrides = { ...previousOverrides };
  if (Object.keys(nextRelease).length) {
    nextState.releaseMetadataOverrides[releaseId] = nextRelease;
  } else {
    delete nextState.releaseMetadataOverrides[releaseId];
  }
  return nextState;
}

export function readReleaseMetadataRecord(userState = {}, releaseId) {
  const userRelease = (userState.userReleases ?? []).find(
    (release) => release?.id === releaseId,
  );
  if (userRelease) return userRelease;
  return userState.releaseMetadataOverrides?.[releaseId] ?? {};
}
