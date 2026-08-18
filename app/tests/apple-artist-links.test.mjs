import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchAppleArtistLinks } from "../apple-artist-links/index.mjs";
import { readSharedState } from "../shared-state/index.mjs";
import {
  appleArtistLinkJobFromGroup,
  confirmedAppleAlbumsForArtist,
  matchingAppleArtistFromAlbum,
  resolveAppleArtistLink,
} from "../src/lib/appleArtistLinkMatch.js";
import { parseAppleMusicArtistUrl } from "../src/lib/appleMusicUrl.js";
import { ARTIST_PROFILE_STORAGE_KEY } from "../src/lib/sharedStorageKeys.js";

function albumCatalog(artists, artistName = artists[0]?.name ?? "") {
  return {
    data: [
      {
        id: "100",
        attributes: { artistName },
        relationships: {
          artists: {
            data: artists.map((artist) => ({
              id: artist.id,
              type: "artists",
            })),
          },
        },
      },
    ],
    included: artists.map((artist) => ({
      type: "artists",
      id: artist.id,
      attributes: { name: artist.name, url: artist.url },
    })),
  };
}

function confirmedAppleRelease(url) {
  return {
    id: "release-1",
    externalLinks: [
      { provider: "APPLE_MUSIC", status: "CONFIRMED", url },
    ],
  };
}

test("Apple Music artist URLs parse to a stable artist id", () => {
  assert.deepEqual(
    parseAppleMusicArtistUrl(
      "https://music.apple.com/cn/artist/arlo-parks/1291875084?l=zh-Hans-CN",
    ),
    {
      provider: "appleMusic",
      sourceStorefront: "cn",
      sourceArtistId: "1291875084",
      canonicalUrl: "https://music.apple.com/cn/artist/1291875084",
    },
  );
  assert.equal(
    parseAppleMusicArtistUrl("https://music.apple.com/us/album/planet-her/1574004234"),
    null,
  );
});

test("an album with one exact Apple artist name is a match", () => {
  const keys = new Set(["doja cat"]);
  const result = matchingAppleArtistFromAlbum(
    albumCatalog([
      {
        id: "1477172905",
        name: "Doja Cat",
        url: "https://music.apple.com/us/artist/doja-cat/1477172905",
      },
    ]),
    keys,
  );
  assert.equal(result.status, "MATCHED");
  assert.equal(result.artist.id, "1477172905");
});

test("collaboration albums keep only the matching local credit", () => {
  const result = matchingAppleArtistFromAlbum(
    albumCatalog(
      [
        {
          id: "1",
          name: "Doja Cat",
          url: "https://music.apple.com/us/artist/doja-cat/1",
        },
        {
          id: "2",
          name: "The Weeknd",
          url: "https://music.apple.com/us/artist/the-weeknd/2",
        },
      ],
      "Doja Cat & The Weeknd",
    ),
    new Set(["doja cat"]),
  );
  assert.equal(result.status, "MATCHED");
  assert.equal(result.artist.id, "1");
});

test("various artists and conflicting Apple ids are not matches", () => {
  assert.equal(
    matchingAppleArtistFromAlbum(
      albumCatalog(
        [
          {
            id: "0",
            name: "Various Artists",
            url: "https://music.apple.com/us/artist/various-artists/0",
          },
        ],
        "Various Artists",
      ),
      new Set(["doja cat"]),
    ).status,
    "VARIOUS_ARTISTS",
  );
  assert.equal(
    resolveAppleArtistLink([
      {
        status: "MATCHED",
        artist: { id: "1", url: "https://music.apple.com/us/artist/a/1" },
      },
      {
        status: "MATCHED",
        artist: { id: "2", url: "https://music.apple.com/us/artist/b/2" },
      },
    ]).status,
    "AMBIGUOUS",
  );
});

test("confirmed Apple albums become match jobs and skip already linked artists", () => {
  const albums = confirmedAppleAlbumsForArtist([
    confirmedAppleRelease("https://music.apple.com/tw/album/planet-her/1574004234"),
    confirmedAppleRelease("https://music.apple.com/tw/album/planet-her/1574004234"),
  ]);
  assert.deepEqual(albums, [
    {
      storefront: "tw",
      albumId: "1574004234",
      canonicalUrl: "https://music.apple.com/tw/album/planet-her/1574004234",
    },
  ]);
  assert.equal(
    appleArtistLinkJobFromGroup(
      { id: "artist-1", artist: "Doja Cat", aliases: [], credits: ["Doja Cat"], releases: [confirmedAppleRelease("https://music.apple.com/us/album/x/1")] },
      { platformLinks: { appleMusic: "https://music.apple.com/us/artist/doja-cat/1" } },
    ),
    null,
  );
  assert.equal(
    appleArtistLinkJobFromGroup(
      { id: "artist-1", artist: "Doja Cat", aliases: [], credits: ["Doja Cat"], releases: [confirmedAppleRelease("https://music.apple.com/us/album/x/1")] },
      { platformLinks: { appleMusic: "" } },
    )?.albums[0].albumId,
    "1",
  );
});

