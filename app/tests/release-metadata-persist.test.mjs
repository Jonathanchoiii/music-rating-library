import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { persistReleaseMetadataFields } from "../shared-state/release-metadata.mjs";
import { handleReleaseMetadataPersistRequest } from "../shared-state/release-metadata.mjs";
import { readSharedState } from "../shared-state/index.mjs";
import {
  applyMetadataFieldsToUserState,
  readReleaseMetadataRecord,
} from "../src/lib/releaseMetadataOverlay.js";
import { getReleaseMetadataFields } from "../src/lib/neodbSync.js";
import { appendManualTrack } from "../src/lib/tracklist.js";
import { buildReleaseDetailsPatch } from "../src/lib/releaseDetails.js";
import { applyNeoDbSyncPlan } from "../src/lib/neodbSync.js";
import { applyCanonicalTitleEvidence, reconcileCanonicalTitleOverride } from "../src/lib/music.js";

const editableRelease = {
  id: "release-edit-test", title: "Original", translatedTitle: "旧译名",
  titleAliases: ["旧译名"], artists: ["Incorrect label"],
  releaseDate: "2019-11-13", releaseDatePrecision: "DAY",
  listeningEntries: [{ id: "heard", rating10: 8, comment: "Keep this history" }],
};
const manualDraft = { title: "Correct title", translatedTitle: "", artists: "Correct artist\nGuest", releaseDate: "" };

test("manual details validate real dates and only confirm fields that changed", () => {
  for (const date of ["2023-02-29", "2024-02-30", "2019-13", "0000", "2024-2-03"]) {
    assert.throws(() => buildReleaseDetailsPatch(editableRelease, { ...manualDraft, releaseDate: date }), /有效发行日期/);
  }
  for (const [date, precision] of [["2024", "YEAR"], ["2024-02", "MONTH"], ["2024-02-29", "DAY"], ["", "UNKNOWN"]]) {
    const patch = buildReleaseDetailsPatch(editableRelease, { ...manualDraft, releaseDate: date });
    assert.equal(patch.releaseDatePrecision, precision);
    assert.equal(patch.releaseDateUserConfirmed, true);
  }
  assert.throws(() => buildReleaseDetailsPatch(editableRelease, { ...manualDraft, title: " " }), /专辑名/);
  assert.throws(() => buildReleaseDetailsPatch(editableRelease, { ...manualDraft, artists: "\n" }), /艺人/);
  const patch = buildReleaseDetailsPatch(editableRelease, { title: editableRelease.title, translatedTitle: editableRelease.translatedTitle, artists: "Correct artist", releaseDate: editableRelease.releaseDate });
  assert.deepEqual(patch, { artists: ["Correct artist"], artistsUserConfirmed: true });
});

test("saved corrections and explicit clears survive disk roundtrip, title enrichment and stale sync plans", async () => {
  await withSharedState(async (statePath) => {
    const patch = buildReleaseDetailsPatch(editableRelease, manualDraft);
    for (const key of Object.keys(patch)) assert.ok(getReleaseMetadataFields().includes(key), key);
    await persistReleaseMetadataFields(editableRelease.id, patch);
    const state = JSON.parse((await readSharedState(statePath)).storage[USER_STATE_KEY]);
    const override = reconcileCanonicalTitleOverride({ ...editableRelease, titleSource: "APPLE_MUSIC_EXACT" }, state.releaseMetadataOverrides[editableRelease.id]);
    const hydrated = { ...editableRelease, ...override };
    assert.equal(hydrated.title, "Correct title");
    assert.deepEqual(hydrated.artists, ["Correct artist", "Guest"]);
    assert.equal(hydrated.translatedTitle, null);
    assert.equal(hydrated.releaseDate, null);
    assert.deepEqual(hydrated.titleAliases, []);
    assert.deepEqual(applyCanonicalTitleEvidence(hydrated, { title: "Stale platform title" }), hydrated);
    const [synced] = applyNeoDbSyncPlan([hydrated], {
      updates: [{ releaseId: hydrated.id, patch: { title: "Stale title", artists: ["Label"], translatedTitle: "Stale translation", titleAliases: ["Stale"], releaseDate: "2020", releaseDatePrecision: "YEAR", markStatus: "complete" }, entries: [] }], additions: [], removals: [],
    });
    assert.equal(synced.title, hydrated.title);
    assert.deepEqual(synced.artists, hydrated.artists);
    assert.equal(synced.releaseDate, null);
    assert.equal(synced.translatedTitle, null);
    assert.deepEqual(synced.listeningEntries, editableRelease.listeningEntries);
    assert.equal(synced.markStatus, "complete");
  });
});

test("manual user releases persist cleared optional details without disturbing other records", () => {
  const state = { userReleases: [editableRelease, { id: "other", title: "Other" }] };
  const next = applyMetadataFieldsToUserState(state, editableRelease.id, buildReleaseDetailsPatch(editableRelease, manualDraft));
  assert.equal(next.userReleases[0].releaseDate, null);
  assert.equal(next.userReleases[0].translatedTitle, null);
  assert.deepEqual(next.userReleases[0].listeningEntries, editableRelease.listeningEntries);
  assert.deepEqual(next.userReleases[1], state.userReleases[1]);
});

const USER_STATE_KEY = "recordshelf-user-state-v2";

