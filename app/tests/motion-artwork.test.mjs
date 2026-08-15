import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  __test,
  handleMotionArtworkFileRequest,
} from "../scripts/apple-motion-artwork.mjs";
import { applySharedStateChanges, readSharedState } from "../shared-state/index.mjs";
import {
  hasLocalMotionArtwork,
  isMotionArtworkEnabled,
  motionArtworkNeedsUpgrade,
  setMotionArtworkEnabled,
} from "../src/lib/motionArtwork.js";

test("local dynamic artwork defaults on and preserves an explicit display switch", () => {
  const release = {
    motionArtwork: {
      status: "AVAILABLE",
      storage: "LOCAL_WEBP",
      localUrl: "/private-motion-artwork/release.webp",
      checkedAt: "2026-08-13T12:00:00.000Z",
    },
  };
  assert.equal(hasLocalMotionArtwork(release), true);
  assert.equal(isMotionArtworkEnabled(release), true);
  assert.equal(motionArtworkNeedsUpgrade(release), true);

  const currentProfile = {
    ...release,
    motionArtwork: { ...release.motionArtwork, profileVersion: 2 },
  };
  assert.equal(motionArtworkNeedsUpgrade(currentProfile), false);

  const disabled = {
    ...release,
    motionArtwork: setMotionArtworkEnabled(release.motionArtwork, false),
  };
  assert.equal(disabled.motionArtwork.enabled, false);
  assert.equal(isMotionArtworkEnabled(disabled), false);
  assert.match(disabled.motionArtwork.preferenceUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("normalizes exact Apple Music album links without retaining tracking data", () => {
  assert.equal(
    __test.normalizeAppleAlbumUrl(
      "https://music.apple.com/cn/album/example-title/1440755899?uo=4",
    ),
    "https://music.apple.com/cn/album/1440755899",
  );
  assert.equal(
    __test.normalizeAppleAlbumUrl(
      "https://music.apple.com/tw/album/%E5%90%89%E4%BB%96%E6%89%8B/152197399",
    ),
    "https://music.apple.com/tw/album/152197399",
  );
  assert.equal(
    __test.normalizeAppleAlbumUrl("https://example.com/album/1440755899"),
    null,
  );
});

test("reads Apple motion artwork from the confirmed storefront catalog", async () => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const guestToken = `${encode({ alg: "none" })}.${encode({
    iss: "AMPWebPlay",
  })}.signature`;
  const requested = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://music.apple.com/tw/album/152197399") {
      return new Response('<script src="/assets/index~test.js"></script>');
    }
    if (url === "https://music.apple.com/assets/index~test.js") {
      return new Response(`window.__token = "${guestToken}";`);
    }
    if (url.startsWith("https://amp-api.music.apple.com/v1/catalog/tw/albums/152197399")) {
      return Response.json({
        data: [
          {
            attributes: {
              editorialVideo: {
                motionDetailSquare: {
                  video:
                    "https://mvod.itunes.apple.com/itunes-assets/square/default.m3u8",
                },
                motionDetailTall: {
                  video:
                    "https://mvod.itunes.apple.com/itunes-assets/tall/default.m3u8",
                },
              },
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await __test.lookupAppleCatalogMotionArtwork(
    "https://music.apple.com/tw/album/152197399",
    fetchImpl,
  );
  assert.equal(
    result.squareUrl,
    "https://mvod.itunes.apple.com/itunes-assets/square/default.m3u8",
  );
  assert.equal(
    result.tallUrl,
    "https://mvod.itunes.apple.com/itunes-assets/tall/default.m3u8",
  );
  assert.ok(
    requested.some((url) =>
      url.includes("/v1/catalog/tw/albums/152197399?extend=editorialVideo"),
    ),
  );
});

test("treats an authoritative empty Apple editorial video as unavailable", async () => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const guestToken = `${encode({ alg: "none" })}.${encode({
    iss: "AMPWebPlay",
  })}.signature`;
  let adapterWasCalled = false;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === "https://music.apple.com/tw/album/152197399") {
      return new Response('<script src="/assets/index~test.js"></script>');
    }
    if (url === "https://music.apple.com/assets/index~test.js") {
      return new Response(guestToken);
    }
    if (url.startsWith("https://amp-api.music.apple.com/v1/catalog/tw/albums/152197399")) {
      return Response.json({ data: [{ attributes: { editorialVideo: {} } }] });
    }
    adapterWasCalled = true;
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await __test.lookupMotionArtwork(
    {
      id: "release-guitarist",
      externalLinks: [
        {
          provider: "APPLE_MUSIC",
          status: "CONFIRMED",
          url: "https://music.apple.com/tw/album/152197399",
        },
      ],
    },
    fetchImpl,
  );
  assert.equal(result.motionArtwork.status, "UNAVAILABLE");
  assert.equal(adapterWasCalled, false);
});

test("requires a confirmed Apple Music link before lookup", () => {
  assert.equal(
    __test.exactAppleLink({
      externalLinks: [
        {
          provider: "APPLE_MUSIC",
          url: "https://music.apple.com/album/1440755899",
          status: "CANDIDATE",
        },
      ],
    }),
    null,
  );
  assert.equal(
    __test.exactAppleLink({
      externalLinks: [
        {
          provider: "APPLE_MUSIC",
          url: "https://music.apple.com/album/1440755899",
          canonicalUrl: "",
          status: "CONFIRMED",
        },
      ],
    }),
    "https://music.apple.com/album/1440755899",
  );
});

test("accepts only Apple HLS motion URLs", () => {
  assert.equal(
    __test.safeMotionUrl(
      "https://mvod.itunes.apple.com/itunes-assets/example/default.m3u8",
    ),
    "https://mvod.itunes.apple.com/itunes-assets/example/default.m3u8",
  );
  assert.equal(__test.safeMotionUrl("https://evil.example/video.m3u8"), null);
  assert.equal(
    __test.safeMotionUrl("https://mvod.itunes.apple.com/example/video.mp4"),
    null,
  );
});

test("wraps independent VP8 frames as an animated WebP", () => {
  const firstFrame = Buffer.from([0x10, 0x20, 0x30]);
  const secondFrame = Buffer.from([0x40, 0x50]);
  const ivf = Buffer.alloc(32 + 12 + firstFrame.length + 12 + secondFrame.length);
  ivf.write("DKIF", 0, 4, "ascii");
  ivf.write("VP80", 8, 4, "ascii");
  ivf.writeUInt32LE(firstFrame.length, 32);
  firstFrame.copy(ivf, 44);
  const secondHeader = 44 + firstFrame.length;
  ivf.writeUInt32LE(secondFrame.length, secondHeader);
  secondFrame.copy(ivf, secondHeader + 12);

  const webp = __test.createAnimatedWebpFromIvf(ivf, 720, 720, 67);
  assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP");
  assert.equal(webp.includes(Buffer.from("ANIM")), true);
  assert.equal(webp.toString("binary").match(/ANMF/g)?.length, 2);
  assert.equal(webp.toString("binary").match(/VP8 /g)?.length, 2);
  assert.equal(webp.readUInt32LE(4), webp.length - 8);
});

test("selects one near-1080 AVC HLS variant for the clear WebP profile", async () => {
  const sourceUrl = "https://mvod.itunes.apple.com/example/master.m3u8";
  const playlist = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="hvc1.2",RESOLUTION=720x720',
    "hevc.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1.64001f",RESOLUTION=360x360',
    "small.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1.64001f",RESOLUTION=768x768',
    "medium.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=400,CODECS="avc1.64001f",RESOLUTION=1080x1080',
    "preferred.m3u8",
  ].join("\n");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(playlist, { status: 200 });
  try {
    assert.equal(
      await __test.preferredMotionStreamUrl(sourceUrl),
      "https://mvod.itunes.apple.com/example/preferred.m3u8",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses descending dynamic artwork profiles with bounded file sizes", () => {
  const profiles = __test.MOTION_ARTWORK_PROFILES;
  assert.equal(__test.MOTION_ARTWORK_PROFILE_VERSION, 2);
  assert.deepEqual(
    profiles.map((profile) => profile.width),
    [960, 800, 720],
  );
  assert.equal(profiles[0].fps, 10);
  assert.equal(profiles.every((profile) => profile.durationSeconds <= 8), true);
  assert.equal(profiles.at(-1).maxBytes, 8 * 1024 * 1024);
});

test("extracts one byte-range MP4 from an Apple media playlist", () => {
  const playlistUrl =
    "https://mvod.itunes.apple.com/example/video-360.m3u8";
  const playlist = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="video-360-.mp4",BYTERANGE="877@0"',
    "#EXTINF:3.75,",
    "video-360-.mp4",
    "#EXT-X-BYTERANGE:1000@877",
    "video-360-.mp4",
  ].join("\n");
  assert.equal(
    __test.playlistMediaUrl(playlist, playlistUrl),
    "https://mvod.itunes.apple.com/example/video-360-.mp4",
  );
});

test("rejects playlists that require multiple independent media files", () => {
  const playlist = [
    "#EXTM3U",
    "first.mp4",
    "second.mp4",
  ].join("\n");
  assert.equal(
    __test.playlistMediaUrl(
      playlist,
      "https://mvod.itunes.apple.com/example/video.m3u8",
    ),
    null,
  );
});

test("downloads Apple media through an injected desktop network stack", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-motion-download-"),
  );
  const destination = path.join(directory, "source.mp4");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("master.m3u8")) {
      return new Response(
        [
          "#EXTM3U",
          '#EXT-X-STREAM-INF:CLOSED-CAPTIONS=NONE,CODECS="avc1.64001f",RESOLUTION=360x360',
          "video.m3u8",
        ].join("\n"),
      );
    }
    if (String(url).endsWith("video.m3u8")) {
      return new Response(
        [
          "#EXTM3U",
          '#EXT-X-MAP:URI="video-.mp4",BYTERANGE="10@0"',
          "video-.mp4",
        ].join("\n"),
      );
    }
    return new Response(Buffer.from("motion-video"), {
      headers: { "content-type": "video/mp4" },
    });
  };

  const result = await __test.downloadMotionSource(
    "https://mvod.itunes.apple.com/example/master.m3u8",
    destination,
    fetchImpl,
  );
  assert.equal(result.byteLength, 12);
  assert.equal(await fs.readFile(destination, "utf8"), "motion-video");
  assert.deepEqual(calls, [
    "https://mvod.itunes.apple.com/example/master.m3u8",
    "https://mvod.itunes.apple.com/example/video.m3u8",
    "https://mvod.itunes.apple.com/example/video-.mp4",
  ]);
});

test("dynamic artwork evidence is written into the authoritative shared state", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-motion-artwork-"),
  );
  const statePath = path.join(directory, "shared-state.json");
  const previousStatePath = process.env.RECORDSHELF_SHARED_STATE_PATH;
  process.env.RECORDSHELF_SHARED_STATE_PATH = statePath;
  context.after(async () => {
    if (previousStatePath === undefined) {
      delete process.env.RECORDSHELF_SHARED_STATE_PATH;
    } else {
      process.env.RECORDSHELF_SHARED_STATE_PATH = previousStatePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await applySharedStateChanges(
    {
      "recordshelf-user-state-v2": JSON.stringify({
        userReleases: [{ id: "release-user", title: "User release" }],
      }),
    },
    statePath,
  );

  await __test.persistMotionArtwork("release-base", {
    status: "UNAVAILABLE",
    checkedAt: "2026-08-13T00:00:00.000Z",
  });
  await __test.persistMotionArtwork("release-user", {
    status: "AVAILABLE",
    localUrl: "/private-motion-artwork/release-user-1.webp",
    storage: "LOCAL_WEBP",
    checkedAt: "2026-08-13T00:01:00.000Z",
  });

  const state = await readSharedState(statePath);
  const userState = JSON.parse(
    state.storage["recordshelf-user-state-v2"],
  );
  assert.equal(
    userState.releaseMetadataOverrides["release-base"].motionArtwork.status,
    "UNAVAILABLE",
  );
  assert.equal(
    userState.userReleases[0].motionArtwork.localUrl,
    "/private-motion-artwork/release-user-1.webp",
  );
});

test("a verified WebP is cached privately and its local URL is persisted", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-motion-file-"),
  );
  const statePath = path.join(directory, "shared-state.json");
  const artworkDirectory = path.join(directory, "motion-artwork");
  const previousStatePath = process.env.RECORDSHELF_SHARED_STATE_PATH;
  const previousArtworkDirectory = process.env.RECORDSHELF_MOTION_ARTWORK_DIR;
  process.env.RECORDSHELF_SHARED_STATE_PATH = statePath;
  process.env.RECORDSHELF_MOTION_ARTWORK_DIR = artworkDirectory;
  context.after(async () => {
    if (previousStatePath === undefined) {
      delete process.env.RECORDSHELF_SHARED_STATE_PATH;
    } else {
      process.env.RECORDSHELF_SHARED_STATE_PATH = previousStatePath;
    }
    if (previousArtworkDirectory === undefined) {
      delete process.env.RECORDSHELF_MOTION_ARTWORK_DIR;
    } else {
      process.env.RECORDSHELF_MOTION_ARTWORK_DIR = previousArtworkDirectory;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const request = new PassThrough();
  request.method = "POST";
  request.url = "/api/apple-motion-artwork/file";
  request.headers = {
    "content-type": "image/webp",
    "x-recordshelf-release-id": "release-cached",
    "x-recordshelf-source-url":
      "https://mvod.itunes.apple.com/example/default.m3u8",
  };
  const fakeWebp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WEBPVP8 ", "ascii"),
  ]);
  request.end(fakeWebp);
  let responseBody = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(body = "") {
      responseBody = String(body);
    },
  };

  assert.equal(
    await handleMotionArtworkFileRequest(request, response),
    true,
  );
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(responseBody);
  assert.match(
    payload.localUrl,
    /^\/private-motion-artwork\/release-cached-\d+\.webp$/,
  );
  assert.deepEqual(
    await fs.readFile(
      path.join(artworkDirectory, path.basename(payload.localUrl)),
    ),
    fakeWebp,
  );
  const state = await readSharedState(statePath);
  const userState = JSON.parse(
    state.storage["recordshelf-user-state-v2"],
  );
  assert.equal(
    userState.releaseMetadataOverrides["release-cached"].motionArtwork
      .storage,
    "LOCAL_WEBP",
  );
});
