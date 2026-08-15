import { seedReleases } from "../data/seed.js";
import {
  reconcileCanonicalCoverOverride,
  reconcileCanonicalExternalLinkOverride,
  reconcileCanonicalTitleOverride,
} from "./music.js";
import {
  dedupeEquivalentListeningEntries,
  getReleaseMetadataFields,
} from "./neodbSync.js";
import { applyMetadataFieldsToUserState } from "./releaseMetadataOverlay.js";
import {
  LEGACY_FULL_LIBRARY_KEYS,
  LEGACY_USER_STATE_KEY,
  USER_STATE_KEY,
} from "./sharedStorageKeys.js";

const BASE_RELEASE_BY_ID = new Map(
  seedReleases.map((release) => [release.id, release]),
);
const BASE_ENTRY_IDS_BY_RELEASE = new Map(
  seedReleases.map((release) => [
    release.id,
    new Set(release.listeningEntries.map((entry) => entry.id)),
  ]),
);
const RELEASE_METADATA_FIELDS = getReleaseMetadataFields();

export function getBaseRelease(releaseId) {
  return BASE_RELEASE_BY_ID.get(releaseId);
}

export function deriveUserState(releases, releaseTypeOverrides = {}) {
  const listeningEntryAdditions = {};
  const listeningEntryRemovals = {};
  const releaseMetadataOverrides = {};
  const userReleases = [];
  const currentReleaseIds = new Set(releases.map((release) => release.id));
  const removedReleaseIds = seedReleases
    .filter((release) => !currentReleaseIds.has(release.id))
    .map((release) => release.id);

  for (const release of releases) {
    const baseRelease = BASE_RELEASE_BY_ID.get(release.id);
    if (!baseRelease) {
      userReleases.push(release);
      continue;
    }
    const baseEntryIds = BASE_ENTRY_IDS_BY_RELEASE.get(release.id);
    const additions = release.listeningEntries.filter(
      (entry) => !baseEntryIds.has(entry.id),
    );
    if (additions.length) {
      listeningEntryAdditions[release.id] = additions;
    }
    const currentEntryIds = new Set(
      release.listeningEntries.map((entry) => entry.id),
    );
    const removals = baseRelease.listeningEntries
      .filter((entry) => !currentEntryIds.has(entry.id))
      .map((entry) => entry.id);
    if (removals.length) {
      listeningEntryRemovals[release.id] = removals;
    }
    const metadataPatch = Object.fromEntries(
      RELEASE_METADATA_FIELDS.filter(
        (field) =>
          JSON.stringify(release[field]) !==
          JSON.stringify(baseRelease[field]),
      ).map((field) => [field, release[field]]),
    );
    if (Object.keys(metadataPatch).length) {
      releaseMetadataOverrides[release.id] = metadataPatch;
    }
  }

  return {
    releaseTypeOverrides,
    listeningEntryAdditions,
    listeningEntryRemovals,
    releaseMetadataOverrides,
    removedReleaseIds,
    userReleases,
  };
}

export function applyUserState(userState = {}) {
  const releaseTypeOverrides = userState.releaseTypeOverrides ?? {};
  const listeningEntryAdditions = userState.listeningEntryAdditions ?? {};
  const listeningEntryRemovals = userState.listeningEntryRemovals ?? {};
  const releaseMetadataOverrides = userState.releaseMetadataOverrides ?? {};
  const removedReleaseIds = new Set(userState.removedReleaseIds ?? []);
  const baseReleases = seedReleases
    .filter((release) => !removedReleaseIds.has(release.id))
    .map((release) => {
      const removedEntryIds = new Set(
        listeningEntryRemovals[release.id] ?? [],
      );
      const metadataOverride = reconcileCanonicalTitleOverride(
        release,
        reconcileCanonicalCoverOverride(
          release,
          reconcileCanonicalExternalLinkOverride(
            release,
            releaseMetadataOverrides[release.id] ?? {},
          ),
        ),
      );
      return {
        ...release,
        ...metadataOverride,
        releaseType:
          releaseTypeOverrides[release.id] ??
          metadataOverride.releaseType ??
          release.releaseType,
        releaseTypeUserConfirmed:
          metadataOverride.releaseTypeUserConfirmed ??
          (Object.hasOwn(releaseTypeOverrides, release.id)
            ? true
            : release.releaseTypeUserConfirmed ?? false),
        listeningEntries: [
          ...dedupeEquivalentListeningEntries([
            ...release.listeningEntries.filter(
              (entry) => !removedEntryIds.has(entry.id),
            ),
            ...(listeningEntryAdditions[release.id] ?? []),
          ]),
        ],
      };
    });
  return [...(userState.userReleases ?? []), ...baseReleases];
}