async function withSharedState(run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-release-metadata-"),
  );
  const previous = process.env.RECORDSHELF_SHARED_STATE_PATH;
  process.env.RECORDSHELF_SHARED_STATE_PATH = path.join(
    directory,
    "shared-local-state.json",
  );
  try {
    return await run(process.env.RECORDSHELF_SHARED_STATE_PATH);
  } finally {
    if (previous === undefined) delete process.env.RECORDSHELF_SHARED_STATE_PATH;
    else process.env.RECORDSHELF_SHARED_STATE_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("album introduction, tracklist, and motion artwork are user-delta fields", () => {
  const fields = getReleaseMetadataFields();
  assert.equal(fields.includes("albumIntroduction"), true);
  assert.equal(fields.includes("tracklist"), true);
  assert.equal(fields.includes("motionArtwork"), true);
});

test("overlays preserve all three fields across shared-state writes and hydrate", async () => {
  await withSharedState(async (statePath) => {
    const tracklist = appendManualTrack(null, {
      title: "Smooth Operator",
      durationMs: 257_000,
      id: "user:smooth",
    }).tracklist;
    await persistReleaseMetadataFields("release-seed", {
      albumIntroduction: "夜晚把这张唱片再听一遍。",
      tracklist,
      motionArtwork: {
        status: "AVAILABLE",
        squareUrl: "https://mvod.itunes.apple.com/example/master.m3u8",
        checkedAt: "2026-08-15T00:00:00.000Z",
        storage: "REMOTE_HLS",
      },
    });
    await persistReleaseMetadataFields("release-seed", {
      motionArtwork: {
        localUrl: "/private-motion-artwork/release-seed.webp",
        storage: "LOCAL_WEBP",
        checkedAt: "2026-08-15T00:01:00.000Z",
      },
    });
    await persistReleaseMetadataFields("release-user", {
      albumIntroduction: "手写介绍。",
      tracklist,
    });

    const shared = await readSharedState(statePath);
    const userState = JSON.parse(shared.storage[USER_STATE_KEY]);
    const seedOverlay = userState.releaseMetadataOverrides["release-seed"];
    assert.equal(seedOverlay.albumIntroduction, "夜晚把这张唱片再听一遍。");
    assert.equal(seedOverlay.tracklist.tracks[0].title, "Smooth Operator");
    assert.equal(seedOverlay.motionArtwork.storage, "LOCAL_WEBP");
    assert.equal(
      seedOverlay.motionArtwork.squareUrl,
      "https://mvod.itunes.apple.com/example/master.m3u8",
    );
    assert.equal(
      seedOverlay.motionArtwork.localUrl,
      "/private-motion-artwork/release-seed.webp",
    );
    assert.equal(
      userState.releaseMetadataOverrides["release-user"].albumIntroduction,
      "手写介绍。",
    );

    await persistReleaseMetadataFields("release-seed", {
      albumIntroduction: null,
    });
    const cleared = JSON.parse(
      (await readSharedState(statePath)).storage[USER_STATE_KEY],
    );
    assert.equal(
      Object.hasOwn(
        cleared.releaseMetadataOverrides["release-seed"],
        "albumIntroduction",
      ),
      false,
    );
    assert.equal(
      cleared.releaseMetadataOverrides["release-seed"].tracklist.provider,
      "USER",
    );
  });
});

test("userReleases keep motion artwork and tracklist on the stored object", async () => {
  await withSharedState(async (statePath) => {
    const { applySharedStateChanges } = await import(
      "../shared-state/index.mjs"
    );
    await applySharedStateChanges(
      {
        [USER_STATE_KEY]: JSON.stringify({
          userReleases: [{ id: "release-user", title: "User release" }],
        }),
      },
      statePath,
    );
    await persistReleaseMetadataFields("release-user", {
      albumIntroduction: "新加入的唱片。",
      motionArtwork: {
        status: "UNAVAILABLE",
        checkedAt: "2026-08-15T02:00:00.000Z",
      },
    });
    const userState = JSON.parse(
      (await readSharedState(statePath)).storage[USER_STATE_KEY],
    );
    assert.equal(userState.userReleases[0].albumIntroduction, "新加入的唱片。");
    assert.equal(userState.userReleases[0].motionArtwork.status, "UNAVAILABLE");
    assert.equal(userState.releaseMetadataOverrides?.["release-user"], undefined);
  });
});

test("local overlay helper writes the same shape the hydrate path reads", () => {
  const tracklist = appendManualTrack(null, {
    title: "Cherry Pie",
    durationMs: 262_000,
    id: "user:cherry",
  }).tracklist;
  const userState = applyMetadataFieldsToUserState(
    {},
    "release-a",
    {
      albumIntroduction: "正文",
      tracklist,
      motionArtwork: { status: "AVAILABLE", localUrl: "/private-motion-artwork/a.webp" },
    },
  );
  const record = readReleaseMetadataRecord(userState, "release-a");
  const hydrated = { id: "release-a", title: "Base", ...record };
  assert.equal(hydrated.albumIntroduction, "正文");
  assert.equal(hydrated.tracklist.tracks[0].title, "Cherry Pie");
  assert.equal(hydrated.motionArtwork.localUrl, "/private-motion-artwork/a.webp");
});

test("the local release-metadata route writes the shared file", async () => {
  await withSharedState(async (statePath) => {
    const request = new PassThrough();
    request.method = "POST";
    request.url = "/api/local-release-metadata";
    request.end(
      JSON.stringify({
        releaseId: "release-intro",
        albumIntroduction: "写入共享库的介绍。",
      }),
    );
    let body = "";
    const response = {
      statusCode: 0,
      setHeader() {},
      end(value = "") {
        body = String(value);
      },
    };
    assert.equal(
      await handleReleaseMetadataPersistRequest(request, response),
      true,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(
      JSON.parse(body).release.albumIntroduction,
      "写入共享库的介绍。",
    );
    const userState = JSON.parse(
      (await readSharedState(statePath)).storage[USER_STATE_KEY],
    );
    assert.equal(
      userState.releaseMetadataOverrides["release-intro"].albumIntroduction,
      "写入共享库的介绍。",
    );
  });
});
