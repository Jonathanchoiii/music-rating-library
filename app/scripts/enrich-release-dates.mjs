#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const libraryPath =
  process.argv.find((argument) => argument.endsWith(".json")) ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");
const force = process.argv.includes("--force");
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
  : 7;
const requestTimeoutMs = 18_000;
const userAgent = "RecordShelf/0.1 (local personal music archive)";
const currentYear = new Date().getUTCFullYear();
const requestCache = new Map();
let musicBrainzQueue = Promise.resolve();
let nextMusicBrainzRequestAt = 0;
let discogsQueue = Promise.resolve();
let nextDiscogsRequestAt = 0;

async function fetchWithTimeout(url, options = {}, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      ...options,
      headers: {
        "User-Agent": userAgent,
        ...options.headers,
      },
      signal: controller.signal,
    });
    if (
      attempt < 2 &&
      (response.status === 429 || response.status >= 500)
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1_000
        : 1_500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithTimeout(url, options, attempt + 1);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function cachedRequest(key, request) {
  if (!requestCache.has(key)) requestCache.set(key, request());
  return requestCache.get(key);
}

function schedule(queueName, intervalMs, task) {
  const isMusicBrainz = queueName === "musicbrainz";
  const queue = isMusicBrainz ? musicBrainzQueue : discogsQueue;
  const run = async () => {
    const nextAt = isMusicBrainz
      ? nextMusicBrainzRequestAt
      : nextDiscogsRequestAt;
    const waitMs = Math.max(0, nextAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const result = await task();
    if (isMusicBrainz) {
      nextMusicBrainzRequestAt = Date.now() + intervalMs;
    } else {
      nextDiscogsRequestAt = Date.now() + intervalMs;
    }
    return result;
  };
  const nextQueue = queue.then(run, run);
  if (isMusicBrainz) musicBrainzQueue = nextQueue;
  else discogsQueue = nextQueue;
  return nextQueue;
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  if (year < 1900 || year > currentYear + 1) return null;
  if (month != null && (month < 1 || month > 12)) return null;
  if (day != null) {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() !== year ||
      candidate.getUTCMonth() + 1 !== month ||
      candidate.getUTCDate() !== day
    ) {
      return null;
    }
  }
  if (day != null) return `${match[1]}-${match[2]}-${match[3]}`;
  if (month != null) return `${match[1]}-${match[2]}`;
  return match[1];
}

function datePrecision(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "DAY";
  if (/^\d{4}-\d{2}$/.test(value)) return "MONTH";
  return "YEAR";
}

function precisionRank(value) {
  return { YEAR: 1, MONTH: 2, DAY: 3 }[datePrecision(value)];
}

function datesAreCompatible(left, right) {
  const leftParts = left.split("-");
  const rightParts = right.split("-");
  return leftParts.every(
    (part, index) => rightParts[index] == null || rightParts[index] === part,
  ) && rightParts.every(
    (part, index) => leftParts[index] == null || leftParts[index] === part,
  );
}

function linksFor(release, provider) {
  return [
    ...new Set(
      (release.externalLinks ?? [])
        .filter((link) => link.provider === provider)
        .map((link) => link.url)
        .filter(Boolean),
    ),
  ];
}

async function dateFromNeoDb(url) {
  return cachedRequest(`neodb:${url}`, async () => {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const rawDate =
      html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] ??
      html.match(/release date:\s*([^<\n]+)/i)?.[1];
    const date = normalizeDate(rawDate);
    return date
      ? { date, source: "NEODB_EXACT", matchedFrom: url }
      : null;
  });
}

