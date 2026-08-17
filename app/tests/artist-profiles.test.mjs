import assert from "node:assert/strict";
import test from "node:test";
import {
  artistResearchFailureMessage,
  artistResearchJobPatch,
  getArtistProfile,
  hasUsefulArtistPublicFacts,
  loadArtistProfileState,
  normalizeArtistPlatformUrl,
  saveArtistProfileState,
  sanitizeArtistProfileState,
  updateArtistProfile,
  visibleArtistMediaMessage,
} from "../src/lib/artistProfiles.js";

test("artist profiles keep only safe shared fields", () => {
  const state = sanitizeArtistProfileState({
    profiles: {
      "artist-1": {
        explorationEnabled: true,
        releaseView: "grid",
        introduction: "  verified copy  ",
        introductionStatus: "READY",
        apiKey: "secret",
      },
    },
  });
  assert.deepEqual(state.profiles["artist-1"], {
    explorationEnabled: true,
    releaseView: "grid",
    introduction: "verified copy",
    introductionStatus: "READY",
    publicFacts: {
      resolvedName: "",
      artistType: "",
      gender: "",
      birthDate: "",
      activeFrom: "",
      endedAt: "",
      birthPlace: "",
      origin: "",
      country: "",
      musicBrainzId: "",
      genres: [],
      members: [],
    },
    identityNote: "",
    recommendedListening: [],
    awards: [],
    nominations: [],
    filmRelationships: [],
    claimSources: [],
    warnings: [],
    platformLinks: {
      appleMusic: "",
      spotify: "",
      youtubeMusic: "",
    },
    media: {
      status: "EMPTY",
      imageUrl: "",
      localMotionUrl: "",
      sourceVideoUrl: "",
      motionEnabled: true,
      source: "",
      checkedAt: "",
      truncated: false,
      notice: "",
      error: "",
    },
    sources: [],
    researchError: "",
    researchMessage: "",
    updatedAt: "",
  });
});

test("artist platform links only accept exact HTTPS artist pages", () => {
  assert.equal(
    normalizeArtistPlatformUrl(
      "appleMusic",
      "https://music.apple.com/us/artist/kiiikiii/1794201263",
    ),
    "https://music.apple.com/us/artist/kiiikiii/1794201263",
  );
  assert.equal(
    normalizeArtistPlatformUrl("spotify", "https://open.spotify.com/album/not-an-artist"),
    "",
  );
  assert.equal(
    normalizeArtistPlatformUrl(
      "youtubeMusic",
      "https://music.youtube.com/channel/UCartist",
    ),
    "https://music.youtube.com/channel/UCartist",
  );
  assert.equal(
    normalizeArtistPlatformUrl("appleMusic", "http://music.apple.com/us/artist/test/1"),
    "",
  );
});

test("artist profile sanitizes platform links and private motion paths", () => {
  const state = sanitizeArtistProfileState({
    profiles: {
      "artist-1": {
        platformLinks: {
          appleMusic: "https://music.apple.com/us/artist/kiiikiii/1794201263",
          spotify: "javascript:alert(1)",
        },
        media: {
          status: "READY",
          imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/example.jpg",
          localMotionUrl: "/private-motion-artwork/artist-1-123.webp",
        },
      },
    },
  });
  assert.equal(
    state.profiles["artist-1"].platformLinks.appleMusic,
    "https://music.apple.com/us/artist/kiiikiii/1794201263",
  );
  assert.equal(state.profiles["artist-1"].platformLinks.spotify, "");
  assert.equal(
    state.profiles["artist-1"].media.localMotionUrl,
    "/private-motion-artwork/artist-1-123.webp",
  );
});

test("artist profile keeps private artist motion mp4 paths", () => {
  const state = sanitizeArtistProfileState({
    profiles: {
      "artist-1": {
        media: {
          status: "READY",
          localMotionUrl: "/private-motion-artwork/artist-1-456.mp4",
        },
      },
    },
  });
  assert.equal(
    state.profiles["artist-1"].media.localMotionUrl,
    "/private-motion-artwork/artist-1-456.mp4",
  );
});

test("artist profile updates preserve the existing introduction", () => {
  const next = updateArtistProfile(
    {
      version: 1,
      profiles: {
        "artist-1": {
          explorationEnabled: false,
          releaseView: "grid",
          introduction: "Existing",
          introductionStatus: "READY",
        },
      },
    },
    "artist-1",
    { explorationEnabled: true },
  );
  assert.equal(next.profiles["artist-1"].explorationEnabled, true);
  assert.equal(next.profiles["artist-1"].releaseView, "grid");
  assert.equal(next.profiles["artist-1"].introduction, "Existing");
});

