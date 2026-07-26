import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCanonicalTitleEvidence,
  classifyImportedRelease,
  compareReleaseDates,
  csvRowToRelease,
  detectHeaderMap,
  findExactNeoDbDuplicateGroups,
  findReleaseByPlatformUrl,
  getCurrentRating,
  getDatePrecision,
  getLatestMarkedAt,
  getNextVisibleLimit,
  getReleaseContextMatches,
  getReleaseKindLabel,
  groupReleasesByArtist,
  inferReleaseTypeFromOfficialTitle,
  normalizeArtistField,
  normalizeExternalReleaseType,
  normalizeNeoDbUrl,
  normalizeSupportedReleaseUrl,
  normalizeReleaseType,
  reconcileCanonicalCoverOverride,
  reconcileCanonicalExternalLinkOverride,
  reconcileCanonicalTitleOverride,
  releaseMatchesArtistQuery,
  releaseMatchesPrimarySearch,
  releaseFingerprint,
  releaseImportIdentityKey,
  releasesHaveConflictingSourceIdentities,
  scoreToStars,
} from "../src/lib/music.js";
import {
  advanceNeoDbRemovalReview,
  applyNeoDbCanonicalMappings,
  applyNeoDbSyncPlan,
  applyReleaseTypeVerification,
  buildNeoDbCanonicalAliases,
  buildNeoDbSyncPlan,
  buildVerifiedNeoDbRemovalCandidates,
  dedupeEquivalentListeningEntries,
  getReleaseTypeVerificationFingerprint,
  neoDbMarkHash,
  neoDbMarkToRelease,
  pullNeoDbDelta,
  verifyChangedReleaseTypes,
} from "../src/lib/neodbSync.js";

test("supported release links normalize only exact album platforms", () => {
  assert.deepEqual(
    normalizeSupportedReleaseUrl(
      "https://open.spotify.com/album/abc123?si=tracking",
    ),
    {
      provider: "SPOTIFY",
      providerLabel: "Spotify",
      normalizedUrl: "https://open.spotify.com/album/abc123",
    },
  );
  assert.equal(
    normalizeSupportedReleaseUrl("https://open.spotify.com/track/abc123"),
    null,
  );
});

test("detail merge lookup requires another record on the same exact platform", () => {
  const releases = [
    {
      id: "current",
      externalLinks: [
        {
          provider: "NEODB",
          url: "https://neodb.social/album/current",
        },
      ],
      listeningEntries: [],
    },
    {
      id: "candidate",
      externalLinks: [
        {
          provider: "NEODB",
          url: "https://neodb.social/album/candidate",
        },
        {
          provider: "APPLE_MUSIC",
          url: "https://music.apple.com/cn/album/example/123",
        },
      ],
      listeningEntries: [],
    },
  ];

  const found = findReleaseByPlatformUrl(
    releases,
    "current",
    "https://neodb.social/album/candidate?ref=share",
  );
  assert.equal(found.status, "FOUND");
  assert.equal(found.candidate.id, "candidate");
  assert.equal(found.provider, "NEODB");

  assert.equal(
    findReleaseByPlatformUrl(
      releases,
      "current",
      "https://music.apple.com/cn/album/example/123",
    ).status,
    "PLATFORM_MISMATCH",
  );
  assert.equal(
    findReleaseByPlatformUrl(
      releases,
      "current",
      "https://neodb.social/album/current",
    ).status,
    "CURRENT_URL",
  );
});

test("exact title evidence promotes the release-language title and preserves the localized alias", () => {
  const release = applyCanonicalTitleEvidence(
    {
      id: "abba-gold",
      title: "纯金选",
      artists: ["ABBA"],
      titleAliases: [],
    },
    {
      title: "Gold: Greatest Hits",
      translatedTitle: "纯金选",
      source: "DOUBAN_EXACT",
      matchedFrom: "https://music.douban.com/subject/1424233/",
      verifiedAt: "2026-07-26T00:00:00.000Z",
    },
  );

  assert.equal(release.title, "Gold: Greatest Hits");
  assert.equal(release.translatedTitle, "纯金选");
  assert.deepEqual(release.titleAliases, ["纯金选"]);
  assert.equal(release.titleSource, "DOUBAN_EXACT");
});

test("canonical title upgrades discard only a legacy swapped title override", () => {
  const baseRelease = {
    title: "Gold: Greatest Hits",
    translatedTitle: "纯金选",
    titleAliases: ["纯金选"],
    titleSource: "DOUBAN_EXACT",
  };

  assert.deepEqual(
    reconcileCanonicalTitleOverride(baseRelease, {
      translatedTitle: "Gold: Greatest Hits",
      releaseType: "LP",
    }),
    { releaseType: "LP" },
  );
  assert.deepEqual(
    reconcileCanonicalTitleOverride(baseRelease, {
      title: "My preferred title",
      translatedTitle: "自定义译名",
    }),
    {
      title: "My preferred title",
      translatedTitle: "自定义译名",
      titleAliases: ["纯金选"],
    },
  );
  assert.deepEqual(
    reconcileCanonicalTitleOverride(
      {
        ...baseRelease,
        titleAliases: ["纯金选", "旧主标题"],
      },
      { titleAliases: ["纯金选"] },
    ).titleAliases,
    ["纯金选", "旧主标题"],
  );
});

