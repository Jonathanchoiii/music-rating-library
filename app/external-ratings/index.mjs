const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DOUBAN_CANDIDATES = 8;

const RATING_LINK_PROVIDERS = {
  AOTY: {
    label: "AOTY",
    hosts: new Set(["albumoftheyear.org", "www.albumoftheyear.org"]),
    pathname: /^\/album\/[^/]+\/?$/,
    fetchPolicy: "ON_DEMAND",
  },
  RATEYOURMUSIC: {
    label: "Rate Your Music",
    hosts: new Set(["rateyourmusic.com", "www.rateyourmusic.com"]),
    pathname: /^\/release\/(?:album|ep|single|comp|mixtape)\/[^/]+\/[^/]+\/?$/,
    fetchPolicy: "MANUAL_LINK_ONLY",
  },
  METACRITIC: {
    label: "Metacritic",
    hosts: new Set(["metacritic.com", "www.metacritic.com"]),
    pathname: /^\/music\/[^/]+\/[^/]+\/?$/,
    fetchPolicy: "ON_DEMAND",
  },
  RECORD_CLUB: {
    label: "Record Club",
    hosts: new Set(["record.club", "www.record.club"]),
    pathname: /^\/releases\/(?:albums|eps|singles)\/[^/]+\/?$/,
    fetchPolicy: "ON_DEMAND",
  },
};

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeIdentityText(value = "") {
  return decodeEntities(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function neodbAlbumId(value = "") {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLocaleLowerCase();
    if (host !== "neodb.social" && !host.startsWith("neodb.")) return null;
    return parsed.pathname.match(/^\/album\/([a-zA-Z0-9]+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeDoubanUrl(value = "") {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "music.douban.com") {
      return null;
    }
    const subjectId = parsed.pathname.match(/^\/subject\/(\d+)\/?$/)?.[1];
    return subjectId
      ? `https://music.douban.com/subject/${subjectId}/`
      : null;
  } catch {
    return null;
  }
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeEntities(
    html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
        "i",
      ),
    )?.[1] ??
      html.match(
        new RegExp(
          `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`,
          "i",
        ),
      )?.[1] ??
      "",
  ).trim();
}

function firstNumber(value) {
  const number = Number.parseFloat(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

export function normalizeExternalRatingLinks(values = []) {
  const byProvider = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const rawUrl = typeof value === "string" ? value : value?.url;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
      const providerEntry = Object.entries(RATING_LINK_PROVIDERS).find(
        ([, config]) =>
          config.hosts.has(parsed.hostname.toLocaleLowerCase()) &&
          config.pathname.test(parsed.pathname),
      );
      if (!providerEntry) continue;
      const [provider, config] = providerEntry;
      parsed.search = "";
      parsed.hash = "";
      byProvider.set(provider, {
        provider,
        providerLabel: config.label,
        url: parsed.toString(),
        addedAt: cleanText(value?.addedAt, 40) || new Date().toISOString(),
        fetchPolicy: config.fetchPolicy,
      });
    } catch {
      // Ignore malformed or unsupported user input.
    }
  }
  return [...byProvider.values()];
}

function stripHtml(value = "") {
  return decodeEntities(
    String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function isBlockedRatingPage(html = "", statusCode = 200) {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) return true;
  const source = String(html);
  return /cf-browser-verification|challenge-platform|just a moment|attention required|access denied/i.test(
    source,
  );
}

function aotyScoreValue(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = String(html).match(
    new RegExp(
      `class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)</div>`,
      "i",
    ),
  )?.[1];
  if (!block) return null;
  const text = stripHtml(block).trim();
  if (!text || /^nr$/i.test(text)) return null;
  const score = firstNumber(text.match(/\d{1,3}/)?.[0]);
  return score != null && score >= 0 && score <= 100 ? score : null;
}

export function parseAotyMusicRating(html, sourceUrl = "") {
  const source = String(html ?? "");
  const criticScore = aotyScoreValue(source, "albumCriticScore");
  const userScore = aotyScoreValue(source, "albumUserScore");
  const criticCount = firstNumber(
    stripHtml(source).match(/([\d,]+)\s*Critic\s+Ratings?/i)?.[1],
  );
  const userCount = firstNumber(
    stripHtml(source).match(/([\d,]+)\s*User\s+Ratings?/i)?.[1],
  );
  const titleBlock = stripHtml(
    source.match(/class=["'][^"']*\balbumTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      "",
  );
  const artistBlock = stripHtml(
    source.match(
      /class=["'][^"']*\bartist\b[^"']*["'][^>]*>[\s\S]*?itemprop=["']name["'][^>]*>([\s\S]*?)<\/(?:span|a|div)/i,
    )?.[1] ??
      source.match(/itemprop=["']byArtist["'][\s\S]*?itemprop=["']name["'][^>]*>([\s\S]*?)</i)?.[1] ??
      "",
  );
  const ogTitle = metaContent(source, "og:title")
    .replace(/\s*\|\s*Album of the Year.*$/i, "")
    .trim();
  let title = titleBlock;
  let artist = artistBlock;
  if (!title && ogTitle.includes(" - ")) {
    const parts = ogTitle.split(" - ");
    artist = artist || parts.shift().trim();
    title = parts.join(" - ").trim();
  } else if (!title) {
    title = ogTitle;
  }
  let url = null;
  try {
    url =
      normalizeExternalRatingLinks([{ url: sourceUrl }]).find(
        (link) => link.provider === "AOTY",
      )?.url ?? null;
  } catch {
    url = null;
  }
  const primaryScore = userScore ?? criticScore;
  return {
    provider: "AOTY",
    providerLabel: "AOTY",
    score: primaryScore,
    criticScore,
    userScore,
    scale: 100,
    ratingCount: Number.isInteger(userCount)
      ? userCount
      : Number.isInteger(criticCount)
        ? criticCount
        : null,
    criticCount: Number.isInteger(criticCount) ? criticCount : null,
    userCount: Number.isInteger(userCount) ? userCount : null,
    title,
    artist,
    url,
  };
}

export function parseMetacriticMusicRating(html, sourceUrl = "") {
  const source = String(html ?? "");
  const text = stripHtml(source);
  const metascoreContext = text.match(/Metascore\s+(\d{1,3})(?:\s|$)/i);
  const score = firstNumber(metascoreContext?.[1]);
  const ratingCount = firstNumber(
    text.match(/based on\s+([\d,]+)\s+Critic Reviews?/i)?.[1],
  );
  const title =
    stripHtml(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") ||
    metaContent(source, "og:title")
      .replace(/\s+(?:Reviews(?: and Tracks)?|- Metacritic).*$/i, "")
      .trim();
  const artist = stripHtml(
    source.match(/\bby\s*<[^>]+>([\s\S]*?)<\/[^>]+>/i)?.[1] ?? "",
  );
  let url = null;
  try {
    const normalized = normalizeExternalRatingLinks([{ url: sourceUrl }]);
    url = normalized.find((link) => link.provider === "METACRITIC")?.url ?? null;
  } catch {
    url = null;
  }
  return {
    provider: "METACRITIC",
    providerLabel: "Metacritic",
    score: score != null && score >= 0 && score <= 100 ? score : null,
    scale: 100,
    ratingCount: Number.isInteger(ratingCount) ? ratingCount : null,
    title,
    artist,
    url,
  };
}

function recordClubReleaseDate(value) {
  if (!value || !Number.isInteger(value.year)) return "";
  const month = Number.isInteger(value.month) ? value.month + 1 : null;
  const day = Number.isInteger(value.day) ? value.day : null;
  return [
    String(value.year).padStart(4, "0"),
    month == null ? null : String(month).padStart(2, "0"),
    day == null ? null : String(day).padStart(2, "0"),
  ]
    .filter(Boolean)
    .join("-");
}

export function parseRecordClubRating(payload, sourceUrl = "") {
  const data = payload?.success === false ? null : payload?.data ?? payload;
  const rawScore = firstNumber(data?.stats?.rating?.average);
  const rawRatingCount = firstNumber(data?.stats?.rating?.count);
  const rawListenerCount = firstNumber(data?.stats?.listens);
  const artists = (Array.isArray(data?.artists) ? data.artists : [])
    .map((entry) => cleanText(entry?.name || entry?.artist?.name))
    .filter(Boolean);
  const normalizedLink = normalizeExternalRatingLinks([{ url: sourceUrl }]).find(
    (link) => link.provider === "RECORD_CLUB",
  );
  return {
    provider: "RECORD_CLUB",
    providerLabel: "Record Club",
    score:
      rawScore != null && rawScore >= 0 && rawScore <= 5
        ? Number(rawScore.toFixed(1))
        : null,
    scale: 5,
    ratingCount: Number.isInteger(rawRatingCount) ? rawRatingCount : null,
    listenerCount: Number.isInteger(rawListenerCount) ? rawListenerCount : null,
    title: cleanText(data?.title),
    artist: artists.join(" / "),
    releaseDate: recordClubReleaseDate(data?.releaseDate),
    url: normalizedLink?.url ?? null,
  };
}

export function parseDoubanMusicRating(html, sourceUrl = "") {
  const source = String(html ?? "");
  const score = firstNumber(
    source.match(
      /<strong[^>]*\bproperty=["']v:average["'][^>]*>\s*([\d.]+)/i,
    )?.[1],
  );
  const ratingCount = firstNumber(
    source.match(
      /<span[^>]*\bproperty=["']v:votes["'][^>]*>\s*([\d,]+)/i,
    )?.[1],
  );
  const title = metaContent(source, "og:title").replace(/\s*\(豆瓣\)\s*$/i, "");
  const artist = metaContent(source, "music:musician");
  const releaseDate = decodeEntities(
    source.match(
      /<span[^>]*class=["'][^"']*pl[^"']*["'][^>]*>\s*发行时间:\s*<\/span>\s*&nbsp;\s*([^<\r\n]+)/i,
    )?.[1] ?? "",
  ).trim();
  return {
    provider: "DOUBAN",
    providerLabel: "豆瓣",
    score,
    scale: 10,
    ratingCount: Number.isInteger(ratingCount) ? ratingCount : null,
    title,
    artist,
    releaseDate,
    url: normalizeDoubanUrl(sourceUrl),
  };
}

function publicReleaseIdentity(release = {}) {
  const titleVariants = [
    release.title,
    release.translatedTitle,
    ...(Array.isArray(release.titleAliases) ? release.titleAliases : []),
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .slice(0, 20);
  const artists = (Array.isArray(release.artists) ? release.artists : [])
    .flatMap((value) => cleanText(value).split(/\s*(?:\/|／|&|＆|,|，|;|；|\bfeat\.?\b|\bfeaturing\b|\bx\b)\s*/i))
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 20);
  const neodbUrl = (Array.isArray(release.externalLinks)
    ? release.externalLinks
    : []
  ).find(
    (link) =>
      link?.provider === "NEODB" &&
      ["CONFIRMED", "AUTO_CONFIRMED"].includes(link?.status),
  )?.url;
  return {
    id: cleanText(release.id, 200),
    titleVariants,
    artists,
    releaseDate: cleanText(release.releaseDate, 20),
    neodbUrl: cleanText(neodbUrl, 500),
  };
}

async function fetchWithTimeout(fetcher, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal,
      headers: {
        accept: options.accept ?? "text/html",
        "user-agent": "RecordShelf/0.1 (personal music archive)",
        ...(options.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function candidateConfidence(candidate, identity) {
  const titleKeys = new Set(identity.titleVariants.map(normalizeIdentityText));
  const titleMatches = titleKeys.has(normalizeIdentityText(candidate.title));
  if (!titleMatches) return -1;
  const artistKeys = identity.artists.map(normalizeIdentityText).filter(Boolean);
  const candidateArtistKey = normalizeIdentityText(candidate.artist);
  const artistMatches = artistKeys.some(
    (artistKey) =>
      artistKey === candidateArtistKey ||
      candidateArtistKey.includes(artistKey) ||
      artistKey.includes(candidateArtistKey),
  );
  const exactDate =
    identity.releaseDate && candidate.releaseDate === identity.releaseDate;
  const sameYear =
    identity.releaseDate &&
    candidate.releaseDate &&
    identity.releaseDate.slice(0, 4) === candidate.releaseDate.slice(0, 4);
  if (!artistMatches && !exactDate) return -1;
  return 4 + (artistMatches ? 4 : 0) + (exactDate ? 5 : sameYear ? 1 : 0);
}

async function fetchDoubanCandidate(fetcher, url) {
  try {
    const response = await fetchWithTimeout(fetcher, url);
    if (!response.ok) return null;
    const parsed = parseDoubanMusicRating(await response.text(), response.url);
    return parsed.score != null && parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchMetacriticRating(fetcher, link) {
  try {
    const response = await fetchWithTimeout(fetcher, link.url);
    const html = await response.text();
    if (!response.ok || isBlockedRatingPage(html, response.status)) {
      return { provider: "METACRITIC", blocked: true };
    }
    const parsed = parseMetacriticMusicRating(html, response.url || link.url);
    return parsed.score != null && parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchAotyRating(fetcher, link) {
  try {
    const response = await fetchWithTimeout(fetcher, link.url);
    const html = await response.text();
    if (!response.ok || isBlockedRatingPage(html, response.status)) {
      return { provider: "AOTY", blocked: true };
    }
    const parsed = parseAotyMusicRating(html, response.url || link.url);
    return parsed.score != null && parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchRecordClubRating(fetcher, link) {
  try {
    const parsedUrl = new URL(link.url);
    const apiUrl = new URL(parsedUrl.pathname, "https://api.record.club");
    const response = await fetchWithTimeout(fetcher, apiUrl, {
      accept: "application/json",
    });
    if (!response.ok) {
      return {
        provider: "RECORD_CLUB",
        blocked: [403, 429, 503].includes(response.status),
      };
    }
    const parsed = parseRecordClubRating(await response.json(), link.url);
    return parsed.score != null && parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

function mergeExternalRatingSources(previousSources = [], freshSources = [], links = []) {
  const linkProviders = new Set(links.map((link) => link.provider));
  const freshByProvider = new Map(
    freshSources
      .filter((source) => source?.provider && !source.blocked)
      .map((source) => [source.provider, source]),
  );
  const previousByProvider = new Map(
    previousSources
      .filter((source) => source?.provider)
      .map((source) => [source.provider, source]),
  );
  const providers = [
    "DOUBAN",
    ...Object.keys(RATING_LINK_PROVIDERS),
    ...previousByProvider.keys(),
    ...freshByProvider.keys(),
  ];
  const merged = [];
  const seen = new Set();
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    if (freshByProvider.has(provider)) {
      merged.push(freshByProvider.get(provider));
      continue;
    }
    const previous = previousByProvider.get(provider);
    if (!previous) continue;
    if (provider === "DOUBAN" || linkProviders.has(provider)) {
      merged.push(previous);
    }
  }
  return merged;
}

export async function refreshExternalRatings(release, options = {}) {
  const identity = publicReleaseIdentity(release);
  const albumId = neodbAlbumId(identity.neodbUrl);
  const previousSources = Array.isArray(release?.externalRatings?.sources)
    ? release.externalRatings.sources
    : [];
  const links = normalizeExternalRatingLinks(
    release?.ratingLinks ?? release?.externalRatings?.links ?? [],
  );
  if (!albumId && !links.length) {
    const error = new Error("NEODB_LINK_REQUIRED");
    error.code = "NEODB_LINK_REQUIRED";
    error.statusCode = 400;
    throw error;
  }
  const fetcher = options.fetchImpl ?? fetch;
  let catalog = { external_resources: [] };
  if (albumId) {
    try {
      const catalogResponse = await fetchWithTimeout(
        fetcher,
        `https://neodb.social/api/album/${encodeURIComponent(albumId)}`,
        { accept: "application/json" },
      );
      if (!catalogResponse.ok && !links.length) {
        const error = new Error("NEODB_CATALOG_UNAVAILABLE");
        error.code = "NEODB_CATALOG_UNAVAILABLE";
        error.statusCode = 502;
        throw error;
      }
      if (catalogResponse.ok) catalog = await catalogResponse.json();
    } catch (cause) {
      if (links.length) {
        catalog = { external_resources: [] };
      } else if (cause?.code === "NEODB_CATALOG_UNAVAILABLE") {
        throw cause;
      } else {
        const error = new Error("NEODB_CATALOG_UNAVAILABLE");
        error.code = "NEODB_CATALOG_UNAVAILABLE";
        error.statusCode = 502;
        throw error;
      }
    }
  }
  const doubanUrls = [
    ...new Set(
      (catalog.external_resources ?? [])
        .map((resource) => normalizeDoubanUrl(resource?.url))
        .filter(Boolean),
    ),
  ].slice(0, MAX_DOUBAN_CANDIDATES);
  const checkedAt = new Date().toISOString();
  const doubanCandidates = (
    await Promise.all(doubanUrls.map((url) => fetchDoubanCandidate(fetcher, url)))
  ).filter(Boolean);
  const canonicalCandidates = [
    ...new Map(doubanCandidates.map((candidate) => [candidate.url, candidate])).values(),
  ];
  const best = canonicalCandidates
    .map((candidate) => ({
      candidate,
      confidence: candidateConfidence(candidate, identity),
    }))
    .filter((entry) => entry.confidence >= 0)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        (right.candidate.ratingCount ?? 0) - (left.candidate.ratingCount ?? 0),
    )[0]?.candidate;

  const linkedFetches = await Promise.all(
    links.map(async (link) => {
      if (link.provider === "METACRITIC") return fetchMetacriticRating(fetcher, link);
      if (link.provider === "RECORD_CLUB") return fetchRecordClubRating(fetcher, link);
      if (link.provider === "AOTY") return fetchAotyRating(fetcher, link);
      return null;
    }),
  );
  const blockedProviders = [
    ...new Set(
      linkedFetches
        .filter((entry) => entry?.blocked && entry.provider)
        .map((entry) => entry.provider),
    ),
  ];
  const linkedSources = linkedFetches
    .filter((source) => source && !source.blocked && source.score != null && source.url)
    .map((source) => ({
      ...source,
      checkedAt,
      matchedVia: "USER_CONFIRMED_LINK",
    }));
  const freshSources = [
    ...(best
      ? [
          {
            provider: best.provider,
            providerLabel: best.providerLabel,
            score: best.score,
            scale: best.scale,
            ratingCount: best.ratingCount,
            url: best.url,
            checkedAt,
            matchedVia: "NEODB_EXTERNAL_RESOURCE",
          },
        ]
      : []),
    ...linkedSources,
  ];
  const sources = mergeExternalRatingSources(previousSources, freshSources, links);
  const retainedProviders = new Set(
    sources
      .filter((source) => !freshSources.some((fresh) => fresh.provider === source.provider))
      .map((source) => source.provider),
  );

  return {
    version: 1,
    status: sources.length ? "SUCCESS" : "NO_EXACT_RATING",
    checkedAt,
    blockedProviders,
    links: links.map((link) => ({
      ...link,
      status: sources.some((source) => source.provider === link.provider)
        ? retainedProviders.has(link.provider)
          ? blockedProviders.includes(link.provider)
            ? "SCORE_BLOCKED"
            : "SCORE_RETAINED"
          : "SCORE_UPDATED"
        : link.fetchPolicy === "MANUAL_LINK_ONLY"
          ? "LINK_SAVED"
          : blockedProviders.includes(link.provider)
            ? "SCORE_BLOCKED"
            : "NO_SCORE_FOUND",
      checkedAt,
    })),
    sources,
  };
}

function json(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

export async function handleExternalRatingsRequest(
  request,
  response,
  options = {},
) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname !== "/api/external-ratings/refresh") return false;
  if (request.method !== "POST") {
    json(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64_000) throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { statusCode: 413 });
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const externalRatings = await refreshExternalRatings(payload.release, options);
    json(response, 200, { externalRatings });
  } catch (error) {
    const safeErrors = new Set([
      "NEODB_LINK_REQUIRED",
      "NEODB_CATALOG_UNAVAILABLE",
      "PAYLOAD_TOO_LARGE",
    ]);
    json(response, error?.statusCode ?? 502, {
      error: safeErrors.has(error?.code ?? error?.message)
        ? error.code ?? error.message
        : "EXTERNAL_RATINGS_UNAVAILABLE",
    });
  }
  return true;
}
