import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { persistReleaseMetadataFields } from "../shared-state/release-metadata.mjs";
import { readSharedState } from "../shared-state/index.mjs";
import {
  appleTracklistStorefrontsToTry,
  fetchExactTracklist,
  handleTracklistRequest,
  normalizeAppleTracklistPayload,
} from "../tracklists/index.mjs";
import {
  appendManualTrack,
  mergeFetchedTracklist,
  parseTrackDurationInput,
} from "../src/lib/tracklist.js";
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

test("Apple tracklist fetch writes the shared release overlay", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-tracklist-persist-"),
  );
  const statePath = path.join(directory, "shared-state.json");
  const previous = process.env.RECORDSHELF_SHARED_STATE_PATH;
  process.env.RECORDSHELF_SHARED_STATE_PATH = statePath;
  context.after(async () => {
    if (previous === undefined) {
      delete process.env.RECORDSHELF_SHARED_STATE_PATH;
    } else {
      process.env.RECORDSHELF_SHARED_STATE_PATH = previous;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  await persistReleaseMetadataFields(release.id, {
    tracklist: appendManualTrack(null, {
      title: "Keep extra",
      durationMs: 120_000,
      id: "user:keep",
    }).tracklist,
  });

  const request = new PassThrough();
  request.method = "POST";
  request.url = "/api/tracklists/refresh";
  request.end(
    JSON.stringify({
      release: {
        id: release.id,
        externalLinks: release.externalLinks,
      },
    }),
  );
  let body = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(value = "") {
      body = String(value);
    },
  };
  assert.equal(
    await handleTracklistRequest(request, response, {
      fetchImpl: async () =>
        new Response(JSON.stringify(songPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    true,
  );
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(body);
  assert.equal(payload.tracklist.provider, "MIXED");
  assert.equal(payload.tracklist.tracks.at(-1).id, "user:keep");

  const userState = JSON.parse(
    (await readSharedState(statePath)).storage["recordshelf-user-state-v2"],
  );
  assert.equal(
    userState.releaseMetadataOverrides[release.id].tracklist.provider,
    "MIXED",
  );
  assert.equal(
    userState.releaseMetadataOverrides[release.id].tracklist.tracks[0].title,
    "Exact song",
  );
});

test("parses manual duration as m:ss, h:mm:ss, seconds, or fullwidth colon", () => {
  assert.equal(parseTrackDurationInput("3:45").durationMs, 225_000);
  assert.equal(parseTrackDurationInput("1:02:03").durationMs, 3723_000);
  assert.equal(parseTrackDurationInput("45").durationMs, 45_000);
  assert.equal(parseTrackDurationInput("3：05").durationMs, 185_000);
  assert.equal(parseTrackDurationInput("").error, "DURATION_REQUIRED");
  assert.equal(parseTrackDurationInput("3:99").error, "DURATION_INVALID");
});

test("appends manual title and duration after catalog tracks", () => {
  const first = appendManualTrack(
    {
      version: 1,
      provider: "APPLE_MUSIC",
      status: "SUCCESS",
      tracks: [
        {
          id: "apple:1",
          discNumber: 1,
          trackNumber: 1,
          title: "Smooth Operator",
          durationMs: 257_000,
        },
      ],
    },
    { title: " Hang On to Your Love ", durationMs: 264_000, id: "user:fixed" },
  );
  assert.equal(first.error, null);
  assert.equal(first.tracklist.provider, "MIXED");
  assert.equal(first.tracklist.tracks[1].title, "Hang On to Your Love");
  assert.equal(first.tracklist.tracks[1].trackNumber, 2);
  assert.equal(first.tracklist.tracks[1].id, "user:fixed");

  const second = appendManualTrack(first.tracklist, {
    title: "Cherry Pie",
    durationMs: 262_000,
    id: "user:two",
  });
  assert.equal(second.tracklist.trackCount, 3);
  assert.equal(second.tracklist.tracks[2].trackNumber, 3);
});

test("keeps previously added user tracks after a later Apple fetch", () => {
  const previous = appendManualTrack(null, {
    title: "Manual extra",
    durationMs: 120_000,
    id: "user:keep",
  }).tracklist;
  const merged = mergeFetchedTracklist(
    {
      version: 1,
      provider: "APPLE_MUSIC",
      status: "SUCCESS",
      sourceStorefront: "us",
      tracks: [
        {
          id: "apple:9",
          discNumber: 1,
          trackNumber: 1,
          title: "Smooth Operator",
          durationMs: 257_000,
        },
      ],
    },
    previous,
  );
  assert.equal(merged.provider, "MIXED");
  assert.equal(merged.tracks[1].id, "user:keep");
  assert.equal(merged.tracks[1].trackNumber, 2);
});