test("canonical NeoDB upgrades replace a stale local link override", () => {
  const oldUrl = "https://neodb.social/album/old-item";
  const canonicalUrl = "https://neodb.social/album/current-item";
  const baseRelease = {
    externalLinks: [
      {
        provider: "NEODB",
        url: canonicalUrl,
        originalUrl: oldUrl,
        canonicalUrl,
        status: "CONFIRMED",
      },
    ],
  };
  const override = reconcileCanonicalExternalLinkOverride(baseRelease, {
    externalLinks: [
      { provider: "NEODB", url: oldUrl, status: "CONFIRMED" },
      {
        provider: "SPOTIFY",
        url: "https://open.spotify.com/album/example",
        status: "CONFIRMED",
      },
    ],
  });

  assert.equal(override.externalLinks[0].url, canonicalUrl);
  assert.equal(override.externalLinks[0].originalUrl, oldUrl);
  assert.equal(override.externalLinks[1].provider, "SPOTIFY");
});

test("a pre-split link override cannot reassign a release to another NeoDB identity", () => {
  const baseRelease = {
    externalLinks: [
      {
        provider: "NEODB",
        url: "https://neodb.social/album/009hmT3TB9W1OHlJZvEpjx",
        status: "CONFIRMED",
      },
      {
        provider: "SPOTIFY",
        url: "https://open.spotify.com/album/4yvoTv5xoYbWzHGpVxGClR",
        status: "CONFIRMED",
      },
    ],
  };
  const override = reconcileCanonicalExternalLinkOverride(baseRelease, {
    title: "User title",
    externalLinks: [
      {
        provider: "NEODB",
        url: "https://neodb.social/album/0Zv5gRpVX2iT3ys4Kla1SD",
        status: "CONFIRMED",
      },
      {
        provider: "SPOTIFY",
        url: "https://open.spotify.com/album/3o1TOhMkU5FFMSJMDhXfdF",
        status: "CONFIRMED",
      },
    ],
  });

  assert.equal(override.title, "User title");
  assert.equal(Object.hasOwn(override, "externalLinks"), false);
});

test("exact Apple and Spotify cover consensus replaces a stale pre-split cover", () => {
  const baseRelease = {
    coverUrl: "https://is1-ssl.mzstatic.com/correct.jpg",
    coverSource: "EXACT_PLATFORM_CONSENSUS",
    coverEvidence: [
      {
        source: "APPLE_LOOKUP",
        url: "https://is1-ssl.mzstatic.com/correct.jpg",
      },
      {
        source: "SPOTIFY_OEMBED",
        url: "https://image-cdn-ak.spotifycdn.com/correct.jpg",
      },
    ],
  };
  assert.deepEqual(
    reconcileCanonicalCoverOverride(baseRelease, {
      coverUrl: "https://neodb.social/stale-other-edition.jpg",
      title: "User title",
    }),
    { title: "User title" },
  );
  assert.equal(
    reconcileCanonicalCoverOverride(baseRelease, {
      coverUrl: "https://example.com/user-cover.jpg",
      coverUserConfirmed: true,
    }).coverUrl,
    "https://example.com/user-cover.jpg",
  );
});

test("exact edition evidence keeps Deluxe in the primary title", () => {
  const release = applyCanonicalTitleEvidence(
    {
      id: "jamie-xx-in-waves-deluxe",
      title: "In Waves",
      translatedTitle: "In Waves (Deluxe)",
      platformTitle: "In Waves (Deluxe)",
      artists: ["Jamie xx"],
    },
    {
      title: "In Waves (Deluxe)",
      source: "APPLE_LOOKUP",
      matchedFrom: "https://music.apple.com/album/1782188661",
      verifiedAt: "2026-07-25T14:28:37.207Z",
      platformTitle: "In Waves (Deluxe)",
    },
  );

  assert.equal(release.title, "In Waves (Deluxe)");
  assert.equal(release.translatedTitle, "In Waves");
  assert.deepEqual(release.titleAliases, ["In Waves"]);
});

test("9/10 maps to 4.5 stars", () => {
  assert.equal(scoreToStars(9), 4.5);
  assert.equal(scoreToStars(null), null);
});

test("automatic pagination advances one bounded batch at a time", () => {
  assert.equal(getNextVisibleLimit(84, 1833, 84), 168);
  assert.equal(getNextVisibleLimit(1800, 1833, 84), 1833);
  assert.equal(getNextVisibleLimit(84, 40, 84), 40);
});

