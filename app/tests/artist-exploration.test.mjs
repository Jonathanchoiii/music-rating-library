import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArtistExplorationModel,
  explorationTrackKey,
  groupExplorationReleases,
  matchExplorationReleases,
} from "../src/lib/artistExploration.js";

const ratedEntry = {
  id: "entry-1",
  rating10: 9,
  ratedAt: "2026-08-20T00:00:00Z",
};

test("artist completion deduplicates songs by ISRC across albums and singles", () => {
  const catalog = {
    artistName: "Example Artist",
    releases: [
      {
        id: "100",
        title: "First Album",
        releaseType: "LP",
        tracks: [
          { id: "song-a-album", isrc: "USAAA2600001", title: "Song A" },
          { id: "song-b", isrc: "USAAA2600002", title: "Song B" },
        ],
      },
      {
        id: "200",
        title: "Song A - Single",
        releaseType: "SINGLE",
        tracks: [
          { id: "song-a-single", isrc: "USAAA2600001", title: "Song A" },
        ],
      },
    ],
  };
  const model = buildArtistExplorationModel(catalog, [
    {
      id: "local-album",
      title: "First Album",
      releaseType: "LP",
      externalLinks: [
        {
          provider: "APPLE_MUSIC",
          status: "CONFIRMED",
          url: "https://music.apple.com/us/album/first-album/100",
        },
      ],
      listeningEntries: [ratedEntry],
    },
  ]);
  assert.equal(model.uniqueTrackCount, 2);
  assert.equal(model.heardUniqueTrackCount, 2);
  assert.equal(model.completionPercent, 100);
  assert.equal(model.releases[1].tracks[0].listened, true);
  assert.equal(model.ratedReleaseCount, 1);
});

test("scoped title matching requires one compatible catalog release", () => {
  const catalog = [
    { id: "ep-1", title: "Blue Hour - EP", releaseType: "EP", releaseDate: "2024-01-01" },
    { id: "lp-1", title: "Blue Hour", releaseType: "LP", releaseDate: "2025-01-01" },
  ];
  const matches = matchExplorationReleases(catalog, [
    {
      id: "local-ep",
      title: "Blue Hour",
      releaseType: "EP",
      releaseDate: "2024",
      listeningEntries: [ratedEntry],
    },
  ]);
  assert.equal(matches.get("ep-1")?.localRelease.id, "local-ep");
  assert.equal(matches.get("lp-1"), undefined);
});

test("fallback track identity keeps same title with materially different durations separate", () => {
  assert.notEqual(
    explorationTrackKey({ title: "Intro", artistName: "A", durationMs: 30_000 }),
    explorationTrackKey({ title: "Intro", artistName: "A", durationMs: 95_000 }),
  );
});

test("same-title same-date catalog variants collapse into one release row", () => {
  const grouped = groupExplorationReleases([
    {
      id: "standard",
      title: "Scarlet",
      releaseType: "LP",
      releaseDate: "2023-09-22",
      rating: null,
      matchedReleaseId: "",
      tracks: [
        { id: "song-a", key: "isrc:a", title: "A", listened: false },
      ],
    },
    {
      id: "deluxe",
      title: "Scarlet",
      releaseType: "LP",
      releaseDate: "2023-09-22",
      rating: 8,
      matchedReleaseId: "local-scarlet",
      tracks: [
        { id: "song-a-2", key: "isrc:a", title: "A", listened: true },
        { id: "song-b", key: "isrc:b", title: "B", listened: true },
      ],
    },
    {
      id: "single",
      title: "Scarlet",
      releaseType: "SINGLE",
      releaseDate: "2023-09-22",
      tracks: [{ id: "song-c", key: "isrc:c", title: "C", listened: false }],
    },
  ]);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].id, "deluxe");
  assert.equal(grouped[0].variantCount, 2);
  assert.equal(grouped[0].collapsedVariantCount, 1);
  assert.equal(grouped[0].tracks.length, 2);
  assert.equal(grouped[0].heardTrackCount, 2);
  assert.deepEqual(grouped[0].collapsedVariants, [
    { id: "standard", trackCount: 1, url: "" },
  ]);
  assert.equal(grouped[1].releaseType, "SINGLE");
});

test("same-day remix titles collapse by base title without merging unrelated singles", () => {
  const grouped = groupExplorationReleases([
    {
      id: "disclosure-remix",
      title: "Streets (Disclosure Remix) - Single",
      releaseType: "SINGLE",
      releaseDate: "2021-03-12",
      tracks: [{ id: "track-a", title: "Streets (Disclosure Remix)" }],
    },
    {
      id: "silhouette-remix",
      title: "Streets (Silhouette Remix) - Single",
      releaseType: "SINGLE",
      releaseDate: "2021-03-12",
      tracks: [{ id: "track-b", title: "Streets (Silhouette Remix)" }],
    },
    {
      id: "unrelated-single",
      title: "Kiss Me More - Single",
      releaseType: "SINGLE",
      releaseDate: "2021-03-12",
      tracks: [{ id: "track-c", title: "Kiss Me More" }],
    },
    {
      id: "chapter-one",
      title: "Planet Her (Chapter One) - Single",
      releaseType: "SINGLE",
      releaseDate: "2021-03-12",
      tracks: [{ id: "track-d", title: "Planet Her (Chapter One)" }],
    },
    {
      id: "chapter-two",
      title: "Planet Her (Chapter Two) - Single",
      releaseType: "SINGLE",
      releaseDate: "2021-03-12",
      tracks: [{ id: "track-e", title: "Planet Her (Chapter Two)" }],
    },
  ]);

  assert.equal(grouped.length, 4);
  const streets = grouped.find((release) => release.title.includes("Streets"));
  assert.equal(streets.variantCount, 2);
  assert.equal(streets.collapsedVariantCount, 1);
  assert.deepEqual(streets.variantReleaseIds, [
    "disclosure-remix",
    "silhouette-remix",
  ]);
  assert.equal(grouped.some((release) => release.id === "unrelated-single"), true);
  assert.equal(grouped.some((release) => release.id === "chapter-one"), true);
  assert.equal(grouped.some((release) => release.id === "chapter-two"), true);
});