test("failed artist research patches keep previous public facts", () => {
  const next = updateArtistProfile(
    {
      version: 3,
      profiles: {
        "artist-1": {
          introduction: "Existing",
          introductionStatus: "READY",
          publicFacts: {
            birthDate: "1995-10-21",
            country: "美国",
            genres: ["pop"],
          },
        },
      },
    },
    "artist-1",
    {
      introductionStatus: "FAILED",
      researchError: "无法排除同名艺人，原有资料已保留。",
      publicFacts: {
        birthDate: "1995-10-21",
        country: "",
        genres: [],
      },
    },
  );
  const profile = next.profiles["artist-1"];
  assert.equal(profile.introduction, "Existing");
  assert.equal(profile.introductionStatus, "FAILED");
  assert.equal(profile.publicFacts.birthDate, "1995-10-21");
  assert.equal(profile.publicFacts.country, "美国");
  assert.deepEqual(profile.publicFacts.genres, ["pop"]);
});

test("codex job failures keep MusicBrainz facts as a non-blocking partial result", () => {
  assert.equal(hasUsefulArtistPublicFacts({ country: "美国", genres: ["pop"] }), true);
  const partial = artistResearchJobPatch({
    status: "COMPLETED",
    resultStatus: "PARTIAL",
    error: "CODEX_RESEARCH_FAILED",
    message: "Codex 长文未完成，已用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
    profile: {
      introductionStatus: "READY",
      introduction: "Wikipedia extract",
      publicFacts: { country: "美国", genres: ["pop"] },
      sources: [{ title: "MusicBrainz", url: "https://musicbrainz.org/artist/example" }],
      researchError: "Codex 长文未完成，已用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
    },
  });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.patch.introductionStatus, "READY");
  assert.equal(partial.patch.publicFacts.country, "美国");
  assert.match(partial.patch.researchError, /MusicBrainz \/ Wikipedia/);
  assert.equal(
    partial.patch.researchError.includes("Codex 联网研究没有完成，原有资料已保留"),
    false,
  );

  const failedWithoutFacts = artistResearchJobPatch({
    status: "FAILED",
    error: "CODEX_RESEARCH_FAILED",
    profile: null,
  });
  assert.equal(failedWithoutFacts.kind, "failed");
  assert.equal(
    failedWithoutFacts.patch.researchError,
    artistResearchFailureMessage("CODEX_RESEARCH_FAILED"),
  );

  const failedWithFacts = artistResearchJobPatch({
    status: "FAILED",
    error: "CODEX_CLI_UNAVAILABLE",
    profile: {
      publicFacts: { birthDate: "1995-10-21", country: "美国" },
      sources: [],
    },
  });
  assert.equal(failedWithFacts.kind, "partial");
  assert.equal(failedWithFacts.patch.introductionStatus, "READY");
  assert.match(failedWithFacts.patch.researchError, /未找到 Codex CLI/);

  const identityConflict = artistResearchJobPatch({
    status: "FAILED",
    error: "ARTIST_IDENTITY_AMBIGUOUS",
    profile: null,
  });
  assert.equal(identityConflict.kind, "failed");
  assert.match(identityConflict.patch.researchError, /同名艺人/);
});

test("artist profile normalizes an unknown release view to list", () => {
  const state = sanitizeArtistProfileState({
    profiles: {
      "artist-1": {
        releaseView: "wall",
      },
    },
  });
  assert.equal(state.profiles["artist-1"].releaseView, "list");
});

