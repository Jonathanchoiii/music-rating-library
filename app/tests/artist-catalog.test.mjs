import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchArtistExplorationCatalog,
  normalizeAppleArtistAlbum,
} from "../artist-catalog/index.mjs";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Apple artist albums normalize covers, release types, tracks, and ISRC", () => {
  const release = normalizeAppleArtistAlbum({
    id: "album-1",
    type: "albums",
    attributes: {
      name: "Small Light - EP",
      artistName: "Example Artist",
      releaseDate: "2026-01-02",
      trackCount: 1,
      artwork: { url: "https://is1-ssl.mzstatic.com/{w}x{h}{c}.{f}" },
      url: "https://music.apple.com/us/album/small-light-ep/album-1",
    },
    relationships: {
      tracks: {
        data: [
          {
            id: "song-1",
            type: "songs",
            attributes: {
              name: "Small Light",
              artistName: "Example Artist",
              isrc: "USAAA2600001",
              durationInMillis: 181234,
              trackNumber: 1,
            },
          },
        ],
      },
    },
  });
  assert.equal(release.releaseType, "EP");
  assert.match(release.artworkUrl, /600x600bb\.jpg/);
  assert.equal(release.tracks[0].isrc, "USAAA2600001");
});

test("catalog fetch is anchored to the exact Apple artist id", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/artists/42")) {
      return json({ data: [{ id: "42", attributes: { name: "Exact Artist" } }] });
    }
    if (url.pathname.endsWith("/artists/42/albums")) {
      return json({
        data: [
          {
            id: "100",
            type: "albums",
            attributes: {
              name: "Exact Album",
              artistName: "Exact Artist",
              releaseDate: "2025-05-01",
              trackCount: 1,
              isSingle: false,
              artwork: { url: "https://is1-ssl.mzstatic.com/{w}x{h}bb.jpg" },
              url: "https://music.apple.com/us/album/exact-album/100",
            },
            relationships: {
              tracks: {
                data: [
                  {
                    id: "101",
                    type: "songs",
                    attributes: {
                      name: "Only Song",
                      artistName: "Exact Artist",
                      durationInMillis: 120000,
                      trackNumber: 1,
                      isrc: "USAAA2500001",
                    },
                  },
                ],
              },
            },
          },
        ],
      });
    }
    return json({}, 404);
  };
  const catalog = await fetchArtistExplorationCatalog(
    { appleMusicUrl: "https://music.apple.com/us/artist/exact-artist/42" },
    { developerToken: "test-token", fetchImpl },
  );
  assert.equal(catalog.artistId, "42");
  assert.equal(catalog.artistName, "Exact Artist");
  assert.equal(catalog.releases[0].tracks[0].id, "101");
  assert.equal(calls.some((url) => url.pathname.endsWith("/artists/42/albums")), true);
  assert.equal(calls.some((url) => url.searchParams.has("term")), false);
});
