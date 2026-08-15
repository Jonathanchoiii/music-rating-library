import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSpotifyAccessTokenCache,
  fetchExactTracklist,
  normalizeAppleTracklistPayload,
  normalizeSpotifyTracklistPayload,
} from "../tracklists/index.mjs";
import { getReleaseMetadataFields } from "../src/lib/neodbSync.js";
import { parseSpotifyAlbumUrl } from "../src/lib/spotifyUrl.js";

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

const spotifyRelease = {
  id: "release-spotify",
  externalLinks: [
    {
      provider: "SPOTIFY",
      status: "CONFIRMED",
      url: "https://open.spotify.com/intl-zh/album/4m2880jivSbbyEGAKfITCa?si=tracking",
    },
  ],
};

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

test("uses the confirmed Apple album ID for an exact song lookup", async () => {
  let requestedUrl = "";
  const tracklist = await fetchExactTracklist(release, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({
          results: [
            {
              wrapperType: "track",
              kind: "song",
              collectionId: 123456789,
              trackId: 10,
              discNumber: 1,
              trackNumber: 1,
              trackName: "Exact song",
              trackTimeMillis: 180_000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.origin, "https://itunes.apple.com");
  assert.equal(parsedUrl.searchParams.get("id"), "123456789");
  assert.equal(parsedUrl.searchParams.get("entity"), "song");
  assert.equal(parsedUrl.searchParams.get("country"), "cn");
  assert.equal(tracklist.status, "SUCCESS");
  assert.equal(tracklist.provider, "APPLE_MUSIC");
  assert.equal(tracklist.trackCount, 1);
  assert.equal(tracklist.tracks[0].title, "Exact song");
});

test("refuses track lookup without a confirmed exact Apple or Spotify album link", async () => {
  await assert.rejects(
    () => fetchExactTracklist({ id: "release-no-link", externalLinks: [] }),
    (error) => {
      assert.equal(error.code, "EXACT_ALBUM_LINK_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test("accepts a storeless Apple Music URL when its numeric album ID is exact", async () => {
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
  await fetchExactTracklist(storelessRelease, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({
          results: [
            {
              wrapperType: "track",
              kind: "song",
              collectionId: 123456789,
              trackId: 1,
              discNumber: 1,
              trackNumber: 1,
              trackName: "Track",
              trackTimeMillis: 180_000,
            },
          ],
        }),
      );
    },
  });
  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.searchParams.get("id"), "123456789");
  assert.equal(parsedUrl.searchParams.has("country"), false);
});

test("parses Spotify album URLs including intl paths", () => {
  assert.deepEqual(
    parseSpotifyAlbumUrl(
      "https://open.spotify.com/intl-zh/album/4m2880jivSbbyEGAKfITCa?si=tracking",
    ),
    {
      provider: "spotify",
      sourceAlbumId: "4m2880jivSbbyEGAKfITCa",
      canonicalUrl: "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa",
    },
  );
});

test("normalizes Spotify album tracks by disc and track number", () => {
  const tracks = normalizeSpotifyTracklistPayload(
    {
      items: [
        {
          id: "b",
          disc_number: 1,
          track_number: 2,
          name: " Second ",
          duration_ms: 125_400,
        },
        {
          id: "a",
          disc_number: 1,
          track_number: 1,
          name: "First",
          duration_ms: 61_000,
        },
        {
          id: "local",
          disc_number: 1,
          track_number: 3,
          name: "Local",
          duration_ms: 10_000,
          is_local: true,
        },
      ],
    },
    "4m2880jivSbbyEGAKfITCa",
  );
  assert.deepEqual(tracks, [
    {
      id: "spotify:a",
      discNumber: 1,
      trackNumber: 1,
      title: "First",
      durationMs: 61_000,
    },
    {
      id: "spotify:b",
      discNumber: 1,
      trackNumber: 2,
      title: "Second",
      durationMs: 125_400,
    },
  ]);
});

test("falls back to Spotify when no confirmed Apple Music album exists", async () => {
  clearSpotifyAccessTokenCache();
  const previousId = process.env.SPOTIFY_CLIENT_ID;
  const previousSecret = process.env.SPOTIFY_CLIENT_SECRET;
  process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
  process.env.SPOTIFY_CLIENT_SECRET = "spotify-client-secret";
  const requested = [];
  try {
    const tracklist = await fetchExactTracklist(spotifyRelease, {
      fetchImpl: async (url, init = {}) => {
        const target = String(url);
        requested.push(target);
        if (target.includes("accounts.spotify.com/api/token")) {
          assert.equal(init.method, "POST");
          return new Response(
            JSON.stringify({ access_token: "token-1", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (target.includes("/v1/albums/4m2880jivSbbyEGAKfITCa/tracks")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "track1",
                  disc_number: 1,
                  track_number: 1,
                  name: "Spotify song",
                  duration_ms: 200_000,
                },
              ],
              next: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected url: ${target}`);
      },
    });
    assert.equal(tracklist.provider, "SPOTIFY");
    assert.equal(tracklist.sourceAlbumId, "4m2880jivSbbyEGAKfITCa");
    assert.equal(tracklist.tracks[0].title, "Spotify song");
    assert.ok(requested.some((url) => url.includes("/api/token")));
    assert.ok(
      requested.some((url) =>
        url.includes("/v1/albums/4m2880jivSbbyEGAKfITCa/tracks"),
      ),
    );
  } finally {
    if (previousId == null) delete process.env.SPOTIFY_CLIENT_ID;
    else process.env.SPOTIFY_CLIENT_ID = previousId;
    if (previousSecret == null) delete process.env.SPOTIFY_CLIENT_SECRET;
    else process.env.SPOTIFY_CLIENT_SECRET = previousSecret;
    clearSpotifyAccessTokenCache();
  }
});

test("prefers Apple Music over Spotify when both confirmed links exist", async () => {
  let requestedHost = "";
  const both = {
    id: "release-both",
    externalLinks: [
      ...release.externalLinks,
      ...spotifyRelease.externalLinks,
    ],
  };
  const tracklist = await fetchExactTracklist(both, {
    fetchImpl: async (url) => {
      requestedHost = new URL(String(url)).hostname;
      return new Response(
        JSON.stringify({
          results: [
            {
              wrapperType: "track",
              kind: "song",
              collectionId: 123456789,
              trackId: 10,
              discNumber: 1,
              trackNumber: 1,
              trackName: "Apple song",
              trackTimeMillis: 180_000,
            },
          ],
        }),
      );
    },
  });
  assert.equal(requestedHost, "itunes.apple.com");
  assert.equal(tracklist.provider, "APPLE_MUSIC");
  assert.equal(tracklist.tracks[0].title, "Apple song");
});

test("tracklists are persisted as shared release metadata", () => {
  assert.equal(getReleaseMetadataFields().includes("tracklist"), true);
});