test("matching writes only an Apple artist homepage and never requests media", async () => {
  const previousToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  process.env.APPLE_MUSIC_DEVELOPER_TOKEN = "test-developer-token";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recordshelf-apple-links-"));
  const statePath = path.join(directory, "shared-local-state.json");
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    assert.equal(url.includes("editorialArtwork"), false);
    assert.equal(url.includes("editorialVideo"), false);
    return new Response(
      JSON.stringify(
        albumCatalog([
          {
            id: "1477172905",
            name: "Doja Cat",
            url: "https://music.apple.com/us/artist/doja-cat/1477172905",
          },
        ]),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await matchAppleArtistLinks(
      {
        persist: true,
        artists: [
          {
            artistId: "raw-doja cat",
            names: ["Doja Cat"],
            albums: [{ storefront: "us", albumId: "1574004234" }],
          },
        ],
      },
      { fetchImpl, statePath },
    );
    assert.equal(result.matchedCount, 1);
    assert.equal(
      result.matched[0].appleMusicUrl,
      "https://music.apple.com/us/artist/1477172905",
    );
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(shared.storage[ARTIST_PROFILE_STORAGE_KEY]);
    assert.equal(
      profiles.profiles["raw-doja cat"].platformLinks.appleMusic,
      "https://music.apple.com/us/artist/1477172905",
    );
    assert.equal(profiles.profiles["raw-doja cat"].media?.imageUrl ?? "", "");
    assert.match(calls[0], /\/v1\/catalog\/us\/albums\/1574004234\?include=artists/);
  } finally {
    if (previousToken === undefined) delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    else process.env.APPLE_MUSIC_DEVELOPER_TOKEN = previousToken;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("existing Apple artist links are not overwritten and ambiguous names stay empty", async () => {
  const previousToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  process.env.APPLE_MUSIC_DEVELOPER_TOKEN = "test-developer-token";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recordshelf-apple-links-"));
  const statePath = path.join(directory, "shared-local-state.json");
  await matchAppleArtistLinks(
    {
      persist: true,
      artists: [
        {
          artistId: "artist-1",
          names: ["Kept"],
          albums: [{ storefront: "us", albumId: "1" }],
        },
      ],
    },
    {
      statePath,
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            albumCatalog([
              {
                id: "111",
                name: "Kept",
                url: "https://music.apple.com/us/artist/kept/111",
              },
            ]),
          ),
          { status: 200 },
        ),
    },
  );
  const skipped = await matchAppleArtistLinks(
    {
      persist: true,
      artists: [
        {
          artistId: "artist-1",
          names: ["Kept"],
          albums: [{ storefront: "us", albumId: "1" }],
        },
        {
          artistId: "artist-2",
          names: ["Same Name"],
          albums: [
            { storefront: "us", albumId: "2" },
            { storefront: "us", albumId: "3" },
          ],
        },
      ],
    },
    {
      statePath,
      fetchImpl: async (input) => {
        const url = String(input);
        const id = url.includes("/albums/2") ? "222" : "333";
        return new Response(
          JSON.stringify(
            albumCatalog([
              {
                id,
                name: "Same Name",
                url: `https://music.apple.com/us/artist/same-name/${id}`,
              },
            ]),
          ),
          { status: 200 },
        );
      },
    },
  );
  try {
    assert.equal(
      skipped.skipped.find((item) => item.artistId === "artist-1")?.reason,
      "ALREADY_LINKED",
    );
    assert.equal(
      skipped.skipped.find((item) => item.artistId === "artist-2")?.reason,
      "AMBIGUOUS",
    );
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(shared.storage[ARTIST_PROFILE_STORAGE_KEY]);
    assert.equal(
      profiles.profiles["artist-1"].platformLinks.appleMusic,
      "https://music.apple.com/us/artist/111",
    );
    assert.equal(profiles.profiles["artist-2"], undefined);
  } finally {
    if (previousToken === undefined) delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    else process.env.APPLE_MUSIC_DEVELOPER_TOKEN = previousToken;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("settings does not expose Apple artist homepage matching", async () => {
  const source = await fs.readFile(
    new URL("../src/components/SettingsHome.jsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("匹配 Apple Music 艺人主页"), false);
  assert.equal(source.includes("/api/artists/apple-links"), false);
  assert.equal(source.includes("matchAppleArtistHomepages"), false);
  assert.equal(source.includes("/api/artists/media"), false);
});
