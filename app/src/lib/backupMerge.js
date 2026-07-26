import {
  getReleaseSourceIdentityKeys,
  releasesHaveConflictingSourceIdentities,
  normalizeNeoDbUrl,
  normalizeText,
} from "./music.js";
import { sanitizeArtistIdentityState } from "./artists.js";

const RELEASE_ARRAY_FIELDS = [
  "artists",
  "titleAliases",
  "genres",
  "styles",
  "catalogLanguages",
  "editionTypes",
  "releaseCountries",
  "labels",
  "mediaFormats",
  "tags",
];

function uniqueStrings(...values) {
  const seen = new Set();
  return values
    .flat()
    .filter(Boolean)
    .filter((value) => {
      const key = normalizeText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function neoDbUrl(release) {
  const link = (release?.externalLinks ?? []).find(
    (item) => item.provider === "NEODB",
  );
  return normalizeNeoDbUrl(link?.canonicalUrl ?? link?.url ?? "");
}

function entryFingerprint(entry) {
  return JSON.stringify({
    sourceProvider: normalizeText(entry?.sourceProvider),
    sourceItemId: normalizeText(entry?.sourceItemId),
    listenedAt: entry?.listenedAt ?? "",
    ratedAt: entry?.ratedAt ?? "",
    createdAt: entry?.createdAt ?? "",
    rating10: entry?.rating10 ?? null,
    comment: String(entry?.comment ?? "").replace(/\r\n?/g, "\n").trim(),
    status: normalizeText(entry?.status),
  });
}

function stableSuffix(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function mergeListeningEntries(primary = [], incoming = []) {
  const merged = primary.map((entry) => ({ ...entry }));
  const fingerprints = new Set(merged.map(entryFingerprint));
  const ids = new Map(
    merged.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  let added = 0;

  for (const entry of incoming) {
    const fingerprint = entryFingerprint(entry);
    if (fingerprints.has(fingerprint)) continue;
    const existingId = entry.id && ids.has(entry.id);
    const nextEntry = existingId
      ? {
          ...entry,
          id: `${entry.id}-merge-${stableSuffix(fingerprint)}`,
        }
      : { ...entry };
    merged.push(nextEntry);
    fingerprints.add(fingerprint);
    if (nextEntry.id) ids.set(nextEntry.id, nextEntry);
    added += 1;
  }
  return { entries: merged, added };
}

function mergeExternalLinks(primary = [], incoming = []) {
  const links = new Map();
  for (const link of [...primary, ...incoming]) {
    const normalizedUrl =
      link.provider === "NEODB"
        ? normalizeNeoDbUrl(link.canonicalUrl ?? link.url)
        : String(link.url ?? "").trim();
    const key = `${link.provider ?? ""}:${normalizedUrl}`;
    if (!normalizedUrl || links.has(key)) continue;
    links.set(key, { ...link });
  }
  return [...links.values()];
}

function mergeRelease(primary, incoming) {
  const history = mergeListeningEntries(
    primary.listeningEntries,
    incoming.listeningEntries,
  );
  const next = {
    ...incoming,
    ...primary,
    externalLinks: mergeExternalLinks(
      primary.externalLinks,
      incoming.externalLinks,
    ),
    listeningEntries: history.entries,
  };
  for (const field of RELEASE_ARRAY_FIELDS) {
    next[field] = uniqueStrings(primary[field] ?? [], incoming[field] ?? []);
  }
  if (
    (!primary.releaseType || primary.releaseType === "OTHER") &&
    incoming.releaseType &&
    incoming.releaseType !== "OTHER"
  ) {
    next.releaseType = incoming.releaseType;
  }
  if (!primary.coverUrl && incoming.coverUrl) next.coverUrl = incoming.coverUrl;
  if (
    normalizeText(primary.title) !== normalizeText(incoming.title) &&
    incoming.title
  ) {
    next.titleAliases = uniqueStrings(
      next.titleAliases,
      incoming.title,
    );
  }
  return { release: next, historyAdded: history.added };
}

export function mergeSelectedReleases(
  keptRelease,
  removedRelease,
) {
  if (!keptRelease || !removedRelease || keptRelease.id === removedRelease.id) {
    throw new Error("需要两个不同的发行才能合并");
  }
  const keptLinkProviders = new Set(
    (keptRelease.externalLinks ?? [])
      .map((link) => link.provider)
      .filter(Boolean),
  );
  const incoming = {
    ...removedRelease,
    externalLinks: (removedRelease.externalLinks ?? []).filter(
      (link) => !keptLinkProviders.has(link.provider),
    ),
  };
  const merged = mergeRelease(keptRelease, incoming);
  return {
    ...merged,
    removedReleaseId: removedRelease.id,
    keptReleaseId: keptRelease.id,
  };
}

export function mergeReleaseLibraries(primary = [], incoming = []) {
  const releases = primary.map((release) => ({ ...release }));
  const byId = new Map(releases.map((release) => [release.id, release]));
  const byNeoDbUrl = new Map(
    releases
      .map((release) => [neoDbUrl(release), release])
      .filter(([url]) => url),
  );
  let releasesAdded = 0;
  let releasesUpdated = 0;
  let historyAdded = 0;

  for (const incomingRelease of incoming) {
    const idMatched = byId.get(incomingRelease.id);
    const matched =
      idMatched &&
      !releasesHaveConflictingSourceIdentities(idMatched, incomingRelease)
        ? idMatched
        : byNeoDbUrl.get(neoDbUrl(incomingRelease));
    if (!matched) {
      const added = {
        ...incomingRelease,
        id: idMatched
          ? `${incomingRelease.id}-source-${stableSuffix(
              getReleaseSourceIdentityKeys(incomingRelease).join("|"),
            )}`
          : incomingRelease.id,
      };
      releases.push(added);
      byId.set(added.id, added);
      const url = neoDbUrl(added);
      if (url) byNeoDbUrl.set(url, added);
      releasesAdded += 1;
      continue;
    }
    const merged = mergeRelease(matched, incomingRelease);
    const index = releases.indexOf(matched);
    releases[index] = merged.release;
    byId.set(merged.release.id, merged.release);
    const url = neoDbUrl(merged.release);
    if (url) byNeoDbUrl.set(url, merged.release);
    if (JSON.stringify(merged.release) !== JSON.stringify(matched)) {
      releasesUpdated += 1;
    }
    historyAdded += merged.historyAdded;
  }
  return { releases, releasesAdded, releasesUpdated, historyAdded };
}

function identitySignature(identity) {
  return [
    normalizeText(identity.canonicalName),
    ...(identity.aliases ?? []).map((alias) => normalizeText(alias.name)),
  ]
    .filter(Boolean)
    .sort()
    .join("|");
}

function mergeIdentity(primary, incoming) {
  const aliases = new Map();
  for (const alias of [...(primary.aliases ?? []), ...(incoming.aliases ?? [])]) {
    const key = normalizeText(alias.name);
    if (key && !aliases.has(key)) aliases.set(key, { ...alias });
  }
  if (
    incoming.canonicalName &&
    normalizeText(incoming.canonicalName) !==
      normalizeText(primary.canonicalName)
  ) {
    aliases.set(normalizeText(incoming.canonicalName), {
      name: incoming.canonicalName,
      locale: "",
      type: "ARTIST_NAME",
      source: "MERGED_BACKUP",
    });
  }
  const candidateMap = new Map();
  for (const candidate of [
    ...(primary.musicBrainzCandidates ?? []),
    ...(incoming.musicBrainzCandidates ?? []),
  ]) {
    const key =
      candidate.musicBrainzMbid || normalizeText(candidate.name);
    if (key && !candidateMap.has(key)) candidateMap.set(key, candidate);
  }
  return {
    ...incoming,
    ...primary,
    musicBrainzMbid:
      primary.musicBrainzMbid || incoming.musicBrainzMbid || "",
    musicBrainzStatus:
      primary.musicBrainzStatus || incoming.musicBrainzStatus || "",
    musicBrainzEvidence:
      primary.musicBrainzEvidence ?? incoming.musicBrainzEvidence ?? null,
    musicBrainzCandidates: [...candidateMap.values()].slice(0, 5),
    aliases: [...aliases.values()],
  };
}

export function mergeArtistIdentityStates(primary, incoming) {
  const base = sanitizeArtistIdentityState(primary);
  const imported = sanitizeArtistIdentityState(incoming);
  const identities = base.identities.map((identity) => ({ ...identity }));
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  const byMbid = new Map(
    identities
      .filter((identity) => identity.musicBrainzMbid)
      .map((identity) => [identity.musicBrainzMbid, identity]),
  );
  const bySignature = new Map(
    identities.map((identity) => [identitySignature(identity), identity]),
  );
  let identitiesAdded = 0;
  let identitiesUpdated = 0;

  for (const incomingIdentity of imported.identities) {
    const matched =
      byId.get(incomingIdentity.id) ??
      (incomingIdentity.musicBrainzMbid
        ? byMbid.get(incomingIdentity.musicBrainzMbid)
        : null) ??
      bySignature.get(identitySignature(incomingIdentity));
    if (!matched) {
      identities.push(incomingIdentity);
      byId.set(incomingIdentity.id, incomingIdentity);
      if (incomingIdentity.musicBrainzMbid) {
        byMbid.set(incomingIdentity.musicBrainzMbid, incomingIdentity);
      }
      bySignature.set(identitySignature(incomingIdentity), incomingIdentity);
      identitiesAdded += 1;
      continue;
    }
    const merged = mergeIdentity(matched, incomingIdentity);
    const index = identities.indexOf(matched);
    identities[index] = merged;
    byId.set(merged.id, merged);
    if (merged.musicBrainzMbid) byMbid.set(merged.musicBrainzMbid, merged);
    bySignature.set(identitySignature(merged), merged);
    if (JSON.stringify(merged) !== JSON.stringify(matched)) {
      identitiesUpdated += 1;
    }
  }
  return {
    state: sanitizeArtistIdentityState({
      schemaVersion: 2,
      identities,
    }),
    identitiesAdded,
    identitiesUpdated,
  };
}

export function validateRecordshelfBackup(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("JSON 备份格式无效");
  }
  if (!Array.isArray(payload.releases)) {
    throw new Error("JSON 备份缺少 releases 数组");
  }
  if (!Array.isArray(payload.artistIdentityState?.identities)) {
    throw new Error("JSON 备份缺少 artistIdentityState");
  }
  return payload;
}
