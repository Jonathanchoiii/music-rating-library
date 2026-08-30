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