async function dateFromAppleMusic(url) {
  const id = url.match(/\/album\/(?:[^/]+\/)?(\d+)(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  return cachedRequest(`apple:${id}`, async () => {
    const response = await fetchWithTimeout(
      `https://itunes.apple.com/lookup?id=${id}&entity=album`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    const result = (await response.json()).results?.find(
      (item) =>
        item.wrapperType === "collection" &&
        String(item.collectionId) === id,
    );
    const date = normalizeDate(result?.releaseDate);
    return date
      ? { date, source: "APPLE_LOOKUP", matchedFrom: url }
      : null;
  });
}

async function dateFromMusicBrainz(url) {
  const match = url.match(
    /musicbrainz\.org\/(release-group|release)\/([0-9a-f-]{36})/i,
  );
  if (!match) return null;
  return cachedRequest(`musicbrainz:${match[1]}:${match[2]}`, () =>
    schedule("musicbrainz", 1_100, async () => {
      const endpoint = new URL(
        `https://musicbrainz.org/ws/2/${match[1]}/${match[2]}`,
      );
      endpoint.searchParams.set("fmt", "json");
      const response = await fetchWithTimeout(endpoint, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const date = normalizeDate(
        match[1] === "release-group"
          ? payload["first-release-date"]
          : payload.date,
      );
      return date
        ? { date, source: "MUSICBRAINZ_EXACT", matchedFrom: url }
        : null;
    }),
  );
}

async function dateFromDiscogs(url) {
  const match = url.match(/discogs\.com\/(release|master)\/(\d+)/i);
  if (!match) return null;
  return cachedRequest(`discogs:${match[1]}:${match[2]}`, () =>
    schedule("discogs", 2_500, async () => {
      const endpoint =
        match[1] === "master"
          ? `https://api.discogs.com/masters/${match[2]}`
          : `https://api.discogs.com/releases/${match[2]}`;
      const response = await fetchWithTimeout(endpoint, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const date = normalizeDate(payload.year ?? payload.released);
      return date
        ? { date, source: "DISCOGS_EXACT", matchedFrom: url }
        : null;
    }),
  );
}

async function candidatesForRelease(release) {
  const tasks = [
    ...linksFor(release, "NEODB").map((url) => dateFromNeoDb(url)),
    ...linksFor(release, "APPLE_MUSIC").map((url) =>
      dateFromAppleMusic(url),
    ),
    ...linksFor(release, "MUSICBRAINZ").map((url) =>
      dateFromMusicBrainz(url),
    ),
    ...linksFor(release, "DISCOGS").map((url) => dateFromDiscogs(url)),
  ];
  const results = await Promise.all(
    tasks.map((task) => Promise.resolve(task).catch(() => null)),
  );
  const seen = new Set();
  return results.filter(Boolean).filter((candidate) => {
    const key = `${candidate.source}|${candidate.matchedFrom}|${candidate.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectUncontestedDate(candidates) {
  if (!candidates.length) return { status: "UNRESOLVED" };
  const compatible = candidates.every((candidate, index) =>
    candidates
      .slice(index + 1)
      .every((other) => datesAreCompatible(candidate.date, other.date)),
  );
  if (!compatible) return { status: "CONFLICT", candidates };
  const selected = [...candidates].sort(
    (left, right) =>
      precisionRank(right.date) - precisionRank(left.date) ||
      ["MUSICBRAINZ_EXACT", "NEODB_EXACT", "APPLE_LOOKUP", "DISCOGS_EXACT"].indexOf(
        left.source,
      ) -
        ["MUSICBRAINZ_EXACT", "NEODB_EXACT", "APPLE_LOOKUP", "DISCOGS_EXACT"].indexOf(
          right.source,
        ),
  )[0];
  return { status: "MATCHED", selected, candidates };
}

async function saveLibrary(releases) {
  await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
}

const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const targets = releases
  .filter(
    (release) =>
      force || (!release.releaseDate && !release.releaseDateCheckedAt),
  )
  .slice(0, Number.isInteger(limit) ? limit : undefined);
let matched = 0;
let conflicts = 0;
let unresolved = 0;
const sourceCounts = {};

console.log(
  `Release date enrichment: ${targets.length} targets, ${concurrency} concurrent releases`,
);

for (let offset = 0; offset < targets.length; offset += concurrency) {
  const batch = targets.slice(offset, offset + concurrency);
  await Promise.all(
    batch.map(async (release) => {
      const candidates = await candidatesForRelease(release);
      const result = selectUncontestedDate(candidates);
      release.releaseDateCheckedAt = new Date().toISOString();
      if (result.status === "MATCHED") {
        release.releaseDate = result.selected.date;
        release.releaseDatePrecision = datePrecision(result.selected.date);
        release.releaseDateSource =
          result.candidates.length > 1
            ? "EXACT_CONSENSUS"
            : result.selected.source;
        release.releaseDateMatchedFrom = result.selected.matchedFrom;
        release.releaseDateEvidence = result.candidates;
        release.releaseDateMatchedAt = new Date().toISOString();
        delete release.releaseDateConflict;
        sourceCounts[release.releaseDateSource] =
          (sourceCounts[release.releaseDateSource] ?? 0) + 1;
        matched += 1;
      } else if (result.status === "CONFLICT") {
        release.releaseDate = null;
        release.releaseDatePrecision = "UNKNOWN";
        release.releaseDateConflict = result.candidates;
        conflicts += 1;
      } else {
        release.releaseDate = null;
        release.releaseDatePrecision = "UNKNOWN";
        unresolved += 1;
      }
    }),
  );
  if ((offset + batch.length) % 35 < concurrency) {
    await saveLibrary(releases);
    console.log(
      `Processed ${Math.min(offset + batch.length, targets.length)}/${targets.length}: ${matched} matched, ${conflicts} conflicts, ${unresolved} unresolved`,
    );
  }
}

await saveLibrary(releases);
console.log(
  JSON.stringify(
    { matched, conflicts, unresolved, sources: sourceCounts },
    null,
    2,
  ),
);
