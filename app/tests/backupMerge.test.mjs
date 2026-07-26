import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeArtistIdentityStates,
  mergeReleaseLibraries,
  mergeSelectedReleases,
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

test("manual detail merge preserves the chosen record and absorbs unique history", () => {
  const kept = release("keep", "Keep title", "one");
  kept.externalLinks.push({
    provider: "SPOTIFY",
    url: "https://open.spotify.com/album/keep",
  });
  const removed = release("remove", "Removed title", "two");
  removed.externalLinks[0].url = "https://neodb.social/album/remove";
  removed.externalLinks.push({
    provider: "SPOTIFY",
    url: "https://open.spotify.com/album/remove",
  });
  removed.externalLinks.push({
    provider: "APPLE_MUSIC",
    url: "https://music.apple.com/cn/album/example/123",
  });

  const result = mergeSelectedReleases(kept, removed, "NEODB");

  assert.equal(result.keptReleaseId, "keep");
  assert.equal(result.removedReleaseId, "remove");
  assert.equal(result.historyAdded, 1);
  assert.equal(result.release.title, "Keep title");
  assert.deepEqual(result.release.titleAliases, ["Removed title"]);
  assert.deepEqual(
    result.release.listeningEntries.map((entry) => entry.id),
    ["one", "two"],
  );
  assert.deepEqual(
    result.release.externalLinks
      .filter((link) => link.provider === "NEODB")
      .map((link) => link.url),
    ["https://neodb.social/album/example"],
  );
  assert.equal(
    result.release.externalLinks.some(
      (link) => link.provider === "APPLE_MUSIC",
    ),
    true,
  );
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
