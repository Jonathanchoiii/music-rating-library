import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_LIBRARY_FILTERS,
  activeFilterCount,
  collectTrustedFacetOptions,
  collectVisibleTrustedFacetOptions,
  releaseMatchesLibraryFilters,
  sanitizeLibraryFilters,
} from "../src/lib/filters.js";
import { DEFAULT_ARTIST_IDENTITY_STATE } from "../src/lib/artists.js";

function release(overrides = {}) {
  return {
    id: "release",
    title: "Release",
    artists: ["魏如萱"],
    releaseType: "LP",
    releaseDate: "2024-05-10",
    genres: [],
    styles: [],
    catalogLanguages: [],
    editionTypes: [],
    releaseCountries: [],
    labels: [],
    coverUrl: "https://example.com/cover.jpg",
    markStatus: "complete",
    externalLinks: [],
    listeningEntries: [
      {
        listenedAt: "2025-03-01T00:00:00Z",
        ratedAt: "2025-03-01T00:00:00Z",
        createdAt: "2025-02-20T00:00:00Z",
        rating10: 8,
        comment: "很好",
      },
    ],
    ...overrides,
  };
}

test("different filter dimensions combine with AND", () => {
  const filters = {
    ...EMPTY_LIBRARY_FILTERS,
    releaseDateFrom: "2024-01-01",
    releaseDateTo: "2024-12-31",
    releaseTypes: ["LP", "EP"],
    ratingMin: "8",
    commentState: "WITH_COMMENT",
  };
  assert.equal(
    releaseMatchesLibraryFilters(
      release(),
      filters,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
  assert.equal(
    releaseMatchesLibraryFilters(
      release({ releaseType: "SINGLE" }),
      filters,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    false,
  );
});

test("multiple values inside one dimension combine with OR", () => {
  const filters = {
    ...EMPTY_LIBRARY_FILTERS,
    platforms: ["APPLE_MUSIC", "SPOTIFY"],
  };
  const item = release({
    externalLinks: [
      {
        provider: "SPOTIFY",
        url: "https://open.spotify.com/album/example",
        status: "CONFIRMED",
      },
    ],
  });
  assert.equal(
    releaseMatchesLibraryFilters(
      item,
      filters,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
});

test("artist filters resolve a mapped alias to the same stable identity", () => {
  const filters = {
    ...EMPTY_LIBRARY_FILTERS,
    artistIds: ["mbid-3821e3ac-4d91-40b8-a669-f58d1fe2c0c4"],
  };
  assert.equal(
    releaseMatchesLibraryFilters(
      release({ artists: ["Waa Wei"] }),
      filters,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
});

test("unknown dates are excluded only when a date range is active", () => {
  assert.equal(
    releaseMatchesLibraryFilters(
      release({ releaseDate: null }),
      EMPTY_LIBRARY_FILTERS,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
  assert.equal(
    releaseMatchesLibraryFilters(
      release({ releaseDate: null }),
      { ...EMPTY_LIBRARY_FILTERS, releaseDateFrom: "2020-01-01" },
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    false,
  );
});

test("legacy marked-date filters are discarded in favor of listened time", () => {
  const filters = sanitizeLibraryFilters({
    markedDateFrom: "2025-01-01",
    markedDateTo: "2025-12-31",
    listenedDateFrom: "2025-03-01",
    listenedDateTo: "2025-03-01",
  });

  assert.equal("markedDateFrom" in filters, false);
  assert.equal("markedDateTo" in filters, false);
  assert.equal(activeFilterCount(filters), 1);
  assert.equal(
    releaseMatchesLibraryFilters(
      release(),
      filters,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
});

test("legacy missing-language completeness filters are discarded", () => {
  const filters = sanitizeLibraryFilters({
    completeness: ["MISSING_LANGUAGE", "MISSING_GENRE"],
  });

  assert.deepEqual(filters.completeness, ["MISSING_GENRE"]);
  assert.equal(activeFilterCount(filters), 1);
});

test("unsupported inferred facets never become filter options", () => {
  const releases = [
    release({
      genres: ["Dream Pop"],
      genreSource: "FUZZY_INFERRED",
    }),
    release({
      id: "unproven",
      genres: ["Guesscore"],
    }),
    release({
      id: "verified",
      genres: ["Art Pop"],
      genreSource: "MUSICBRAINZ_EXACT",
    }),
  ];
  assert.deepEqual(collectTrustedFacetOptions(releases, "genres"), [
    { value: "Art Pop", count: 1 },
  ]);
});

test("external filter dimensions without trusted options stay hidden", () => {
  const releases = [
    release({
      genres: ["Art Pop"],
      genreSource: "APPLE_MUSIC_EXACT",
    }),
    release({
      id: "unverified-style",
      styles: ["Dream Pop"],
      styleSource: "FUZZY_INFERRED",
    }),
  ];

  assert.deepEqual(
    collectVisibleTrustedFacetOptions(releases, [
      "genres",
      "styles",
      "catalogLanguages",
      "editionTypes",
      "releaseCountries",
      "labels",
      "mediaFormats",
    ]),
    {
      genres: [{ value: "Art Pop", count: 1 }],
    },
  );
});

test("completeness filters expose missing metadata without inventing it", () => {
  const filters = {
    ...EMPTY_LIBRARY_FILTERS,
    completeness: ["MISSING_GENRE"],
  };
  assert.equal(
    releaseMatchesLibraryFilters(
      release(),
      filters,
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
});
