function normalizeNeoDbUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    if (!(host === "neodb.social" || host.startsWith("neodb."))) return null;
    url.protocol = "https:";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function resolveNeoDbUrl(sourceUrl, fetcher) {
  const normalized = normalizeNeoDbUrl(sourceUrl);
  if (!normalized) return null;
  try {
    let response = await fetcher(normalized, {
      method: "HEAD",
      redirect: "follow",
      headers: { accept: "text/html" },
    });
    if (response.status === 405) {
      response = await fetcher(normalized, {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html" },
      });
    }
    return normalizeNeoDbUrl(response.url) ?? normalized;
  } catch {
    return normalized;
  }
}

async function canonicalizeNeoDbUrls(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const urls = [
    ...new Set((payload.urls ?? []).map(normalizeNeoDbUrl).filter(Boolean)),
  ].slice(0, 100);
  const fetcher = env.NEODB_FETCH ?? fetch;
  const canonicalUrls = {};
  for (let offset = 0; offset < urls.length; offset += 10) {
    const batch = urls.slice(offset, offset + 10);
    const results = await Promise.all(
      batch.map((url) => resolveNeoDbUrl(url, fetcher)),
    );
    batch.forEach((url, index) => {
      canonicalUrls[url] = results[index] ?? url;
    });
  }
  return Response.json(
    { canonicalUrls },
    { headers: { "cache-control": "no-store" } },
  );
}

