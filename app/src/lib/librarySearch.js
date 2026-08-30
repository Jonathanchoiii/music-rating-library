import {
  compareReleaseDates,
  getCurrentRating,
  getLatestListenedAt,
  getReleaseContextMatches,
  normalizeText,
  releaseMatchesPrimarySearch,
} from "./music.js";
import { releaseMatchesMappedArtistQuery } from "./artists.js";
import { decodeArtistProfileId } from "./artistProfiles.js";
import { releaseMatchesLibraryFilters } from "./filters.js";

export function compareLibraryReleases(releaseA, releaseB, sort) {
  if (sort === "rating_desc") {
    return (
      (getCurrentRating(releaseB.listeningEntries) ?? -1) -
      (getCurrentRating(releaseA.listeningEntries) ?? -1)
    );
  }
  if (sort === "title_asc") {
    return releaseA.title.localeCompare(releaseB.title, "zh-CN");
  }
  if (sort === "released_desc") {
    return compareReleaseDates(releaseA, releaseB, "desc");
  }
  if (sort === "released_asc") {
    return compareReleaseDates(releaseA, releaseB, "asc");
  }
  return (
    Date.parse(getLatestListenedAt(releaseB.listeningEntries) ?? 0) -
    Date.parse(getLatestListenedAt(releaseA.listeningEntries) ?? 0)
  );
}

export function getLibrarySearchResults({
  releases,
  search,
  filters,
  artistIdentityState,
  listeningGuideStatuses,
  sort,
}) {
  const query = normalizeText(search);
  const filtered = releases.filter((release) =>
    releaseMatchesLibraryFilters(
      release,
      filters,
      artistIdentityState,
      listeningGuideStatuses,
    ),
  );
  const sortReleases = (releaseA, releaseB) =>
    compareLibraryReleases(releaseA, releaseB, sort);
  if (!query) {
    return {
      primary: [...filtered].sort(sortReleases),
      contextual: [],
    };
  }

  const primary = filtered
    .filter(
      (release) =>
        releaseMatchesPrimarySearch(release, query) ||
        releaseMatchesMappedArtistQuery(release, query, artistIdentityState),
    )
    .sort(sortReleases);
  const primaryIds = new Set(primary.map((release) => release.id));
  const contextual = filtered
    .filter((release) => !primaryIds.has(release.id))
    .map((release) => ({
      release,
      matches: getReleaseContextMatches(release, query),
    }))
    .filter((result) => result.matches.length)
    .sort((resultA, resultB) =>
      sortReleases(resultA.release, resultB.release),
    );
  return { primary, contextual };
}

export function countReleaseTypes(releases) {
  return releases.reduce(
    (result, release) => {
      result.ALL += 1;
      result[release.releaseType] = (result[release.releaseType] ?? 0) + 1;
      return result;
    },
    { ALL: 0, LP: 0, EP: 0, SINGLE: 0 },
  );
}

export function getLibraryRouteState(location) {
  const pathname = location.pathname;
  const params = new URLSearchParams(location.search);
  const rawArtistId = params.get("artist") ?? "";
  const selectedArtistId = decodeArtistProfileId(rawArtistId) || rawArtistId;
  const isArtistRoute = pathname === "/artists";
  const isRoamRoute = pathname === "/roam" || pathname.startsWith("/roam/");
  const selectedRoamCountry = pathname.startsWith("/roam/")
    ? decodeURIComponent(pathname.split("/").filter(Boolean).pop()).toUpperCase()
    : "";
  const isDuplicateRoute =
    pathname === "/settings/duplicates" || pathname === "/duplicates";
  const isSettingsRoute =
    pathname === "/settings" || pathname === "/settings/artists";
  return {
    isArtistRoute,
    isRoamRoute,
    selectedRoamCountry,
    isAddRoute: pathname === "/admin/add",
    isImportRoute: pathname === "/admin/import",
    isSyncRoute: pathname === "/sync",
    isSettingsRoute,
    isArtistSettingsRoute: pathname === "/settings/artists",
    isDuplicateRoute,
    selectedArtistId,
    isArtistIndex: isArtistRoute && !selectedArtistId,
    detailId: pathname.startsWith("/releases/")
      ? decodeURIComponent(pathname.split("/").pop())
      : null,
    detailReturnTarget: params.get("from"),
    detailReturnArtistId: selectedArtistId,
    detailReturnCountryCode: (params.get("country") ?? "").toUpperCase(),
  };
}
