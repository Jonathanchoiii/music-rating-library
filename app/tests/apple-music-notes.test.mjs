import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildEditorialVersions,
  classifyAppleMusicUrl,
  editorialNoteHash,
  parseAppleMusicAlbumUrl,
  sanitizeEditorialHtml,
  scanAppleMusicEditorialNotes,
} from "../apple-music-notes/index.mjs";
import {
  editorialVersionLabel,
  normalizeAlbumIntroduction,
  selectAlbumIntroductionVersionId,
  selectDefaultEditorialVersionId,
  USER_ALBUM_INTRODUCTION_VERSION_ID,
} from "../src/lib/appleMusicEditorial.js";
import { findConfirmedAppleMusicAlbum } from "../src/lib/appleMusicUrl.js";
import { getReleaseMetadataFields } from "../src/lib/neodbSync.js";

async function temporaryStorePath() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-apple-notes-"),
  );
  return { directory, storePath: path.join(directory, "notes.json") };
}

test("Apple Music album URLs are parsed strictly", () => {
  assert.deepEqual(
    parseAppleMusicAlbumUrl(
      "https://music.apple.com/tw/album/sable-fable/1795572998",
    ),
    {
      provider: "appleMusic",
      sourceStorefront: "tw",
      sourceAlbumId: "1795572998",
      canonicalUrl:
        "https://music.apple.com/tw/album/sable-fable/1795572998",
    },
  );

  // A shared song link keeps the album path; the `i` parameter is ignored.
  assert.equal(
    parseAppleMusicAlbumUrl(
      "https://music.apple.com/US/album/sable-fable/1795572998?i=1795573001&uo=4#play",
    ).canonicalUrl,
    "https://music.apple.com/us/album/sable-fable/1795572998",
  );

  assert.equal(
    parseAppleMusicAlbumUrl(
      "https://www.music.apple.com/jp/album/slug/123/",
    ).sourceStorefront,
    "jp",
  );
  assert.equal(
    parseAppleMusicAlbumUrl("https://music.apple.com/us/album/1795572998")
      .sourceAlbumId,
    "1795572998",
  );

  for (const rejected of [
    "http://music.apple.com/us/album/slug/123",
    "https://user:pass@music.apple.com/us/album/slug/123",
    "https://music.apple.example.com/us/album/slug/123",
    "https://open.spotify.com/album/123",
    "https://music.apple.com/us/artist/name/123",
    "https://music.apple.com/us/playlist/name/pl.123",
    "https://music.apple.com/us/station/name/ra.123",
    "https://music.apple.com/album/slug/123",
    "https://music.apple.com/us/album/slug",
    "https://music.apple.com/us/album/slug/pl.abc",
    "https://music.apple.com/usa/album/slug/123",
    "not a url",
    "",
  ]) {
    assert.equal(parseAppleMusicAlbumUrl(rejected), null, rejected);
  }
});

test("unsupported Apple Music resources are separated from invalid URLs", () => {
  assert.equal(
    classifyAppleMusicUrl("https://music.apple.com/us/artist/name/123").error,
    "UNSUPPORTED_APPLE_MUSIC_RESOURCE",
  );
  assert.equal(
    classifyAppleMusicUrl("https://open.spotify.com/album/1").error,
    "INVALID_APPLE_MUSIC_URL",
  );
});

test("confirmed Apple Music album links drive the detail module", () => {
  assert.equal(
    findConfirmedAppleMusicAlbum({
      externalLinks: [
        { provider: "APPLE_MUSIC", url: "https://music.apple.com/", status: "CONFIRMED" },
        {
          provider: "APPLE_MUSIC",
          url: "https://music.apple.com/tw/album/slug/9",
          status: "AUTO_CONFIRMED",
        },
      ],
    }).sourceAlbumId,
    "9",
  );
  assert.equal(
    findConfirmedAppleMusicAlbum({
      externalLinks: [
        {
          provider: "APPLE_MUSIC",
          url: "https://music.apple.com/tw/album/slug/9",
          status: "PENDING",
        },
      ],
    }),
    null,
  );
});

