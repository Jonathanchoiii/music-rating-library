import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backfillListeningGuides,
  createFallbackGuide,
  createPilotGuide,
  getCodexListeningGuideJob,
  isPilotIdentity,
  normalizedResearchGuide,
  normalizedCodexResearchGuide,
  publicListeningGuideIdentity,
  readProviderConfig,
  readListeningGuideStore,
  requestGeminiResearch,
  saveCodexResearchGuide,
  savePilotGuide,
  saveProviderConfig,
  startCodexListeningGuideJob,
} from "../listening-guides/index.mjs";

const PILOT = {
  originalTitle: "SABLE, fABLE",
  artists: ["Bon Iver"],
  releaseDate: "2025-04-11",
  releaseType: "LP",
  editionTypes: [],
  externalIdentities: [
    {
      provider: "SPOTIFY",
      idOrUrl: "https://open.spotify.com/album/example",
    },
  ],
};

async function temporaryStore() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-listening-guides-"),
  );
  return { directory, storePath: path.join(directory, "guides.json") };
}

test("pilot identity requires the exact original title and artist", () => {
  assert.equal(isPilotIdentity(PILOT), true);
  assert.equal(
    isPilotIdentity({ ...PILOT, originalTitle: "SABLE" }),
    false,
  );
  assert.equal(
    isPilotIdentity({ ...PILOT, artists: ["Bon Iver Tribute"] }),
    false,
  );
});

test("pilot guide is source-grounded and never stores private listening data", () => {
  const guide = createPilotGuide("release-pilot", {
    ...PILOT,
    rating: 10,
    comment: "private comment",
    listeningEntries: [{ listenedAt: "2026-08-09" }],
    artistMappings: { private: true },
  });
  const serialized = JSON.stringify(guide);

  assert.equal(guide.status, "READY");
  assert.equal(guide.sections.length, 7);
  assert.ok(guide.sources.length >= 8);
  assert.equal(guide.confidence, "HIGH");
  assert.equal(serialized.includes("private comment"), false);
  assert.equal(serialized.includes("listeningEntries"), false);
  assert.equal(serialized.includes("artistMappings"), false);
  assert.equal(serialized.includes("rating"), false);
});

test("first generation persists, repeat generation uses cache, refresh keeps history", async (context) => {
  const { directory, storePath } = await temporaryStore();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const first = await savePilotGuide("release-pilot", PILOT, {
    storePath,
    now: new Date("2026-08-09T01:00:00Z"),
  });
  const cached = await savePilotGuide("release-pilot", PILOT, {
    storePath,
    now: new Date("2026-08-09T02:00:00Z"),
  });
  const refreshed = await savePilotGuide("release-pilot", PILOT, {
    refresh: true,
    storePath,
    now: new Date("2026-08-09T03:00:00Z"),
  });
  const store = await readListeningGuideStore(storePath);
  const details = await fs.stat(storePath);

  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(cached.guide.id, first.guide.id);
  assert.equal(refreshed.cached, false);
  assert.notEqual(refreshed.guide.id, first.guide.id);
  assert.equal(refreshed.guide.previousVersionId, first.guide.id);
  assert.equal(store.history["release-pilot"].length, 1);
  assert.equal(store.history["release-pilot"][0].id, first.guide.id);
  assert.equal(details.mode & 0o777, 0o600);
});

test("unrelated albums cannot accidentally receive the pilot guide", async (context) => {
  const { directory, storePath } = await temporaryStore();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      savePilotGuide(
        "another-release",
        { ...PILOT, originalTitle: "For Emma, Forever Ago" },
        { storePath },
      ),
    /PILOT_RELEASE_ONLY/,
  );
  const store = await readListeningGuideStore(storePath);
  assert.deepEqual(store.guides, {});
});

test("fallback guide creates an empty evidence-safe record without private data", () => {
  const guide = createFallbackGuide("release-empty", {
    originalTitle: "Unknown Album",
    artists: ["Unknown Artist"],
    comment: "private comment",
    rating: 9,
    listeningEntries: [{ listenedAt: "2026-08-09" }],
    externalIdentities: [
      { provider: "NEODB", idOrUrl: "https://neodb.social/album/example" },
    ],
  });
  const serialized = JSON.stringify(guide);

  assert.equal(guide.status, "INSUFFICIENT_SOURCES");
  assert.equal(guide.summary, null);
  assert.deepEqual(guide.sections, []);
  assert.equal(guide.sources.length, 1);
  assert.equal(serialized.includes("private comment"), false);
  assert.equal(serialized.includes("listeningEntries"), false);
  assert.equal(serialized.includes("rating"), false);
});

test("public release identity keeps only confirmed public platform links", () => {
  const identity = publicListeningGuideIdentity({
    title: "Album",
    artists: ["Artist"],
    externalLinks: [
      { provider: "NEODB", url: "https://neodb.social/album/exact", status: "CONFIRMED" },
      { provider: "SPOTIFY", url: "https://open.spotify.com/album/exact", status: "AUTO_CONFIRMED" },
      { provider: "APPLE_MUSIC", url: "https://music.apple.com/album/guess", status: "CANDIDATE" },
    ],
    listeningEntries: [{ comment: "private" }],
  });

  assert.deepEqual(identity.externalIdentities, [
    { provider: "NEODB", idOrUrl: "https://neodb.social/album/exact" },
    { provider: "SPOTIFY", idOrUrl: "https://open.spotify.com/album/exact" },
  ]);
  assert.equal(JSON.stringify(identity).includes("private"), false);
});

