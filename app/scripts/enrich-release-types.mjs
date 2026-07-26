import fs from "node:fs/promises";
import path from "node:path";
import {
  inferReleaseTypeFromOfficialTitle,
  normalizeExternalReleaseType,
} from "../src/lib/music.js";

const libraryPath =
  process.argv.find((argument) => argument.endsWith(".json")) ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");
const force = process.argv.includes("--force");
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
  : 6;
const requestTimeoutMs = 18_000;
const userAgent = "RecordShelf/0.1 (local personal music archive)";
let musicBrainzQueue = Promise.resolve();
let nextMusicBrainzRequestAt = 0;

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function plainText(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " "))
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

function scheduleMusicBrainz(task) {
  const run = async () => {
    const waitMs = Math.max(0, nextMusicBrainzRequestAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const result = await task();
    nextMusicBrainzRequestAt = Date.now() + 1_100;
    return result;
  };
  musicBrainzQueue = musicBrainzQueue.then(run, run);
  return musicBrainzQueue;
}

function linkFor(release, provider) {
  return release.externalLinks?.find((link) => link.provider === provider)?.url;
}

async function typeFromMusicBrainz(release) {
  const url = linkFor(release, "MUSICBRAINZ");
  const match = url?.match(
    /musicbrainz\.org\/(release-group|release)\/([0-9a-f-]{36})/i,
  );
  if (!match) return null;
  return scheduleMusicBrainz(async () => {
    const endpoint = new URL(
      `https://musicbrainz.org/ws/2/${match[1]}/${match[2]}`,
    );
    endpoint.searchParams.set("fmt", "json");
    if (match[1] === "release") {
      endpoint.searchParams.set("inc", "release-groups");
    }
    const response = await fetchWithTimeout(endpoint, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const evidence =
      payload["primary-type"] ?? payload["release-group"]?.["primary-type"];
    const releaseType = normalizeExternalReleaseType(evidence);
    return releaseType
      ? {
          releaseType,
          source: "MUSICBRAINZ_EXACT",
          matchedFrom: url,
          evidence,
        }
      : null;
  });
}

async function typeFromNeoDb(release) {
  const url = linkFor(release, "NEODB");
  if (!url) return null;
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "text/html" },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const typeBlock = html.match(/album type:\s*([\s\S]*?)<\/div>/i)?.[1];
  const evidence = plainText(typeBlock);
  const releaseType = normalizeExternalReleaseType(evidence);
  return releaseType
    ? {
        releaseType,
        source: "NEODB_EXACT",
        matchedFrom: url,
        evidence,
      }
    : null;
}

async function discogsReleasePayload(url) {
  const match = url?.match(/discogs\.com\/(release|master)\/(\d+)/i);
  if (!match) return null;
  let response = await fetchWithTimeout(
    `https://api.discogs.com/${match[1] === "master" ? "masters" : "releases"}/${match[2]}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  let payload = await response.json();
  if (match[1] === "master" && payload.main_release) {
    response = await fetchWithTimeout(
      `https://api.discogs.com/releases/${payload.main_release}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    payload = await response.json();
  }
  return payload;
}

async function typeFromDiscogs(release) {
  const url = linkFor(release, "DISCOGS");
  if (!url) return null;
  const payload = await discogsReleasePayload(url);
  const evidence = (payload?.formats ?? [])
    .flatMap((format) => [format.name, ...(format.descriptions ?? [])])
    .filter(Boolean)
    .join(" · ");
  const releaseType = normalizeExternalReleaseType(evidence);
  return releaseType
    ? {
        releaseType,
        source: "DISCOGS_EXACT",
        matchedFrom: url,
        evidence,
      }
    : null;
}

function typeFromOfficialTitle(release) {
  if (
    !["APPLE_LOOKUP", "SPOTIFY_OEMBED", "MUSICBRAINZ_EXACT"].includes(
      release.titleSource,
    )
  ) {
    return null;
  }
  const releaseType = inferReleaseTypeFromOfficialTitle(release.title);
  return releaseType
    ? {
        releaseType,
        source: "OFFICIAL_TITLE_SUFFIX",
        matchedFrom: release.titleMatchedFrom,
        evidence: release.title,
      }
    : null;
}

async function findReleaseType(release) {
  for (const resolver of [
    typeFromMusicBrainz,
    typeFromNeoDb,
    typeFromDiscogs,
  ]) {
    try {
      const result = await resolver(release);
      if (result?.releaseType) return result;
    } catch {
      // A failed exact provider should not block the remaining resolvers.
    }
  }
  return typeFromOfficialTitle(release);
}

async function saveLibrary(releases) {
  await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
}

const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const targets = releases
  .filter((release) => !onlyId || release.id === onlyId)
  .filter(
    (release) =>
      force ||
      (release.releaseType === "OTHER" && !release.releaseTypeSource),
  )
  .slice(0, Number.isInteger(limit) ? limit : undefined);
const sourceCounts = {};
const typeCounts = { LP: 0, EP: 0, SINGLE: 0 };
let matched = 0;
let unresolved = 0;

console.log(
  `Release type enrichment: ${targets.length} targets, ${concurrency} concurrent requests`,
);

for (let offset = 0; offset < targets.length; offset += concurrency) {
  const batch = targets.slice(offset, offset + concurrency);
  await Promise.all(
    batch.map(async (release) => {
      const result = await findReleaseType(release);
      if (!result) {
        unresolved += 1;
        return;
      }
      release.releaseType = result.releaseType;
      release.releaseTypeSource = result.source;
      release.releaseTypeMatchedFrom = result.matchedFrom;
      release.releaseTypeEvidence = result.evidence;
      release.releaseTypeMatchedAt = new Date().toISOString();
      sourceCounts[result.source] = (sourceCounts[result.source] ?? 0) + 1;
      typeCounts[result.releaseType] += 1;
      matched += 1;
    }),
  );

  if ((offset + batch.length) % 48 < concurrency) {
    await saveLibrary(releases);
    console.log(
      `Processed ${Math.min(offset + batch.length, targets.length)}/${targets.length}: ${matched} matched, ${unresolved} unresolved`,
    );
  }
}

await saveLibrary(releases);
console.log(
  JSON.stringify(
    {
      matched,
      unresolved,
      types: typeCounts,
      sources: sourceCounts,
    },
    null,
    2,
  ),
);
