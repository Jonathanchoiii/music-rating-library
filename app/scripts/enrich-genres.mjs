#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const libraryPath =
  process.argv.find((argument) => argument.endsWith(".json")) ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");
const dryRun = process.argv.includes("--dry-run");
const externalLookupConfirmed = process.argv.includes(
  "--confirm-external-id-lookup",
);
const limitArgument = process.argv.find((argument) =>
  argument.startsWith("--limit="),
);
const limit = limitArgument
  ? Number.parseInt(limitArgument.split("=")[1], 10)
  : null;
const requestTimeoutMs = 18_000;
const userAgent = "RecordShelf/0.1 (local personal music archive)";
const verifiedAt = new Date().toISOString();
const genericGenreNames = new Set([
  "music",
  "musik",
  "musique",
  "música",
  "音乐",
  "音樂",
]);

function cleanGenre(value) {
  const genre = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  return genre && !genericGenreNames.has(genre.toLocaleLowerCase())
    ? genre
    : null;
}

function uniqueGenres(values = []) {
  return [
    ...new Map(
      values
        .map(cleanGenre)
        .filter(Boolean)
        .map((value) => [value.toLocaleLowerCase(), value]),
    ).values(),
  ];
}

function confirmedLink(release, provider) {
  return (release.externalLinks ?? []).find(
    (link) =>
      link.provider === provider &&
      ["CONFIRMED", "AUTO_CONFIRMED"].includes(link.status),
  )?.url;
}

