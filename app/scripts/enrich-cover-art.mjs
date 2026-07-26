import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_LIBRARY_PATH = path.resolve(
  import.meta.dirname,
  "../.private/neodb-library.local.json",
);
const DEFAULT_COVER_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../.private/covers",
);
const PRIVATE_COVER_ROUTE = "/private-covers";

function supportCoverDirectory() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "covers",
  );
}
const requestTimeoutMs = 15_000;
const userAgent = "RecordShelf/0.1 (local personal music archive)";

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
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
  return (release.externalLinks ?? []).find(
    (link) => link.provider === provider,
  )?.url;
}

function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function extensionForContentType(contentType = "") {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

function isRemoteCoverUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ""));
}

function isLocalCoverUrl(value) {
  return String(value ?? "").startsWith(`${PRIVATE_COVER_ROUTE}/`);
}

function localCoverFileName(releaseId, extension = "jpg") {
  const safeId = String(releaseId).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${safeId}.${extension}`;
}

async function coverFromNeoDb(release) {
  const url = linkFor(release, "NEODB");
  if (!url) return null;
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "text/html" },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const match =
    html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    );
  return match?.[1]
    ? { url: decodeHtml(match[1]), source: "NEODB_OG", matchedFrom: url }
    : null;
}

async function coverFromAppleMusic(release) {
  const url = linkFor(release, "APPLE_MUSIC");
  const id = url?.match(/\/album\/(?:[^/]+\/)?(\d+)(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  const response = await fetchWithTimeout(
    `https://itunes.apple.com/lookup?id=${id}&entity=album`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const result = (await response.json()).results?.find(
    (item) => item.wrapperType === "collection",
  );
  const artwork = result?.artworkUrl100;
  if (!artwork) return null;
  return {
    url: artwork.replace(/\/\d+x\d+[^/]*\.(jpg|png)$/i, "/600x600bb.$1"),
    source: "APPLE_LOOKUP",
    matchedFrom: url,
  };
}