test("backfill is idempotent and metadata changes do not rewrite ready prose", async (context) => {
  const { directory, storePath } = await temporaryStore();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const other = {
    id: "release-other",
    originalTitle: "Other Album",
    artists: ["Other Artist"],
    releaseDate: "2026-01-01",
  };

  const first = await backfillListeningGuides(
    [{ id: "release-pilot", ...PILOT }, other],
    { storePath, now: new Date("2026-08-09T01:00:00Z") },
  );
  const second = await backfillListeningGuides(
    [{ id: "release-pilot", ...PILOT }, other],
    { storePath, now: new Date("2026-08-09T02:00:00Z") },
  );
  const changed = await backfillListeningGuides(
    [{ id: "release-pilot", ...PILOT, releaseDate: "2025-04-12" }, other],
    { storePath, now: new Date("2026-08-09T03:00:00Z") },
  );
  const store = await readListeningGuideStore(storePath);

  assert.equal(first.created, 2);
  assert.equal(first.ready, 1);
  assert.equal(first.insufficient, 1);
  assert.equal(second.created, 0);
  assert.equal(second.existing, 2);
  assert.equal(changed.identityUpdated, 1);
  assert.equal(store.guides["release-pilot"].status, "READY");
  assert.equal(store.guides["release-pilot"].needsRefresh, true);
  assert.equal(store.guides["release-pilot"].sections.length, 7);
  assert.equal(store.history["release-pilot"], undefined);
});

test("OpenAI research accepts only searched source URLs and requires seven sourced sections", () => {
  const now = new Date("2026-08-09T04:00:00Z");
  const source = {
    id: "S1",
    title: "Official album page",
    publisher: "Artist",
    url: "https://artist.example/album",
    sourceType: "OFFICIAL",
    supports: ["orientation"],
  };
  const sections = [
    "orientation",
    "origin",
    "sound",
    "emotion_lyrics",
    "visual",
    "reception",
    "recommendation",
  ].map((key) => ({ key, title: key, body: `verified ${key}`, sourceIds: ["S1"] }));
  const guide = normalizedResearchGuide(
    "release-researched",
    PILOT,
    {
      status: "READY",
      releaseIdentity: { originalTitle: PILOT.originalTitle, artists: PILOT.artists },
      summary: "verified summary",
      sections,
      highlightTracks: [],
      sources: [
        source,
        { ...source, id: "S2", url: "https://invented.example/not-searched" },
      ],
      confidence: "HIGH",
    },
    {
      id: "resp_test",
      output: [
        {
          type: "web_search_call",
          action: { sources: [{ url: source.url, title: source.title }] },
        },
      ],
    },
    now,
  );

  assert.equal(guide.status, "INSUFFICIENT_SOURCES");
  assert.equal(guide.sources.length, 1);
  assert.equal(guide.sources[0].url, source.url);
  assert.equal(JSON.stringify(guide).includes("invented.example"), false);
});

test("Codex research persists a source-grounded guide and does not overwrite READY", async (context) => {
  const { directory, storePath } = await temporaryStore();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = [
    {
      id: "S1",
      title: "Official album page",
      publisher: "Artist",
      author: null,
      publishedAt: null,
      url: "https://artist.example/album",
      sourceType: "OFFICIAL",
      supports: ["orientation"],
    },
    {
      id: "S2",
      title: "Album review",
      publisher: "Review",
      author: null,
      publishedAt: null,
      url: "https://review.example/album",
      sourceType: "PROFESSIONAL_REVIEW",
      supports: ["sound"],
    },
  ];
  const payload = {
    status: "READY",
    reason: null,
    releaseIdentity: {
      originalTitle: PILOT.originalTitle,
      artists: PILOT.artists,
      releaseYear: "2025",
      edition: null,
    },
    summary: "verified summary",
    sections: [
      "orientation",
      "origin",
      "sound",
      "emotion_lyrics",
      "visual",
      "reception",
      "recommendation",
    ].map((key) => ({ key, title: key, body: `verified ${key}`, sourceIds: ["S1", "S2"] })),
    highlightTracks: [],
    credits: {
      releaseDate: "2025-04-11",
      label: null,
      producers: [],
      songwriters: [],
      recordingStudios: [],
    },
    reception: { professional: null, audience: null, awardsAndCharts: null },
    sources,
    confidence: "HIGH",
  };

  const normalized = normalizedCodexResearchGuide("release-pilot", PILOT, payload);
  assert.equal(normalized.status, "READY");
  assert.equal(normalized.provider, "CODEX_CHATGPT_WEB_RESEARCH");

  const first = await saveCodexResearchGuide("release-pilot", PILOT, payload, { storePath });
  const second = await saveCodexResearchGuide(
    "release-pilot",
    PILOT,
    { ...payload, summary: "should not replace" },
    { storePath },
  );
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.guide.summary, "verified summary");

  const refreshed = await saveCodexResearchGuide(
    "release-pilot",
    PILOT,
    { ...payload, summary: "manually refreshed" },
    { storePath, force: true },
  );
  const refreshedStore = await readListeningGuideStore(storePath);
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.guide.summary, "manually refreshed");
  assert.equal(refreshedStore.history["release-pilot"][0].summary, "verified summary");
});

