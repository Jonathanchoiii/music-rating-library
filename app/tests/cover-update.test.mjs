import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { handleLocalCoverEnrichRequest } from "../scripts/private-covers-http.mjs";

function jsonRequest(method, url, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function jsonCapture() {
  const headers = new Map();
  let body = "";
  const response = {
    statusCode: 0,
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLocaleLowerCase(), String(value));
    },
    end(value) {
      body = value ?? "";
    },
  };
  return {
    response,
    headers,
    json() {
      return JSON.parse(body || "{}");
    },
  };
}

test("设置页封面更新按 40 张一批推进，且常量已声明", async () => {
  const source = await fs.readFile(
    new URL("../src/components/SettingsHome.jsx", import.meta.url),
    "utf8",
  );
  const lookupSource = await fs.readFile(
    new URL("../src/lib/coverStatus.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /const COVER_UPDATE_BATCH_SIZE = 40;/);
  assert.match(source, /offset \+= COVER_UPDATE_BATCH_SIZE/);
  assert.match(
    source,
    /targets\.slice\(offset, offset \+ COVER_UPDATE_BATCH_SIZE\)/,
  );
  assert.match(source, /coverLookupRecord/);
  assert.doesNotMatch(source, /force:\s*true/);
  assert.match(lookupSource, /coverRemoteUrl: release.coverRemoteUrl \?\? ""/);
});

test("详情封面刷新只出现在发行详情英雄封面，并 force 重解析当前发行", async () => {
  const detailSource = await fs.readFile(
    new URL("../src/components/ReleaseDetail.jsx", import.meta.url),
    "utf8",
  );
  const artworkSource = await fs.readFile(
    new URL("../src/components/ReleaseArtwork.jsx", import.meta.url),
    "utf8",
  );
  const viewsSource = await fs.readFile(
    new URL("../src/components/ReleaseViews.jsx", import.meta.url),
    "utf8",
  );

  assert.match(detailSource, /className="detail-cover-refresh"/);
  assert.match(detailSource, /force:\s*true/);
  assert.match(detailSource, /\/api\/local-enrich-covers/);
  assert.match(detailSource, /wait:\s*true/);
  assert.doesNotMatch(artworkSource, /detail-cover-refresh/);
  assert.doesNotMatch(viewsSource, /detail-cover-refresh/);
});

test("GET /api/local-enrich-covers 返回当前空闲状态", async () => {
  const capture = jsonCapture();
  const handled = await handleLocalCoverEnrichRequest(
    { method: "GET", url: "/api/local-enrich-covers" },
    capture.response,
  );

  assert.equal(handled, true);
  assert.equal(capture.response.statusCode, 200);
  assert.equal(capture.json().running, false);
});

test("POST /api/local-enrich-covers wait 批处理可以启动并回报结果", async () => {
  const capture = jsonCapture();
  const handled = await handleLocalCoverEnrichRequest(
    jsonRequest("POST", "/api/local-enrich-covers", {
      wait: true,
      cacheLocal: false,
      releases: [
        {
          id: "rel-1",
          title: "Example",
          artists: ["Example Artist"],
          coverUrl: "/private-covers/rel-1.jpg",
        },
      ],
    }),
    capture.response,
  );

  assert.equal(handled, true);
  assert.equal(capture.response.statusCode, 200);
  const result = capture.json();
  assert.equal(result.started, true);
  assert.equal(result.waited, true);
  assert.equal(result.targets, 0);
  assert.ok(Array.isArray(result.coverUpdates));
});

test("Apple 与 Spotify 同时返回时优先平台共识，而不是 NeoDB OG", async () => {
  const { chooseExactCover } = await import("../scripts/enrich-cover-art.mjs");
  const chosen = chooseExactCover({
    apple: {
      url: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg",
      source: "APPLE_LOOKUP",
      matchedFrom: "https://music.apple.com/album/1",
    },
    spotify: {
      url: "https://image-cdn-fa.spotifycdn.com/image/abc",
      source: "SPOTIFY_OEMBED",
      matchedFrom: "https://open.spotify.com/album/abc",
    },
    neodb: {
      url: "https://neodb.social/m/album/stale.jpg",
      source: "NEODB_OG",
      matchedFrom: "https://neodb.social/album/stale",
    },
  });
  assert.equal(chosen.source, "EXACT_PLATFORM_CONSENSUS");
  assert.equal(
    chosen.url,
    "https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg",
  );
});

test("已有远程 NeoDB 封面会按精确 Apple/Spotify 链接重解析", async () => {
  const { runCoverEnrichment } = await import("../scripts/enrich-cover-art.mjs");
  const { mkdtemp, rm, readFile, stat } = fs;
  const os = await import("node:os");
  const path = await import("node:path");
  const coverDirectory = await mkdtemp(path.join(os.tmpdir(), "recordshelf-covers-"));
  const originalFetch = globalThis.fetch;
  const requested = [];
  const jpeg = Buffer.from("fake-jpeg");
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.includes("itunes.apple.com/lookup")) {
      return jsonFetchResponse({
        results: [
          {
            wrapperType: "collection",
            artworkUrl100:
              "https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg",
          },
        ],
      });
    }
    if (href.includes("open.spotify.com/oembed")) {
      return jsonFetchResponse({
        thumbnail_url: "https://image-cdn-fa.spotifycdn.com/image/abc",
      });
    }
    if (href.includes("neodb.social")) {
      throw new Error("stale NeoDB URL must not be reused when platforms answer");
    }
    if (href.includes("mzstatic.com")) {
      return imageFetchResponse(jpeg);
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  try {
    const result = await runCoverEnrichment({
      libraryReleases: [
        {
          id: "rel-stale",
          title: "Example",
          artists: ["Example Artist"],
          coverUrl: "https://neodb.social/m/album/stale.jpg",
          coverSource: "NEODB_OG",
          externalLinks: [
            {
              provider: "APPLE_MUSIC",
              url: "https://music.apple.com/album/123",
              status: "CONFIRMED",
            },
            {
              provider: "SPOTIFY",
              url: "https://open.spotify.com/album/abc",
              status: "CONFIRMED",
            },
          ],
        },
      ],
      coverDirectory,
      cacheLocal: true,
    });
    assert.equal(result.targets, 1);
    assert.equal(result.unresolved, 0);
    assert.equal(result.coverUpdates[0].coverSource, "EXACT_PLATFORM_CONSENSUS");
    assert.match(result.coverUpdates[0].coverRemoteUrl, /mzstatic\.com/);
    assert.equal(
      result.coverUpdates[0].coverUrl,
      "/private-covers/rel-stale.jpg",
    );
    const stored = await readFile(path.join(coverDirectory, "rel-stale.jpg"));
    assert.equal(stored.equals(jpeg), true);
    assert.equal(
      requested.some((href) => href.includes("neodb.social")),
      false,
    );
    await stat(path.join(coverDirectory, "rel-stale.jpg"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(coverDirectory, { recursive: true, force: true });
  }
});

test("加载失败的空封面不能靠旧 coverRemoteUrl 计为成功", async () => {
  const { runCoverEnrichment } = await import("../scripts/enrich-cover-art.mjs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("providers unavailable");
  };
  try {
    const result = await runCoverEnrichment({
      libraryReleases: [
        {
          id: "rel-failed",
          title: "Example",
          artists: ["Example Artist"],
          coverUrl: "",
          coverRemoteUrl: "https://neodb.social/m/album/stale.jpg",
          coverSource: "NEODB_OG",
        },
      ],
      cacheLocal: false,
    });
    assert.equal(result.targets, 1);
    assert.equal(result.unresolved, 1);
    assert.equal(result.coverUpdates.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("本地封面展示 URL 会带上 coverMatchedAt 以刷新缓存", async () => {
  const { coverDisplaySrc } = await import("../src/lib/coverStatus.js");
  assert.equal(
    coverDisplaySrc({
      coverUrl: "/private-covers/rel-stale.jpg",
      coverMatchedAt: "2026-08-16T01:10:00.000Z",
    }),
    "/private-covers/rel-stale.jpg?v=2026-08-16T01%3A10%3A00.000Z",
  );
  assert.equal(
    coverDisplaySrc({ coverUrl: "https://neodb.social/m/album/stale.jpg" }),
    "https://neodb.social/m/album/stale.jpg",
  );
});

test("force:true 会重解析已有本地封面，而不是因为文件存在而跳过", async () => {
  const { runCoverEnrichment } = await import("../scripts/enrich-cover-art.mjs");
  const { mkdtemp, rm, readFile, writeFile } = fs;
  const os = await import("node:os");
  const path = await import("node:path");
  const coverDirectory = await mkdtemp(path.join(os.tmpdir(), "recordshelf-covers-"));
  const originalFetch = globalThis.fetch;
  const requested = [];
  const jpeg = Buffer.from("fresh-jpeg");
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.includes("itunes.apple.com/lookup")) {
      return jsonFetchResponse({
        results: [
          {
            wrapperType: "collection",
            artworkUrl100:
              "https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg",
          },
        ],
      });
    }
    if (href.includes("mzstatic.com")) {
      return imageFetchResponse(jpeg);
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const release = {
    id: "rel-local",
    title: "Example",
    artists: ["Example Artist"],
    coverUrl: "/private-covers/rel-local.jpg",
    coverSource: "NEODB_OG",
    externalLinks: [
      {
        provider: "APPLE_MUSIC",
        url: "https://music.apple.com/album/123",
        status: "CONFIRMED",
      },
    ],
  };

  try {
    await writeFile(path.join(coverDirectory, "rel-local.jpg"), "stale-bytes");
    const skipped = await runCoverEnrichment({
      libraryReleases: [{ ...release }],
      coverDirectory,
      cacheLocal: true,
    });
    assert.equal(skipped.targets, 0);

    requested.length = 0;
    const forced = await runCoverEnrichment({
      libraryReleases: [{ ...release }],
      coverDirectory,
      cacheLocal: true,
      force: true,
    });
    assert.equal(forced.targets, 1);
    assert.equal(forced.unresolved, 0);
    assert.equal(forced.coverUpdates[0].coverUrl, "/private-covers/rel-local.jpg");
    assert.equal(forced.coverUpdates[0].coverSource, "APPLE_LOOKUP");
    const stored = await readFile(path.join(coverDirectory, "rel-local.jpg"));
    assert.equal(stored.equals(jpeg), true);
    assert.equal(
      requested.some((href) => href.includes("itunes.apple.com/lookup")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(coverDirectory, { recursive: true, force: true });
  }
});

function jsonFetchResponse(payload) {
  return {
    ok: true,
    status: 200,
    url: "https://example.test/json",
    json: async () => payload,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  };
}

function imageFetchResponse(body) {
  return {
    ok: true,
    status: 200,
    url: "https://example.test/cover.jpg",
    json: async () => ({}),
    headers: new Headers({ "content-type": "image/jpeg" }),
    arrayBuffer: async () => body,
    body: { cancel: async () => {} },
  };
}