test("artist media hides a stale invalid-url error when motion already exists or the catalog is a still", () => {
  assert.equal(
    visibleArtistMediaMessage({
      error: "动态视频地址无效，已保留高清艺人图片。",
      notice: "",
      localMotionUrl: "/private-motion-artwork/artist-raw-kiiikiii.mp4",
      sourceVideoUrl:
        "https://mvod.itunes.apple.com/itunes-assets/square.m3u8",
    }),
    "",
  );
  assert.equal(
    visibleArtistMediaMessage({
      error: "动态视频地址无效，已保留高清艺人图片。",
      notice: "",
      localMotionUrl: "",
      sourceVideoUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Video211/preview/2400x1350mv.webp",
    }),
    "",
  );
  assert.equal(
    visibleArtistMediaMessage({
      error: "动态视频地址无效，已保留高清艺人图片。",
      notice: "",
      localMotionUrl: "",
      sourceVideoUrl:
        "https://mvod.itunes.apple.com/itunes-assets/HLSMusic221/example.m3u8",
    }),
    "",
  );
  assert.match(
    visibleArtistMediaMessage({
      error: "动态视频转码失败，已保留高清艺人图片。",
      notice: "",
      localMotionUrl: "",
      sourceVideoUrl:
        "https://mvod.itunes.apple.com/itunes-assets/HLSMusic221/example.m3u8",
    }),
    /转码失败/,
  );
  const state = sanitizeArtistProfileState({
    profiles: {
      "raw-doja cat": {
        media: {
          status: "IMAGE_ONLY",
          error: "动态视频地址无效，已保留高清艺人图片。",
          sourceVideoUrl:
            "https://mvod.itunes.apple.com/itunes-assets/HLSMusic221/example.m3u8",
        },
      },
    },
  });
  assert.equal(state.profiles["raw-doja cat"].media.error, "");
});

test("saved platform links and media round-trip through sanitize, lookup, and load/save", () => {
  const apple = "https://music.apple.com/us/artist/doja-cat/1477172905";
  const spotify = "https://open.spotify.com/artist/5cj0lLjcoR7YOSnhnX0Po5";
  const youtube = "https://music.youtube.com/channel/UCartist";
  const motion = "/private-motion-artwork/artist-raw-doja-cat.mp4";
  const image = "https://is1-ssl.mzstatic.com/image/thumb/doja.jpg";
  const stored = sanitizeArtistProfileState({
    profiles: {
      "raw-doja+cat": {
        platformLinks: { appleMusic: apple, spotify, youtubeMusic: youtube },
        media: {
          status: "READY",
          imageUrl: image,
          localMotionUrl: motion,
        },
      },
    },
  });
  assert.equal(stored.profiles["raw-doja cat"].platformLinks.appleMusic, apple);
  assert.equal(stored.profiles["raw-doja cat"].platformLinks.spotify, spotify);
  assert.equal(stored.profiles["raw-doja cat"].media.localMotionUrl, motion);
  assert.equal(stored.profiles["raw-doja+cat"], undefined);

  const storage = new Map();
  const ls = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(saveArtistProfileState(stored, ls, { notify: false }), true);
  const loaded = loadArtistProfileState(ls);
  assert.equal(
    getArtistProfile(loaded, "raw-doja+cat").platformLinks.appleMusic,
    apple,
  );
  assert.equal(
    getArtistProfile(loaded, "raw-doja cat").platformLinks.youtubeMusic,
    youtube,
  );
  assert.equal(
    getArtistProfile(loaded, "artist-mapped", ["Doja Cat"]).media.imageUrl,
    image,
  );

  const mapped = updateArtistProfile(
    loaded,
    "artist-mapped",
    { explorationEnabled: true },
    ["Doja Cat"],
  );
  assert.equal(mapped.profiles["artist-mapped"].platformLinks.spotify, spotify);
  assert.equal(mapped.profiles["artist-mapped"].media.localMotionUrl, motion);
  assert.equal(mapped.profiles["raw-doja cat"], undefined);
});

test("saving one platform URL does not clear already-cached artist media", () => {
  const next = updateArtistProfile(
    {
      version: 3,
      profiles: {
        "raw-arlo parks": {
          platformLinks: {
            appleMusic: "https://music.apple.com/cn/artist/1291875084",
          },
          media: {
            status: "READY",
            imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/arlo.jpg",
            localMotionUrl: "/private-motion-artwork/artist-raw-arlo-parks.mp4",
          },
        },
      },
    },
    "raw-arlo parks",
    {
      platformLinks: {
        appleMusic: "https://music.apple.com/cn/artist/1291875084",
        spotify: "https://open.spotify.com/artist/arlo",
      },
    },
  );
  assert.equal(
    next.profiles["raw-arlo parks"].platformLinks.spotify,
    "https://open.spotify.com/artist/arlo",
  );
  assert.equal(
    next.profiles["raw-arlo parks"].media.localMotionUrl,
    "/private-motion-artwork/artist-raw-arlo-parks.mp4",
  );
});
