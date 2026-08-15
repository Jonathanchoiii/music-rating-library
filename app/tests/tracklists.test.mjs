import assert from "node:assert/strict";
import test from "node:test";
import {
  appleTracklistStorefrontsToTry,
  fetchExactTracklist,
  normalizeAppleTracklistPayload,
} from "../tracklists/index.mjs";
import { getReleaseMetadataFields } from "../src/lib/neodbSync.js";

const album = {
  sourceAlbumId: "123456789",
  sourceStorefront: "cn",
  canonicalUrl: "https://music.apple.com/cn/album/example/123456789",
};

const release = {
  id: "release-test",
  externalLinks: [
    {
      provider: "APPLE_MUSIC",
      status: "CONFIRMED",
      url: album.canonicalUrl,
    },
  ],
};

function songPayload(title = "Exact song") {
  return {
    results: [
      {
        wrapperType: "track",
        kind: "song",
        collectionId: 123456789,
        trackId: 10,
        discNumber: 1,
        trackNumber: 1,
        trackName: title,
        trackTimeMillis: 180_000,
      },
    ],
  };
}

test("normalizes only songs belonging to the exact Apple collection", () => {
  const tracks = normalizeAppleTracklistPayload(
    {
      results: [
        { wrapperType: "collection", collectionId: 123456789 },
        {
          wrapperType: "track",
          kind: "song",
          collectionId: 123456789,
          trackId: 2,
          discNumber: 1,
          trackNumber: 2,
          trackName: " Second ",
          trackTimeMillis: 125_400,
        },
        {
          wrapperType: "track",
          kind: "song",
          collectionId: 987654321,
          trackId: 99,
          discNumber: 1,
          trackNumber: 1,
          trackName: "Wrong edition",
          trackTimeMillis: 100_000,
        },
        {
          wrapperType: "track",
          kind: "song",
          collectionId: 123456789,
          trackId: 1,
          discNumber: 1,
          trackNumber: 1,
          trackName: "First",
          trackTimeMillis: 61_000,
        },
      ],
    },
    album,
  );

  assert.deepEqual(tracks, [
    {
      id: "apple:1",
      discNumber: 1,
      trackNumber: 1,
      title: "First",
      durationMs: 61_000,
    },
    {
      id: "apple:2",
      discNumber: 1,
      trackNumber: 2,
      title: "Second",
      durationMs: 125_400,
    },
  ]);
});

test("uses the confirmed Apple album ID and linked storefront first", async () => {
  const requested = [];
  const tracklist = await fetchExactTracklist(release, {
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify(songPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requested.length, 1);
  const parsedUrl = new URL(requested[0]);
  assert.equal(parsedUrl.origin, "https://itunes.apple.com");
  assert.equal(parsedUrl.searchParams.get("id"), "123456789");
  assert.equal(parsedUrl.searchParams.get("entity"), "song");
  assert.equal(parsedUrl.searchParams.get("country"), "cn");
  assert.equal(tracklist.status, "SUCCESS");
  assert.equal(tracklist.provider, "APPLE_MUSIC");
  assert.equal(tracklist.sourceStorefront, "cn");
  assert.equal(tracklist.trackCount, 1);
  assert.equal(tracklist.tracks[0].title, "Exact song");
});

test("refuses track lookup without a confirmed exact Apple album link", async () => {
  await assert.rejects(
    () =>
      fetchExactTracklist({
        id: "release-spotify-only",
        externalLinks: [
          {
            provider: "SPOTIFY",
            status: "CONFIRMED",
            url: "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa",
          },
        ],
      }),
    (error) => {
      assert.equal(error.code, "EXACT_APPLE_MUSIC_LINK_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test("storeless Apple URLs start lookup in the US storefront", async () => {
  let requestedUrl = "";
  const storelessRelease = {
    id: "release-storeless",
    externalLinks: [
      {
        provider: "APPLE_MUSIC",
        status: "CONFIRMED",
        url: "https://music.apple.com/album/123456789",
      },
    ],
  };
  const tracklist = await fetchExactTracklist(storelessRelease, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(songPayload("Track")));
    },
  });
  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.searchParams.get("id"), "123456789");
  assert.equal(parsedUrl.searchParams.get("country"), "us");
  assert.equal(tracklist.sourceStorefront, "us");
});

test("tries later storefronts after US or the linked country returns no songs", async () => {
  const requestedCountries = [];
  const storelessRelease = {
    id: "release-us-missing",
    externalLinks: [
      {
        provider: "APPLE_MUSIC",
        status: "CONFIRMED",
        url: "https://music.apple.com/album/123456789",
      },
    ],
  };
  const tracklist = await fetchExactTracklist(storelessRelease, {
    fetchImpl: async (url) => {
      const country = new URL(String(url)).searchParams.get("country");
      requestedCountries.push(country);
      if (country === "gb") {
        return new Response(JSON.stringify(songPayload("British copy")));
      }
      return new Response(JSON.stringify({ resultCount: 0, results: [] }));
    },
  });
  assert.deepEqual(requestedCountries, ["us", "gb"]);
  assert.equal(tracklist.sourceStorefront, "gb");
  assert.equal(tracklist.tracks[0].title, "British copy");
});

test("keeps the first storefront that returns exact songs", () => {
  assert.deepEqual(appleTracklistStorefrontsToTry("cn").slice(0, 3), [
    "cn",
    "us",
    "gb",
  ]);
  assert.deepEqual(appleTracklistStorefrontsToTry(null).slice(0, 3), [
    "us",
    "gb",
    "hk",
  ]);
});

test("tracklists are persisted as shared release metadata", () => {
  assert.equal(getReleaseMetadataFields().includes("tracklist"), true);
});
