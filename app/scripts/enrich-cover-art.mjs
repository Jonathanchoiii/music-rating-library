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
  : 4;
const batchPauseMs = concurrency === 1 ? 1_100 : 180;
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
  return release.externalLinks.find((link) => link.provider === provider)?.url;
}

function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
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
  const artistName = release.artists[0].split("/")[0].trim();
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
      artistKeys.some(
        (artistKey) =>
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

async function saveLibrary(releases) {
  await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
}

const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const targets = releases
  .filter((release) => force || !release.coverUrl)
  .slice(0, Number.isInteger(limit) ? limit : undefined);
const sourceCounts = {};
let matched = 0;
let failed = 0;

console.log(
  `Cover enrichment: ${targets.length} targets, ${concurrency} concurrent requests`,
);

for (let offset = 0; offset < targets.length; offset += concurrency) {
  const batch = targets.slice(offset, offset + concurrency);
  await Promise.all(
    batch.map(async (release) => {
      const cover = await findCover(release);
      if (!cover) {
        failed += 1;
        return;
      }
      release.coverUrl = cover.url;
      release.coverSource = cover.source;
      release.coverMatchedFrom = cover.matchedFrom;
      release.coverMatchedAt = new Date().toISOString();
      sourceCounts[cover.source] = (sourceCounts[cover.source] ?? 0) + 1;
      matched += 1;
    }),
  );

  const processed = Math.min(offset + batch.length, targets.length);
  if (processed % 40 === 0 || processed === targets.length) {
    await saveLibrary(releases);
    console.log(
      `Processed ${processed}/${targets.length} · matched ${matched} · unresolved ${failed}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, batchPauseMs));
}

await saveLibrary(releases);
console.log(
  JSON.stringify(
    {
      releases: releases.length,
      targets: targets.length,
      matched,
      unresolved: failed,
      sourceCounts,
      libraryPath,
    },
    null,
    2,
  ),
);