test("editorial notes keep only a bold/italic/break allowlist", () => {
  const { html, plainText } = sanitizeEditorialHtml(
    '<p onclick="x()">A <b class="x">bold</b> &amp; <i>quiet</i><br>line' +
      '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">link</a></p>',
  );

  assert.equal(html, "A <b>bold</b> &amp; <i>quiet</i><br />linelink");
  assert.equal(plainText, "A bold & quiet\nlinelink");
  assert.ok(!html.includes("onerror"));
  assert.ok(!html.includes("script"));
  assert.ok(!html.includes("javascript:"));
});

test("unbalanced Apple markup is closed instead of leaking", () => {
  assert.equal(sanitizeEditorialHtml("<b>loud").html, "<b>loud</b>");
});

test("normalized note hashing ignores cosmetic whitespace differences", () => {
  assert.equal(
    editorialNoteHash("Hello\u00a0 world"),
    editorialNoteHash("Hello world "),
  );
  assert.notEqual(editorialNoteHash("Hello world"), editorialNoteHash("Hi"));
  assert.equal(editorialNoteHash("   "), "");
});

test("identical prose from several regions collapses into one version", () => {
  const versions = buildEditorialVersions([
    {
      storefront: "tw",
      regionName: "Taiwan",
      languageTag: "zh-Hant",
      albumId: "1",
      noteType: "standard",
      html: "同一段介绍",
      plainText: "同一段介绍",
    },
    {
      storefront: "hk",
      regionName: "Hong Kong",
      languageTag: "zh-Hant",
      albumId: "2",
      noteType: "standard",
      html: "同一段介绍",
      plainText: "同一段介绍 ",
    },
    {
      storefront: "us",
      regionName: "United States",
      languageTag: "en-US",
      albumId: "3",
      noteType: "short",
      html: "A short blurb",
      plainText: "A short blurb",
    },
  ]);

  assert.equal(versions.length, 2);
  const [chinese, english] = versions;
  assert.equal(chinese.sources.length, 2);
  assert.deepEqual(
    chinese.sources.map((source) => source.storefront),
    ["hk", "tw"],
  );
  assert.equal(chinese.noteType, "standard");
  assert.equal(english.noteType, "short");
});

test("the same language with different prose stays separate", () => {
  const versions = buildEditorialVersions([
    {
      storefront: "tw",
      regionName: "Taiwan",
      languageTag: "zh-Hant",
      albumId: "1",
      noteType: "standard",
      html: "台版介绍",
      plainText: "台版介绍",
    },
    {
      storefront: "hk",
      regionName: "Hong Kong",
      languageTag: "zh-Hant",
      albumId: "2",
      noteType: "standard",
      html: "港版介绍",
      plainText: "港版介绍",
    },
  ]);

  assert.equal(versions.length, 2);
  assert.deepEqual(
    versions.map((version) => version.sources[0].storefront).sort(),
    ["hk", "tw"],
  );
});

test("a fuller note upgrades a short duplicate of the same prose", () => {
  const versions = buildEditorialVersions([
    {
      storefront: "us",
      regionName: "United States",
      languageTag: "en-US",
      albumId: "1",
      noteType: "short",
      html: "Same words",
      plainText: "Same words",
    },
    {
      storefront: "gb",
      regionName: "United Kingdom",
      languageTag: "en-GB",
      albumId: "2",
      noteType: "standard",
      html: "Same words",
      plainText: "Same words",
    },
  ]);

  assert.equal(versions.length, 1);
  assert.equal(versions[0].noteType, "standard");
  assert.deepEqual(versions[0].languageTags, ["en-GB", "en-US"]);
});

function storefrontPayload(entries) {
  return {
    data: entries.map(([id, name, defaultLanguageTag, supported]) => ({
      id,
      attributes: {
        name,
        defaultLanguageTag,
        supportedLanguageTags: supported,
      },
    })),
  };
}

function albumPayload({ id, notes, name = "Sable, Fable", artist = "Bon Iver" }) {
  return {
    data: [
      {
        id,
        attributes: {
          name,
          artistName: artist,
          url: `https://music.apple.com/us/album/slug/${id}`,
          artwork: { url: "https://example.com/{w}x{h}.jpg" },
          ...(notes ? { editorialNotes: notes } : {}),
        },
      },
    ],
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    json: async () => payload,
  };
}

