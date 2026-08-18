import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  artistMotionFailureMessage,
  artistResearchCodexNotice,
  buildCodexArtistExecArgs,
  classifyCodexCliFailure,
  musicBrainzDetailsToProfile,
  persistResearchedArtistProfile,
  requestArtistMedia,
  requestCodexArtistResearch,
  researchArtist,
  runArtistResearchJob,
  selectExactMusicBrainzCandidate,
} from "../artist-research/index.mjs";
import { readSharedState } from "../shared-state/index.mjs";
import { ARTIST_PROFILE_STORAGE_KEY } from "../src/lib/sharedStorageKeys.js";

test("artist research accepts only one high-confidence exact identity", () => {
  const candidate = selectExactMusicBrainzCandidate(
    [
      { id: "doja", name: "Doja Cat", score: 100, aliases: [] },
      { id: "other", name: "Doja", score: 87, aliases: [] },
    ],
    ["Doja Cat"],
  );
  assert.equal(candidate?.id, "doja");
  assert.equal(
    selectExactMusicBrainzCandidate(
      [
        { id: "one", name: "Same Name", score: 100 },
        { id: "two", name: "Same Name", score: 99 },
      ],
      ["Same Name"],
    ),
    null,
  );
});

test("artist research preserves structured life and group member facts", () => {
  const profile = musicBrainzDetailsToProfile({
    id: "group-id",
    name: "Example Group",
    type: "Group",
    country: "GB",
    area: { name: "London" },
    "life-span": { begin: "2001", end: null },
    genres: [{ name: "art pop", count: 4 }],
    relations: [
      {
        type: "member of band",
        artist: { id: "member-id", name: "Member One" },
        attributes: ["vocals"],
      },
    ],
  });
  assert.equal(profile.publicFacts.activeFrom, "2001");
  assert.equal(profile.publicFacts.artistType, "团体");
  assert.equal(profile.publicFacts.origin, "英国 · 伦敦");
  assert.equal(profile.publicFacts.country, "英国");
  assert.deepEqual(profile.publicFacts.genres, ["art pop"]);
  assert.equal(profile.publicFacts.members[0].name, "Member One");
});