function appleAlbumId(url) {
  return url?.match(/\/album\/(?:[^/]+\/)?(?:id)?(\d+)(?:[/?#]|$)/i)?.[1] ??
    null;
}

function musicBrainzEntity(url) {
  const match = url?.match(
    /musicbrainz\.org\/(release-group|release)\/([0-9a-f-]{36})/i,
  );
  return match ? { type: match[1], id: match[2], url } : null;
}

async function fetchWithTimeout(url, options = {}, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      ...options,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
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

function chunk(values, size) {
  const batches = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
}

async function fetchAppleGenres(ids) {
  const genresById = new Map();
  const batches = chunk([...new Set(ids)], 100);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const endpoint = new URL("https://itunes.apple.com/lookup");
    endpoint.searchParams.set("id", batch.join(","));
    endpoint.searchParams.set("entity", "album");
    endpoint.searchParams.set("limit", "200");
    try {
      const response = await fetchWithTimeout(endpoint);
      if (response.ok) {
        const payload = await response.json();
        for (const result of payload.results ?? []) {
          if (result.wrapperType !== "collection" || !result.collectionId) {
            continue;
          }
          const genre = cleanGenre(result.primaryGenreName);
          if (genre) genresById.set(String(result.collectionId), [genre]);
        }
      }
    } catch {
      // A failed exact lookup remains unresolved and is never guessed.
    }
    if (index < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_100));
    }
  }
  return genresById;
}

let nextMusicBrainzRequestAt = 0;

async function musicBrainzRequest(type, id, includes) {
  const waitMs = Math.max(0, nextMusicBrainzRequestAt - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  nextMusicBrainzRequestAt = Date.now() + 1_100;
  const endpoint = new URL(`https://musicbrainz.org/ws/2/${type}/${id}`);
  endpoint.searchParams.set("fmt", "json");
  endpoint.searchParams.set("inc", includes);
  const response = await fetchWithTimeout(endpoint);
  return response.ok ? response.json() : null;
}

function genresFromMusicBrainzPayload(payload) {
  return uniqueGenres(
    (payload?.genres ?? [])
      .filter((genre) => Number(genre.count ?? 1) > 0)
      .sort((left, right) => Number(right.count ?? 0) - Number(left.count ?? 0))
      .map((genre) => genre.name),
  );
}

async function fetchMusicBrainzGenres(entities) {
  const genresByUrl = new Map();
  for (const entity of entities) {
    try {
      const payload = await musicBrainzRequest(
        entity.type,
        entity.id,
        entity.type === "release" ? "genres+release-groups" : "genres",
      );
      let genres = genresFromMusicBrainzPayload(payload);
      if (!genres.length && entity.type === "release") {
        const releaseGroupId = payload?.["release-group"]?.id;
        if (releaseGroupId) {
          const releaseGroup = await musicBrainzRequest(
            "release-group",
            releaseGroupId,
            "genres",
          );
          genres = genresFromMusicBrainzPayload(releaseGroup);
        }
      }
      if (genres.length) genresByUrl.set(entity.url, genres);
    } catch {
      // Exact source downtime leaves this record unchanged.
    }
  }
  return genresByUrl;
}

function hasUserGenreEvidence(release) {
  return (
    (release.genres ?? []).length > 0 &&
    /user/i.test(
      `${release.genreSource ?? ""} ${
        release.metadataEvidence?.genres?.source ?? ""
      }`,
    )
  );
}

async function checkpointLibrary() {
  const checkpointDirectory = path.resolve(
    path.dirname(libraryPath),
    "checkpoints",
  );
  await fs.mkdir(checkpointDirectory, { recursive: true });
  const safeTimestamp = verifiedAt.replaceAll(":", "-");
  const checkpointPath = path.join(
    checkpointDirectory,
    `neodb-library.before-genres.${safeTimestamp}.json`,
  );
  await fs.copyFile(libraryPath, checkpointPath);
  return checkpointPath;
}

const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const targets = releases
  .filter((release) => !hasUserGenreEvidence(release))
  .filter((release) => !(release.genres ?? []).length)
  .map((release) => {
    const appleUrl = confirmedLink(release, "APPLE_MUSIC");
    const musicBrainzUrl = confirmedLink(release, "MUSICBRAINZ");
    return {
      release,
      appleUrl,
      appleId: appleAlbumId(appleUrl),
      musicBrainzUrl,
      musicBrainzEntity: musicBrainzEntity(musicBrainzUrl),
    };
  })
  .filter((target) => target.appleId || target.musicBrainzEntity)
  .slice(0, Number.isInteger(limit) ? limit : undefined);

console.log(
  JSON.stringify({
    phase: "start",
    targets: targets.length,
    appleExact: targets.filter((target) => target.appleId).length,
    musicBrainzExact: targets.filter((target) => target.musicBrainzEntity)
      .length,
    dryRun,
    externalLookupConfirmed,
  }),
);

const isSmallReadOnlyValidation =
  dryRun && Number.isInteger(limit) && limit > 0 && limit <= 5;
if (!externalLookupConfirmed && !isSmallReadOnlyValidation) {
  console.error(
    [
      "External lookup blocked before any catalog IDs were sent.",
      "Use --dry-run --limit=5 for a bounded read-only validation, or",
      "--confirm-external-id-lookup after the owner approves the displayed",
      "Apple Music and MusicBrainz ID counts.",
    ].join(" "),
  );
  process.exitCode = 2;
  process.exit();
}

const appleGenres = await fetchAppleGenres(
  targets.map((target) => target.appleId).filter(Boolean),
);
const musicBrainzGenres = await fetchMusicBrainzGenres(
  targets.map((target) => target.musicBrainzEntity).filter(Boolean),
);

let enriched = 0;
let appleMatched = 0;
let musicBrainzMatched = 0;

for (const target of targets) {
  const sources = [];
  const appleValues = appleGenres.get(target.appleId) ?? [];
  const musicBrainzValues =
    musicBrainzGenres.get(target.musicBrainzUrl) ?? [];
  if (appleValues.length) {
    appleMatched += 1;
    sources.push({
      source: "APPLE_MUSIC",
      source_url: target.appleUrl,
      values: appleValues,
    });
  }
  if (musicBrainzValues.length) {
    musicBrainzMatched += 1;
    sources.push({
      source: "MUSICBRAINZ",
      source_url: target.musicBrainzUrl,
      values: musicBrainzValues,
    });
  }
  const genres = uniqueGenres(sources.flatMap((source) => source.values));
  if (!genres.length) continue;

  target.release.genres = genres;
  target.release.genreSource =
    sources.length > 1
      ? "APPLE_MUSIC_AND_MUSICBRAINZ_EXACT"
      : sources[0].source === "APPLE_MUSIC"
        ? "APPLE_MUSIC_EXACT"
        : "MUSICBRAINZ_EXACT";
  target.release.metadataEvidence = {
    ...(target.release.metadataEvidence ?? {}),
    genres: {
      source: sources[0].source,
      source_entity_id:
        target.appleId ?? target.musicBrainzEntity?.id ?? null,
      source_url: sources[0].source_url,
      match_status: "EXACT",
      verified_at: verifiedAt,
      sources: sources.map((source) => ({
        ...source,
        verified_at: verifiedAt,
      })),
    },
  };
  enriched += 1;
}

let checkpointPath = null;
if (!dryRun && enriched > 0) {
  checkpointPath = await checkpointLibrary();
  await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
}

console.log(
  JSON.stringify({
    phase: "complete",
    enriched,
    appleMatched,
    musicBrainzMatched,
    unresolved: targets.length - enriched,
    checkpointCreated: Boolean(checkpointPath),
  }),
);