test("release date sorting keeps unknown dates last in both directions", () => {
  const releases = [
    { id: "unknown", releaseDate: null },
    { id: "new", releaseDate: "2026-07-24" },
    { id: "old", releaseDate: "1984" },
    { id: "middle", releaseDate: "2001-09" },
  ];
  assert.deepEqual(
    [...releases]
      .sort((a, b) => compareReleaseDates(a, b, "asc"))
      .map((release) => release.id),
    ["old", "middle", "new", "unknown"],
  );
  assert.deepEqual(
    [...releases]
      .sort((a, b) => compareReleaseDates(a, b, "desc"))
      .map((release) => release.id),
    ["new", "middle", "old", "unknown"],
  );
});

test("current rating uses the latest rated entry and preserves history", () => {
  const entries = [
    {
      rating10: 8,
      ratedAt: "2025-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
    },
    {
      rating10: 9,
      ratedAt: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  assert.equal(getCurrentRating(entries), 9);
  assert.equal(entries.length, 2);
});

test("release type aliases normalize to PRD values", () => {
  assert.equal(normalizeReleaseType("album"), "LP");
  assert.equal(normalizeReleaseType("单曲"), "SINGLE");
  assert.equal(normalizeReleaseType("unknown format"), "OTHER");
});

test("trusted external release types map only Album, EP and Single", () => {
  assert.equal(normalizeExternalReleaseType("Album · LP"), "LP");
  assert.equal(normalizeExternalReleaseType("EP"), "EP");
  assert.equal(normalizeExternalReleaseType("Digital · Single"), "SINGLE");
  assert.equal(normalizeExternalReleaseType("Compilation"), null);
  assert.equal(normalizeExternalReleaseType("Other"), null);
  assert.equal(normalizeExternalReleaseType("EP · Single"), null);
});

test("official title suffix identifies only explicit EP or Single labels", () => {
  assert.equal(
    inferReleaseTypeFromOfficialTitle("Good Luck, Babe! - Single"),
    "SINGLE",
  );
  assert.equal(inferReleaseTypeFromOfficialTitle("Only cry in the rain - EP"), "EP");
  assert.equal(inferReleaseTypeFromOfficialTitle("The Singles"), null);
  assert.equal(inferReleaseTypeFromOfficialTitle("An Album"), null);
});

test("date precision does not invent missing month or day", () => {
  assert.equal(getDatePrecision("2026"), "YEAR");
  assert.equal(getDatePrecision("2026-07"), "MONTH");
  assert.equal(getDatePrecision("2026-07-25"), "DAY");
  assert.equal(getDatePrecision("07/08/2026"), "UNKNOWN");
});

test("Chinese CSV headers map and create a listening entry", () => {
  const headers = ["专辑名", "艺人", "类型", "评分", "评论", "听过日期"];
  const map = detectHeaderMap(headers);
  const result = csvRowToRelease(
    {
      专辑名: "测试唱片",
      艺人: "测试艺人",
      类型: "EP",
      评分: "9",
      评论: "保留这一刻",
      听过日期: "2026-07-25",
    },
    map,
    2,
  );
  assert.equal(result.status, "WARNING");
  assert.equal(result.release.title, "测试唱片");
  assert.equal(result.release.listeningEntries[0].rating10, 9);
});

test("explicit CSV facets are user-provided evidence instead of inferred metadata", () => {
  const headers = [
    "专辑名",
    "艺人",
    "流派",
    "风格",
    "目录语言",
    "版本属性",
    "发行地区",
    "厂牌",
    "介质",
  ];
  const map = detectHeaderMap(headers);
  const result = csvRowToRelease(
    {
      专辑名: "Evidence",
      艺人: "Artist",
      流派: "Pop;Electronic",
      风格: "Synthpop",
      目录语言: "English",
      版本属性: "Deluxe",
      发行地区: "GB",
      厂牌: "Example Records",
      介质: "Digital;Vinyl",
    },
    map,
    3,
  );

  assert.deepEqual(result.release.genres, ["Pop", "Electronic"]);
  assert.deepEqual(result.release.styles, ["Synthpop"]);
  assert.deepEqual(result.release.catalogLanguages, ["English"]);
  assert.deepEqual(result.release.editionTypes, ["Deluxe"]);
  assert.deepEqual(result.release.releaseCountries, ["GB"]);
  assert.deepEqual(result.release.labels, ["Example Records"]);
  assert.deepEqual(result.release.mediaFormats, ["Digital", "Vinyl"]);
  assert.equal(result.release.genreSource, "USER_PROVIDED_IMPORT");
  assert.equal(result.release.catalogLanguageSource, "USER_PROVIDED_IMPORT");
});

test("stable source id is idempotent", () => {
  const existing = [
    {
      id: "existing",
      title: "Album",
      artists: ["Artist"],
      releaseDate: "2020",
      releaseType: "LP",
      listeningEntries: [
        { source: "NEODB", sourceItemId: "stable-id" },
      ],
    },
  ];
  const candidate = {
    status: "READY",
    errors: [],
    warnings: [],
    release: {
      title: "Album",
      artists: ["Artist"],
      releaseDate: "2020",
      releaseType: "LP",
      listeningEntries: [
        { source: "NEODB", sourceItemId: "stable-id" },
      ],
    },
  };
  assert.equal(
    classifyImportedRelease(candidate, existing).status,
    "DUPLICATE",
  );
});

test("release fingerprint is stable across case and spacing", () => {
  assert.equal(
    releaseFingerprint({
      title: "  Dream Album ",
      artists: ["ARTIST"],
      releaseDate: "2024-01-01",
      releaseType: "album",
    }),
    releaseFingerprint({
      title: "dream album",
      artists: ["artist"],
      releaseDate: "2024",
      releaseType: "LP",
    }),
  );
});

test("same title and artist with different NeoDB IDs remain separate releases", () => {
  const first = {
    title: "EUSEXUA",
    artists: ["FKA twigs"],
    releaseDate: null,
    releaseType: "OTHER",
    externalLinks: [
      {
        provider: "NEODB",
        url: "https://neodb.social/album/009hmT3TB9W1OHlJZvEpjx",
      },
    ],
    listeningEntries: [
      {
        source: "NEODB",
        sourceItemId: "009hmT3TB9W1OHlJZvEpjx",
      },
    ],
  };
  const second = {
    ...first,
    externalLinks: [
      {
        provider: "NEODB",
        url: "https://neodb.social/album/0Zv5gRpVX2iT3ys4Kla1SD",
      },
    ],
    listeningEntries: [
      {
        source: "NEODB",
        sourceItemId: "0Zv5gRpVX2iT3ys4Kla1SD",
      },
    ],
  };

  assert.notEqual(
    releaseImportIdentityKey(first),
    releaseImportIdentityKey(second),
  );
  assert.equal(releasesHaveConflictingSourceIdentities(first, second), true);
  assert.notEqual(
    classifyImportedRelease(
      { status: "READY", errors: [], warnings: [], release: second },
      [first],
    ).status,
    "DUPLICATE",
  );
});

test("localized source title still matches an imported duplicate", () => {
  const existing = {
    id: "existing",
    title: "Heaven or Las Vegas",
    translatedTitle: "天堂或拉斯维加斯",
    artists: ["Cocteau Twins"],
    releaseDate: "",
    releaseType: "OTHER",
    listeningEntries: [],
  };
  const candidate = {
    status: "READY",
    errors: [],
    warnings: [],
    release: {
      title: "天堂或拉斯维加斯",
      artists: ["Cocteau Twins"],
      releaseDate: "",
      releaseType: "OTHER",
      listeningEntries: [{}],
    },
  };
  assert.equal(
    classifyImportedRelease(candidate, [existing]).status,
    "DUPLICATE",
  );
});

test("NeoDB artist info removes only the artist field label", () => {
  assert.equal(normalizeArtistField("artist:Korn"), "Korn");
  assert.equal(normalizeArtistField(" Artist ： 李荣浩 "), "李荣浩");
  assert.equal(
    normalizeArtistField("Macklemore & Ryan Lewis"),
    "Macklemore & Ryan Lewis",
  );
  assert.equal(
    normalizeArtistField("artist:/person/2VoiktW7gmIMbZhf6JFD5P"),
    "Charli xcx",
  );
  assert.equal(
    normalizeArtistField(
      "artist:/organization/1ykXwtydTz68rbTS1Skr3v",
    ),
    "DOUDOU",
  );
  assert.equal(
    normalizeArtistField(
      "artist:ROSÉ//person/4hqCNGbaCePZSE4dd9vDLB",
    ),
    "ROSÉ/Bruno Mars",
  );
  assert.equal(
    normalizeArtistField("artist:/organization/unresolved"),
    "",
  );
});

test("artist search merges collaborations into the matched artist group", () => {
  const releases = [
    {
      id: "solo",
      title: "BRAT",
      artists: ["Charli xcx"],
      listeningEntries: [],
    },
    {
      id: "collaboration",
      title: "Guess",
      artists: ["Charli xcx/Billie Eilish"],
      listeningEntries: [],
    },
  ];

  const groups = groupReleasesByArtist(releases, "charli xcx");

  assert.equal(groups.length, 1);
  assert.equal(groups[0].artist, "Charli xcx");
  assert.deepEqual(
    groups[0].releases.map((release) => release.id),
    ["solo", "collaboration"],
  );
  assert.deepEqual(groups[0].releases[1].artists, [
    "Charli xcx/Billie Eilish",
  ]);
});

test("partial artist search keeps different matching artists separate", () => {
  const releases = [
    {
      id: "charli",
      artists: ["Charli xcx/Billie Eilish"],
      listeningEntries: [],
    },
    {
      id: "charlie",
      artists: ["Charlie Puth"],
      listeningEntries: [],
    },
  ];

  const groups = groupReleasesByArtist(releases, "charli");

  assert.deepEqual(
    groups.map((group) => group.artist),
    ["Charli xcx", "Charlie Puth"],
  );
});

test("artist-only filtering ignores a match found only outside artist credits", () => {
  assert.equal(
    releaseMatchesArtistQuery(
      {
        title: "A song about Charli xcx",
        artists: ["Unrelated Artist"],
      },
      "Charli xcx",
    ),
    false,
  );
  assert.equal(
    releaseMatchesArtistQuery(
      {
        title: "Guess",
        artists: ["Charli xcx/Billie Eilish"],
      },
      "Charli xcx",
    ),
    true,
  );
});

test("primary search includes release title and artist but excludes comment-only hits", () => {
  const release = {
    title: "Unrelated Album",
    artists: ["Another Artist"],
    listeningEntries: [{ comment: "Charli xcx would love this" }],
  };
  assert.equal(releaseMatchesPrimarySearch(release, "Charli xcx"), false);
  assert.equal(releaseMatchesPrimarySearch(release, "Another Artist"), true);
  assert.equal(releaseMatchesPrimarySearch(release, "Unrelated Album"), true);
});

test("context search reports the exact comment and secondary field that matched", () => {
  const release = {
    id: "context-release",
    title: "Unrelated Album",
    translatedTitle: "Charli xcx 的夏日",
    titleAliases: [],
    artists: ["Another Artist"],
    genres: ["Pop"],
    tags: [],
    listeningEntries: [
      {
        id: "context-entry",
        comment: "这段让我想到 Charli xcx 的制作。",
      },
    ],
  };
  const matches = getReleaseContextMatches(release, "charli xcx");
  assert.deepEqual(
    matches.map((match) => match.label),
    ["译名", "评论"],
  );
  assert.equal(matches[1].text, "这段让我想到 Charli xcx 的制作。");
});

test("NeoDB export preset maps artist, timestamp and streaming links", () => {
  const headers = [
    "title",
    "info",
    "links",
    "timestamp",
    "status",
    "rating",
    "comment",
    "tags",
  ];
  const map = detectHeaderMap(headers);
  const result = csvRowToRelease(
    {
      title: "True",
      info: "artist:Avicii",
      links:
        "https://neodb.social/album/example https://open.spotify.com/album/spotify-id https://music.apple.com/album/apple-id",
      timestamp: "2014-08-18T01:46:18+00:00",
      status: "complete",
      rating: "8",
      comment: "依旧好听",
      tags: "",
    },
    map,
    2,
  );

  assert.equal(result.release.artists[0], "Avicii");
  assert.equal(result.release.listeningEntries[0].source, "NEODB");
  assert.equal(
    result.release.listeningEntries[0].listenedAt,
    "2014-08-18T01:46:18+00:00",
  );
  assert.equal(
    result.release.listeningEntries[0].ratedAt,
    "2014-08-18T01:46:18+00:00",
  );
  assert.deepEqual(
    result.release.externalLinks.map((link) => link.provider),
    ["NEODB", "SPOTIFY", "APPLE_MUSIC"],
  );
});

test("NeoDB wishlist timestamp is not treated as a listening date", () => {
  const map = detectHeaderMap([
    "title",
    "info",
    "links",
    "timestamp",
    "status",
    "rating",
  ]);
  const result = csvRowToRelease(
    {
      title: "Wishlist Item",
      info: "artist:Future Artist",
      links: "https://neodb.social/album/wishlist-id",
      timestamp: "2025-01-13T13:43:44+00:00",
      status: "wishlist",
      rating: "",
    },
    map,
    2,
  );

  assert.equal(result.release.listeningEntries[0].listenedAt, null);
  assert.equal(result.release.listeningEntries[0].ratedAt, null);
  assert.equal(result.release.markStatus, "wishlist");
  assert.equal(
    getLatestMarkedAt(result.release.listeningEntries),
    "2025-01-13T13:43:44+00:00",
  );
  assert.equal(getReleaseKindLabel(result.release), "想听");
});

const neoDbMark = {
  shelf_type: "complete",
  visibility: 0,
  created_time: "2026-07-25T10:00:00Z",
  comment_text: "短评",
  rating_grade: 9,
  tags: ["dream pop"],
  item: {
    uuid: "neodb-album-1",
    url: "https://neodb.social/album/neodb-album-1",
    title: "Heaven or Las Vegas",
    localized_title: [{ lang: "zh-hans", text: "天堂或拉斯维加斯" }],
    type: "Album",
    tags: ["Dream Pop"],
    cover_image_url: "https://neodb.social/m/item-cover.jpg",
    credits: [{ role: "Artist", name: "Cocteau Twins" }],
    external_resources: [
      { url: "https://music.apple.com/us/album/example" },
    ],
  },
};

test("NeoDB mark keeps original title and stores localized title as translation", () => {
  const release = neoDbMarkToRelease(neoDbMark);
  assert.equal(release.title, "Heaven or Las Vegas");
  assert.equal(release.translatedTitle, "天堂或拉斯维加斯");
  assert.deepEqual(release.artists, ["Cocteau Twins"]);
  assert.equal(release.releaseType, "OTHER");
  assert.equal(release.releaseTypeSource, "PENDING_EXACT_CHECK");
  assert.equal(release.listeningEntries[0].rating10, 9);
  assert.deepEqual(release.tags, ["dream pop"]);
  assert.deepEqual(release.genres, []);
});

test("sync type verification accepts exact agreement and leaves uncertainty unclassified", () => {
  const releases = [
    {
      id: "matched",
      releaseType: "OTHER",
      listeningEntries: [],
    },
    {
      id: "conflict",
      releaseType: "LP",
      listeningEntries: [],
    },
    {
      id: "manual",
      releaseType: "EP",
      releaseTypeUserConfirmed: true,
      listeningEntries: [],
    },
  ];
  const next = applyReleaseTypeVerification(releases, [
    {
      id: "matched",
      status: "MATCHED",
      releaseType: "SINGLE",
      source: "EXACT_SOURCES_AGREE",
      matchedFrom: ["https://neodb.social/album/a"],
      rawEvidence: ["Single"],
    },
    {
      id: "conflict",
      status: "CONFLICT",
      releaseType: "OTHER",
      evidence: [
        {
          source: "NEODB_EXACT",
          matchedFrom: "https://neodb.social/album/b",
          rawType: "Album",
        },
        {
          source: "MUSICBRAINZ_EXACT",
          matchedFrom:
            "https://musicbrainz.org/release-group/00000000-0000-0000-0000-000000000000",
          rawType: "EP",
        },
      ],
    },
    {
      id: "manual",
      status: "MATCHED",
      releaseType: "LP",
      source: "NEODB_EXACT",
    },
  ]);

  assert.equal(next[0].releaseType, "SINGLE");
  assert.equal(next[0].releaseTypeSource, "EXACT_SOURCES_AGREE");
  assert.equal(next[1].releaseType, "OTHER");
  assert.equal(next[1].releaseTypeSource, "EXACT_SOURCE_CONFLICT");
  assert.equal(next[2].releaseType, "EP");
});

test("release type verification reuses an unchanged evidence fingerprint cache", async () => {
  const release = {
    id: "cache-release",
    title: "Cache Me",
    artists: ["Artist"],
    releaseType: "OTHER",
    neodbSourceType: "EP",
    externalLinks: [
      {
        provider: "NEODB",
        url: "https://neodb.social/album/cache-release",
        status: "CONFIRMED",
      },
    ],
    listeningEntries: [],
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);
    return Response.json({
      results: payload.releases.map((item) => ({
        id: item.id,
        status: "MATCHED",
        releaseType: "EP",
        source: "NEODB_EXACT",
        matchedFrom: ["https://neodb.social/album/cache-release"],
        rawEvidence: ["EP"],
        evidence: [],
      })),
    });
  };
  try {
    const first = await verifyChangedReleaseTypes(
      [release],
      [release.id],
      {},
    );
    const second = await verifyChangedReleaseTypes(
      first.releases,
      [release.id],
      first.nextCache,
    );
    const changedFingerprint = getReleaseTypeVerificationFingerprint({
      ...first.releases[0],
      title: "Cache Me (New Title)",
    });

    assert.equal(first.queried, 1);
    assert.equal(first.cacheHits, 0);
    assert.equal(second.queried, 0);
    assert.equal(second.cacheHits, 1);
    assert.equal(calls, 1);
    assert.notEqual(
      changedFingerprint,
      first.releases[0].typeVerificationInputFingerprint,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NeoDB sync appends changed history instead of overwriting an old entry", () => {
  const existing = neoDbMarkToRelease({
    ...neoDbMark,
    rating_grade: 8,
    comment_text: "旧短评",
    created_time: "2025-07-25T10:00:00Z",
  });
  const plan = buildNeoDbSyncPlan(
    [existing],
    [{ mark: neoDbMark, review: { body: "长评" }, logs: [] }],
  );
  const next = applyNeoDbSyncPlan([existing], plan);
  assert.equal(plan.updates.length, 1);
  assert.equal(next[0].listeningEntries.length, 2);
  assert.equal(next[0].listeningEntries[0].comment, "旧短评");
  assert.equal(next[0].listeningEntries[1].comment, "短评\n\n长评");
});

test("comment-only NeoDB changes do not request another type verification", () => {
  const existing = {
    ...neoDbMarkToRelease({
      ...neoDbMark,
      comment_text: "旧短评",
    }),
    releaseType: "LP",
    releaseTypeSource: "NEODB_EXACT",
  };
  const plan = buildNeoDbSyncPlan(
    [existing],
    [
      {
        mark: { ...neoDbMark, comment_text: "新短评" },
        review: null,
        logs: [],
      },
    ],
  );

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].typeVerificationRelevant, false);
  assert.deepEqual(plan.updates[0].changedMetadataFields, []);
});

test("NeoDB redirect plus source rename promotes the new exact title and keeps the old title as an alias", () => {
  const oldUrl = "https://neodb.social/album/legacy-title-id";
  const canonicalUrl = "https://neodb.social/album/current-title-id";
  const existing = {
    ...neoDbMarkToRelease({
      ...neoDbMark,
      item: {
        ...neoDbMark.item,
        uuid: "legacy-title-id",
        url: oldUrl,
        title: "旧标题",
      },
    }),
    id: "renamed-release",
    title: "旧标题",
    titleSource: "SPOTIFY_OEMBED",
    titleMatchedFrom: "https://open.spotify.com/album/exact",
  };
  delete existing.neodbSourceTitle;
  delete existing.neodbSourceTitleUrl;
  delete existing.neodbSourceTitleUpdatedAt;
  const reconciled = applyNeoDbCanonicalMappings(
    [existing],
    { [oldUrl]: canonicalUrl },
  ).releases;
  const renamedMark = {
    ...neoDbMark,
    item: {
      ...neoDbMark.item,
      uuid: "current-title-id",
      url: canonicalUrl,
      title: "推开世界的门-single",
    },
  };
  const plan = buildNeoDbSyncPlan(reconciled, [
    { mark: renamedMark, review: null, logs: [] },
  ]);
  const next = applyNeoDbSyncPlan(reconciled, plan);

  assert.equal(plan.updates.length, 1);
  assert.equal(next[0].title, "推开世界的门-single");
  assert.equal(next[0].titleSource, "NEODB_SYNC_EXACT");
  assert.ok(next[0].titleAliases.includes("旧标题"));
  assert.equal(next[0].neodbSourceTitle, "推开世界的门-single");

  const repeatedPlan = buildNeoDbSyncPlan(next, [
    { mark: renamedMark, review: null, logs: [] },
  ]);
  assert.equal(repeatedPlan.updates.length, 0);
  assert.equal(repeatedPlan.unchanged.length, 1);
});

test("NeoDB sync deduplicates the same instant across equivalent timestamp formats", () => {
  const shared = {
    rating10: 7,
    comment: "慢慢听，越听越有意思。",
    source: "NEODB",
    sourceItemId: "same-album",
    markStatus: "complete",
  };
  const entries = dedupeEquivalentListeningEntries([
    {
      ...shared,
      id: "csv-entry",
      listenedAt: "2026-07-25T11:35:33.340545+00:00",
      ratedAt: "2026-07-25T11:35:33.340545+00:00",
    },
    {
      ...shared,
      id: "sync-entry",
      listenedAt: "2026-07-25T11:35:33.340Z",
      ratedAt: "2026-07-25T11:35:33.340Z",
    },
    {
      ...shared,
      id: "later-entry",
      listenedAt: "2026-07-25T11:35:34.340Z",
      ratedAt: "2026-07-25T11:35:34.340Z",
    },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["csv-entry", "later-entry"],
  );
});

test("NeoDB removals delete only matching NeoDB entries", () => {
  const existing = neoDbMarkToRelease(neoDbMark);
  existing.listeningEntries.push({
    id: "manual-entry",
    source: "MANUAL",
    comment: "本地记录保留",
  });
  const plan = buildNeoDbSyncPlan(
    [existing],
    [],
    [neoDbMark.item.uuid],
  );
  const next = applyNeoDbSyncPlan([existing], plan, {
    applyRemovals: true,
  });
  assert.equal(next.length, 1);
  assert.deepEqual(
    next[0].listeningEntries.map((entry) => entry.id),
    ["manual-entry"],
  );
});

test("NeoDB mark hash changes when a remote rating or comment changes", () => {
  assert.notEqual(
    neoDbMarkHash(neoDbMark),
    neoDbMarkHash({ ...neoDbMark, rating_grade: 10 }),
  );
});

test("NeoDB sync maps a redirected legacy item id to its canonical URL", () => {
  const aliases = buildNeoDbCanonicalAliases([
    {
      externalLinks: [
        {
          provider: "NEODB",
          originalUrl: "https://neodb.social/album/legacy-id",
          url: "https://neodb.social/album/canonical-id",
        },
      ],
      listeningEntries: [],
    },
  ]);
  assert.equal(
    aliases.get("legacy-id"),
    "https://neodb.social/album/canonical-id",
  );
  assert.equal(
    aliases.get("https://neodb.social/album/legacy-id"),
    "https://neodb.social/album/canonical-id",
  );
});

test("sync canonical reconciliation exposes merged addresses for manual duplicate review", () => {
  const releases = [
    {
      id: "legacy-release",
      title: "Legacy copy",
      externalLinks: [
        {
          provider: "NEODB",
          url: "https://neodb.social/album/legacy-id",
        },
      ],
      listeningEntries: [
        {
          id: "legacy-entry",
          source: "NEODB",
          sourceUrl: "https://neodb.social/album/legacy-id",
          sourceItemId: "legacy-id",
          comment: "保留这条评论供用户判断",
        },
      ],
    },
    {
      id: "canonical-release",
      title: "Canonical copy",
      externalLinks: [
        {
          provider: "NEODB",
          url: "https://neodb.social/album/canonical-id",
        },
      ],
      listeningEntries: [],
    },
  ];
  const identityReleases = [
    {
      externalLinks: [
        {
          provider: "NEODB",
          originalUrl: "https://neodb.social/album/legacy-id",
          url: "https://neodb.social/album/canonical-id",
          canonicalUrl: "https://neodb.social/album/canonical-id",
        },
      ],
      listeningEntries: [],
    },
  ];

  const result = applyNeoDbCanonicalMappings(
    releases,
    {},
    identityReleases,
    "2026-07-26T00:00:00.000Z",
  );
  assert.deepEqual(result.changedReleaseIds, ["legacy-release"]);
  assert.equal(
    result.releases[0].externalLinks[0].url,
    "https://neodb.social/album/canonical-id",
  );
  assert.equal(
    result.releases[0].listeningEntries[0].sourceItemId,
    "canonical-id",
  );
  assert.equal(
    result.releases[0].listeningEntries[0].comment,
    "保留这条评论供用户判断",
  );
  const groups = findExactNeoDbDuplicateGroups(result.releases);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].releases.map((release) => release.id),
    ["legacy-release", "canonical-release"],
  );
});