function scanOptions(overrides = {}) {
  return {
    url: "https://music.apple.com/tw/album/slug/100",
    token: "developer-token",
    sleepImpl: async () => {},
    now: Date.now(),
    ...overrides,
  };
}

test("a quick scan resolves equivalents, localizes notes and dedupes regions", async (context) => {
  const { directory, storePath } = await temporaryStorePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/v1/storefronts")) {
      return jsonResponse(
        storefrontPayload([
          ["tw", "Taiwan", "zh-Hant-TW", ["zh-Hant-TW", "en-GB"]],
          ["us", "United States", "en-US", ["en-US"]],
        ]),
      );
    }
    if (url.includes("filter%5Bequivalents%5D")) {
      return jsonResponse({ data: [{ id: "900" }] });
    }
    if (url.includes("/albums/100")) {
      return jsonResponse(
        albumPayload({
          id: "100",
          notes: { standard: "<b>台版</b>官方介绍" },
        }),
      );
    }
    if (url.includes("/albums/900")) {
      return jsonResponse(
        albumPayload({ id: "900", notes: { short: "US blurb" } }),
      );
    }
    return jsonResponse({ data: [] }, { status: 404 });
  };

  const result = await scanAppleMusicEditorialNotes(
    scanOptions({ storePath, fetchImpl, locale: "zh-TW" }),
  );

  assert.equal(result.provider, "appleMusic");
  assert.equal(result.album.sourceStorefront, "tw");
  assert.equal(result.album.sourceAlbumId, "100");
  assert.equal(result.scan.status, "complete");
  assert.equal(result.emptyReason, null);
  assert.equal(result.versions.length, 2);

  const chinese = result.versions.find((version) =>
    version.languageTags.includes("zh-Hant-TW"),
  );
  assert.equal(chinese.html, "<b>台版</b>官方介绍");
  assert.equal(chinese.noteType, "standard");
  assert.equal(chinese.sources[0].regionName, "Taiwan");

  const english = result.versions.find(
    (version) => version.noteType === "short",
  );
  assert.equal(english.plainText, "US blurb");

  // Cross-storefront lookups must go through the equivalents filter.
  assert.ok(
    calls.some((url) =>
      url.includes("/v1/catalog/us/albums?filter%5Bequivalents%5D=100"),
    ),
  );
  assert.ok(calls.some((url) => url.includes("/albums/900?l=en-US")));

  // A repeat scan is served from the private cache without new Apple requests.
  const cachedCalls = calls.length;
  const cached = await scanAppleMusicEditorialNotes(
    scanOptions({ storePath, fetchImpl, locale: "zh-TW" }),
  );
  assert.equal(calls.length, cachedCalls);
  assert.equal(cached.versions.length, 2);
});

test("empty editorial notes never become a version", async (context) => {
  const { directory, storePath } = await temporaryStorePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const fetchImpl = async (url) => {
    if (url.includes("/v1/storefronts")) {
      return jsonResponse(
        storefrontPayload([["tw", "Taiwan", "zh-Hant-TW", ["zh-Hant-TW"]]]),
      );
    }
    if (url.includes("/albums/100")) {
      return jsonResponse(
        albumPayload({
          id: "100",
          notes: { standard: "   ", short: "" },
        }),
      );
    }
    return jsonResponse({ data: [] }, { status: 404 });
  };

  const result = await scanAppleMusicEditorialNotes(
    scanOptions({ storePath, fetchImpl }),
  );
  assert.deepEqual(result.versions, []);
  assert.equal(result.emptyReason, "APPLE_MUSIC_NO_EDITORIAL_NOTES");
});