async function coverFromSpotify(release) {
  const url = linkFor(release, "SPOTIFY");
  if (!url) return null;
  const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await fetchWithTimeout(endpoint, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const result = await response.json();
  return result.thumbnail_url
    ? {
        url: result.thumbnail_url,
        source: "SPOTIFY_OEMBED",
        matchedFrom: url,
      }
    : null;
}

async function coverFromMusicBrainz(release) {
  const url = linkFor(release, "MUSICBRAINZ");
  const match = url?.match(
    /musicbrainz\.org\/(release-group|release)\/([0-9a-f-]{36})/i,
  );
  if (!match) return null;
  const endpoint = `https://coverartarchive.org/${match[1]}/${match[2]}/front-500`;
  const response = await fetchWithTimeout(endpoint, {
    headers: { Accept: "image/*" },
  });
  if (!response.ok) return null;
  await response.body?.cancel();
  return {
    url: response.url,
    source: "COVER_ART_ARCHIVE",
    matchedFrom: url,
  };
}

async function coverFromMusicBrainzSearch(release) {
  const artistName = (release.artists?.[0] ?? "").split("/")[0].trim();
  if (!artistName || !release.title) return null;
  const endpoint = new URL("https://musicbrainz.org/ws/2/release-group/");
  endpoint.searchParams.set(
    "query",
    `releasegroup:"${release.title.replaceAll('"', '\\"')}" AND artist:"${artistName.replaceAll('"', '\\"')}"`,
  );
  endpoint.searchParams.set("fmt", "json");
  endpoint.searchParams.set("limit", "5");
  const response = await fetchWithTimeout(endpoint, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const titleKey = normalizeMatchText(release.title);
  const artistKeys = release.artists[0]
    .split("/")
    .map(normalizeMatchText)
    .filter(Boolean);
  const result = (await response.json())["release-groups"]?.find((item) => {
    const resultTitle = normalizeMatchText(item.title);
    const resultArtists = (item["artist-credit"] ?? [])
      .map((credit) => normalizeMatchText(credit.artist?.name))
      .filter(Boolean);
    return (
      resultTitle === titleKey &&
      artistKeys.some((artistKey) =>
        resultArtists.some(
          (resultArtist) =>
            resultArtist.includes(artistKey) ||
            artistKey.includes(resultArtist),
        ),
      )
    );
  });
  if (!result?.id) return null;
  const coverEndpoint = `https://coverartarchive.org/release-group/${result.id}/front-500`;
  const coverResponse = await fetchWithTimeout(coverEndpoint, {
    headers: { Accept: "image/*" },
  });
  if (!coverResponse.ok) return null;
  await coverResponse.body?.cancel();
  return {
    url: coverResponse.url,
    source: "MUSICBRAINZ_PRECISE_SEARCH",
    matchedFrom: `https://musicbrainz.org/release-group/${result.id}`,
  };
}

async function findCover(release) {
  const resolvers = [
    coverFromAppleMusic,
    coverFromSpotify,
    coverFromNeoDb,
    coverFromMusicBrainz,
    coverFromMusicBrainzSearch,
  ];
  for (const resolver of resolvers) {
    try {
      const result = await resolver(release);
      if (result?.url) return result;
    } catch {
      // A failed provider should not stop the remaining exact-link fallbacks.
    }
  }
  return null;
}

async function cacheCoverLocally(
  release,
  remoteUrl,
  {
    coverDirectory = DEFAULT_COVER_DIRECTORY,
  } = {},
) {
  if (!remoteUrl || !isRemoteCoverUrl(remoteUrl)) return null;
  await fs.mkdir(coverDirectory, { recursive: true });
  const response = await fetchWithTimeout(remoteUrl, {
    headers: { Accept: "image/*" },
  });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;
  const extension = extensionForContentType(contentType);
  const fileName = localCoverFileName(release.id, extension);
  const filePath = path.join(coverDirectory, fileName);
  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()), {
    mode: 0o600,
  });
  return `${PRIVATE_COVER_ROUTE}/${fileName}`;
}

async function localCoverExists(
  coverUrl,
  coverDirectory = DEFAULT_COVER_DIRECTORY,
) {
  if (!isLocalCoverUrl(coverUrl)) return false;
  const fileName = coverUrl.slice(`${PRIVATE_COVER_ROUTE}/`.length);
  if (!fileName || fileName.includes("/") || fileName.includes("..")) {
    return false;
  }
  try {
    await fs.access(path.join(coverDirectory, fileName));
    return true;
  } catch {
    return false;
  }
}

function needsCoverWork(release, { force = false, cacheLocal = true } = {}) {
  if (force) return true;
  if (!release.coverUrl) return true;
  if (!cacheLocal) return false;
  if (isRemoteCoverUrl(release.coverUrl)) return true;
  if (isLocalCoverUrl(release.coverUrl)) return "check-local";
  return false;
}

