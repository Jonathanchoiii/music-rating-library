import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("canonicalizes only NeoDB URLs through the read-only endpoint", async () => {
  const requested = [];
  const response = await worker.fetch(
    new Request("https://example.test/api/neodb/canonicalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        urls: [
          "https://neodb.social/album/legacy-id?from=share",
          "https://example.com/private",
        ],
      }),
    }),
    {
      ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
      NEODB_FETCH: async (url, options) => {
        requested.push({ url, method: options.method });
        return new Response(null, {
          status: 200,
          headers: {},
        });
      },
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(requested, [
    {
      url: "https://neodb.social/album/legacy-id",
      method: "HEAD",
    },
  ]);
  assert.deepEqual(payload.canonicalUrls, {
    "https://neodb.social/album/legacy-id":
      "https://neodb.social/album/legacy-id",
  });
});

test("verifies release types only from exact whitelisted record links", async () => {
  const requested = [];
  const musicBrainzId = "00000000-0000-0000-0000-000000000001";
  const response = await worker.fetch(
    new Request("https://example.test/api/metadata/release-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        releases: [
          {
            id: "conflicting-release",
            title: "Exact record",
            artists: ["Artist"],
            externalLinks: [
              {
                provider: "NEODB",
                url: "https://neodb.social/album/exact-record",
                status: "CONFIRMED",
              },
              {
                provider: "MUSICBRAINZ",
                url: `https://musicbrainz.org/release-group/${musicBrainzId}`,
                status: "CONFIRMED",
              },
              {
                provider: "OTHER",
                url: "https://example.com/private",
                status: "CONFIRMED",
              },
            ],
          },
          {
            id: "no-exact-link",
            title: "Do not fuzzy search",
            artists: ["Artist"],
            externalLinks: [],
          },
        ],
      }),
    }),
    {
      ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
      MUSICBRAINZ_DELAY_MS: 0,
      METADATA_FETCH: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("musicbrainz.org/ws/2/release-group")) {
          return Response.json({ "primary-type": "EP" });
        }
        if (url === "https://neodb.social/album/exact-record") {
          return new Response(
            '<div>album type: <span>Album</span></div>',
            { status: 200 },
          );
        }
        return new Response("missing", { status: 404 });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.results[0].status, "CONFLICT");
  assert.equal(payload.results[0].releaseType, "OTHER");
  assert.equal(payload.results[1].status, "UNRESOLVED");
  assert.deepEqual(
    requested.some((url) => url.includes("example.com/private")),
    false,
  );
  assert.deepEqual(
    requested.some((url) => url.includes("Do%20not%20fuzzy")),
    false,
  );
});

test("fills an artist MBID only when name and exact release-group evidence agree", async () => {
  const requested = [];
  const artistMbid = "00000000-0000-0000-0000-000000000009";
  const response = await worker.fetch(
    new Request("https://example.test/api/metadata/artist-identities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identities: [
          {
            id: "local-artist",
            canonicalName: "Example Artist",
            aliases: ["範例藝人", "范例艺人"],
            releaseTitles: ["Shared Album"],
            fingerprint: "fingerprint",
          },
        ],
      }),
    }),
    {
      ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
      MUSICBRAINZ_DELAY_MS: 0,
      MUSICBRAINZ_FETCH: async (input) => {
        const url = new URL(String(input));
        requested.push(url.pathname + url.search);
        if (
          url.pathname === "/ws/2/release-group" &&
          url.searchParams.has("query")
        ) {
          return Response.json({
            "release-groups": [
              {
                title: "Shared Album",
                "artist-credit": [
                  {
                    name: "Example Artist",
                    artist: {
                      id: artistMbid,
                      name: "Example Artist",
                    },
                  },
                ],
              },
            ],
          });
        }
        if (url.pathname === `/ws/2/artist/${artistMbid}`) {
          return Response.json({
            id: artistMbid,
            name: "Example Artist",
            aliases: [{ name: "范例艺人", locale: "zh_CN" }],
          });
        }
        return new Response("missing", { status: 404 });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.results[0].status, "MATCHED");
  assert.equal(payload.results[0].musicBrainzMbid, artistMbid);
  assert.deepEqual(
    payload.results[0].evidence.matchedReleaseTitles,
    ["Shared Album"],
  );
  assert.equal(requested.length, 2);
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
});
