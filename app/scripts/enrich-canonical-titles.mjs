import fs from "node:fs/promises";
import path from "node:path";
import { applyCanonicalTitleEvidence } from "../src/lib/music.js";

const libraryPath =
  process.argv.find((argument) => argument.endsWith(".json")) ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");
const force = process.argv.includes("--force");
const promoteStoredPlatformTitles = process.argv.includes(
  "--promote-stored-platform-titles",
);
const idArgument = process.argv.find((argument) => argument.startsWith("--id="));
const onlyId = idArgument?.slice("--id=".length) || null;
const limitArgument = process.argv.find((argument) =>
  argument.startsWith("--limit="),
);
const limit = limitArgument
  ? Number.parseInt(limitArgument.split("=")[1], 10)
  : null;
const concurrencyArgument = process.argv.find((argument) =>
  argument.startsWith("--concurrency="),
);
const concurrency = concurrencyArgument
  ? Math.max(1, Number.parseInt(concurrencyArgument.split("=")[1], 10))
  : 5;
const requestTimeoutMs = 15_000;
const userAgent = "RecordShelf/0.1 (local personal music archive)";
const localCanonicalTitleEvidencePath = path.resolve(
  import.meta.dirname,
  "../.private/canonical-title-evidence.local.json",
);
const publicCanonicalTitleEvidencePath = path.resolve(
  import.meta.dirname,
  "../src/data/canonical-title-evidence.json",
);
const canonicalTitleEvidencePath = await fs
  .access(localCanonicalTitleEvidencePath)
  .then(() => localCanonicalTitleEvidencePath)
  .catch(() => publicCanonicalTitleEvidencePath);

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function cleanTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      headers: {
        "User-Agent": userAgent,
        ...options.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function linkFor(release, provider) {
  return release.externalLinks?.find((link) => link.provider === provider)?.url;
}

async function titleFromAppleMusic(release) {
  const url = linkFor(release, "APPLE_MUSIC");
  const id = url?.match(/\/album\/(?:[^/]+\/)?(\d+)(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  const response = await fetchWithTimeout(
    `https://itunes.apple.com/lookup?id=${id}&entity=album`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const result = (await response.json()).results?.find(
    (item) => item.wrapperType === "collection" && item.collectionName,
  );
  return result
    ? {
        title: cleanTitle(result.collectionName),
        source: "APPLE_LOOKUP",
        matchedFrom: url,
      }
    : null;
}

async function titleFromSpotify(release) {
  const url = linkFor(release, "SPOTIFY");
  if (!url || !/open\.spotify\.com\/album\//i.test(url)) return null;
  const response = await fetchWithTimeout(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const result = await response.json();
  const title = cleanTitle(result.title);
  return title
    ? {
        title,
        source: "SPOTIFY_OEMBED",
        matchedFrom: url,
      }
    : null;
}

async function titleFromMusicBrainz(release) {
  const url = linkFor(release, "MUSICBRAINZ");
  const match = url?.match(
    /musicbrainz\.org\/(release-group|release)\/([0-9a-f-]{36})/i,
  );
  if (!match) return null;
  const response = await fetchWithTimeout(
    `https://musicbrainz.org/ws/2/${match[1]}/${match[2]}?fmt=json`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const title = cleanTitle((await response.json()).title);
  return title
    ? {
        title,
        source: "MUSICBRAINZ_EXACT",
        matchedFrom: url,
      }
    : null;
}

async function findCanonicalTitle(release) {
  const streamingResults = await Promise.all(
    [titleFromAppleMusic, titleFromSpotify].map(async (resolver) => {
      try {
        return await resolver(release);
      } catch {
        return null;
      }
    }),
  );
  const candidates = streamingResults.filter(Boolean);
  if (candidates.length === 0) {
    try {
      const musicBrainzResult = await titleFromMusicBrainz(release);
      if (musicBrainzResult) candidates.push(musicBrainzResult);
    } catch {
      // An unavailable exact MusicBrainz record leaves the CSV title untouched.
    }
  }
  const sourcePreference = {
    MUSICBRAINZ_EXACT: 0,
    APPLE_LOOKUP: 1,
    SPOTIFY_OEMBED: 2,
  };
  const selected = candidates.sort(
    (a, b) => sourcePreference[a.source] - sourcePreference[b.source],
  )[0];
  return selected ?? null;
}

async function saveLibrary(releases) {
  await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
}

const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const canonicalTitleEvidence = JSON.parse(
  await fs.readFile(canonicalTitleEvidencePath, "utf8"),
);

for (const release of releases) {
  const neoDbUrl = linkFor(release, "NEODB");
  const evidence = canonicalTitleEvidence[neoDbUrl];
  if (!evidence || (onlyId && release.id !== onlyId)) continue;
  Object.assign(release, applyCanonicalTitleEvidence(release, evidence));
}

if (promoteStoredPlatformTitles) {
  for (const release of releases) {
    if (
      !release.platformTitle ||
      !["APPLE_LOOKUP", "SPOTIFY_OEMBED", "MUSICBRAINZ_EXACT"].includes(
        release.titleSource,
      ) ||
      (onlyId && release.id !== onlyId)
    ) {
      continue;
    }
    Object.assign(
      release,
      applyCanonicalTitleEvidence(release, {
        title: release.platformTitle,
        source: release.titleSource,
        matchedFrom: release.titleMatchedFrom,
        verifiedAt: release.titleMatchedAt,
        platformTitle: release.platformTitle,
      }),
    );
  }
}

const targets = (promoteStoredPlatformTitles ? [] : releases)
  .filter((release) => !onlyId || release.id === onlyId)
  .filter(
    (release) =>
      force ||
      !release.titleSource ||
      !["APPLE_LOOKUP", "SPOTIFY_OEMBED", "MUSICBRAINZ_EXACT"].includes(
        release.titleSource,
      ),
  )
  .filter((release) =>
    release.externalLinks?.some((link) =>
      ["APPLE_MUSIC", "SPOTIFY", "MUSICBRAINZ"].includes(link.provider),
    ),
  )
  .slice(0, Number.isInteger(limit) ? limit : undefined);

const sourceCounts = {};
let matched = 0;
let aliases = 0;
let unchanged = 0;
let failed = 0;

console.log(
  `Canonical title enrichment: ${targets.length} targets, ${concurrency} concurrent requests`,
);

for (let offset = 0; offset < targets.length; offset += concurrency) {
  const batch = targets.slice(offset, offset + concurrency);
  await Promise.all(
    batch.map(async (release) => {
      const result = await findCanonicalTitle(release);
      if (!result) {
        failed += 1;
        return;
      }

      const previousTitle = release.title;
      Object.assign(
        release,
        applyCanonicalTitleEvidence(release, {
          title: result.title,
          source: result.source,
          matchedFrom: result.matchedFrom,
          verifiedAt: new Date().toISOString(),
          platformTitle: result.title,
        }),
      );
      if (
        release.translatedTitle &&
        normalizeTitle(release.translatedTitle) !== normalizeTitle(release.title)
      ) {
        aliases += 1;
      } else {
        unchanged += 1;
      }
      if (normalizeTitle(previousTitle) === normalizeTitle(release.title)) {
        unchanged += 1;
      }
      sourceCounts[result.source] = (sourceCounts[result.source] ?? 0) + 1;
      matched += 1;
    }),
  );

  if ((offset + batch.length) % 50 < concurrency) {
    await saveLibrary(releases);
    console.log(
      `Processed ${Math.min(offset + batch.length, targets.length)}/${targets.length}: ${matched} matched, ${failed} unresolved`,
    );
  }
}

await saveLibrary(releases);
console.log(
  JSON.stringify(
    {
      matched,
      aliases,
      unchanged,
      unresolved: failed,
      sources: sourceCounts,
    },
    null,
    2,
  ),
);
