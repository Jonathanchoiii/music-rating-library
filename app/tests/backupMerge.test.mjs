import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeArtistIdentityStates,
  mergeReleaseLibraries,
  validateRecordshelfBackup,
} from "../src/lib/backupMerge.js";

function release(id, title, entryId) {
  return {
    id,
    title,
    artists: ["Example"],
    releaseType: "OTHER",
    titleAliases: [],
    externalLinks: [
      {
        provider: "NEODB",
        url: "https://neodb.social/album/example",
      },
    ],
    listeningEntries: [
      {
        id: entryId,
        listenedAt: `2026-07-${entryId === "one" ? "01" : "02"}`,
        rating10: entryId === "one" ? 8 : 9,
        comment: entryId,
      },
    ],
  };
}

test("backup release merge keeps the primary record and adds distinct history", () => {
  const result = mergeReleaseLibraries(
    [release("primary", "Original", "one")],
    [release("other-origin", "Translated", "two")],
  );

  assert.equal(result.releases.length, 1);
  assert.equal(result.historyAdded, 1);
  assert.equal(result.releases[0].listeningEntries.length, 2);
  assert.deepEqual(result.releases[0].titleAliases, ["Translated"]);
});

test("backup release merge keeps different NeoDB identities separate on ID collision", () => {
  const first = release("collision", "EUSEXUA", "one");
  first.listeningEntries[0].source = "NEODB";
  first.listeningEntries[0].sourceItemId = "009hmT3TB9W1OHlJZvEpjx";
  first.externalLinks[0].url =
    "https://neodb.social/album/009hmT3TB9W1OHlJZvEpjx";

  const second = release("collision", "EUSEXUA", "two");
  second.listeningEntries[0].source = "NEODB";
  second.listeningEntries[0].sourceItemId = "0Zv5gRpVX2iT3ys4Kla1SD";
  second.externalLinks[0].url =
    "https://neodb.social/album/0Zv5gRpVX2iT3ys4Kla1SD";

  const result = mergeReleaseLibraries([first], [second]);
  assert.equal(result.releases.length, 2);
  assert.equal(new Set(result.releases.map((item) => item.id)).size, 2);
  assert.deepEqual(
    result.releases.map((item) => item.listeningEntries[0].id),
    ["one", "two"],
  );
});

test("backup artist merge combines stable identities and keeps unmatched identities", () => {
  const result = mergeArtistIdentityStates(
    {
      schemaVersion: 2,
      identities: [
        {
          id: "stable",
          canonicalName: "One",
          aliases: [{ name: "Uno" }],
        },
      ],
    },
    {
      schemaVersion: 2,
      identities: [
        {
          id: "stable",
          canonicalName: "One",
          aliases: [{ name: "壹" }],
        },
        {
          id: "new",
          canonicalName: "Two",
          aliases: [],
        },
      ],
    },
  );

  assert.equal(result.identitiesAdded, 1);
  assert.deepEqual(
    result.state.identities
      .find((identity) => identity.id === "stable")
      .aliases.map((alias) => alias.name)
      .sort(),
    ["One", "Uno", "壹"].sort(),
  );
});

test("backup validation rejects incomplete exports", () => {
  assert.throws(
    () => validateRecordshelfBackup({ releases: [] }),
    /artistIdentityState/,
  );
});