test("rate limits honor Retry-After and 5xx retries eventually succeed", async (context) => {
  const { directory, storePath } = await temporaryStorePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const delays = [];
  let storefrontAttempts = 0;
  let albumAttempts = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/v1/storefronts")) {
      storefrontAttempts += 1;
      if (storefrontAttempts === 1) {
        return jsonResponse({}, { status: 429, headers: { "retry-after": "2" } });
      }
      return jsonResponse(
        storefrontPayload([["tw", "Taiwan", "zh-Hant-TW", ["zh-Hant-TW"]]]),
      );
    }
    albumAttempts += 1;
    if (albumAttempts === 1) return jsonResponse({}, { status: 503 });
    return jsonResponse(
      albumPayload({ id: "100", notes: { standard: "官方介绍" } }),
    );
  };

  const result = await scanAppleMusicEditorialNotes(
    scanOptions({
      storePath,
      fetchImpl,
      sleepImpl: async (ms) => delays.push(ms),
    }),
  );

  assert.equal(storefrontAttempts, 2);
  assert.equal(albumAttempts, 2);
  assert.equal(delays[0], 2000);
  assert.equal(result.versions.length, 1);
  assert.equal(result.scan.failedRequests, 0);
});

test("an unauthorized token fails fast without retrying", async (context) => {
  const { directory, storePath } = await temporaryStorePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return jsonResponse({}, { status: 401 });
  };

  await assert.rejects(
    scanAppleMusicEditorialNotes(scanOptions({ storePath, fetchImpl })),
    (error) => error.code === "APPLE_MUSIC_UNAUTHORIZED",
  );
  assert.equal(attempts, 1);
});

test("one failing language still returns the other results as partial", async (context) => {
  const { directory, storePath } = await temporaryStorePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const fetchImpl = async (url) => {
    if (url.includes("/v1/storefronts")) {
      return jsonResponse(
        storefrontPayload([
          ["tw", "Taiwan", "zh-Hant-TW", ["zh-Hant-TW", "en-GB"]],
        ]),
      );
    }
    if (url.includes("l=en-GB")) {
      return jsonResponse({}, { status: 500 });
    }
    return jsonResponse(
      albumPayload({ id: "100", notes: { standard: "官方介绍" } }),
    );
  };

  const result = await scanAppleMusicEditorialNotes(
    scanOptions({ storePath, fetchImpl }),
  );

  assert.equal(result.versions.length, 1);
  assert.equal(result.scan.status, "partial");
  assert.equal(result.scan.failedRequests, 1);
});

test("a missing developer token never reaches the network", async (context) => {
  const { directory, storePath } = await temporaryStorePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  context.after(() => {
    delete process.env.RECORDSHELF_APPLE_MUSIC_TOKEN_PATH;
    delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  });

  process.env.RECORDSHELF_APPLE_MUSIC_TOKEN_PATH = path.join(
    directory,
    "absent-token",
  );
  delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;

  let called = false;
  await assert.rejects(
    scanAppleMusicEditorialNotes({
      url: "https://music.apple.com/tw/album/slug/100",
      storePath,
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
      sleepImpl: async () => {},
    }),
    (error) => error.code === "APPLE_MUSIC_NOT_CONFIGURED",
  );
  assert.equal(called, false);
});

test("an unsupported Apple Music link is rejected before any request", async () => {
  let called = false;
  await assert.rejects(
    scanAppleMusicEditorialNotes({
      url: "https://music.apple.com/us/artist/name/123",
      token: "developer-token",
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    }),
    (error) => error.code === "UNSUPPORTED_APPLE_MUSIC_RESOURCE",
  );
  assert.equal(called, false);
});

test("the default version prefers the product locale and full notes", () => {
  const versions = [
    {
      id: "en",
      noteType: "standard",
      languageTags: ["en-US"],
      sources: [{ storefront: "us", regionName: "United States" }],
    },
    {
      id: "zh-short",
      noteType: "short",
      languageTags: ["zh-Hant-TW"],
      sources: [{ storefront: "tw", regionName: "Taiwan" }],
    },
    {
      id: "zh-full",
      noteType: "standard",
      languageTags: ["zh-Hant-TW"],
      sources: [{ storefront: "hk", regionName: "Hong Kong" }],
    },
  ];

  assert.equal(
    selectDefaultEditorialVersionId(versions, { locale: "zh-Hant-TW" }),
    "zh-full",
  );
  assert.equal(
    selectDefaultEditorialVersionId(versions, { locale: "zh-CN" }),
    "zh-full",
  );
  assert.equal(
    selectDefaultEditorialVersionId(versions, { locale: "fr-FR" }),
    "en",
  );
  assert.equal(
    selectDefaultEditorialVersionId(versions, {
      locale: "zh-CN",
      previousVersionId: "en",
    }),
    "en",
  );
  assert.equal(
    selectDefaultEditorialVersionId(versions, {
      locale: "zh-CN",
      previousVersionId: "removed",
    }),
    "zh-full",
  );
});

