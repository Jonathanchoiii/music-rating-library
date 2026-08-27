import { findConfirmedAppleMusicCatalogAlbum } from "./appleMusicUrl.js";
import { getCurrentRating, normalizeText } from "./music.js";

const RELEASE_TYPES = new Set(["LP", "EP", "SINGLE"]);
const EXPLORATION_VARIANT_QUALIFIER = /\b(?:remix|mix|edit|version|remaster(?:ed)?|deluxe|expanded|anniversary|bonus|instrumental|acoustic|live|sped\s*up|slowed(?:\s*down)?|rework|reprise)\b/i;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function releaseTitleKey(value) {
  return normalizeText(value)
    .replace(/\s*[-–—]\s*(?:ep|single)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function explorationReleaseFamilyTitle(value) {
  const original = releaseTitleKey(value);
  let title = original;
  let changed = true;
  while (changed && title) {
    changed = false;
    title = title
      .replace(/\s*[([{]([^\])}]+)[\])}]\s*$/, (match, qualifier) => {
        if (!EXPLORATION_VARIANT_QUALIFIER.test(qualifier)) return match;
        changed = true;
        return "";
      })
      .replace(/\s*[-–—:]\s*([^-–—:]+)$/, (match, qualifier) => {
        if (!EXPLORATION_VARIANT_QUALIFIER.test(qualifier)) return match;
        changed = true;
        return "";
      })
      .replace(/\s+/g, " ")
      .trim();
  }
  return title || original;
}