function keepExplicitLegacyTypeOverrides(overrides = {}) {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([releaseId, releaseType]) =>
        BASE_RELEASE_BY_ID.has(releaseId) && releaseType !== "OTHER",
    ),
  );
}

export function loadInitialLibraryState() {
  try {
    const savedUserState = window.localStorage.getItem(USER_STATE_KEY);
    if (savedUserState) {
      const userState = JSON.parse(savedUserState);
      return { releases: applyUserState(userState), userState };
    }

    const legacyUserStateValue =
      window.localStorage.getItem(LEGACY_USER_STATE_KEY);
    if (legacyUserStateValue) {
      const legacyUserState = JSON.parse(legacyUserStateValue);
      const userState = {
        ...legacyUserState,
        releaseTypeOverrides: keepExplicitLegacyTypeOverrides(
          legacyUserState.releaseTypeOverrides,
        ),
      };
      window.localStorage.setItem(USER_STATE_KEY, JSON.stringify(userState));
      window.localStorage.removeItem(LEGACY_USER_STATE_KEY);
      return { releases: applyUserState(userState), userState };
    }

    for (const legacyKey of LEGACY_FULL_LIBRARY_KEYS) {
      const legacyValue = window.localStorage.getItem(legacyKey);
      if (!legacyValue) continue;
      const legacyReleases = JSON.parse(legacyValue);
      const legacyTypeOverrides = Object.fromEntries(
        legacyReleases
          .filter((release) => {
            const baseRelease = BASE_RELEASE_BY_ID.get(release.id);
            return (
              baseRelease &&
              release.releaseType !== "OTHER" &&
              release.releaseType !== baseRelease.releaseType
            );
          })
          .map((release) => [release.id, release.releaseType]),
      );
      const migratedState = deriveUserState(
        legacyReleases,
        legacyTypeOverrides,
      );
      window.localStorage.setItem(
        USER_STATE_KEY,
        JSON.stringify(migratedState),
      );
      LEGACY_FULL_LIBRARY_KEYS.forEach((key) =>
        window.localStorage.removeItem(key),
      );
      return {
        releases: applyUserState(migratedState),
        userState: migratedState,
      };
    }
    const userState = deriveUserState(seedReleases);
    return { releases: applyUserState(userState), userState };
  } catch {
    const userState = deriveUserState(seedReleases);
    return { releases: applyUserState(userState), userState };
  }
}

function parseStoredUserState() {
  try {
    const savedUserState = window.localStorage.getItem(USER_STATE_KEY);
    return savedUserState ? JSON.parse(savedUserState) : {};
  } catch {
    return {};
  }
}

export function patchPersistedReleaseMetadata(releaseId, fields) {
  const nextState = applyMetadataFieldsToUserState(
    parseStoredUserState(),
    releaseId,
    fields,
  );
  const serializedState = JSON.stringify(nextState);
  if (window.localStorage.getItem(USER_STATE_KEY) === serializedState) {
    return false;
  }
  try {
    window.localStorage.setItem(USER_STATE_KEY, serializedState);
    return true;
  } catch (error) {
    console.warn("用户发行增量暂时无法写入本地存储", error);
    return false;
  }
}

export function persistUserState(releases, releaseTypeOverrides) {
  const serializedState = JSON.stringify(
    deriveUserState(releases, releaseTypeOverrides),
  );
  if (window.localStorage.getItem(USER_STATE_KEY) === serializedState) {
    return false;
  }
  try {
    window.localStorage.setItem(USER_STATE_KEY, serializedState);
    return true;
  } catch (error) {
    try {
      LEGACY_FULL_LIBRARY_KEYS.forEach((key) =>
        window.localStorage.removeItem(key),
      );
      window.localStorage.removeItem(LEGACY_USER_STATE_KEY);
      window.localStorage.setItem(USER_STATE_KEY, serializedState);
      return true;
    } catch (retryError) {
      console.warn("用户变更暂时无法写入本地存储", retryError ?? error);
      return false;
    }
  }
}