test("artist research resolves an exact name, respects the provider interval, and returns public facts", async () => {
  const calls = [];
  const delays = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/ws/2/artist?")) {
      return new Response(
        JSON.stringify({
          artists: [
            {
              id: "5df62a88-cac9-490a-b62c-c7c88f4020f4",
              name: "Doja Cat",
              score: 100,
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        id: "5df62a88-cac9-490a-b62c-c7c88f4020f4",
        name: "Doja Cat",
        type: "Person",
        gender: "female",
        country: "US",
        area: { name: "United States" },
        "begin-area": { name: "Tarzana" },
        "life-span": { begin: "1995-10-21" },
        genres: [{ name: "pop", count: 8 }],
        relations: [],
      }),
      { status: 200 },
    );
  };

  const profile = await researchArtist(
    { name: "Doja Cat", aliases: [] },
    {
      fetchImpl,
      delayImpl: async (ms) => delays.push(ms),
    },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [1_100]);
  assert.equal(profile.publicFacts.birthDate, "1995-10-21");
  assert.equal(profile.publicFacts.artistType, "个人");
  assert.equal(profile.publicFacts.birthPlace, "美国 · 塔扎纳");
  assert.equal(profile.publicFacts.country, "美国");
  assert.deepEqual(profile.publicFacts.genres, ["pop"]);
});

test("artist research persists public facts without losing local display preferences", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-research-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    await persistResearchedArtistProfile(
      "raw-doja-cat",
      {
        introduction: "Doja Cat is an American artist.",
        introductionStatus: "READY",
        publicFacts: {
          birthDate: "1995-10-21",
          birthPlace: "Los Angeles",
        },
        sources: [
          {
            label: "MusicBrainz",
            url: "https://musicbrainz.org/artist/example",
          },
        ],
      },
      statePath,
    );
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(
      shared.storage[ARTIST_PROFILE_STORAGE_KEY],
    );
    const profile = profiles.profiles["raw-doja-cat"];
    assert.equal(profile.introductionStatus, "READY");
    assert.equal(profile.publicFacts.birthDate, "1995-10-21");
    assert.equal(profile.releaseView, "list");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("artist research persist keeps saved homepage links and cached media", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-links-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    await persistResearchedArtistProfile(
      "raw-doja+cat",
      {
        platformLinks: {
          appleMusic: "https://music.apple.com/us/artist/doja-cat/1477172905",
          spotify: "https://open.spotify.com/artist/5cj0lLjcoR7YOSnhnX0Po5",
        },
        media: {
          status: "READY",
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/doja.jpg",
          localMotionUrl: "/private-motion-artwork/artist-raw-doja-cat.mp4",
        },
      },
      statePath,
    );
    await persistResearchedArtistProfile(
      "raw-doja cat",
      {
        publicFacts: { birthDate: "1995-10-21", birthPlace: "Los Angeles" },
        sources: [
          {
            title: "MusicBrainz",
            url: "https://musicbrainz.org/artist/example",
          },
        ],
      },
      statePath,
    );
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(shared.storage[ARTIST_PROFILE_STORAGE_KEY]);
    const profile = profiles.profiles["raw-doja cat"];
    assert.equal(
      profile.platformLinks.appleMusic,
      "https://music.apple.com/us/artist/doja-cat/1477172905",
    );
    assert.equal(
      profile.platformLinks.spotify,
      "https://open.spotify.com/artist/5cj0lLjcoR7YOSnhnX0Po5",
    );
    assert.equal(
      profile.media.localMotionUrl,
      "/private-motion-artwork/artist-raw-doja-cat.mp4",
    );
    assert.equal(profile.publicFacts.birthDate, "1995-10-21");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("codex failure still persists MusicBrainz public facts", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-research-fail-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    await persistResearchedArtistProfile(
      "raw-doja cat",
      {
        introduction: "Existing introduction",
        introductionStatus: "READY",
        publicFacts: { birthDate: "1995-10-21" },
      },
      statePath,
    );
    const job = {
      jobId: "job-1",
      artistId: "raw-doja cat",
      status: "PREPARING",
      message: "",
      resultStatus: "",
      profile: null,
      warnings: [],
      error: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    };
    await runArtistResearchJob(
      job,
      { artistId: "raw-doja cat", name: "Doja Cat" },
      {
        statePath,
        researchArtistImpl: async () => ({
          introduction: "Wikipedia extract should not replace a prior intro",
          introductionStatus: "READY",
          publicFacts: {
            birthDate: "1995-10-21",
            birthPlace: "美国 · 塔扎纳",
            country: "美国",
            artistType: "个人",
            genres: ["pop"],
          },
          sources: [
            {
              sourceId: "MB1",
              title: "Doja Cat",
              publisher: "MusicBrainz",
              url: "https://musicbrainz.org/artist/example",
            },
          ],
        }),
        requestCodexArtistResearchImpl: async () => {
          throw Object.assign(new Error("CODEX_RESEARCH_FAILED"), {
            code: "CODEX_RESEARCH_FAILED",
          });
        },
      },
    );
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.resultStatus, "PARTIAL");
    assert.equal(job.profile.publicFacts.country, "美国");
    assert.deepEqual(job.profile.publicFacts.genres, ["pop"]);
    assert.equal(job.profile.introduction, "Existing introduction");
    assert.equal(job.profile.introductionStatus, "READY");
    assert.equal(job.profile.researchError, artistResearchCodexNotice("CODEX_RESEARCH_FAILED"));
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(shared.storage[ARTIST_PROFILE_STORAGE_KEY]);
    const profile = profiles.profiles["raw-doja cat"];
    assert.equal(profile.introduction, "Existing introduction");
    assert.equal(profile.introductionStatus, "READY");
    assert.equal(profile.publicFacts.birthDate, "1995-10-21");
    assert.equal(profile.publicFacts.country, "美国");
    assert.deepEqual(profile.publicFacts.genres, ["pop"]);
    assert.equal(profile.researchError, artistResearchCodexNotice("CODEX_RESEARCH_FAILED"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("codex failure may persist a Wikipedia extract when no previous intro exists", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-research-wiki-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    const job = {
      jobId: "job-wiki",
      artistId: "raw-doja cat",
      status: "PREPARING",
      message: "",
      resultStatus: "",
      profile: null,
      warnings: [],
      error: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    };
    await runArtistResearchJob(
      job,
      { artistId: "raw-doja cat", name: "Doja Cat" },
      {
        statePath,
        researchArtistImpl: async () => ({
          introduction: "这是一段可核验的公开艺人介绍。",
          introductionStatus: "READY",
          publicFacts: {
            birthDate: "1995-10-21",
            country: "美国",
            artistType: "个人",
          },
          sources: [
            {
              sourceId: "W1",
              title: "Doja Cat",
              publisher: "Wikipedia",
              url: "https://en.wikipedia.org/wiki/Doja_Cat",
            },
          ],
        }),
        requestCodexArtistResearchImpl: async () => {
          throw Object.assign(new Error("CODEX_CLI_UNAVAILABLE"), {
            code: "CODEX_CLI_UNAVAILABLE",
          });
        },
      },
    );
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.resultStatus, "PARTIAL");
    assert.equal(job.profile.introduction, "这是一段可核验的公开艺人介绍。");
    assert.match(job.profile.researchError, /未找到 Codex CLI/);
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(shared.storage[ARTIST_PROFILE_STORAGE_KEY]);
    const profile = profiles.profiles["raw-doja cat"];
    assert.equal(profile.introduction, "这是一段可核验的公开艺人介绍。");
    assert.equal(profile.introductionStatus, "READY");
    assert.equal(profile.publicFacts.country, "美国");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous artist identity keeps previous data and skips Codex", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-research-ambiguous-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    await persistResearchedArtistProfile(
      "raw-same-name",
      {
        introduction: "Keep me",
        introductionStatus: "READY",
        publicFacts: { country: "美国" },
      },
      statePath,
    );
    const job = {
      jobId: "job-ambiguous",
      artistId: "raw-same-name",
      status: "PREPARING",
      message: "",
      resultStatus: "",
      profile: null,
      warnings: [],
      error: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    };
    let codexCalled = false;
    await runArtistResearchJob(
      job,
      { artistId: "raw-same-name", name: "Same Name" },
      {
        statePath,
        researchArtistImpl: async () => {
          throw Object.assign(new Error("ARTIST_IDENTITY_AMBIGUOUS"), {
            code: "ARTIST_IDENTITY_AMBIGUOUS",
            statusCode: 409,
            safeMessage: "没有找到唯一的精确艺人身份。",
          });
        },
        requestCodexArtistResearchImpl: async () => {
          codexCalled = true;
          throw new Error("should not run Codex");
        },
      },
    );
    assert.equal(codexCalled, false);
    assert.equal(job.status, "FAILED");
    assert.equal(job.error, "ARTIST_IDENTITY_AMBIGUOUS");
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(shared.storage[ARTIST_PROFILE_STORAGE_KEY]);
    const profile = profiles.profiles["raw-same-name"];
    assert.equal(profile.introduction, "Keep me");
    assert.equal(profile.publicFacts.country, "美国");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("artist media request caches one exact Apple Music artist and persists its links", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-media-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    const result = await requestArtistMedia(
      {
        artistId: "raw-kiiikiii",
        appleMusicUrl: "https://music.apple.com/us/artist/kiiikiii/123456789",
      },
      {
        statePath,
        lookupArtistMediaImpl: async () => ({
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/artist.jpg",
          sourceVideoUrl: "https://mvod.itunes.apple.com/kiiikiii.m3u8",
          normalizedUrl:
            "https://music.apple.com/us/artist/kiiikiii/123456789",
        }),
        cacheArtistMotionArtworkImpl: async () => ({
          localUrl: "/private-motion-artwork/artist-raw-kiiikiii.mp4",
        }),
      },
    );

    assert.equal(result.media.status, "READY");
    assert.equal(
      result.media.localMotionUrl,
      "/private-motion-artwork/artist-raw-kiiikiii.mp4",
    );
    const shared = await readSharedState(statePath);
    const profiles = JSON.parse(
      shared.storage[ARTIST_PROFILE_STORAGE_KEY],
    );
    const profile = profiles.profiles["raw-kiiikiii"];
    assert.equal(
      profile.platformLinks.appleMusic,
      "https://music.apple.com/us/artist/kiiikiii/123456789",
    );
    assert.equal(profile.media.status, "READY");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("artist research follows a Wikidata relation to a verifiable Wikipedia introduction", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/ws/2/artist?")) {
      return new Response(
        JSON.stringify({
          artists: [{ id: "artist-id", name: "Example Artist", score: 100 }],
        }),
        { status: 200 },
      );
    }
    if (value.includes("/ws/2/artist/artist-id")) {
      return new Response(
        JSON.stringify({
          id: "artist-id",
          name: "Example Artist",
          type: "Person",
          relations: [
            {
              type: "wikidata",
              url: { resource: "https://www.wikidata.org/wiki/Q123" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (value.includes("Special:EntityData/Q123.json")) {
      return new Response(
        JSON.stringify({
          entities: {
            Q123: {
              sitelinks: {
                zhwiki: { url: "https://zh.wikipedia.org/wiki/Example_Artist" },
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ extract: "这是一段可核验的公开艺人介绍。" }),
      { status: 200 },
    );
  };

  const profile = await researchArtist(
    { name: "Example Artist", aliases: [] },
    { fetchImpl, delayImpl: async () => {} },
  );

  assert.equal(profile.introduction, "这是一段可核验的公开艺人介绍。");
  assert.equal(profile.sources[1]?.publisher, "Wikipedia");
  assert.ok(calls.some((url) => url.includes("Special:EntityData/Q123.json")));
  assert.ok(calls.some((url) => url.includes("zh.wikipedia.org/api/rest_v1")));
});

test("artist media keeps a truncated MP4 instead of failing to a still", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-media-trim-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    const result = await requestArtistMedia(
      {
        artistId: "raw-kiiikiii",
        appleMusicUrl: "https://music.apple.com/us/artist/kiiikiii/123456789",
      },
      {
        statePath,
        lookupArtistMediaImpl: async () => ({
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/artist.jpg",
          sourceVideoUrl: "https://mvod.itunes.apple.com/kiiikiii.m3u8",
          normalizedUrl:
            "https://music.apple.com/us/artist/kiiikiii/123456789",
        }),
        cacheArtistMotionArtworkImpl: async () => ({
          localUrl: "/private-motion-artwork/artist-raw-kiiikiii.mp4",
          motionArtwork: {
            truncated: true,
            durationSeconds: 5,
            byteLength: 7_000_000,
          },
        }),
      },
    );

    assert.equal(result.media.status, "READY");
    assert.equal(result.media.truncated, true);
    assert.equal(
      result.media.notice,
      "动态视频已截短至 5 秒，以控制在 8 MB 以内。",
    );
    assert.equal(result.media.error, "");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("artist media preserves the last playable motion file when ffmpeg fails", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-media-keep-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    await persistResearchedArtistProfile(
      "raw-kiiikiii",
      {
        media: {
          status: "READY",
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/old.jpg",
          localMotionUrl: "/private-motion-artwork/artist-raw-kiiikiii-old.mp4",
        },
      },
      statePath,
    );
    const result = await requestArtistMedia(
      {
        artistId: "raw-kiiikiii",
        appleMusicUrl: "https://music.apple.com/us/artist/kiiikiii/123456789",
      },
      {
        statePath,
        lookupArtistMediaImpl: async () => ({
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/artist.jpg",
          sourceVideoUrl: "https://mvod.itunes.apple.com/kiiikiii.m3u8",
          normalizedUrl:
            "https://music.apple.com/us/artist/kiiikiii/123456789",
        }),
        cacheArtistMotionArtworkImpl: async () => {
          throw new Error("FFMPEG_FAILED:libx264");
        },
      },
    );

    assert.equal(result.media.status, "READY");
    assert.equal(
      result.media.localMotionUrl,
      "/private-motion-artwork/artist-raw-kiiikiii-old.mp4",
    );
    assert.match(result.media.error, /动态视频转码失败/);
    assert.match(result.media.error, /已保留上次成功的动态视频/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("artist motion failure copy distinguishes size, network, and still fallbacks", () => {
  assert.equal(
    artistMotionFailureMessage(new Error("MOTION_ARTWORK_TOO_LARGE"), {
      preservedImage: true,
    }),
    "动态视频压缩后仍超过 8 MB，已保留高清艺人图片。",
  );
  assert.match(
    artistMotionFailureMessage(new Error("MOTION_SOURCE_HTTP_403"), {
      preservedImage: true,
    }),
    /暂时无法下载/,
  );
  assert.match(
    artistMotionFailureMessage(new Error("INVALID_ARTIST_MOTION_ID"), {
      preservedImage: true,
    }),
    /无法写入本机/,
  );
});

test("artist media ignores Apple motion preview stills instead of treating them as video", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-media-still-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    const result = await requestArtistMedia(
      {
        artistId: "raw-kiiikiii",
        appleMusicUrl: "https://music.apple.com/us/artist/kiiikiii/1795471746",
      },
      {
        statePath,
        lookupArtistMediaImpl: async () => ({
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/artist.jpg",
          sourceVideoUrl:
            "https://is1-ssl.mzstatic.com/image/thumb/Video211/v4/ab/7c/dc/ab7cdc86-a059-45b2-89e3-eb4a2b561cdd/Job47a94e31-7ad0-478e-a8ad-d74fc7f24978-200819453-PreviewImage_Preview_Image_Intermediate_nonvideo_393019442_2303427635-Time1755799427448.png/2400x1350mv.webp",
          normalizedUrl:
            "https://music.apple.com/us/artist/kiiikiii/1795471746",
        }),
        cacheArtistMotionArtworkImpl: async () => {
          throw new Error("should not encode a preview still");
        },
      },
    );

    assert.equal(result.media.status, "IMAGE_ONLY");
    assert.equal(result.media.sourceVideoUrl, "");
    assert.equal(result.media.error, "");
    assert.equal(
      result.media.imageUrl,
      "https://is1-ssl.mzstatic.com/image/thumb/artist.jpg",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("artist media encodes HLS for spaced raw artist ids", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-artist-media-slug-"),
  );
  const statePath = path.join(directory, "shared-local-state.json");
  try {
    let cachedId = "";
    const result = await requestArtistMedia(
      {
        artistId: "raw-doja cat",
        appleMusicUrl: "https://music.apple.com/us/artist/doja-cat/830588310",
      },
      {
        statePath,
        lookupArtistMediaImpl: async () => ({
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/artist.jpg",
          sourceVideoUrl:
            "https://mvod.itunes.apple.com/itunes-assets/HLSMusic221/example.m3u8",
          normalizedUrl:
            "https://music.apple.com/us/artist/doja-cat/830588310",
        }),
        cacheArtistMotionArtworkImpl: async (artistId) => {
          cachedId = artistId;
          return {
            localUrl: "/private-motion-artwork/artist-raw-doja-cat.mp4",
            motionArtwork: { truncated: false },
          };
        },
      },
    );

    assert.equal(cachedId, "raw-doja cat");
    assert.equal(result.media.status, "READY");
    assert.equal(result.media.error, "");
    assert.equal(
      result.media.localMotionUrl,
      "/private-motion-artwork/artist-raw-doja-cat.mp4",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Codex JSONL model errors are classified instead of a generic failure", () => {
  const stdout = [
    `{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.\\"}}"}`,
    `{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.\\"}}"}}`,
  ].join("\n");
  assert.equal(
    classifyCodexCliFailure({ stdout, stderr: "" }),
    "CODEX_MODEL_UNSUPPORTED",
  );
  assert.equal(
    artistResearchCodexNotice("CODEX_MODEL_UNSUPPORTED"),
    "本机 Codex 当前模型不被 ChatGPT 登录支持，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  );
  const args = buildCodexArtistExecArgs({
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/result.json",
    workingDirectory: "/tmp",
  });
  assert.equal(args[0], "--search");
  assert.equal(args[1], "exec");
  assert.equal(args.includes("--ignore-user-config"), true);
  assert.equal(args.includes("--model"), false);
});

test("Codex artist research retries without an unsupported ChatGPT model", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-codex-model-retry-"),
  );
  const fakeCli = path.join(directory, "fake-codex.mjs");
  await fs.writeFile(
    fakeCli,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { stdin, argv, exit } from "node:process";
stdin.resume();
const args = argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "";
const outputPath = args[args.indexOf("--output-last-message") + 1];
const ignoreUserConfig = args.includes("--ignore-user-config");
const fail = model === "gpt-5.2" || !ignoreUserConfig;
const finish = (code) => {
  stdin.on("end", () => exit(code));
  setTimeout(() => exit(code), 20);
};
if (fail) {
  console.log(JSON.stringify({
    type: "error",
    message: JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.",
      },
    }),
  }));
  finish(1);
} else {
  writeFileSync(outputPath, JSON.stringify({
    status: "OK",
    artist_id: "dry-run",
    artist_name: "Dry Run",
    identity_note: "",
    public_facts: {
      resolved_name: "Dry Run",
      artist_type: "个人",
      birth_date: "",
      active_from: "",
      ended_at: "",
      birth_place: "",
      country: "",
      origin: "",
      genres: [],
    },
    introduction: "测试长文",
    group_members: [],
    awards: [],
    nominations: [],
    film_relationships: [],
    recommended_listening: [],
    claim_sources: [],
    sources: [],
    warnings: [],
  }));
  finish(0);
}
`,
    { mode: 0o755 },
  );
  try {
    const result = await requestCodexArtistResearch({
      identity: { artist_id: "dry-run", artist_name: "Dry Run" },
      executable: fakeCli,
      model: "gpt-5.2",
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "OK");
    assert.equal(result.introduction, "测试长文");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