export async function runCoverEnrichment({
  libraryPath = DEFAULT_LIBRARY_PATH,
  coverDirectory = DEFAULT_COVER_DIRECTORY,
  force = false,
  cacheLocal = true,
  limit = null,
  concurrency = 4,
  releaseIds = null,
  onProgress = null,
} = {}) {
  const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
  const releaseIdSet = releaseIds?.length ? new Set(releaseIds) : null;
  const batchPauseMs = concurrency === 1 ? 1_100 : 180;
  const candidates = [];
  for (const release of releases) {
    if (releaseIdSet && !releaseIdSet.has(release.id)) continue;
    const need = needsCoverWork(release, { force, cacheLocal });
    if (!need) continue;
    if (need === "check-local") {
      if (await localCoverExists(release.coverUrl, coverDirectory)) continue;
    }
    candidates.push(release);
  }
  const targets = candidates.slice(
    0,
    Number.isInteger(limit) ? limit : undefined,
  );
  const sourceCounts = {};
  let matched = 0;
  let cached = 0;
  let failed = 0;

  async function saveLibrary() {
    await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
  }

  for (let offset = 0; offset < targets.length; offset += concurrency) {
    const batch = targets.slice(offset, offset + concurrency);
    await Promise.all(
      batch.map(async (release) => {
        let remoteUrl = isRemoteCoverUrl(release.coverUrl)
          ? release.coverUrl
          : null;
        let source = release.coverSource ?? null;
        let matchedFrom = release.coverMatchedFrom ?? null;

        if (!remoteUrl || force) {
          const cover = await findCover(release);
          if (!cover) {
            if (!remoteUrl) {
              failed += 1;
              return;
            }
          } else {
            remoteUrl = cover.url;
            source = cover.source;
            matchedFrom = cover.matchedFrom;
            matched += 1;
            sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
          }
        } else {
          matched += 1;
          sourceCounts[source ?? "EXISTING_REMOTE"] =
            (sourceCounts[source ?? "EXISTING_REMOTE"] ?? 0) + 1;
        }

        if (cacheLocal && remoteUrl) {
          try {
            const localUrl = await cacheCoverLocally(release, remoteUrl, {
              coverDirectory,
            });
            if (localUrl) {
              release.coverUrl = localUrl;
              release.coverRemoteUrl = remoteUrl;
              release.coverSource = source ?? release.coverSource ?? null;
              release.coverMatchedFrom =
                matchedFrom ?? release.coverMatchedFrom ?? null;
              release.coverMatchedAt = new Date().toISOString();
              cached += 1;
              return;
            }
          } catch {
            // Fall back to remote URL when local caching fails.
          }
        }

        release.coverUrl = remoteUrl;
        release.coverSource = source ?? release.coverSource ?? null;
        release.coverMatchedFrom =
          matchedFrom ?? release.coverMatchedFrom ?? null;
        release.coverMatchedAt = new Date().toISOString();
      }),
    );

    const processed = Math.min(offset + batch.length, targets.length);
    if (processed % 40 === 0 || processed === targets.length) {
      await saveLibrary();
      onProgress?.({
        processed,
        targets: targets.length,
        matched,
        cached,
        unresolved: failed,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, batchPauseMs));
  }

  await saveLibrary();
  return {
    releases: releases.length,
    targets: targets.length,
    matched,
    cached,
    unresolved: failed,
    sourceCounts,
    libraryPath,
    coverDirectory,
  };
}

export function getPrivateCoverDirectory() {
  if (process.env.RECORDSHELF_COVER_DIRECTORY) {
    return path.resolve(process.env.RECORDSHELF_COVER_DIRECTORY);
  }
  // Packaged Electron cannot write into asar/resources; cache new covers here.
  if (process.versions?.electron) {
    return supportCoverDirectory();
  }
  return DEFAULT_COVER_DIRECTORY;
}

export function getBundledPrivateCoverDirectory() {
  if (process.env.RECORDSHELF_BUNDLED_COVER_DIRECTORY) {
    return path.resolve(process.env.RECORDSHELF_BUNDLED_COVER_DIRECTORY);
  }
  if (process.versions?.electron && process.resourcesPath) {
    return path.join(process.resourcesPath, "covers");
  }
  return null;
}

export function getPrivateCoverRoutePrefix() {
  return PRIVATE_COVER_ROUTE;
}

async function main() {
  const libraryPath =
    process.argv.find((argument) => argument.endsWith(".json")) ??
    DEFAULT_LIBRARY_PATH;
  const force = process.argv.includes("--force");
  const cacheLocal = !process.argv.includes("--no-cache-local");
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
    : 4;

  console.log(
    `Cover enrichment: cacheLocal=${cacheLocal}, concurrency=${concurrency}`,
  );
  const result = await runCoverEnrichment({
    libraryPath,
    force,
    cacheLocal,
    limit,
    concurrency,
    onProgress: ({ processed, targets, matched, cached, unresolved }) => {
      console.log(
        `Processed ${processed}/${targets} · matched ${matched} · cached ${cached} · unresolved ${unresolved}`,
      );
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
