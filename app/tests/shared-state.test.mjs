import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySharedStateChanges,
  getNeoDbSnapshotDirectory,
  isAuthoritativeSharedStateRequest,
  persistNeoDbCsvSnapshot,
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

test("the shared database accepts writes only through port 4173", () => {
  assert.equal(
    isAuthoritativeSharedStateRequest({
      headers: { host: "127.0.0.1:4173" },
    }),
    true,
  );
  assert.equal(
    isAuthoritativeSharedStateRequest({
      headers: { host: "localhost:4173" },
    }),
    true,
  );
  assert.equal(
    isAuthoritativeSharedStateRequest({
      headers: { host: "127.0.0.1:5173" },
    }),
    false,
  );
  assert.equal(
    isAuthoritativeSharedStateRequest({
      headers: { host: "127.0.0.1:4187" },
    }),
    false,
  );
});

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

test("NeoDB CSV snapshots are private, retained locally, and content-addressed", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const payload = {
    csv: "title,source_item_id\nAlbum,source-one\n",
    rowCount: 1,
    syncedAt: "2026-07-26T12:34:56Z",
  };

  const first = await persistNeoDbCsvSnapshot(payload, statePath);
  const second = await persistNeoDbCsvSnapshot(payload, statePath);
  const snapshotPath = path.join(
    getNeoDbSnapshotDirectory(statePath),
    first.fileName,
  );
  const details = await fs.stat(snapshotPath);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.fileName, first.fileName);
  assert.equal(await fs.readFile(snapshotPath, "utf8"), payload.csv);
  assert.equal(details.mode & 0o777, 0o600);
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

test("stale artist identities with a shared name and alias are coalesced", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-artist-identities-v1";
  const current = {
    identities: [
      {
        id: "artist-current",
        canonicalName: "持修",
        source: "MUSICBRAINZ_AND_USER",
        musicBrainzMbid: "mbid-1",
        aliases: [
          { name: "持修", source: "USER" },
          { name: "Chih Siou", source: "USER" },
        ],
      },
    ],
  };
  const staleClient = {
    identities: [
      {
        id: "artist-stale",
        canonicalName: "持修",
        source: "USER_CONFIRMED_DUPLICATE",
        aliases: [
          { name: "持修", source: "USER_CONFIRMED_DUPLICATE" },
          {
            name: "Chih Siou",
            source: "USER_CONFIRMED_DUPLICATE",
          },
          {
            name: "持修 chih_siou",
            source: "USER_CONFIRMED_DUPLICATE",
          },
        ],
      },
    ],
  };

  await applySharedStateChanges(
    { [key]: JSON.stringify(current) },
    statePath,
  );
  const state = await applySharedStateChanges(
    { [key]: JSON.stringify(staleClient) },
    statePath,
    {
      baseStorage: {
        [key]: JSON.stringify({ identities: [] }),
      },
    },
  );
  const merged = JSON.parse(state.storage[key]);

  assert.equal(merged.identities.length, 1);
  assert.equal(merged.identities[0].id, "artist-current");
  assert.equal(merged.identities[0].musicBrainzMbid, "mbid-1");
  assert.equal(
    merged.identities[0].source,
    "USER_CONFIRMED_DUPLICATE",
  );
  assert.deepEqual(
    merged.identities[0].aliases.map((alias) => alias.name),
    ["持修", "Chih Siou", "持修 chih_siou"],
  );
});

test("same-name artists stay separate without a second shared alias", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-artist-identities-v1";

  await applySharedStateChanges(
    {
      [key]: JSON.stringify({
        identities: [
          {
            id: "artist-a",
            canonicalName: "重名艺人",
            aliases: [{ name: "重名艺人" }],
          },
        ],
      }),
    },
    statePath,
  );
  const state = await applySharedStateChanges(
    {
      [key]: JSON.stringify({
        identities: [
          {
            id: "artist-b",
            canonicalName: "重名艺人",
            aliases: [{ name: "重名艺人" }],
          },
        ],
      }),
    },
    statePath,
    {
      baseStorage: {
        [key]: JSON.stringify({ identities: [] }),
      },
    },
  );

  assert.equal(
    JSON.parse(state.storage[key]).identities.length,
    2,
  );
});

test("conflicting MusicBrainz identities never coalesce", async (context) => {
  const { directory, statePath } = await temporaryStatePath();
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = "recordshelf-artist-identities-v1";
  const identity = (id, mbid) => ({
    id,
    canonicalName: "Same Name",
    musicBrainzMbid: mbid,
    aliases: [
      { name: "Same Name" },
      { name: "Shared Alias" },
    ],
  });

  await applySharedStateChanges(
    {
      [key]: JSON.stringify({
        identities: [identity("artist-a", "mbid-a")],
      }),
    },
    statePath,
  );
  const state = await applySharedStateChanges(
    {
      [key]: JSON.stringify({
        identities: [identity("artist-b", "mbid-b")],
      }),
    },
    statePath,
    {
      baseStorage: {
        [key]: JSON.stringify({ identities: [] }),
      },
    },
  );

  assert.equal(
    JSON.parse(state.storage[key]).identities.length,
    2,
  );
});