test("verified removals compare final canonical ids instead of legacy ids", () => {
  const legacyUrl = "https://neodb.social/album/legacy-kept-id";
  const canonicalUrl = "https://neodb.social/album/current-kept-id";
  const releases = applyNeoDbCanonicalMappings(
    [
      {
        id: "kept-release",
        title: "Still collected",
        externalLinks: [
          { provider: "NEODB", url: legacyUrl, status: "CONFIRMED" },
        ],
        listeningEntries: [
          {
            id: "kept-entry",
            source: "NEODB",
            sourceUrl: legacyUrl,
            sourceItemId: "legacy-kept-id",
          },
        ],
      },
    ],
    { [legacyUrl]: canonicalUrl },
  ).releases;

  assert.deepEqual(
    buildVerifiedNeoDbRemovalCandidates(
      releases,
      ["current-kept-id"],
      releases,
    ),
    [],
  );
});

test("local removal requires two consecutive verified full-audit misses", () => {
  const candidate = {
    sourceItemId: "missing-id",
    releaseId: "missing-release",
    title: "Missing once",
  };
  const first = advanceNeoDbRemovalReview(
    [candidate],
    {},
    "2026-07-26T00:00:00.000Z",
  );
  const second = advanceNeoDbRemovalReview(
    [candidate],
    first.streaks,
    "2026-07-27T00:00:00.000Z",
  );
  const reset = advanceNeoDbRemovalReview(
    [],
    second.streaks,
    "2026-07-28T00:00:00.000Z",
  );

  assert.equal(first.reviewCandidates.length, 1);
  assert.equal(first.pendingRemovals.length, 0);
  assert.equal(second.reviewCandidates.length, 0);
  assert.equal(second.pendingRemovals.length, 1);
  assert.deepEqual(reset.streaks, {});
  assert.deepEqual(reset.pendingRemovals, []);
});

