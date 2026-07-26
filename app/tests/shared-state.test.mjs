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
  const backups = await fs.readdir(`${statePath}.backups`);
  assert.deepEqual(backups, ["revision-00000001.json"]);
});

test("three-way merge keeps the latest edit and unions deletion decisions", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-user-state-v2";
  const base = {
    removedReleaseIds: [],
    releaseMetadataOverrides: {
      "release-a": { title: "Base title" },
      "release-b": { rating: 7 },
    },
  };
  const latest = {
    removedReleaseIds: ["release-deleted-on-mac"],
    releaseMetadataOverrides: {
      "release-a": { title: "Latest title" },
      "release-b": { rating: 7 },
    },
  };
  const staleClientEdit = {
    removedReleaseIds: ["release-deleted-on-web"],
    releaseMetadataOverrides: {
      "release-a": { title: "Older competing title" },
      "release-b": { rating: 9 },
    },
  };

  await applySharedStateChanges(
    { [key]: JSON.stringify(latest) },
    statePath,
  );
  const state = await applySharedStateChanges(
    { [key]: JSON.stringify(staleClientEdit) },
    statePath,
    { baseStorage: { [key]: JSON.stringify(base) } },
  );
  const merged = JSON.parse(state.storage[key]);

  assert.deepEqual(merged.removedReleaseIds, [
    "release-deleted-on-mac",
    "release-deleted-on-web",
  ]);
  assert.equal(
    merged.releaseMetadataOverrides["release-a"].title,
    "Latest title",
  );
  assert.equal(
    merged.releaseMetadataOverrides["release-b"].rating,
    9,
  );
});

test("legacy migration adds unique identities without replacing newer edits", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-artist-identities-v1";

  await applySharedStateChanges(
    {
      [key]: JSON.stringify({
        identities: [
          { id: "artist-1", canonicalName: "Latest name", aliases: [] },
        ],
      }),
    },
    statePath,
  );
  const state = await applySharedStateChanges(
    {
      [key]: JSON.stringify({
        identities: [
          { id: "artist-1", canonicalName: "Old name", aliases: [] },
          { id: "artist-2", canonicalName: "Recovered artist", aliases: [] },
        ],
      }),
    },
    statePath,
    { mergeMode: "preserve-latest" },
  );
  const merged = JSON.parse(state.storage[key]);

  assert.deepEqual(
    merged.identities.map((identity) => [
      identity.id,
      identity.canonicalName,
    ]),
    [
      ["artist-1", "Latest name"],
      ["artist-2", "Recovered artist"],
    ],
  );
});

test("duplicate dismissals from Web and Mac are both retained", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-dismissed-artist-duplicates-v1";

  await applySharedStateChanges(
    { [key]: JSON.stringify(["candidate-from-mac"]) },
    statePath,
  );
  const state = await applySharedStateChanges(
    { [key]: JSON.stringify(["candidate-from-web"]) },
    statePath,
    { baseStorage: { [key]: "[]" } },
  );

  assert.deepEqual(JSON.parse(state.storage[key]), [
    "candidate-from-mac",
    "candidate-from-web",
  ]);
});

test("different alias edits merge while an explicit removal stays removed", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-artist-identities-v1";
  const alias = (name) => ({ name, source: "USER" });
  const base = {
    identities: [
      {
        id: "artist-1",
        canonicalName: "Artist",
        aliases: [alias("Remove me"), alias("Keep me")],
      },
    ],
  };
  const latest = {
    identities: [
      {
        id: "artist-1",
        canonicalName: "Artist",
        aliases: [alias("Keep me"), alias("Mac alias")],
      },
    ],
  };
  const incoming = {
    identities: [
      {
        id: "artist-1",
        canonicalName: "Artist",
        aliases: [
          alias("Remove me"),
          alias("Keep me"),
          alias("Web alias"),
        ],
      },
    ],
  };

  await applySharedStateChanges(
    { [key]: JSON.stringify(latest) },
    statePath,
  );
  const state = await applySharedStateChanges(
    { [key]: JSON.stringify(incoming) },
    statePath,
    { baseStorage: { [key]: JSON.stringify(base) } },
  );
  const aliases = JSON.parse(state.storage[key]).identities[0].aliases;

  assert.deepEqual(
    aliases.map((item) => item.name),
    ["Keep me", "Mac alias", "Web alias"],
  );
});
