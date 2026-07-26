import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMusicBrainzArtistAuditResults,
  ARTIST_IDENTITY_BACKUP_STORAGE_KEY,
  ARTIST_IDENTITY_STORAGE_KEY,
  DEFAULT_ARTIST_IDENTITY_STATE,
  findArtistNameConflicts,
  findDuplicateArtistMbidGroups,
  getArtistAliasIndex,
  getReleaseArtistTargets,
  groupReleasesByArtistIdentity,
  loadArtistIdentityState,
  releaseMatchesMappedArtistQuery,
  saveArtistIdentityState,
  sortArtistGroups,
} from "../src/lib/artists.js";
import {
  getChineseNameVariants,
  reconcileChineseArtistVariants,
} from "../src/lib/artistChinese.js";

function release(id, artist) {
  return {
    id,
    title: id,
    artists: [artist],
    externalLinks: [],
    listeningEntries: [],
  };
}

test("artist aliases resolve to one stable artist identity", () => {
  const releases = [
    release("one", "魏如萱"),
    release("two", "魏如萱 Waa"),
    release("three", "Waa Wei"),
  ];
  const groups = groupReleasesByArtistIdentity(
    releases,
    DEFAULT_ARTIST_IDENTITY_STATE,
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].artist, "魏如萱");
  assert.equal(groups[0].releases.length, 3);
  assert.deepEqual(releases[1].artists, ["魏如萱 Waa"]);
});

test("an alias search matches releases credited with another alias", () => {
  const item = release("one", "魏如萱");
  assert.equal(
    releaseMatchesMappedArtistQuery(
      item,
      "Waa Wei",
      DEFAULT_ARTIST_IDENTITY_STATE,
    ),
    true,
  );
});

test("collaboration credits join the mapped artist group without changing display credit", () => {
  const item = release("one", "Charli xcx/魏如萱 Waa");
  const groups = groupReleasesByArtistIdentity(
    [item],
    DEFAULT_ARTIST_IDENTITY_STATE,
    "Waa Wei",
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].artist, "魏如萱");
  assert.deepEqual(groups[0].releases[0].artists, [
    "Charli xcx/魏如萱 Waa",
  ]);
});

test("release detail artist targets split collaborations and preserve mapped identities", () => {
  const targets = getReleaseArtistTargets(
    release("one", "Charli xcx/魏如萱 Waa"),
    DEFAULT_ARTIST_IDENTITY_STATE,
  );

  assert.deepEqual(
    targets.map((target) => ({
      name: target.name,
      canonicalName: target.canonicalName,
      id: target.id,
    })),
    [
      {
        name: "Charli xcx",
        canonicalName: "Charli xcx",
        id: "raw-charli xcx",
      },
      {
        name: "魏如萱 Waa",
        canonicalName: "魏如萱",
        id: "mbid-3821e3ac-4d91-40b8-a669-f58d1fe2c0c4",
      },
    ],
  );
});

test("artist index sorts by average rating with unrated artists last", () => {
  const groups = [
    { artist: "No Score", average: null, releases: [1, 2, 3] },
    { artist: "Beta", average: 8, releases: [1] },
    { artist: "Alpha", average: 9, releases: [1] },
  ];

  assert.deepEqual(
    sortArtistGroups(groups).map((group) => group.artist),
    ["Alpha", "Beta", "No Score"],
  );
});

test("artist index supports artist name A–Z and Z–A", () => {
  const groups = [
    { artist: "Beta", average: 9, releases: [] },
    { artist: "Alpha", average: 8, releases: [] },
    { artist: "Charlie", average: 7, releases: [] },
  ];

  assert.deepEqual(
    sortArtistGroups(groups, "name_asc").map((group) => group.artist),
    ["Alpha", "Beta", "Charlie"],
  );
  assert.deepEqual(
    sortArtistGroups(groups, "name_desc").map((group) => group.artist),
    ["Charlie", "Beta", "Alpha"],
  );
});

test("OpenCC creates deterministic simplified and traditional name variants", () => {
  assert.deepEqual(getChineseNameVariants("张震岳"), [
    "张震岳",
    "張震嶽",
  ]);
});

test("script variants create one identity only when the same work is shared", () => {
  const releases = [
    { ...release("one", "张震岳"), title: "再见" },
    { ...release("two", "張震嶽"), title: "再见" },
    { ...release("three", "後海大鯊魚"), title: "心要野" },
    { ...release("four", "后海大鲨鱼"), title: "浪潮" },
  ];
  const result = reconcileChineseArtistVariants(releases, {
    schemaVersion: 2,
    identities: [],
  });

  assert.equal(result.created, 1);
  assert.deepEqual(
    result.state.identities[0].aliases.map((alias) => alias.name).sort(),
    ["张震岳", "張震嶽"].sort(),
  );
});

