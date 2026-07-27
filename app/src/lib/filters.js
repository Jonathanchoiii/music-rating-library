import {
  getCurrentRating,
  getLatestListenedAt,
  normalizeText,
  splitArtistCredits,
} from "./music.js";
import {
  getArtistAliasIndex,
  resolveArtistCredit,
} from "./artists.js";
import { notifySharedLocalStateChanged } from "./sharedLocalState.js";

export const LIBRARY_FILTER_STORAGE_KEY = "recordshelf-library-filters-v1";

export const EMPTY_LIBRARY_FILTERS = {
  releaseDateFrom: "",
  releaseDateTo: "",
  listenedDateFrom: "",
  listenedDateTo: "",
  listenedDateMode: "LATEST",
  artistIds: [],
  releaseTypes: [],
  ratingState: "ANY",
  ratingMin: "",
  ratingMax: "",
  markStatuses: [],
  commentState: "ANY",
  listenCount: "ANY",
  platforms: [],
  completeness: [],
  confidence: [],
  genres: [],
  styles: [],
  catalogLanguages: [],
  editionTypes: [],
  releaseCountries: [],
  labels: [],
  mediaFormats: [],
};

const ARRAY_FILTER_FIELDS = [
  "artistIds",
  "releaseTypes",
  "markStatuses",
  "platforms",
  "completeness",
  "confidence",
  "genres",
  "styles",
  "catalogLanguages",
  "editionTypes",
  "releaseCountries",
  "labels",
  "mediaFormats",
];

const FACET_FIELD_CONFIG = {
  genres: { sourceFields: ["genreSource", "genresSource"] },
  styles: { sourceFields: ["styleSource", "stylesSource"] },
  catalogLanguages: {
    sourceFields: ["catalogLanguageSource", "languageSource"],
  },
  editionTypes: {
    sourceFields: ["editionTypeSource", "secondaryTypeSource"],
  },
  releaseCountries: {
    sourceFields: ["releaseCountrySource", "countrySource"],
  },
  labels: { sourceFields: ["labelSource", "labelsSource"] },
  mediaFormats: { sourceFields: ["mediaFormatSource", "formatSource"] },
};

function uniqueStrings(values = []) {
  return [
    ...new Map(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").normalize("NFKC").trim())
        .filter(Boolean)
        .map((value) => [normalizeText(value), value]),
    ).values(),
  ];
}

export function sanitizeLibraryFilters(filters = {}) {
  const sanitized = Object.fromEntries(
    Object.entries(EMPTY_LIBRARY_FILTERS).map(([field, defaultValue]) => [
      field,
      filters[field] ?? defaultValue,
    ]),
  );
  for (const field of ARRAY_FILTER_FIELDS) {
    sanitized[field] = uniqueStrings(filters[field] ?? []);
  }
  sanitized.completeness = sanitized.completeness.filter(
    (value) => value !== "MISSING_LANGUAGE",
  );
  return sanitized;
}

export function loadLibraryFilters(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(LIBRARY_FILTER_STORAGE_KEY);
    if (saved) return sanitizeLibraryFilters(JSON.parse(saved));
  } catch (error) {
    console.warn("筛选条件暂时无法读取", error);
  }
  return sanitizeLibraryFilters();
}

export function saveLibraryFilters(
  filters,
  storage = globalThis.localStorage,
) {
  const sanitized = sanitizeLibraryFilters(filters);
  try {
    storage?.setItem(
      LIBRARY_FILTER_STORAGE_KEY,
      JSON.stringify(sanitized),
    );
    if (storage === globalThis.localStorage) {
      notifySharedLocalStateChanged();
    }
  } catch (error) {
    console.warn("筛选条件暂时无法保存", error);
  }
  return sanitized;
}

export function activeFilterCount(filters = {}) {
  const value = sanitizeLibraryFilters(filters);
  return [
    value.releaseDateFrom || value.releaseDateTo,
    value.listenedDateFrom || value.listenedDateTo,
    value.artistIds.length,
    value.releaseTypes.length,
    value.ratingState !== "ANY" ||
      value.ratingMin !== "" ||
      value.ratingMax !== "",
    value.markStatuses.length,
    value.commentState !== "ANY",
    value.listenCount !== "ANY",
    value.platforms.length,
    value.completeness.length,
    value.confidence.length,
    value.genres.length,
    value.styles.length,
    value.catalogLanguages.length,
    value.editionTypes.length,
    value.releaseCountries.length,
    value.labels.length,
    value.mediaFormats.length,
  ].filter(Boolean).length;
}