function comparableTrackTitle(value) {
  return normalizeText(value)
    .replace(/\s*[([](?:\d{4}\s+)?remaster(?:ed)?[^\])]*[\])]/gi, "")
    .replace(/\s*[-–—]\s*(?:\d{4}\s+)?remaster(?:ed)?.*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function explorationTrackKey(track) {
  const isrc = cleanText(track?.isrc).toLocaleUpperCase();
  if (isrc) return `isrc:${isrc}`;
  const title = comparableTrackTitle(track?.title);
  const artist = normalizeText(track?.artistName);
  const durationBucket = Math.round((Number(track?.durationMs) || 0) / 2_000);
  if (title) return `track:${artist}:${title}:${durationBucket}`;
  return `apple:${cleanText(track?.id)}`;
}

function localReleaseTitleKeys(release) {
  return new Set(
    [
      release?.title,
      release?.translatedTitle,
      ...(release?.titleAliases ?? []),
    ]
      .map(releaseTitleKey)
      .filter(Boolean),
  );
}

function compatibleReleaseType(localRelease, catalogRelease) {
  const localType = cleanText(localRelease?.releaseType).toLocaleUpperCase();
  return (
    !RELEASE_TYPES.has(localType) || localType === catalogRelease.releaseType
  );
}

function releaseYear(value) {
  return cleanText(value).match(/^\d{4}/)?.[0] ?? "";
}

export function matchExplorationReleases(catalogReleases = [], localReleases = []) {
  const exactCatalogIds = new Map(
    catalogReleases.map((release) => [String(release.id), release]),
  );
  const matches = new Map();

  for (const localRelease of localReleases) {
    const exactAppleAlbum = findConfirmedAppleMusicCatalogAlbum(localRelease);
    const exact = exactAppleAlbum
      ? exactCatalogIds.get(String(exactAppleAlbum.sourceAlbumId))
      : null;
    if (exact) {
      matches.set(exact.id, {
        localRelease,
        method: "APPLE_MUSIC_ALBUM_ID",
      });
      continue;
    }

    const titleKeys = localReleaseTitleKeys(localRelease);
    if (!titleKeys.size) continue;
    let candidates = catalogReleases.filter(
      (catalogRelease) =>
        titleKeys.has(releaseTitleKey(catalogRelease.title)) &&
        compatibleReleaseType(localRelease, catalogRelease),
    );
    const localYear = releaseYear(localRelease.releaseDate);
    if (candidates.length > 1 && localYear) {
      const dated = candidates.filter(
        (candidate) => releaseYear(candidate.releaseDate) === localYear,
      );
      if (dated.length) candidates = dated;
    }
    if (candidates.length !== 1 || matches.has(candidates[0].id)) continue;
    matches.set(candidates[0].id, {
      localRelease,
      method: "EXACT_SCOPED_TITLE",
    });
  }
  return matches;
}

export function buildArtistExplorationModel(catalog, localReleases = []) {
  const catalogReleases = Array.isArray(catalog?.releases)
    ? catalog.releases
    : [];
  const matches = matchExplorationReleases(catalogReleases, localReleases);
  const heardTrackKeys = new Set();
  let matchedReleaseCount = 0;
  let ratedReleaseCount = 0;

  for (const release of catalogReleases) {
    const match = matches.get(release.id);
    if (!match) continue;
    matchedReleaseCount += 1;
    const rating = getCurrentRating(match.localRelease.listeningEntries);
    if (rating == null) continue;
    ratedReleaseCount += 1;
    for (const track of release.tracks ?? []) {
      heardTrackKeys.add(explorationTrackKey(track));
    }
  }

  const uniqueTrackKeys = new Set();
  const releases = catalogReleases.map((release) => {
    const match = matches.get(release.id);
    const rating = match
      ? getCurrentRating(match.localRelease.listeningEntries)
      : null;
    const tracks = (release.tracks ?? []).map((track) => {
      const key = explorationTrackKey(track);
      uniqueTrackKeys.add(key);
      return { ...track, key, listened: heardTrackKeys.has(key) };
    });
    const heardTrackCount = tracks.filter((track) => track.listened).length;
    return {
      ...release,
      tracks,
      heardTrackCount,
      completionPercent: tracks.length
        ? Math.round((heardTrackCount / tracks.length) * 100)
        : 0,
      matchedReleaseId: match?.localRelease?.id ?? "",
      matchMethod: match?.method ?? "",
      rating,
      listened: rating != null,
    };
  });

  let heardUniqueTrackCount = 0;
  for (const key of uniqueTrackKeys) {
    if (heardTrackKeys.has(key)) heardUniqueTrackCount += 1;
  }
  const uniqueTrackCount = uniqueTrackKeys.size;
  return {
    artistName: cleanText(catalog?.artistName),
    checkedAt: cleanText(catalog?.checkedAt),
    source: cleanText(catalog?.source) || "Apple Music",
    releases,
    uniqueTrackCount,
    heardUniqueTrackCount,
    completionPercent: uniqueTrackCount
      ? Math.round((heardUniqueTrackCount / uniqueTrackCount) * 100)
      : 0,
    matchedReleaseCount,
    ratedReleaseCount,
  };
}

function explorationReleaseGroupKey(release) {
  const title = explorationReleaseFamilyTitle(release?.title);
  const releaseDate = cleanText(release?.releaseDate);
  const releaseType = cleanText(release?.releaseType).toLocaleUpperCase();
  if (!title || !releaseDate || !RELEASE_TYPES.has(releaseType)) {
    return `id:${cleanText(release?.id)}`;
  }
  return `${releaseType}:${releaseDate}:${title}`;
}

function preferredExplorationVariant(left, right) {
  const leftRated = left?.rating != null ? 1 : 0;
  const rightRated = right?.rating != null ? 1 : 0;
  if (leftRated !== rightRated) return rightRated - leftRated;
  const leftMatched = left?.matchedReleaseId ? 1 : 0;
  const rightMatched = right?.matchedReleaseId ? 1 : 0;
  if (leftMatched !== rightMatched) return rightMatched - leftMatched;
  const trackDifference = (right?.tracks?.length ?? 0) - (left?.tracks?.length ?? 0);
  if (trackDifference) return trackDifference;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

export function groupExplorationReleases(releases = []) {
  const groups = new Map();
  for (const release of releases) {
    const key = explorationReleaseGroupKey(release);
    const group = groups.get(key) ?? [];
    group.push(release);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) {
      return {
        ...group[0],
        variantCount: 1,
        collapsedVariantCount: 0,
      };
    }

    const variants = [...group].sort(preferredExplorationVariant);
    const primary = variants[0];
    const tracks = primary.tracks ?? [];
    const heardTrackCount = tracks.filter((track) => track.listened).length;
    return {
      ...primary,
      tracks,
      heardTrackCount,
      completionPercent: tracks.length
        ? Math.round((heardTrackCount / tracks.length) * 100)
        : 0,
      variantCount: variants.length,
      collapsedVariantCount: variants.length - 1,
      variantReleaseIds: variants.map((variant) => variant.id),
      collapsedVariants: variants.slice(1).map((variant) => ({
        id: variant.id,
        trackCount: variant.tracks?.length ?? 0,
        url: variant.url ?? "",
      })),
    };
  });
}