test("MusicBrainz results write only exact work-evidenced matches", () => {
  const initial = {
    schemaVersion: 2,
    identities: [
      {
        id: "artist-one",
        canonicalName: "Example",
        aliases: [],
      },
      {
        id: "artist-two",
        canonicalName: "Uncertain",
        aliases: [],
      },
    ],
  };
  const result = applyMusicBrainzArtistAuditResults(initial, [
    {
      id: "artist-one",
      status: "MATCHED",
      musicBrainzMbid: "00000000-0000-0000-0000-000000000001",
      checkedAt: "2026-07-26T00:00:00.000Z",
      fingerprint: "exact",
      aliases: [{ name: "Example Artist" }],
    },
    {
      id: "artist-two",
      status: "AMBIGUOUS",
      musicBrainzMbid: "00000000-0000-0000-0000-000000000002",
      checkedAt: "2026-07-26T00:00:00.000Z",
      fingerprint: "uncertain",
    },
  ]);

  assert.equal(
    result.identities[0].musicBrainzMbid,
    "00000000-0000-0000-0000-000000000001",
  );
  assert.equal(result.identities[1].musicBrainzMbid, "");
});

test("duplicate MusicBrainz IDs are reported without merging identities", () => {
  const mbid = "00000000-0000-0000-0000-000000000001";
  const groups = findDuplicateArtistMbidGroups({
    identities: [
      { id: "one", canonicalName: "One", musicBrainzMbid: mbid },
      { id: "two", canonicalName: "Two", musicBrainzMbid: mbid },
    ],
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].identities.map((identity) => identity.canonicalName),
    ["One", "Two"],
  );
});

test("artist name conflicts include primary names, aliases and recognition candidates", () => {
  const state = {
    schemaVersion: 2,
    identities: [
      {
        id: "one",
        canonicalName: "Alex",
        aliases: [{ name: "ALEX" }],
        musicBrainzCandidates: [],
      },
      {
        id: "two",
        canonicalName: "Someone Else",
        aliases: [],
        musicBrainzCandidates: [
          {
            name: "Chris Lee",
            musicBrainzMbid: "00000000-0000-0000-0000-000000000002",
          },
        ],
      },
    ],
  };

  assert.deepEqual(
    findArtistNameConflicts(state, "alex").map(
      (conflict) => conflict.identity.id,
    ),
    ["one"],
  );
  assert.deepEqual(
    findArtistNameConflicts(state, "Chris Lee").map(
      (conflict) => conflict.identity.id,
    ),
    ["two"],
  );
  assert.equal(findArtistNameConflicts(state, "alex", "one").length, 0);
});

test("an acknowledged same-name collision stays unresolved instead of mapping to the first artist", () => {
  const state = {
    schemaVersion: 2,
    identities: [
      { id: "one", canonicalName: "Alex", aliases: [] },
      { id: "two", canonicalName: "Alex", aliases: [] },
    ],
  };

  assert.equal(getArtistAliasIndex(state).has("alex"), false);
  assert.equal(
    groupReleasesByArtistIdentity([release("same-name", "Alex")], state)[0]
      .mapped,
    false,
  );
});

test("artist identity edits persist with a rolling recovery snapshot", () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const first = {
    schemaVersion: 2,
    identities: [{ id: "one", canonicalName: "One", aliases: [] }],
  };
  const edited = {
    schemaVersion: 2,
    identities: [
      { id: "one", canonicalName: "One", aliases: [{ name: "Uno" }] },
      { id: "two", canonicalName: "Two", aliases: [] },
    ],
  };

  saveArtistIdentityState(first, storage);
  saveArtistIdentityState(edited, storage);
  assert.deepEqual(loadArtistIdentityState(storage), {
    schemaVersion: 2,
    identities: saveArtistIdentityState(edited, storage).identities,
  });

  const backups = JSON.parse(
    storage.getItem(ARTIST_IDENTITY_BACKUP_STORAGE_KEY),
  );
  assert.equal(backups.length, 2);
  storage.setItem(ARTIST_IDENTITY_STORAGE_KEY, "{broken");
  assert.equal(loadArtistIdentityState(storage).identities.length, 2);
});