test("NeoDB sync compares every music shelf before deciding a record was removed", async () => {
  const wishlistMark = {
    ...neoDbMark,
    shelf_type: "wishlist",
    rating_grade: null,
    comment_text: null,
    item: {
      ...neoDbMark.item,
      uuid: "neodb-wishlist-1",
      url: "https://neodb.social/album/neodb-wishlist-1",
      title: "Wishlist Album",
    },
  };
  const releases = [
    neoDbMarkToRelease(neoDbMark),
    neoDbMarkToRelease(wishlistMark),
  ];
  const requestedShelves = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const shelf = String(url).match(/\/api\/me\/shelf\/([^?]+)/)?.[1];
    if (!shelf) throw new Error(`Unexpected URL: ${url}`);
    requestedShelves.push(shelf);
    const data =
      shelf === "complete"
        ? [neoDbMark]
        : shelf === "wishlist"
          ? [wishlistMark]
          : [];
    return new Response(
      JSON.stringify({ data, pages: data.length ? 1 : 0, count: data.length }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await pullNeoDbDelta(
      releases,
      "test-token",
      {
        schemaVersion: 2,
        profile: { username: "tester" },
        remoteCount: 2,
        snapshot: {
          [neoDbMark.item.uuid]: neoDbMarkHash(neoDbMark),
          [wishlistMark.item.uuid]: neoDbMarkHash(wishlistMark),
        },
        auditPages: {},
      },
      { identityReleases: releases },
    );
    assert.deepEqual(
      [...new Set(requestedShelves)].sort(),
      ["complete", "dropped", "progress", "wishlist"],
    );
    assert.equal(result.plan.additions.length, 0);
    assert.equal(result.plan.removals.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate manager groups only releases with the same normalized NeoDB URL", () => {
  const release = (id, url) => ({
    id,
    title: id,
    externalLinks: [{ provider: "NEODB", url }],
    listeningEntries: [],
  });
  const groups = findExactNeoDbDuplicateGroups([
    release(
      "first",
      "https://neodb.social/album/4RXOw79OuQvsatSQu74qzA/?from=share",
    ),
    release(
      "second",
      "https://neodb.social/album/4RXOw79OuQvsatSQu74qzA",
    ),
    release(
      "different",
      "https://neodb.social/album/a-different-record",
    ),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].releases.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(
    normalizeNeoDbUrl(
      "http://neodb.social/album/4RXOw79OuQvsatSQu74qzA/#details",
    ),
    "https://neodb.social/album/4RXOw79OuQvsatSQu74qzA",
  );
});
