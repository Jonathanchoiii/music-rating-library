import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  persistResearchedArtistProfile,
  researchArtist,
} from "../artist-research/index.mjs";
import {
  groupReleasesByArtistIdentity,
  sanitizeArtistIdentityState,
} from "../src/lib/artists.js";
import {
  artistProfileLookupKeys,
  sanitizeArtistProfileState,
} from "../src/lib/artistProfiles.js";
import { getCurrentRating } from "../src/lib/music.js";
import { resolveRoamCountry } from "../src/lib/roam.js";
import {
  ARTIST_IDENTITY_STORAGE_KEY,
  ARTIST_PROFILE_STORAGE_KEY,
  USER_STATE_KEY,
} from "../src/lib/sharedStorageKeys.js";
import {
  getSharedStatePath,
  readSharedState,
} from "../shared-state/index.mjs";

const APP_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PRIVATE_LIBRARY_PATH = path.join(
  APP_DIRECTORY,
  ".private",
  "neodb-library.local.json",
);
const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1_150;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseStoredJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function applyListeningState(baseReleases, userState = {}) {
  const removedReleaseIds = new Set(userState.removedReleaseIds ?? []);
  const additions = userState.listeningEntryAdditions ?? {};
  const removals = userState.listeningEntryRemovals ?? {};
  const base = baseReleases
    .filter((release) => !removedReleaseIds.has(release.id))
    .map((release) => {
      const removedEntryIds = new Set(removals[release.id] ?? []);
      return {
        ...release,
        listeningEntries: [
          ...(release.listeningEntries ?? []).filter(
            (entry) => !removedEntryIds.has(entry.id),
          ),
          ...(additions[release.id] ?? []),
        ],
      };
    });
  return [...(userState.userReleases ?? []), ...base];
}

function storedProfile(profileState, artistId) {
  const key = artistProfileLookupKeys(artistId).find(
    (candidate) => profileState.profiles?.[candidate],
  );
  return key ? profileState.profiles[key] : null;
}

function hasRatedRelease(group) {
  return (group.releases ?? []).some(
    (release) => getCurrentRating(release.listeningEntries) != null,
  );
}

function isRoamReady(profile) {
  return Boolean(
    profile?.introductionStatus === "READY" &&
      profile?.sources?.length &&
      resolveRoamCountry(profile?.publicFacts?.country),
  );
}

function mergeSources(previous = [], incoming = []) {
  const sources = new Map();
  for (const source of [...previous, ...incoming]) {
    const key = source?.url || source?.sourceId;
    if (key) sources.set(key, source);
  }
  return [...sources.values()];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const force = args.has("--force");
const statePath = getSharedStatePath();
const sharedState = await readSharedState(statePath);
const baseReleases = JSON.parse(await readFile(PRIVATE_LIBRARY_PATH, "utf8"));
const userState = parseStoredJson(
  sharedState.storage[USER_STATE_KEY],
  {},
);
const identityState = sanitizeArtistIdentityState(
  parseStoredJson(sharedState.storage[ARTIST_IDENTITY_STORAGE_KEY], {}),
);
let profileState = sanitizeArtistProfileState(
  parseStoredJson(sharedState.storage[ARTIST_PROFILE_STORAGE_KEY], {}),
);
const releases = applyListeningState(baseReleases, userState);
const groups = groupReleasesByArtistIdentity(releases, identityState, "");
const groupById = new Map(groups.map((group) => [group.id, group]));
const eligible = identityState.identities.filter((identity) =>
  hasRatedRelease(groupById.get(identity.id) ?? {}),
);
const pending = eligible.filter(
  (identity) => force || !isRoamReady(storedProfile(profileState, identity.id)),
);

console.log(
  `漫游国家扫描：${eligible.length} 位已听艺人已有稳定身份，${
    eligible.length - pending.length
  } 位已可点亮，${pending.length} 位待核验。`,
);

if (!write) {
  console.log("当前为只读盘点；加入 --write 才会联网核验并写回资料。");
  process.exit(0);
}

const summary = {
  checked: 0,
  updated: 0,
  noCountry: 0,
  ambiguous: 0,
  failed: 0,
};

for (const [index, identity] of pending.entries()) {
  const previous = storedProfile(profileState, identity.id) ?? {};
  const aliases = (identity.aliases ?? [])
    .map((alias) => alias.name)
    .filter(Boolean);
  const prefix = `[${index + 1}/${pending.length}] ${identity.canonicalName}`;
  try {
    const result = await researchArtist({
      artistId: identity.id,
      name: identity.canonicalName,
      aliases,
      musicBrainzId: MBID_PATTERN.test(identity.musicBrainzMbid ?? "")
        ? identity.musicBrainzMbid
        : "",
    });
    summary.checked += 1;
    const region = resolveRoamCountry(result.publicFacts?.country);
    if (!region || !result.sources?.length) {
      summary.noCountry += 1;
      console.log(`${prefix}：来源未返回可映射国家，跳过`);
    } else {
      await persistResearchedArtistProfile(
        identity.id,
        {
          introductionStatus: "READY",
          publicFacts: result.publicFacts,
          sources: mergeSources(previous.sources, result.sources),
          researchError: "",
        },
        statePath,
      );
      summary.updated += 1;
      console.log(`${prefix}：${region.name}（${region.code}）`);
      const refreshed = await readSharedState(statePath);
      profileState = sanitizeArtistProfileState(
        parseStoredJson(
          refreshed.storage[ARTIST_PROFILE_STORAGE_KEY],
          {},
        ),
      );
    }
  } catch (error) {
    if (error?.code === "ARTIST_IDENTITY_AMBIGUOUS") {
      summary.ambiguous += 1;
      console.log(`${prefix}：同名身份无法唯一确认，跳过`);
    } else {
      summary.failed += 1;
      console.log(`${prefix}：核验失败（${error?.code || error?.message || "UNKNOWN"}）`);
    }
  }
  if (index < pending.length - 1) {
    await delay(MUSICBRAINZ_REQUEST_INTERVAL_MS);
  }
}

const finalState = await readSharedState(statePath);
const finalProfiles = sanitizeArtistProfileState(
  parseStoredJson(finalState.storage[ARTIST_PROFILE_STORAGE_KEY], {}),
);
const ready = eligible
  .map((identity) => storedProfile(finalProfiles, identity.id))
  .filter(isRoamReady);
const countries = [
  ...new Set(
    ready
      .map((profile) => resolveRoamCountry(profile.publicFacts.country)?.name)
      .filter(Boolean),
  ),
].sort((left, right) => left.localeCompare(right, "zh-CN"));

console.log(
  JSON.stringify(
    {
      ...summary,
      stableIdentityReadyArtists: ready.length,
      litCountries: countries.length,
      countries,
    },
    null,
    2,
  ),
);