test("version labels name the language, region count and short notes", () => {
  const english = {
    id: "en",
    noteType: "standard",
    languageTags: ["en-US"],
    sources: Array.from({ length: 5 }, (_, index) => ({
      storefront: ["us", "gb", "ca", "au", "sg"][index],
      regionName: "region",
    })),
  };
  const japanese = {
    id: "ja",
    noteType: "short",
    languageTags: ["ja"],
    sources: [{ storefront: "jp", regionName: "Japan" }],
  };
  const taiwan = {
    id: "tw",
    noteType: "standard",
    languageTags: ["zh-Hant"],
    sources: [{ storefront: "tw", regionName: "Taiwan" }],
  };
  const hongKong = {
    id: "hk",
    noteType: "standard",
    languageTags: ["zh-Hant"],
    sources: [{ storefront: "hk", regionName: "Hong Kong" }],
  };
  const versions = [english, japanese, taiwan, hongKong];

  assert.equal(
    editorialVersionLabel(english, { locale: "zh-CN", versions }),
    "美国英语 · 5 个地区",
  );
  assert.ok(
    editorialVersionLabel(japanese, { locale: "zh-CN", versions }).endsWith(
      "短导语",
    ),
  );
  const taiwanLabel = editorialVersionLabel(taiwan, {
    locale: "zh-CN",
    versions,
  });
  const hongKongLabel = editorialVersionLabel(hongKong, {
    locale: "zh-CN",
    versions,
  });
  assert.notEqual(taiwanLabel, hongKongLabel);
  assert.ok(taiwanLabel.includes("台湾"));
  assert.ok(hongKongLabel.includes("香港"));
});

test("user album introductions decode copied HTML entities and stay plain text", () => {
  assert.equal(
    normalizeAlbumIntroduction(
      "  摇滚、Funk 与 R&amp;B 元素，热单《Bad Habit》\r\n\r\n第二段。  ",
    ),
    "摇滚、Funk 与 R&B 元素，热单《Bad Habit》\n\n第二段。",
  );
  assert.equal(normalizeAlbumIntroduction("   \n  "), "");
  assert.equal(
    normalizeAlbumIntroduction("a".repeat(20_001)).length,
    20_000,
  );
  assert.equal(
    getReleaseMetadataFields().includes("albumIntroduction"),
    true,
  );
});

test("album introduction version selection prefers the user-written copy", () => {
  const versions = [
    {
      id: "en",
      noteType: "standard",
      languageTags: ["en-US"],
      sources: [{ storefront: "us" }],
    },
  ];

  assert.equal(
    selectAlbumIntroductionVersionId(versions, {
      locale: "zh-CN",
      hasUserIntroduction: true,
    }),
    USER_ALBUM_INTRODUCTION_VERSION_ID,
  );
  assert.equal(
    selectAlbumIntroductionVersionId(versions, {
      locale: "zh-CN",
      hasUserIntroduction: true,
      previousVersionId: "en",
    }),
    "en",
  );
  assert.equal(
    selectAlbumIntroductionVersionId(versions, {
      locale: "zh-CN",
      hasUserIntroduction: true,
      previousVersionId: USER_ALBUM_INTRODUCTION_VERSION_ID,
    }),
    USER_ALBUM_INTRODUCTION_VERSION_ID,
  );
  assert.equal(
    selectAlbumIntroductionVersionId(versions, {
      locale: "zh-CN",
      hasUserIntroduction: false,
    }),
    "en",
  );
});