function dateOnly(value) {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

function dateInRange(value, from, to) {
  if (!from && !to) return true;
  const comparable = dateOnly(value);
  if (!comparable) return false;
  if (from && comparable < from) return false;
  if (to && comparable > to) return false;
  return true;
}

function earliestListenedAt(entries = []) {
  return (
    entries
      .map((entry) => entry.listenedAt)
      .filter(Boolean)
      .sort((dateA, dateB) => Date.parse(dateA) - Date.parse(dateB))[0] ??
    null
  );
}

export function getTrustedFacetValues(release, field) {
  const values = uniqueStrings(release?.[field] ?? []);
  if (!values.length) return [];
  const config = FACET_FIELD_CONFIG[field];
  const evidence = release?.metadataEvidence?.[field];
  const source = config?.sourceFields
    .map((sourceField) => release?.[sourceField])
    .find(Boolean);
  const sourceLabel = normalizeText(source);
  const evidenceStatus = normalizeText(
    evidence?.match_status ?? evidence?.matchStatus ?? evidence?.status,
  );
  const sourceIsTrusted = [
    "user",
    "exact",
    "verified",
    "confirmed",
    "musicbrainz",
    "apple",
    "discogs",
    "neodb_structured",
  ].some((marker) => sourceLabel.includes(marker));
  const evidenceIsTrusted = ["exact", "verified", "user_confirmed"].some(
    (marker) => evidenceStatus.includes(marker),
  );
  if (
    (!sourceIsTrusted && !evidenceIsTrusted) ||
    evidenceStatus.includes("conflict") ||
    evidenceStatus.includes("rejected") ||
    sourceLabel.includes("inferred") ||
    sourceLabel.includes("fuzzy") ||
    sourceLabel.includes("unverified")
  ) {
    return [];
  }
  return values;
}

export function collectTrustedFacetOptions(releases = [], field) {
  const counts = new Map();
  for (const release of releases) {
    for (const value of getTrustedFacetValues(release, field)) {
      const key = normalizeText(value);
      const current = counts.get(key) ?? { value, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort(
    (optionA, optionB) =>
      optionB.count - optionA.count ||
      optionA.value.localeCompare(optionB.value, "zh-CN"),
  );
}

function releaseArtistIds(release, artistIdentityState) {
  const aliasIndex = getArtistAliasIndex(artistIdentityState);
  return new Set(
    splitArtistCredits(release.artists).map(
      (credit) =>
        resolveArtistCredit(credit, artistIdentityState, aliasIndex).id,
    ),
  );
}

function hasPlatform(release, provider) {
  const links = release.externalLinks ?? [];
  if (provider === "NO_STREAMING") {
    return !links.some(
      (link) =>
        ["APPLE_MUSIC", "SPOTIFY"].includes(link.provider) &&
        link.status !== "REJECTED",
    );
  }
  return links.some(
    (link) => link.provider === provider && link.status !== "REJECTED",
  );
}

function releaseHasComment(release) {
  return (release.listeningEntries ?? []).some((entry) =>
    String(entry.comment ?? "").trim(),
  );
}

function listenedEntryCount(release) {
  return (release.listeningEntries ?? []).filter((entry) => entry.listenedAt)
    .length;
}

function matchesListenCount(release, listenCount) {
  if (listenCount === "ANY") return true;
  const count = listenedEntryCount(release);
  if (listenCount === "NONE") return count === 0;
  if (listenCount === "ONE") return count === 1;
  if (listenCount === "TWO_THREE") return count >= 2 && count <= 3;
  if (listenCount === "FOUR_PLUS") return count >= 4;
  return true;
}

function matchesCompleteness(release, value) {
  if (value === "MISSING_DATE") return !release.releaseDate;
  if (value === "MISSING_TYPE") return release.releaseType === "OTHER";
  if (value === "MISSING_COVER") return !release.coverUrl;
  if (value === "MISSING_STREAMING") {
    return hasPlatform(release, "NO_STREAMING");
  }
  if (value === "MISSING_GENRE") {
    return getTrustedFacetValues(release, "genres").length === 0;
  }
  return false;
}

function matchesFacet(release, field, selectedValues) {
  if (!selectedValues.length) return true;
  const releaseValues = new Set(
    getTrustedFacetValues(release, field).map(normalizeText),
  );
  return selectedValues.some((value) => releaseValues.has(normalizeText(value)));
}

export function getReleaseEvidenceStates(release) {
  const states = new Set();
  const sourceValues = [
    release.releaseTypeSource,
    release.releaseDateSource,
    release.genreSource,
    release.styleSource,
    release.catalogLanguageSource,
    release.editionTypeSource,
    release.releaseCountrySource,
    release.labelSource,
    release.mediaFormatSource,
  ]
    .map(normalizeText)
    .filter(Boolean);
  const evidenceValues = Object.values(release.metadataEvidence ?? {});
  if (
    release.releaseTypeUserConfirmed ||
    sourceValues.some((source) => source.includes("user")) ||
    evidenceValues.some((evidence) =>
      normalizeText(evidence?.status).includes("user"),
    )
  ) {
    states.add("USER_CONFIRMED");
  }
  if (
    sourceValues.some(
      (source) =>
        source.includes("exact") ||
        source.includes("consensus") ||
        source.includes("musicbrainz") ||
        source.includes("apple") ||
        source.includes("discogs"),
    ) ||
    evidenceValues.some((evidence) =>
      ["verified", "exact", "confirmed"].some((status) =>
        normalizeText(evidence?.status).includes(status),
      ),
    )
  ) {
    states.add("VERIFIED");
  }
  if (
    !release.releaseDate ||
    release.releaseType === "OTHER" ||
    release.releaseDateConflict ||
    evidenceValues.some((evidence) =>
      ["conflict", "rejected", "unverified"].some((status) =>
        normalizeText(evidence?.status).includes(status),
      ),
    )
  ) {
    states.add("NEEDS_REVIEW");
  }
  return states;
}

export function releaseMatchesLibraryFilters(
  release,
  rawFilters,
  artistIdentityState,
) {
  const filters = sanitizeLibraryFilters(rawFilters);
  if (
    !dateInRange(
      release.releaseDate,
      filters.releaseDateFrom,
      filters.releaseDateTo,
    )
  ) {
    return false;
  }

  const listenedAt =
    filters.listenedDateMode === "FIRST"
      ? earliestListenedAt(release.listeningEntries)
      : getLatestListenedAt(release.listeningEntries);
  if (
    !dateInRange(
      listenedAt,
      filters.listenedDateFrom,
      filters.listenedDateTo,
    )
  ) {
    return false;
  }

  if (filters.artistIds.length) {
    const ids = releaseArtistIds(release, artistIdentityState);
    if (!filters.artistIds.some((artistId) => ids.has(artistId))) {
      return false;
    }
  }

  if (
    filters.releaseTypes.length &&
    !filters.releaseTypes.includes(release.releaseType)
  ) {
    return false;
  }

  const rating = getCurrentRating(release.listeningEntries);
  if (filters.ratingState === "RATED" && rating == null) return false;
  if (filters.ratingState === "UNRATED" && rating != null) return false;
  if (
    rating != null &&
    filters.ratingMin !== "" &&
    rating < Number(filters.ratingMin)
  ) {
    return false;
  }
  if (
    rating != null &&
    filters.ratingMax !== "" &&
    rating > Number(filters.ratingMax)
  ) {
    return false;
  }
  if (
    rating == null &&
    (filters.ratingMin !== "" || filters.ratingMax !== "")
  ) {
    return false;
  }

  if (
    filters.markStatuses.length &&
    !filters.markStatuses.includes(release.markStatus)
  ) {
    return false;
  }
  if (
    filters.commentState === "WITH_COMMENT" &&
    !releaseHasComment(release)
  ) {
    return false;
  }
  if (
    filters.commentState === "WITHOUT_COMMENT" &&
    releaseHasComment(release)
  ) {
    return false;
  }
  if (!matchesListenCount(release, filters.listenCount)) return false;

  if (
    filters.platforms.length &&
    !filters.platforms.some((provider) => hasPlatform(release, provider))
  ) {
    return false;
  }

  if (
    filters.completeness.length &&
    !filters.completeness.some((value) =>
      matchesCompleteness(release, value),
    )
  ) {
    return false;
  }
  if (filters.confidence.length) {
    const states = getReleaseEvidenceStates(release);
    if (!filters.confidence.some((value) => states.has(value))) {
      return false;
    }
  }

  return [
    "genres",
    "styles",
    "catalogLanguages",
    "editionTypes",
    "releaseCountries",
    "labels",
    "mediaFormats",
  ].every((field) => matchesFacet(release, field, filters[field]));
}

export function filterReleases(
  releases = [],
  filters,
  artistIdentityState,
) {
  return releases.filter((release) =>
    releaseMatchesLibraryFilters(release, filters, artistIdentityState),
  );
}
