import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySharedStateChanges,
  readSharedState,
} from "../shared-state/index.mjs";

async function temporaryStatePath() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-shared-state-"),
  );
  return {
    directory,
    statePath: path.join(directory, "state.json"),
  };
}

test("shared state persists only approved local keys", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const state = await applySharedStateChanges(
    {
      "recordshelf-user-state-v2": '{"removedReleaseIds":["release-1"]}',
      "recordshelf-neodb-access-token-v1": "must-not-persist",
      "unrelated-key": "must-not-persist",
    },
    statePath,
  );

  assert.equal(state.revision, 1);
  assert.deepEqual(state.storage, {
    "recordshelf-user-state-v2":
      '{"removedReleaseIds":["release-1"]}',
  });
  const onDisk = await readSharedState(statePath);
  assert.deepEqual(onDisk, state);
});

test("shared state merges changes and honors removals", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await applySharedStateChanges(
    {
      "recordshelf-user-state-v2": '{"one":1}',
      "recordshelf-library-filters-v1": '{"ratingMin":8}',
    },
    statePath,
  );
  const state = await applySharedStateChanges(
    {
      "recordshelf-user-state-v2": '{"one":2}',
      "recordshelf-library-filters-v1": null,
    },
    statePath,
  );

  assert.equal(state.revision, 2);
  assert.deepEqual(state.storage, {
    "recordshelf-user-state-v2": '{"one":2}',
  });
});