test("manual Codex job runs asynchronously and writes the shared guide cache", async (context) => {
  const { directory, storePath } = await temporaryStore();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const releaseId = `release-manual-${Date.now()}`;
  const payload = {
    status: "READY",
    reason: null,
    releaseIdentity: {
      originalTitle: PILOT.originalTitle,
      artists: PILOT.artists,
      releaseYear: "2025",
      edition: null,
    },
    summary: "manual Codex summary",
    sections: [
      "orientation",
      "origin",
      "sound",
      "emotion_lyrics",
      "visual",
      "reception",
      "recommendation",
    ].map((key) => ({
      key,
      title: key,
      body: `manual ${key}`,
      sourceIds: ["S1", "S2"],
    })),
    highlightTracks: [],
    credits: {
      releaseDate: "2025-04-11",
      label: null,
      producers: [],
      songwriters: [],
      recordingStudios: [],
    },
    reception: { professional: null, audience: null, awardsAndCharts: null },
    sources: [
      {
        id: "S1",
        title: "Official",
        publisher: "Artist",
        author: null,
        publishedAt: null,
        url: "https://artist.example/manual",
        sourceType: "OFFICIAL",
        supports: ["orientation"],
      },
      {
        id: "S2",
        title: "Review",
        publisher: "Review",
        author: null,
        publishedAt: null,
        url: "https://review.example/manual",
        sourceType: "PROFESSIONAL_REVIEW",
        supports: ["sound"],
      },
    ],
    confidence: "HIGH",
  };

  const started = startCodexListeningGuideJob(releaseId, PILOT, {
    storePath,
    runner: async () => payload,
  });
  assert.equal(started.status, "RUNNING");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getCodexListeningGuideJob(releaseId)?.status !== "RUNNING") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const finished = getCodexListeningGuideJob(releaseId);
  const store = await readListeningGuideStore(storePath);
  assert.equal(finished.status, "COMPLETED");
  assert.equal(store.guides[releaseId].summary, "manual Codex summary");
  assert.equal(store.guides[releaseId].provider, "CODEX_CHATGPT_WEB_RESEARCH");
});

test("provider config stores only provider metadata in a private local file", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recordshelf-provider-"));
  const configPath = path.join(directory, "provider.json");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await saveProviderConfig(
    {
      activeProvider: "GEMINI",
      model: "gemini-3.6-flash",
      apiKey: "this-must-never-be-serialized",
    },
    configPath,
  );
  const config = await readProviderConfig(configPath);
  const serialized = await fs.readFile(configPath, "utf8");
  const details = await fs.stat(configPath);

  assert.equal(config.activeProvider, "GEMINI");
  assert.equal(config.models.GEMINI, "gemini-3.6-flash");
  assert.equal(serialized.includes("this-must-never-be-serialized"), false);
  assert.equal(details.mode & 0o777, 0o600);
});

test("Gemini research uses only the fixed Google host and returns grounded sources", async () => {
  let capturedUrl = "";
  let capturedOptions = null;
  const fakeKey = "test-gemini-key-that-is-never-persisted";
  const result = await requestGeminiResearch({
    key: fakeKey,
    model: "gemini-3.6-flash",
    prompt: "research this release",
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "gemini-response",
          steps: [
            {
              type: "google_search_result",
              result: [{ url: "https://artist.example/release", title: "Artist" }],
            },
            {
              type: "model_output",
              content: [{ type: "text", text: '{"status":"INSUFFICIENT_SOURCES"}' }],
            },
          ],
        }),
      };
    },
  });
  const body = JSON.parse(capturedOptions.body);

  assert.equal(
    capturedUrl,
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  assert.equal(capturedOptions.headers["x-goog-api-key"], fakeKey);
  assert.equal(capturedOptions.body.includes(fakeKey), false);
  assert.equal(body.model, "gemini-3.6-flash");
  assert.deepEqual(body.tools, [{ type: "google_search" }]);
  assert.equal(body.response_format.mime_type, "application/json");
  assert.equal(result.providerMetadata.provider, "GEMINI_GOOGLE_SEARCH");
  assert.deepEqual(result.providerMetadata.searchedSources, [
    { url: "https://artist.example/release", title: "Artist" },
  ]);
});

test("Gemini research preserves quota failures instead of reporting missing sources", async () => {
  await assert.rejects(
    requestGeminiResearch({
      key: "test-gemini-key-that-is-never-persisted",
      model: "gemini-3.6-flash",
      prompt: "research this release",
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: "too_many_requests" } }),
      }),
    }),
    (error) =>
      error.message === "GEMINI_QUOTA_EXCEEDED" && error.statusCode === 429,
  );
});