function normalizedExternalReleaseType(value = "") {
  const normalized = String(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[._/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const matches = new Set();
  if (/(^|\W)single(\W|$)/i.test(normalized)) matches.add("SINGLE");
  if (/(^|\W)ep(\W|$)/i.test(normalized)) matches.add("EP");
  if (/(^|\W)(album|lp|long play)(\W|$)/i.test(normalized)) {
    matches.add("LP");
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function officialTitleSuffixType(value = "") {
  const title = String(value).trim();
  if (/(?:\s[-–—]\s*|\s*\()single\)?$/i.test(title)) return "SINGLE";
  if (/(?:\s[-–—]\s*|\s*\()ep\)?$/i.test(title)) return "EP";
  return null;
}

function plainText(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactProviderLink(release, provider) {
  return (release.externalLinks ?? []).find(
    (link) =>
      link?.provider === provider &&
      link?.status !== "REJECTED" &&
      typeof link?.url === "string",
  )?.url;
}

function musicBrainzTarget(value) {
  const match = String(value ?? "").match(
    /^https?:\/\/(?:www\.)?musicbrainz\.org\/(release-group|release)\/([0-9a-f-]{36})(?:[/?#]|$)/i,
  );
  return match ? { entity: match[1], id: match[2] } : null;
}

function discogsTarget(value) {
  const match = String(value ?? "").match(
    /^https?:\/\/(?:www\.)?discogs\.com\/(?:[^/]+\/)?(release|master)\/(\d+)(?:[/?#-]|$)/i,
  );
  return match ? { entity: match[1], id: match[2] } : null;
}

function appleMusicAlbumId(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "music.apple.com") return null;
    const pathId = url.pathname
      .split("/")
      .filter(Boolean)
      .reverse()
      .find((part) => /^\d+$/.test(part));
    return pathId ?? null;
  } catch {
    return null;
  }
}

async function fetchJson(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    redirect: "follow",
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": "RecordShelf/0.1 (personal music archive)",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) return null;
  return response.json();
}

async function evidenceFromMusicBrainz(release, fetcher, throttle) {
  const matchedFrom = exactProviderLink(release, "MUSICBRAINZ");
  const target = musicBrainzTarget(matchedFrom);
  if (!target) return null;
  await throttle();
  const endpoint = new URL(
    `https://musicbrainz.org/ws/2/${target.entity}/${target.id}`,
  );
  endpoint.searchParams.set("fmt", "json");
  if (target.entity === "release") {
    endpoint.searchParams.set("inc", "release-groups");
  }
  const payload = await fetchJson(fetcher, endpoint);
  const rawType =
    payload?.["primary-type"] ??
    payload?.["release-group"]?.["primary-type"];
  const releaseType = normalizedExternalReleaseType(rawType);
  return releaseType
    ? { source: "MUSICBRAINZ_EXACT", matchedFrom, rawType, releaseType }
    : null;
}

async function evidenceFromNeoDb(release, fetcher) {
  const matchedFrom = normalizeNeoDbUrl(exactProviderLink(release, "NEODB"));
  if (!matchedFrom) return null;
  const response = await fetcher(matchedFrom, {
    redirect: "follow",
    headers: {
      accept: "text/html",
      "user-agent": "RecordShelf/0.1 (personal music archive)",
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const rawType = plainText(
    html.match(/album type:\s*([\s\S]*?)<\/div>/i)?.[1] ?? "",
  );
  const releaseType = normalizedExternalReleaseType(rawType);
  return releaseType
    ? { source: "NEODB_EXACT", matchedFrom, rawType, releaseType }
    : null;
}

async function evidenceFromDiscogs(release, fetcher) {
  const matchedFrom = exactProviderLink(release, "DISCOGS");
  const target = discogsTarget(matchedFrom);
  if (!target) return null;
  let payload = await fetchJson(
    fetcher,
    `https://api.discogs.com/${
      target.entity === "master" ? "masters" : "releases"
    }/${target.id}`,
  );
  if (target.entity === "master" && payload?.main_release) {
    payload = await fetchJson(
      fetcher,
      `https://api.discogs.com/releases/${payload.main_release}`,
    );
  }
  const rawType = (payload?.formats ?? [])
    .flatMap((format) => [format.name, ...(format.descriptions ?? [])])
    .filter(Boolean)
    .join(" · ");
  const releaseType = normalizedExternalReleaseType(rawType);
  return releaseType
    ? { source: "DISCOGS_EXACT", matchedFrom, rawType, releaseType }
    : null;
}

async function evidenceFromAppleMusic(release, fetcher) {
  const matchedFrom = exactProviderLink(release, "APPLE_MUSIC");
  const albumId = appleMusicAlbumId(matchedFrom);
  if (!albumId) return null;
  const payload = await fetchJson(
    fetcher,
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(
      albumId,
    )}&entity=album`,
  );
  const album = payload?.results?.find(
    (item) => item.wrapperType === "collection",
  );
  const rawType = album?.collectionName ?? "";
  const releaseType = officialTitleSuffixType(rawType);
  return releaseType
    ? { source: "APPLE_MUSIC_EXACT", matchedFrom, rawType, releaseType }
    : null;
}

async function verifyOneReleaseType(release, fetcher, throttle) {
  const evidence = (
    await Promise.all(
      [
        evidenceFromMusicBrainz(release, fetcher, throttle),
        evidenceFromNeoDb(release, fetcher),
        evidenceFromDiscogs(release, fetcher),
        evidenceFromAppleMusic(release, fetcher),
      ].map(async (resolver) => {
        try {
          return await resolver;
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);
  const types = [...new Set(evidence.map((item) => item.releaseType))];
  if (types.length !== 1) {
    return {
      id: release.id,
      status: types.length > 1 ? "CONFLICT" : "UNRESOLVED",
      releaseType: "OTHER",
      evidence,
    };
  }
  return {
    id: release.id,
    status: "MATCHED",
    releaseType: types[0],
    source:
      evidence.length > 1
        ? "EXACT_SOURCES_AGREE"
        : evidence[0].source,
    matchedFrom: evidence.map((item) => item.matchedFrom),
    rawEvidence: evidence.map((item) => item.rawType),
    evidence,
  };
}

export async function verifyReleaseTypes(request, env = {}) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const releases = Array.isArray(payload.releases)
    ? payload.releases.slice(0, 12)
    : [];
  const fetcher = env.METADATA_FETCH ?? fetch;
  const delayMs = env.MUSICBRAINZ_DELAY_MS ?? 1_100;
  let nextMusicBrainzRequestAt = 0;
  const throttle = async () => {
    const waitMs = Math.max(0, nextMusicBrainzRequestAt - Date.now());
    if (waitMs) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    nextMusicBrainzRequestAt = Date.now() + delayMs;
  };
  const results = [];
  for (const release of releases) {
    if (!release?.id || !release?.title) continue;
    results.push(await verifyOneReleaseType(release, fetcher, throttle));
  }
  return Response.json(
    { results },
    { headers: { "cache-control": "no-store" } },
  );
}

function normalizeMusicBrainzText(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function validMusicBrainzId(value = "") {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value),
  );
}

function musicBrainzQueryPhrase(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f]/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/\s+/g, " ")
    .trim();
}

function artistAliasesFromPayload(payload) {
  return [
    {
      name: payload?.name ?? "",
      locale: "",
      type: "ARTIST_NAME",
    },
    ...(payload?.aliases ?? []).map((alias) => ({
      name: alias.name ?? alias["sort-name"] ?? "",
      locale: alias.locale ?? "",
      type: alias.type ?? "SEARCH_ALIAS",
    })),
  ].filter((alias) => alias.name);
}

function releaseGroupArtistCredits(group) {
  return (group?.["artist-credit"] ?? [])
    .map((credit) => ({
      id: credit?.artist?.id,
      name: credit?.name ?? credit?.artist?.name,
      disambiguation: credit?.artist?.disambiguation ?? "",
    }))
    .filter((artist) => validMusicBrainzId(artist.id) && artist.name);
}

async function lookupMusicBrainzArtist(
  musicBrainzMbid,
  fetcher,
  throttle,
) {
  await throttle();
  const endpoint = new URL(
    `https://musicbrainz.org/ws/2/artist/${musicBrainzMbid}`,
  );
  endpoint.searchParams.set("fmt", "json");
  endpoint.searchParams.set("inc", "aliases");
  return fetchJson(fetcher, endpoint);
}

async function browseMusicBrainzArtistReleaseGroups(
  musicBrainzMbid,
  fetcher,
  throttle,
) {
  await throttle();
  const endpoint = new URL(
    "https://musicbrainz.org/ws/2/release-group",
  );
  endpoint.searchParams.set("artist", musicBrainzMbid);
  endpoint.searchParams.set("release-group-status", "website-default");
  endpoint.searchParams.set("limit", "100");
  endpoint.searchParams.set("fmt", "json");
  return fetchJson(fetcher, endpoint);
}

async function searchMusicBrainzReleaseGroup(
  title,
  fetcher,
  throttle,
) {
  await throttle();
  const endpoint = new URL(
    "https://musicbrainz.org/ws/2/release-group",
  );
  endpoint.searchParams.set(
    "query",
    `releasegroup:"${musicBrainzQueryPhrase(title)}"`,
  );
  endpoint.searchParams.set("limit", "15");
  endpoint.searchParams.set("fmt", "json");
  return fetchJson(fetcher, endpoint);
}

function normalizedArtistInput(identity) {
  return {
    id: String(identity?.id ?? "").slice(0, 160),
    canonicalName: String(identity?.canonicalName ?? "").slice(0, 240),
    aliases: [
      ...new Set(
        (identity?.aliases ?? [])
          .map((alias) => String(alias?.name ?? alias).slice(0, 240))
          .filter(Boolean),
      ),
    ].slice(0, 24),
    releaseTitles: [
      ...new Set(
        (identity?.releaseTitles ?? [])
          .map((title) => String(title).slice(0, 300))
          .filter(Boolean),
      ),
    ].slice(0, 24),
    musicBrainzMbid: String(identity?.musicBrainzMbid ?? ""),
    fingerprint: String(identity?.fingerprint ?? "").slice(0, 120),
  };
}

async function verifyExistingMusicBrainzArtist(
  identity,
  fetcher,
  throttle,
  checkedAt,
) {
  const artist = await lookupMusicBrainzArtist(
    identity.musicBrainzMbid,
    fetcher,
    throttle,
  );
  if (!artist?.id) {
    return {
      id: identity.id,
      status: "UNAVAILABLE",
      checkedAt,
      fingerprint: identity.fingerprint,
    };
  }
  const releaseGroups = await browseMusicBrainzArtistReleaseGroups(
    identity.musicBrainzMbid,
    fetcher,
    throttle,
  );
  const localTitles = new Set(
    identity.releaseTitles.map(normalizeMusicBrainzText),
  );
  const matchedReleaseTitles = (releaseGroups?.["release-groups"] ?? [])
    .map((group) => group.title)
    .filter((title) => localTitles.has(normalizeMusicBrainzText(title)));
  const aliases = artistAliasesFromPayload(artist);
  const localNames = new Set(
    [identity.canonicalName, ...identity.aliases].map(
      normalizeMusicBrainzText,
    ),
  );
  const nameMatches = aliases.some((alias) =>
    localNames.has(normalizeMusicBrainzText(alias.name)),
  );
  const valid = nameMatches && matchedReleaseTitles.length > 0;
  return {
    id: identity.id,
    status: valid ? "VALID" : "NEEDS_REVIEW",
    musicBrainzMbid: identity.musicBrainzMbid,
    checkedAt,
    fingerprint: identity.fingerprint,
    aliases: valid ? aliases : [],
    evidence: {
      source: "MUSICBRAINZ_ARTIST_AND_RELEASE_GROUP",
      artistUrl: `https://musicbrainz.org/artist/${identity.musicBrainzMbid}`,
      matchedReleaseTitles,
      nameMatches,
      disambiguation: artist.disambiguation ?? "",
    },
    candidates: valid
      ? []
      : [
          {
            musicBrainzMbid: artist.id,
            name: artist.name,
            disambiguation: artist.disambiguation ?? "",
            matchedReleaseTitles,
          },
        ],
  };
}

async function findMusicBrainzArtistByReleaseEvidence(
  identity,
  fetcher,
  throttle,
  checkedAt,
) {
  const localNames = new Set(
    [identity.canonicalName, ...identity.aliases].map(
      normalizeMusicBrainzText,
    ),
  );
  const localTitles = new Set(
    identity.releaseTitles.map(normalizeMusicBrainzText),
  );
  const candidates = new Map();

  for (const title of identity.releaseTitles.slice(0, 3)) {
    const payload = await searchMusicBrainzReleaseGroup(
      title,
      fetcher,
      throttle,
    );
    for (const group of payload?.["release-groups"] ?? []) {
      if (!localTitles.has(normalizeMusicBrainzText(group.title))) {
        continue;
      }
      for (const artist of releaseGroupArtistCredits(group)) {
        if (!localNames.has(normalizeMusicBrainzText(artist.name))) {
          continue;
        }
        const current = candidates.get(artist.id) ?? {
          musicBrainzMbid: artist.id,
          name: artist.name,
          disambiguation: artist.disambiguation,
          matchedReleaseTitles: new Set(),
        };
        current.matchedReleaseTitles.add(group.title);
        candidates.set(artist.id, current);
      }
    }
    if (candidates.size === 1) break;
  }

  const serializedCandidates = [...candidates.values()].map((candidate) => ({
    ...candidate,
    matchedReleaseTitles: [...candidate.matchedReleaseTitles],
  }));
  if (serializedCandidates.length !== 1) {
    return {
      id: identity.id,
      status:
        serializedCandidates.length > 1 ? "AMBIGUOUS" : "UNRESOLVED",
      checkedAt,
      fingerprint: identity.fingerprint,
      candidates: serializedCandidates.slice(0, 5),
    };
  }

  const candidate = serializedCandidates[0];
  const artist = await lookupMusicBrainzArtist(
    candidate.musicBrainzMbid,
    fetcher,
    throttle,
  );
  if (!artist?.id) {
    return {
      id: identity.id,
      status: "UNAVAILABLE",
      checkedAt,
      fingerprint: identity.fingerprint,
      candidates: [candidate],
    };
  }
  return {
    id: identity.id,
    status: "MATCHED",
    musicBrainzMbid: candidate.musicBrainzMbid,
    checkedAt,
    fingerprint: identity.fingerprint,
    aliases: artistAliasesFromPayload(artist),
    evidence: {
      source: "MUSICBRAINZ_EXACT_RELEASE_GROUP",
      artistUrl: `https://musicbrainz.org/artist/${candidate.musicBrainzMbid}`,
      matchedReleaseTitles: candidate.matchedReleaseTitles,
      disambiguation: artist.disambiguation ?? "",
    },
    candidates: [],
  };
}

export async function verifyArtistIdentities(request, env = {}) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const identities = Array.isArray(payload.identities)
    ? payload.identities
        .slice(0, 5)
        .map(normalizedArtistInput)
        .filter(
          (identity) =>
            identity.id &&
            identity.canonicalName &&
            identity.releaseTitles.length,
        )
    : [];
  const fetcher = env.MUSICBRAINZ_FETCH ?? fetch;
  const delayMs = env.MUSICBRAINZ_DELAY_MS ?? 1_100;
  let nextMusicBrainzRequestAt = 0;
  const throttle = async () => {
    const waitMs = Math.max(0, nextMusicBrainzRequestAt - Date.now());
    if (waitMs) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    nextMusicBrainzRequestAt = Date.now() + delayMs;
  };
  const checkedAt = new Date().toISOString();
  const results = [];
  for (const identity of identities) {
    try {
      results.push(
        validMusicBrainzId(identity.musicBrainzMbid)
          ? await verifyExistingMusicBrainzArtist(
              identity,
              fetcher,
              throttle,
              checkedAt,
            )
          : await findMusicBrainzArtistByReleaseEvidence(
              identity,
              fetcher,
              throttle,
              checkedAt,
            ),
      );
    } catch {
      results.push({
        id: identity.id,
        status: "UNAVAILABLE",
        checkedAt,
        fingerprint: identity.fingerprint,
      });
    }
  }
  return Response.json(
    { results },
    { headers: { "cache-control": "no-store" } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === "/api/neodb/canonicalize" &&
      request.method === "POST"
    ) {
      return canonicalizeNeoDbUrls(request, env);
    }
    if (
      url.pathname === "/api/metadata/release-types" &&
      request.method === "POST"
    ) {
      return verifyReleaseTypes(request, env);
    }
    if (
      url.pathname === "/api/metadata/artist-identities" &&
      request.method === "POST"
    ) {
      return verifyArtistIdentities(request, env);
    }
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
