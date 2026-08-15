import Papa from "papaparse";
import {
  getDatePrecision,
  inferReleaseTypeFromOfficialTitle,
  normalizeExternalReleaseType,
  normalizeSupportedReleaseUrl,
  normalizeText,
  sortListeningEntriesNewestFirst,
} from "./music.js";
import { notifySharedLocalStateChanged } from "./sharedLocalState.js";
import {
  NEODB_OAUTH_CLIENT_KEY,
  NEODB_SYNC_STATE_KEY,
} from "./sharedStorageKeys.js";

export const NEODB_ORIGIN = "https://neodb.social";
export { NEODB_SYNC_STATE_KEY, NEODB_OAUTH_CLIENT_KEY };
export const NEODB_OAUTH_PENDING_KEY = "recordshelf-neodb-oauth-pending-v1";
export const NEODB_ACCESS_TOKEN_KEY = "recordshelf-neodb-access-token-v1";

const PAGE_SIZE = 100;
const KNOWN_MARK_BATCH_SIZE = 20;
const KNOWN_MARK_AUDIT_CONCURRENCY = 6;
const SHELF_TYPES = ["complete", "progress", "wishlist", "dropped"];
const SYNC_SCHEMA_VERSION = 2;
const REMOVAL_EVIDENCE_VERSION = 2;
const TYPE_VERIFICATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DAILY_CANONICAL_AUDIT_SIZE = 12;
const NEODB_SNAPSHOT_COLUMNS = [
  "title",
  "info",
  "links",
  "timestamp",
  "status",
  "rating",
  "comment",
  "tags",
  "source_item_id",
  "release_type",
  "release_date",
  "translated_title",
  "content_hash",
];
const METADATA_FIELDS = [
  "title",
  "translatedTitle",
  "titleAliases",
  "titleSource",
  "titleMatchedFrom",
  "titleMatchedAt",
  "neodbSourceTitle",
  "neodbSourceTitleUrl",
  "neodbSourceTitleUpdatedAt",
  "artists",
  "releaseType",
  "releaseDate",
  "releaseDatePrecision",
  "releaseDateCheckedAt",
  "genres",
  "styles",
  "catalogLanguages",
  "editionTypes",
  "releaseCountries",
  "labels",
  "mediaFormats",
  "genreSource",
  "styleSource",
  "catalogLanguageSource",
  "editionTypeSource",
  "releaseCountrySource",
  "labelSource",
  "mediaFormatSource",
  "metadataEvidence",
  "coverUrl",
  "coverRemoteUrl",
  "coverSource",
  "coverMatchedFrom",
  "coverMatchedAt",
  "motionArtwork",
  "isPrivate",
  "externalLinks",
  "markStatus",
  "tags",
  "releaseTypeSource",
  "releaseTypeMatchedFrom",
  "releaseTypeEvidence",
  "releaseTypeMatchedAt",
  "releaseTypeUserConfirmed",
  "neodbSourceType",
  "typeVerificationInputFingerprint",
  "neodbPlatformLinksCheckedAt",
  "albumIntroduction",
  "externalRatings",
  "tracklist",
];

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function jsonHash(value) {
  return stableHash(JSON.stringify(value));
}

function sourceItemIdFromUrl(url) {
  if (!url) return null;
  try {
    return (
      new URL(url, NEODB_ORIGIN).pathname.split("/").filter(Boolean).at(-1) ??
      null
    );
  } catch {
    return null;
  }
}

function normalizedNeoDbUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url), NEODB_ORIGIN);
    const host = parsed.hostname.toLocaleLowerCase();
    if (!(host === "neodb.social" || host.startsWith("neodb."))) return null;
    parsed.protocol = "https:";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function catalogUrlFromItem(item) {
  if (!item) return null;
  for (const value of [item.id, item.url]) {
    const normalized = normalizedNeoDbUrl(value);
    if (normalized) return normalized;
  }
  const uuid = String(item.uuid ?? "").trim();
  if (!uuid) return null;
  const category = String(item.category ?? "").toLocaleLowerCase();
  const type = String(item.type ?? "").toLocaleLowerCase();
  if (category && category !== "music" && type !== "album") return null;
  return `${NEODB_ORIGIN}/album/${uuid}`;
}

export function buildNeoDbCanonicalAliases(releases = []) {
  const aliases = new Map();
  const rememberAlias = (alias, canonicalUrl) => {
    const normalizedAlias = normalizedNeoDbUrl(alias);
    if (!normalizedAlias || !canonicalUrl) return;
    const existing = aliases.get(normalizedAlias);
    if (
      !existing ||
      existing === normalizedAlias ||
      canonicalUrl !== normalizedAlias
    ) {
      aliases.set(normalizedAlias, canonicalUrl);
    }
    const aliasId = sourceItemIdFromUrl(normalizedAlias);
    if (!aliasId) return;
    const existingById = aliases.get(aliasId);
    if (!existingById || existingById === normalizedAlias) {
      aliases.set(aliasId, canonicalUrl);
    }
  };
  for (const release of releases) {
    for (const link of release.externalLinks ?? []) {
      if (link.provider !== "NEODB") continue;
      const canonicalUrl = normalizedNeoDbUrl(link.canonicalUrl ?? link.url);
      if (!canonicalUrl) continue;
      for (const alias of [link.url, link.originalUrl, link.canonicalUrl]) {
        rememberAlias(alias, canonicalUrl);
      }
    }
    for (const entry of release.listeningEntries ?? []) {
      if (entry.source !== "NEODB") continue;
      const canonicalUrl = normalizedNeoDbUrl(
        entry.canonicalSourceUrl ?? entry.sourceUrl,
      );
      if (!canonicalUrl) continue;
      for (const alias of [
        entry.sourceUrl,
        entry.originalSourceUrl,
        entry.canonicalSourceUrl,
      ]) {
        rememberAlias(alias, canonicalUrl);
      }
      if (entry.sourceItemId && !aliases.has(entry.sourceItemId)) {
        aliases.set(entry.sourceItemId, canonicalUrl);
      }
    }
  }
  return aliases;
}

function neoDbUrlsFromReleases(releases = []) {
  return [
    ...new Set(
      releases
        .flatMap((release) => [
          ...(release.externalLinks ?? [])
            .filter((link) => link.provider === "NEODB")
            .flatMap((link) => [
              link.originalUrl,
              link.canonicalUrl,
              link.url,
            ]),
          ...(release.listeningEntries ?? [])
            .filter((entry) => entry.source === "NEODB")
            .flatMap((entry) => [
              entry.originalSourceUrl,
              entry.canonicalSourceUrl,
              entry.sourceUrl,
            ]),
        ])
        .map(normalizedNeoDbUrl)
        .filter(Boolean),
    ),
  ].sort();
}

function entryMarkedTime(entry) {
  return (
    Date.parse(entry.markedAt ?? entry.createdAt ?? entry.listenedAt ?? 0) ||
    0
  );
}

function latestEntry(entries = []) {
  let latest = entries[0];
  for (let index = 1; index < entries.length; index += 1) {
    if (entryMarkedTime(entries[index]) > entryMarkedTime(latest)) {
      latest = entries[index];
    }
  }
  return latest;
}

function uniqueUrls(urls = []) {
  return [...new Set(urls.filter(Boolean))];
}

function neoDbSnapshotRows(releases = []) {
  const rows = [];
  for (const release of releases) {
    const entriesBySourceId = new Map();
    for (const entry of release.listeningEntries ?? []) {
      if (entry.source !== "NEODB") continue;
      const sourceItemId =
        entry.sourceItemId ?? sourceItemIdFromUrl(entry.sourceUrl);
      if (!sourceItemId) continue;
      const entries = entriesBySourceId.get(sourceItemId) ?? [];
      entries.push(entry);
      entriesBySourceId.set(sourceItemId, entries);
    }
    for (const [sourceItemId, entries] of entriesBySourceId) {
      const entry = latestEntry(entries);
      const row = {
        title: release.neodbSourceTitle ?? release.title,
        info: `artist:${(release.artists ?? []).join("/")}`,
        links: uniqueUrls([
          entry.sourceUrl,
          ...(release.externalLinks ?? []).map((link) => link.url),
        ]).join(" "),
        timestamp:
          entry.markedAt ??
          entry.createdAt ??
          entry.listenedAt ??
          entry.ratedAt ??
          "",
        status: entry.markStatus ?? release.markStatus ?? "",
        rating: entry.rating10 ?? "",
        comment: entry.comment ?? "",
        tags: (entry.tags ?? release.tags ?? []).join("|"),
        source_item_id: sourceItemId,
        release_type: release.releaseType ?? "OTHER",
        release_date: release.releaseDate ?? "",
        translated_title: release.translatedTitle ?? "",
      };
      rows.push({
        ...row,
        content_hash: jsonHash(row),
      });
    }
  }
  return rows.sort((left, right) => {
    const timeDifference =
      (Date.parse(right.timestamp) || 0) -
      (Date.parse(left.timestamp) || 0);
    return (
      timeDifference ||
      left.source_item_id.localeCompare(right.source_item_id)
    );
  });
}

export function buildNeoDbCsvSnapshot(releases = []) {
  const rows = neoDbSnapshotRows(releases);
  return {
    csv: `${Papa.unparse(rows, {
      columns: NEODB_SNAPSHOT_COLUMNS,
      newline: "\n",
    })}\n`,
    rowCount: rows.length,
  };
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function snapshotSaveResult(meta = {}, extras = {}) {
  return {
    fileName: meta.fileName ?? null,
    contentHash: meta.contentHash ?? null,
    rowCount: meta.rowCount ?? 0,
    reused: Boolean(meta.reused),
    saved: false,
    ...extras,
  };
}

export async function saveNeoDbCsvSnapshot(
  releases,
  {
    syncedAt = new Date().toISOString(),
    previousSnapshot = null,
  } = {},
) {
  const snapshot = buildNeoDbCsvSnapshot(releases);
  const contentHash = await sha256Hex(snapshot.csv);
  if (
    contentHash &&
    previousSnapshot?.contentHash === contentHash &&
    previousSnapshot?.fileName
  ) {
    return snapshotSaveResult(
      {
        fileName: previousSnapshot.fileName,
        contentHash,
        rowCount: snapshot.rowCount,
        reused: true,
      },
      { saved: true },
    );
  }
  try {
    const response = await fetch("/api/local-neodb-snapshot", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csv: snapshot.csv,
        rowCount: snapshot.rowCount,
        syncedAt,
      }),
    });
    if (response.status === 404) {
      return snapshotSaveResult({ rowCount: snapshot.rowCount });
    }
    if (!response.ok) {
      throw new Error(`本地 CSV 快照保存失败（${response.status}）`);
    }
    return snapshotSaveResult(await response.json(), { saved: true });
  } catch (error) {
    return snapshotSaveResult(
      { rowCount: snapshot.rowCount },
      { error: error.message },
    );
  }
}

export function applyNeoDbCanonicalMappings(
  releases,
  canonicalByUrl = {},
  identityReleases = [],
  checkedAt = new Date().toISOString(),
) {
  const aliases = buildNeoDbCanonicalAliases([
    ...identityReleases,
    ...releases,
  ]);
  for (const [sourceUrl, targetUrl] of Object.entries(canonicalByUrl)) {
    const source = normalizedNeoDbUrl(sourceUrl);
    const target = normalizedNeoDbUrl(targetUrl);
    if (!source || !target) continue;
    aliases.set(source, target);
    const sourceId = sourceItemIdFromUrl(source);
    if (sourceId) aliases.set(sourceId, target);
  }

  const changedReleaseIds = [];
  const nextReleases = releases.map((release) => {
    let changed = false;
    const externalLinks = (release.externalLinks ?? []).map((link) => {
      if (link.provider !== "NEODB") return link;
      const normalized = normalizedNeoDbUrl(link.url);
      const canonicalUrl =
        aliases.get(normalized) ??
        aliases.get(sourceItemIdFromUrl(normalized)) ??
        normalized;
      if (!normalized || !canonicalUrl || canonicalUrl === normalized) {
        return link;
      }
      changed = true;
      return {
        ...link,
        originalUrl: link.originalUrl ?? link.url,
        url: canonicalUrl,
        canonicalUrl,
        canonicalizedAt: checkedAt,
      };
    });
    const listeningEntries = (release.listeningEntries ?? []).map((entry) => {
      if (entry.source !== "NEODB") return entry;
      const normalized = normalizedNeoDbUrl(entry.sourceUrl);
      const canonicalUrl =
        aliases.get(entry.sourceItemId) ??
        aliases.get(normalized) ??
        aliases.get(sourceItemIdFromUrl(normalized)) ??
        normalized;
      if (!normalized || !canonicalUrl || canonicalUrl === normalized) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        originalSourceUrl: entry.originalSourceUrl ?? entry.sourceUrl,
        sourceUrl: canonicalUrl,
        canonicalSourceUrl: canonicalUrl,
        sourceItemId:
          sourceItemIdFromUrl(canonicalUrl) ?? entry.sourceItemId,
        sourceUrlCanonicalizedAt: checkedAt,
      };
    });
    if (!changed) return release;
    changedReleaseIds.push(release.id);
    return { ...release, externalLinks, listeningEntries };
  });

  return { releases: nextReleases, changedReleaseIds };
}

async function fetchCanonicalNeoDbUrls(urls) {
  if (!urls.length) return {};
  const canonicalUrls = {};
  for (let offset = 0; offset < urls.length; offset += 100) {
    const response = await fetch("/api/neodb/canonicalize", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ urls: urls.slice(offset, offset + 100) }),
    });
    if (!response.ok) {
      throw new Error(`NeoDB 地址核验暂时不可用（${response.status}）`);
    }
    Object.assign(
      canonicalUrls,
      (await response.json()).canonicalUrls ?? {},
    );
  }
  return canonicalUrls;
}

function remapNeoDbSnapshotIds(snapshot = {}, aliases = new Map()) {
  const next = {};
  const deferredAliases = [];
  for (const [sourceItemId, value] of Object.entries(snapshot)) {
    const canonicalUrl = aliases.get(sourceItemId);
    const canonicalId = sourceItemIdFromUrl(canonicalUrl) ?? sourceItemId;
    if (canonicalId === sourceItemId) next[sourceItemId] = value;
    else deferredAliases.push([canonicalId, value]);
  }
  for (const [canonicalId, value] of deferredAliases) {
    if (!(canonicalId in next)) next[canonicalId] = value;
  }
  return next;
}

export async function refreshNeoDbCanonicalIdentity(
  releases,
  identityReleases = [],
  {
    auditCursor = 0,
    forceFull = false,
    auditSize = DAILY_CANONICAL_AUDIT_SIZE,
    priorityReleaseIds = [],
  } = {},
) {
  const known = applyNeoDbCanonicalMappings(
    releases,
    {},
    identityReleases,
  );
  const urls = neoDbUrlsFromReleases(known.releases);
  let urlsToCheck = urls;
  let start = 0;
  let count = urls.length;
  if (!forceFull) {
    start = urls.length ? auditCursor % urls.length : 0;
    count = Math.min(auditSize, urls.length);
    const auditUrls = Array.from(
      { length: count },
      (_, offset) => urls[(start + offset) % urls.length],
    );
    const priorityIds = new Set(priorityReleaseIds);
    const priorityUrls = neoDbUrlsFromReleases(
      known.releases.filter((release) => priorityIds.has(release.id)),
    );
    urlsToCheck = [...new Set([...priorityUrls, ...auditUrls])];
  }
  let canonicalByUrl = {};
  let error = null;
  try {
    canonicalByUrl = await fetchCanonicalNeoDbUrls(urlsToCheck);
  } catch (canonicalError) {
    error = canonicalError.message;
  }
  const checked = applyNeoDbCanonicalMappings(
    known.releases,
    canonicalByUrl,
    identityReleases,
  );
  return {
    releases: checked.releases,
    changedReleaseIds: [
      ...new Set([
        ...known.changedReleaseIds,
        ...checked.changedReleaseIds,
      ]),
    ],
    checkedUrlCount: urlsToCheck.length,
    nextAuditCursor: urls.length ? (start + count) % urls.length : 0,
    error,
  };
}

function canonicalizeNeoDbMark(mark, aliases) {
  const sourceUrl = catalogUrlFromItem(mark.item);
  const canonicalUrl =
    aliases.get(mark.item.uuid) ?? aliases.get(sourceUrl) ?? sourceUrl;
  if (!canonicalUrl) return mark;
  return {
    ...mark,
    item: {
      ...mark.item,
      uuid: sourceItemIdFromUrl(canonicalUrl) ?? mark.item.uuid,
      id: canonicalUrl,
      url: canonicalUrl,
    },
  };
}

function providerFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLocaleLowerCase();
    if (host === "open.spotify.com") return "SPOTIFY";
    if (host === "music.apple.com") return "APPLE_MUSIC";
    if (host === "musicbrainz.org") return "MUSICBRAINZ";
    if (host.endsWith("discogs.com")) return "DISCOGS";
    if (host === "neodb.social" || host.startsWith("neodb.")) return "NEODB";
    return "OTHER";
  } catch {
    return null;
  }
}

function uniqueStrings(values = []) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function artistNamesFromItem(item) {
  const credits = item.credits ?? [];
  const likelyArtists = credits.filter((credit) =>
    /artist|performer|vocal|singer|music|乐队|歌手|音乐人|演唱/i.test(
      credit.role ?? "",
    ),
  );
  const names = uniqueStrings(
    (likelyArtists.length ? likelyArtists : credits)
      .map((credit) => credit.name?.trim())
      .filter(Boolean),
  );
  return names.length ? names : ["未知艺人"];
}

function translatedTitleFromItem(item) {
  const localized = (item.localized_title ?? [])
    .map((label) => label.text?.trim())
    .filter(Boolean)
    .find((title) => normalizeText(title) !== normalizeText(item.title));
  return localized ?? null;
}

function catalogApiPathFromItem(item) {
  if (item?.api_url) {
    try {
      const url = new URL(item.api_url, NEODB_ORIGIN);
      return `${url.pathname}${url.search}`;
    } catch {
      return String(item.api_url).startsWith("/")
        ? item.api_url
        : `/${item.api_url}`;
    }
  }
  const uuid = String(item?.uuid ?? "").trim();
  if (!uuid) return null;
  const category = String(item.category ?? "").toLocaleLowerCase();
  const type = String(item.type ?? "").toLocaleLowerCase();
  if (category && category !== "music" && type !== "album") return null;
  return `/api/album/${encodeURIComponent(uuid)}`;
}

function mergeCatalogItem(shelfItem, catalogItem) {
  if (!catalogItem) return shelfItem;
  const seen = new Set();
  const external_resources = [
    ...(shelfItem?.external_resources ?? []),
    ...(catalogItem.external_resources ?? []),
  ].filter((resource) => {
    const url = String(resource?.url ?? "").trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  return {
    ...shelfItem,
    ...catalogItem,
    uuid: shelfItem?.uuid ?? catalogItem.uuid,
    id: catalogItem.id ?? shelfItem?.id,
    url: catalogItem.url ?? shelfItem?.url,
    api_url: catalogItem.api_url ?? shelfItem?.api_url,
    external_resources,
  };
}

function platformLinkFromUrl(url) {
  const normalized = normalizeSupportedReleaseUrl(url);
  if (normalized) {
    return {
      provider: normalized.provider,
      url: normalized.normalizedUrl,
      status:
        normalized.provider === "NEODB" ? "CONFIRMED" : "AUTO_CONFIRMED",
    };
  }
  const provider = providerFromUrl(url);
  if (!provider || provider === "OTHER" || provider === "DOUBAN") return null;
  return {
    provider,
    url,
    status: provider === "NEODB" ? "CONFIRMED" : "AUTO_CONFIRMED",
  };
}

function externalLinksFromItem(item) {
  const urls = [
    catalogUrlFromItem(item),
    ...(item.external_resources ?? []).map((resource) => resource.url),
  ].filter(Boolean);
  const seen = new Set();
  const seenProviders = new Set();
  const links = [];
  for (const url of urls) {
    const link = platformLinkFromUrl(url);
    if (!link) continue;
    const key = `${link.provider}|${link.url}`;
    if (seen.has(key)) continue;
    if (
      ["NEODB", "APPLE_MUSIC", "SPOTIFY"].includes(link.provider) &&
      seenProviders.has(link.provider)
    ) {
      continue;
    }
    seen.add(key);
    seenProviders.add(link.provider);
    links.push(link);
  }
  return links;
}

function releaseTypeFromItem(item) {
  return (
    normalizeExternalReleaseType(item.type) ??
    inferReleaseTypeFromOfficialTitle(item.title) ??
    "OTHER"
  );
}

export function neoDbMarkHash(mark) {
  return jsonHash({
    shelfType: mark.shelf_type,
    visibility: mark.visibility,
    postId: mark.post_id,
    createdTime: mark.created_time,
    comment: mark.comment_text,
    rating: mark.rating_grade,
    tags: mark.tags,
    item: {
      uuid: mark.item?.uuid,
      title: mark.item?.title,
      localizedTitle: mark.item?.localized_title,
      cover: mark.item?.cover_image_url,
      type: mark.item?.type,
      tags: mark.item?.tags,
      credits: mark.item?.credits,
      resources: mark.item?.external_resources,
    },
  });
}

function combinedComment(mark, review) {
  return uniqueStrings([mark.comment_text?.trim(), review?.body?.trim()])
    .filter(Boolean)
    .join("\n\n") || null;
}

export function neoDbReviewHash(review = null) {
  const body = typeof review?.body === "string" ? review.body.trim() : "";
  const title = typeof review?.title === "string" ? review.title.trim() : "";
  if (!body && !title) return "";
  return jsonHash({ title, body });
}

export function neoDbMarkToEntry(mark, review = null, suffix = "") {
  const sourceItemId = mark.item.uuid;
  const createdAt = mark.created_time;
  const isListened = mark.shelf_type === "complete";
  return {
    id: `entry-neodb-sync-${stableHash(
      `${sourceItemId}|${createdAt}|${mark.rating_grade}|${combinedComment(
        mark,
        review,
      )}|${suffix}`,
    )}`,
    listenedAt: isListened ? createdAt : null,
    listenedAtPrecision: getDatePrecision(isListened ? createdAt : null),
    ratedAt: mark.rating_grade == null ? null : createdAt,
    rating10: mark.rating_grade ?? null,
    comment: combinedComment(mark, review),
    source: "NEODB",
    sourceUrl: catalogUrlFromItem(mark.item) ?? mark.item.url,
    sourceItemId,
    markStatus: mark.shelf_type,
    markedAt: createdAt,
    tags: mark.tags ?? [],
    createdAt,
  };
}

function markLogToEntry(mark, log) {
  const createdAt = log.timestamp;
  const isListened = log.shelf_type === "complete";
  return {
    id: `entry-neodb-log-${stableHash(
      `${mark.item.uuid}|${createdAt}|${log.rating_grade}|${log.comment_text}`,
    )}`,
    listenedAt: isListened ? createdAt : null,
    listenedAtPrecision: getDatePrecision(isListened ? createdAt : null),
    ratedAt: log.rating_grade == null ? null : createdAt,
    rating10: log.rating_grade ?? null,
    comment: log.comment_text?.trim() || null,
    source: "NEODB",
    sourceUrl: catalogUrlFromItem(mark.item) ?? mark.item.url,
    sourceItemId: mark.item.uuid,
    markStatus: log.shelf_type,
    markedAt: createdAt,
    createdAt,
  };
}

function releaseDateFromItem(item = {}) {
  const raw =
    item.release_date ||
    item.releaseDate ||
    (Number.isInteger(item.release_year) ? String(item.release_year) : "") ||
    (Number.isInteger(item.year) ? String(item.year) : "");
  const value = String(raw ?? "").trim();
  if (!value) {
    return { releaseDate: null, releaseDatePrecision: "UNKNOWN" };
  }
  return {
    releaseDate: value,
    releaseDatePrecision: getDatePrecision(value),
  };
}

export function neoDbMarkToRelease(mark, review = null, logs = []) {
  const item = mark.item;
  const translatedTitle = translatedTitleFromItem(item);
  const currentEntry = neoDbMarkToEntry(mark, review);
  const reportedReleaseType = releaseTypeFromItem(item);
  const historicalEntries = logs
    .map((log) => markLogToEntry(mark, log))
    .filter((entry) => !entriesAreEquivalent(entry, currentEntry));
  const releaseDateFields = releaseDateFromItem(item);
  return {
    id: `release-neodb-sync-${item.uuid}`,
    title: item.title,
    translatedTitle,
    titleAliases: translatedTitle ? [translatedTitle] : [],
    neodbSourceTitle: item.title,
    neodbSourceTitleUrl: catalogUrlFromItem(item) ?? item.url,
    neodbSourceTitleUpdatedAt: mark.created_time ?? null,
    artists: artistNamesFromItem(item),
    releaseType: "OTHER",
    releaseTypeSource: "PENDING_EXACT_CHECK",
    releaseTypeEvidence:
      reportedReleaseType === "OTHER" ? item.type ?? null : item.type,
    releaseTypeMatchedFrom: catalogUrlFromItem(item) ?? item.url,
    releaseTypeMatchedAt: null,
    neodbSourceType: item.type ?? null,
    ...releaseDateFields,
    releaseDateCheckedAt: new Date().toISOString(),
    genres: [],
    coverUrl: item.cover_image_url ?? null,
    isPrivate: mark.visibility === 2,
    externalLinks: externalLinksFromItem(item),
    neodbPlatformLinksCheckedAt: new Date().toISOString(),
    markStatus: mark.shelf_type,
    tags: mark.tags ?? [],
    listeningEntries: [...historicalEntries, currentEntry],
  };
}

export function applyReleaseTypeVerification(
  releases,
  results = [],
  checkedAt = new Date().toISOString(),
) {
  const resultById = new Map(results.map((result) => [result.id, result]));
  return releases.map((release) => {
    const result = resultById.get(release.id);
    if (!result || release.releaseTypeUserConfirmed) return release;
    const matched = result.status === "MATCHED";
    return {
      ...release,
      releaseType: matched ? result.releaseType : "OTHER",
      releaseTypeSource: matched
        ? result.source
        : result.status === "CONFLICT"
          ? "EXACT_SOURCE_CONFLICT"
          : "EXACT_SOURCE_UNRESOLVED",
      releaseTypeMatchedFrom:
        result.matchedFrom ??
        result.evidence?.map((item) => item.matchedFrom) ??
        [],
      releaseTypeEvidence:
        result.rawEvidence ??
        result.evidence?.map((item) => item.rawType) ??
        [],
      releaseTypeMatchedAt: checkedAt,
      typeVerificationInputFingerprint:
        result.fingerprint ??
        getReleaseTypeVerificationFingerprint(release),
    };
  });
}

function releaseTypeCacheKey(release) {
  const neoDbLink = (release.externalLinks ?? []).find(
    (link) => link.provider === "NEODB",
  );
  const canonicalUrl = normalizedNeoDbUrl(
    neoDbLink?.canonicalUrl ?? neoDbLink?.url,
  );
  return canonicalUrl ? `neodb:${canonicalUrl}` : `release:${release.id}`;
}

export function getReleaseTypeVerificationFingerprint(release) {
  return jsonHash({
    title: normalizeText(release.title),
    artists: (release.artists ?? []).map(normalizeText).sort(),
    neodbSourceType: normalizeText(release.neodbSourceType),
    externalLinks: (release.externalLinks ?? [])
      .filter((link) =>
        ["NEODB", "MUSICBRAINZ", "DISCOGS", "APPLE_MUSIC"].includes(
          link.provider,
        ),
      )
      .map((link) => ({
        provider: link.provider,
        url:
          link.provider === "NEODB"
            ? normalizedNeoDbUrl(link.canonicalUrl ?? link.url)
            : link.url,
        status: link.status,
      }))
      .sort((a, b) =>
        `${a.provider}|${a.url}`.localeCompare(`${b.provider}|${b.url}`),
      ),
  });
}

function reusableTypeCacheEntry(entry, fingerprint, now) {
  if (!entry || entry.fingerprint !== fingerprint || !entry.checkedAt) {
    return false;
  }
  const checkedAt = Date.parse(entry.checkedAt);
  return (
    Number.isFinite(checkedAt) &&
    now - checkedAt <= TYPE_VERIFICATION_CACHE_TTL_MS
  );
}

export async function verifyChangedReleaseTypes(
  releases,
  changedReleaseIds,
  cache = {},
) {
  const changedIds = new Set(changedReleaseIds);
  const targets = releases.filter(
    (release) =>
      changedIds.has(release.id) && !release.releaseTypeUserConfirmed,
  );
  const now = Date.now();
  const results = [];
  const misses = [];
  const nextCache = { ...cache };
  for (const release of targets) {
    const fingerprint = getReleaseTypeVerificationFingerprint(release);
    const key = releaseTypeCacheKey(release);
    const cached = cache[key];
    if (reusableTypeCacheEntry(cached, fingerprint, now)) {
      results.push({
        ...cached.result,
        id: release.id,
        fingerprint,
        cacheHit: true,
      });
    } else {
      misses.push({ release, fingerprint, key });
    }
  }
  for (let offset = 0; offset < misses.length; offset += 12) {
    const batch = misses.slice(offset, offset + 12);
    const response = await fetch("/api/metadata/release-types", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        releases: batch.map(({ release }) => ({
          id: release.id,
          title: release.title,
          artists: release.artists,
          externalLinks: release.externalLinks,
        })),
      }),
    });
    if (!response.ok) {
      throw new Error(`发行类型校验暂时不可用（${response.status}）`);
    }
    const returned = (await response.json()).results ?? [];
    const returnedById = new Map(
      returned.map((result) => [result.id, result]),
    );
    const checkedAt = new Date().toISOString();
    for (const item of batch) {
      const result = returnedById.get(item.release.id) ?? {
        id: item.release.id,
        status: "UNRESOLVED",
        releaseType: "OTHER",
        evidence: [],
      };
      const enrichedResult = {
        ...result,
        fingerprint: item.fingerprint,
        cacheHit: false,
      };
      results.push(enrichedResult);
      nextCache[item.key] = {
        fingerprint: item.fingerprint,
        checkedAt,
        result: {
          ...result,
          id: undefined,
        },
      };
    }
  }
  const counts = results.reduce(
    (summary, result) => {
      if (result.status === "MATCHED") summary.matched += 1;
      else if (result.status === "CONFLICT") summary.conflicts += 1;
      else summary.unresolved += 1;
      return summary;
    },
    {
      checked: results.length,
      matched: 0,
      unresolved: 0,
      conflicts: 0,
      cacheHits: results.filter((result) => result.cacheHit).length,
      queried: misses.length,
      skippedUserConfirmed: changedIds.size - targets.length,
    },
  );
  return {
    releases: applyReleaseTypeVerification(releases, results),
    results,
    nextCache,
    ...counts,
  };
}

function neoDbIdsFromReleaseLinks(release) {
  return (release.externalLinks ?? [])
    .filter((link) => link.provider === "NEODB")
    .flatMap((link) => [
      sourceItemIdFromUrl(link.url),
      sourceItemIdFromUrl(link.canonicalUrl),
      sourceItemIdFromUrl(link.originalUrl),
    ])
    .filter(Boolean);
}

function neoDbIdsFromReleaseEntries(release) {
  return (release.listeningEntries ?? [])
    .filter((entry) => entry.source === "NEODB")
    .map(
      (entry) =>
        entry.sourceItemId ?? sourceItemIdFromUrl(entry.sourceUrl),
    )
    .filter(Boolean);
}

export function getNeoDbSourceIds(releases = []) {
  return new Set(releases.flatMap((release) => neoDbIdsFromReleaseEntries(release)));
}

export function getNeoDbLinkedSourceIds(releases = []) {
  return new Set(releases.flatMap((release) => neoDbIdsFromReleaseLinks(release)));
}

export function getOrphanNeoDbLinkedSourceIds(releases = []) {
  const entryIds = getNeoDbSourceIds(releases);
  return new Set(
    [...getNeoDbLinkedSourceIds(releases)].filter((id) => !entryIds.has(id)),
  );
}

export function getUnlinkedNeoDbSourceIds(releases = []) {
  const linkedIds = getNeoDbLinkedSourceIds(releases);
  return new Set(
    [...getNeoDbSourceIds(releases)].filter((id) => !linkedIds.has(id)),
  );
}

function hasProviderLink(release, provider) {
  return (release.externalLinks ?? []).some(
    (link) => link.provider === provider,
  );
}

export function getUnlinkedPlatformSourceIds(releases = []) {
  return new Set(
    releases
      .filter(
        (release) =>
          !release.neodbPlatformLinksCheckedAt &&
          (!hasProviderLink(release, "APPLE_MUSIC") ||
            !hasProviderLink(release, "SPOTIFY")),
      )
      .flatMap((release) => [
        ...neoDbIdsFromReleaseEntries(release),
        ...neoDbIdsFromReleaseLinks(release),
      ])
      .filter(Boolean),
  );
}

export function buildVerifiedNeoDbRemovalCandidates(
  releases,
  remoteSourceIds = [],
  identityReleases = [],
) {
  const aliases = buildNeoDbCanonicalAliases([
    ...identityReleases,
    ...releases,
  ]);
  const canonicalId = (sourceId) => {
    const canonicalUrl = aliases.get(sourceId);
    return sourceItemIdFromUrl(canonicalUrl) ?? sourceId;
  };
  const remoteIds = new Set(remoteSourceIds.map(canonicalId));
  const candidates = [];
  const seen = new Set();
  for (const release of releases) {
    for (const entry of release.listeningEntries ?? []) {
      if (entry.source !== "NEODB") continue;
      const sourceItemId =
        entry.sourceItemId ?? sourceItemIdFromUrl(entry.sourceUrl);
      if (!sourceItemId) continue;
      const finalSourceItemId = canonicalId(sourceItemId);
      const key = `${release.id}|${finalSourceItemId}`;
      if (remoteIds.has(finalSourceItemId) || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        sourceItemId: finalSourceItemId,
        releaseId: release.id,
        title: release.title,
      });
    }
  }
  return candidates;
}

export function advanceNeoDbRemovalReview(
  candidates,
  previousStreaks = {},
  checkedAt = new Date().toISOString(),
) {
  const streaks = {};
  const pendingRemovals = [];
  const reviewCandidates = [];
  for (const candidate of candidates) {
    const previous = previousStreaks[candidate.sourceItemId];
    const count = (previous?.count ?? 0) + 1;
    const reviewed = { ...candidate, count, checkedAt };
    streaks[candidate.sourceItemId] = reviewed;
    if (count >= 2) pendingRemovals.push(candidate);
    else reviewCandidates.push(candidate);
  }
  return { streaks, pendingRemovals, reviewCandidates };
}

function findReleaseByNeoDbId(releases, sourceItemId) {
  if (!sourceItemId) return null;
  const byEntry = releases.find((release) =>
    neoDbIdsFromReleaseEntries(release).includes(sourceItemId),
  );
  if (byEntry) return byEntry;
  // Manual adds often confirm a NeoDB URL without a NEODB listening entry.
  return releases.find((release) =>
    neoDbIdsFromReleaseLinks(release).includes(sourceItemId),
  );
}

function comparableEntry(entry) {
  const normalizeInstant = (value) => {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp)
      ? String(value).trim()
      : new Date(timestamp).toISOString();
  };
  const normalizeComment = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim() || null;
  return {
    listenedAt: normalizeInstant(entry.listenedAt),
    ratedAt: normalizeInstant(entry.ratedAt),
    rating10: entry.rating10 ?? null,
    comment: normalizeComment(entry.comment),
    markStatus: entry.markStatus ?? null,
    source:
      entry.source === "NEODB"
        ? `NEODB:${
            entry.sourceItemId ??
            sourceItemIdFromUrl(entry.sourceUrl) ??
            "unknown"
          }`
        : entry.source ?? null,
  };
}

function entriesAreEquivalent(a, b) {
  return JSON.stringify(comparableEntry(a)) === JSON.stringify(comparableEntry(b));
}

export function dedupeEquivalentListeningEntries(entries = []) {
  const preferredByKey = new Map();
  for (const entry of entries) {
    const key = JSON.stringify(comparableEntry(entry));
    const current = preferredByKey.get(key);
    if (!current) {
      preferredByKey.set(key, entry);
      continue;
    }
    const currentStamp = Date.parse(
      current.updatedAt ?? current.createdAt ?? current.ratedAt ?? 0,
    );
    const nextStamp = Date.parse(
      entry.updatedAt ?? entry.createdAt ?? entry.ratedAt ?? 0,
    );
    if (
      nextStamp > currentStamp ||
      (nextStamp === currentStamp && Boolean(entry.updatedAt) && !current.updatedAt)
    ) {
      preferredByKey.set(key, entry);
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const key = JSON.stringify(comparableEntry(entry));
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(preferredByKey.get(key));
  }
  return deduped;
}

function latestNeoDbListeningEntry(release, sourceItemId) {
  if (!release || !sourceItemId) return null;
  const entries = (release.listeningEntries ?? []).filter((entry) => {
    if (entry.source !== "NEODB") return false;
    const entrySourceId =
      entry.sourceItemId ?? sourceItemIdFromUrl(entry.sourceUrl);
    return entrySourceId === sourceItemId;
  });
  if (!entries.length) return null;
  return sortListeningEntriesNewestFirst(entries)[0];
}

function localNeoDbNeedsMarkRefresh(release, mark) {
  const latest = latestNeoDbListeningEntry(release, mark.item?.uuid);
  if (!latest) return Boolean(release);
  if ((latest.rating10 ?? null) !== (mark.rating_grade ?? null)) return true;
  if ((latest.markStatus ?? null) !== (mark.shelf_type ?? null)) return true;
  if (
    !String(release.releaseDate ?? "").trim() &&
    !release.releaseDateCheckedAt
  ) {
    return true;
  }
  const remoteComment = String(mark.comment_text ?? "").trim();
  const localComment = String(latest.comment ?? "").trim();
  if (!remoteComment) return false;
  return (
    localComment !== remoteComment &&
    !localComment.startsWith(`${remoteComment}\n`)
  );
}

function mergeExternalLinks(existing = [], incoming = []) {
  const replaceable = new Set(["APPLE_MUSIC", "SPOTIFY"]);
  const links = [...existing];
  const seen = new Set(links.map((link) => `${link.provider}|${link.url}`));
  const indexByProvider = new Map();
  links.forEach((link, index) => {
    if (replaceable.has(link.provider) && !indexByProvider.has(link.provider)) {
      indexByProvider.set(link.provider, index);
    }
  });
  for (const link of incoming) {
    const key = `${link.provider}|${link.url}`;
    if (seen.has(key)) continue;
    if (replaceable.has(link.provider) && indexByProvider.has(link.provider)) {
      const index = indexByProvider.get(link.provider);
      const current = links[index];
      if (current.status === "CONFIRMED") continue;
      if (current.status !== "AUTO_CONFIRMED") continue;
      links[index] = link;
      seen.add(key);
      continue;
    }
    seen.add(key);
    if (replaceable.has(link.provider)) {
      indexByProvider.set(link.provider, links.length);
    }
    links.push(link);
  }
  return links;
}

function metadataPatch(existing, incoming) {
  const existingNeoDbLink = (existing.externalLinks ?? []).find(
    (link) => link.provider === "NEODB",
  );
  const incomingNeoDbLink = (incoming.externalLinks ?? []).find(
    (link) => link.provider === "NEODB",
  );
  const canonicalAddressChanged =
    existingNeoDbLink?.originalUrl &&
    normalizedNeoDbUrl(existingNeoDbLink.originalUrl) !==
      normalizedNeoDbUrl(existingNeoDbLink.url);
  const previousNeoDbTitle = existing.neodbSourceTitle;
  const neoDbTitleChanged =
    previousNeoDbTitle &&
    normalizeText(previousNeoDbTitle) !== normalizeText(incoming.title);
  const previousNeoDbTitleWasPrimary =
    previousNeoDbTitle &&
    normalizeText(previousNeoDbTitle) === normalizeText(existing.title);
  const shouldPromoteNeoDbTitle =
    normalizeText(incoming.title) !== normalizeText(existing.title) &&
    !existing.titleUserConfirmed &&
    (canonicalAddressChanged ||
      (neoDbTitleChanged &&
        (previousNeoDbTitleWasPrimary ||
          String(existing.titleSource ?? "").startsWith("NEODB"))));
  const primaryTitle = shouldPromoteNeoDbTitle
    ? incoming.title
    : existing.title;
  const aliases = uniqueStrings([
    ...(existing.titleAliases ?? []),
    shouldPromoteNeoDbTitle ? existing.title : incoming.title,
    incoming.translatedTitle,
  ]).filter((title) => normalizeText(title) !== normalizeText(primaryTitle));
  const patch = {
    coverUrl: incoming.coverUrl ?? existing.coverUrl,
    genres: uniqueStrings([...(existing.genres ?? []), ...(incoming.genres ?? [])]),
    externalLinks: mergeExternalLinks(
      existing.externalLinks,
      incoming.externalLinks,
    ),
    markStatus: incoming.markStatus,
    tags: uniqueStrings([...(existing.tags ?? []), ...(incoming.tags ?? [])]),
    titleAliases: aliases,
    translatedTitle:
      (existing.translatedTitle &&
      normalizeText(existing.translatedTitle) !== normalizeText(primaryTitle)
        ? existing.translatedTitle
        : null) ??
      (normalizeText(incoming.title) !== normalizeText(primaryTitle)
        ? incoming.title
        : incoming.translatedTitle),
    neodbSourceTitle: incoming.title,
    neodbSourceTitleUrl: incomingNeoDbLink?.url ?? incoming.neodbSourceTitleUrl,
    neodbSourceTitleUpdatedAt:
      !previousNeoDbTitle ||
      normalizeText(previousNeoDbTitle) !== normalizeText(incoming.title)
        ? new Date().toISOString()
        : existing.neodbSourceTitleUpdatedAt,
    neodbSourceType: incoming.neodbSourceType ?? null,
    neodbPlatformLinksCheckedAt:
      existing.neodbPlatformLinksCheckedAt ??
      incoming.neodbPlatformLinksCheckedAt,
  };
  if (shouldPromoteNeoDbTitle) {
    patch.title = incoming.title;
    patch.titleSource = "NEODB_SYNC_EXACT";
    patch.titleMatchedFrom =
      incomingNeoDbLink?.url ?? incoming.neodbSourceTitleUrl;
    patch.titleMatchedAt = new Date().toISOString();
  }
  if (
    existing.releaseType === "OTHER" &&
    incoming.releaseType !== "OTHER"
  ) {
    patch.releaseType = incoming.releaseType;
  }
  if (!String(existing.releaseDate ?? "").trim() && incoming.releaseDate) {
    patch.releaseDate = incoming.releaseDate;
    patch.releaseDatePrecision =
      incoming.releaseDatePrecision ?? getDatePrecision(incoming.releaseDate);
  }
  if (!existing.releaseDateCheckedAt && incoming.releaseDateCheckedAt) {
    patch.releaseDateCheckedAt = incoming.releaseDateCheckedAt;
  }
  return patch;
}

function metadataChanged(existing, patch) {
  return Object.entries(patch).some(
    ([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value),
  );
}

function metadataChangedFields(existing, patch) {
  return Object.entries(patch)
    .filter(
      ([key, value]) =>
        JSON.stringify(existing[key]) !== JSON.stringify(value),
    )
    .map(([key]) => key);
}

export function buildNeoDbSyncPlan(
  releases,
  enrichedMarks,
  removedSourceIds = [],
) {
  const additions = [];
  const updates = [];
  const unchanged = [];

  for (const enriched of enrichedMarks) {
    const { mark, review = null, logs = [] } = enriched;
    const incoming = neoDbMarkToRelease(mark, review, logs);
    const existing = findReleaseByNeoDbId(releases, mark.item.uuid);
    if (!existing) {
      additions.push({ sourceItemId: mark.item.uuid, release: incoming });
      continue;
    }

    const currentEntry = incoming.listeningEntries.at(-1);
    const latestLocalNeoDb = latestNeoDbListeningEntry(
      existing,
      mark.item.uuid,
    );
    const latestMatchesRemote =
      latestLocalNeoDb && entriesAreEquivalent(latestLocalNeoDb, currentEntry);
    // Always refresh the current remote mark when the latest local NeoDB copy
    // drifted, even if an older historical row already matches the remote body.
    const entriesToMerge = incoming.listeningEntries.filter((entry) => {
      if (entry === currentEntry) return !latestMatchesRemote;
      return !existing.listeningEntries.some(
        (current) =>
          current.id === entry.id || entriesAreEquivalent(current, entry),
      );
    });
    const patch = metadataPatch(existing, incoming);
    const changedMetadataFields = metadataChangedFields(existing, patch);
    if (
      !latestMatchesRemote ||
      entriesToMerge.length ||
      metadataChanged(existing, patch)
    ) {
      const syncedAt = new Date().toISOString();
      updates.push({
        sourceItemId: mark.item.uuid,
        releaseId: existing.id,
        title: existing.title,
        patch,
        entries: entriesToMerge.map((entry) => ({
          ...entry,
          updatedAt: entry.updatedAt ?? syncedAt,
        })),
        changedMetadataFields,
        typeVerificationRelevant:
          existing.releaseType === "OTHER" ||
          changedMetadataFields.some((field) =>
            [
              "title",
              "neodbSourceTitle",
              "neodbSourceType",
              "externalLinks",
            ].includes(field),
          ),
      });
    } else {
      unchanged.push(mark.item.uuid);
    }
  }

  const removals = removedSourceIds
    .map((sourceItemId) => {
      const release = findReleaseByNeoDbId(releases, sourceItemId);
      return release
        ? {
            sourceItemId,
            releaseId: release.id,
            title: release.title,
          }
        : null;
    })
    .filter(Boolean);

  return { additions, updates, removals, unchanged };
}

export function applyNeoDbSyncPlan(
  releases,
  plan,
  { applyRemovals = false } = {},
) {
  const updateByReleaseId = new Map(
    plan.updates.map((update) => [update.releaseId, update]),
  );
  const removedIds = new Set(
    applyRemovals ? plan.removals.map((item) => item.sourceItemId) : [],
  );
  const next = [];

  for (const release of releases) {
    const update = updateByReleaseId.get(release.id);
    let candidate = update
      ? {
          ...release,
          ...update.patch,
          listeningEntries: dedupeEquivalentListeningEntries([
            ...release.listeningEntries,
            ...(update.entries ?? []),
          ]),
        }
      : release;

    if (removedIds.size) {
      candidate = {
        ...candidate,
        listeningEntries: candidate.listeningEntries.filter(
          (entry) =>
            !(
              entry.source === "NEODB" &&
              removedIds.has(
                entry.sourceItemId ?? sourceItemIdFromUrl(entry.sourceUrl),
              )
            ),
        ),
      };
    }
    if (candidate.listeningEntries.length) next.push(candidate);
  }

  return [...plan.additions.map((item) => item.release), ...next];
}

async function fetchNeoDb(path, token, { allow404 = false } = {}) {
  const response = await fetch(`${NEODB_ORIGIN}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (allow404 && response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    const error = new Error("NeoDB 登录已失效，请重新登录");
    error.code = "NEODB_AUTH";
    throw error;
  }
  if (!response.ok) {
    throw new Error(`NeoDB 暂时无法同步（${response.status}）`);
  }
  return response.json();
}

async function fetchMarkPage(token, shelfType, page) {
  return fetchNeoDb(
    `/api/me/shelf/${shelfType}?category=music&page=${page}&page_size=${PAGE_SIZE}`,
    token,
  );
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function fetchKnownMarkBatch(token, sourceItemIds) {
  if (!sourceItemIds.length) return [];
  const encodedIds = sourceItemIds.map(encodeURIComponent).join(",");
  const marks = await fetchNeoDb(
    `/api/me/shelf/items/${encodedIds}`,
    token,
    { allow404: true },
  );
  if (marks) return marks;
  if (sourceItemIds.length === 1) return [];
  const middle = Math.ceil(sourceItemIds.length / 2);
  const [left, right] = await Promise.all([
    fetchKnownMarkBatch(token, sourceItemIds.slice(0, middle)),
    fetchKnownMarkBatch(token, sourceItemIds.slice(middle)),
  ]);
  return [...left, ...right];
}

async function fetchKnownMarks(token, sourceItemIds) {
  const batches = [];
  for (
    let offset = 0;
    offset < sourceItemIds.length;
    offset += KNOWN_MARK_BATCH_SIZE
  ) {
    batches.push(
      sourceItemIds.slice(offset, offset + KNOWN_MARK_BATCH_SIZE),
    );
  }
  const results = await mapWithConcurrency(
    batches,
    KNOWN_MARK_AUDIT_CONCURRENCY,
    (batch) => fetchKnownMarkBatch(token, batch),
  );
  return results.flat();
}

function shelfPagesBeyondFirst(totalPagesByShelf) {
  return SHELF_TYPES.flatMap((shelfType) =>
    Array.from(
      { length: Math.max(0, totalPagesByShelf[shelfType] - 1) },
      (_, index) => [shelfType, index + 2],
    ),
  );
}

async function enrichChangedMark(mark, token, includeLogs) {
  const uuid = encodeURIComponent(mark.item.uuid);
  const catalogPath = catalogApiPathFromItem(mark.item);
  const [review, logsPage, catalogItem] = await Promise.all([
    fetchNeoDb(`/api/me/review/item/${uuid}`, token, { allow404: true }),
    includeLogs
      ? fetchNeoDb(
          `/api/me/shelf/item/${uuid}/logs?page=1&page_size=100`,
          token,
          { allow404: true },
        )
      : Promise.resolve(null),
    catalogPath
      ? fetchNeoDb(catalogPath, token, { allow404: true })
      : Promise.resolve(null),
  ]);
  return {
    mark: {
      ...mark,
      item: mergeCatalogItem(mark.item, catalogItem),
    },
    review,
    logs: logsPage?.data ?? [],
  };
}

export function loadNeoDbSyncState() {
  try {
    const state =
      JSON.parse(window.localStorage.getItem(NEODB_SYNC_STATE_KEY)) ?? {};
    if (state.schemaVersion === SYNC_SCHEMA_VERSION) {
      if (state.removalEvidenceVersion === REMOVAL_EVIDENCE_VERSION) {
        return state;
      }
      return {
        ...state,
        removalEvidenceVersion: REMOVAL_EVIDENCE_VERSION,
        pendingRemovals: [],
        removalCandidateStreaks: {},
      };
    }
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      removalEvidenceVersion: REMOVAL_EVIDENCE_VERSION,
      profile: state.profile,
      snapshot: {},
      remoteCount: null,
      auditCursor: 0,
      pendingRemovals: [],
      removalCandidateStreaks: {},
      lastSyncedAt: state.lastSyncedAt ?? null,
      lastFullReconcileAt: null,
    };
  } catch {
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      removalEvidenceVersion: REMOVAL_EVIDENCE_VERSION,
      pendingRemovals: [],
      removalCandidateStreaks: {},
    };
  }
}

export function saveNeoDbSyncState(state) {
  window.localStorage.setItem(NEODB_SYNC_STATE_KEY, JSON.stringify(state));
  notifySharedLocalStateChanged();
}

export function clearNeoDbAccessToken() {
  window.sessionStorage.removeItem(NEODB_ACCESS_TOKEN_KEY);
}

export function getNeoDbAccessToken() {
  return window.sessionStorage.getItem(NEODB_ACCESS_TOKEN_KEY);
}

export async function beginNeoDbLogin() {
  const redirectUri = `${window.location.origin}/sync`;
  let client = null;
  try {
    client = JSON.parse(
      window.localStorage.getItem(NEODB_OAUTH_CLIENT_KEY),
    );
  } catch {
    client = null;
  }
  if (!client || client.redirectUri !== redirectUri) {
    const body = new URLSearchParams({
      client_name: "RecordShelf",
      redirect_uris: redirectUri,
      website: window.location.origin,
      scopes: "read",
    });
    const response = await fetch(`${NEODB_ORIGIN}/api/v1/apps`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) throw new Error("暂时无法连接 NeoDB 登录");
    const registration = await response.json();
    client = {
      clientId: registration.client_id,
      clientSecret: registration.client_secret,
      redirectUri,
    };
    window.localStorage.setItem(
      NEODB_OAUTH_CLIENT_KEY,
      JSON.stringify(client),
    );
    notifySharedLocalStateChanged();
  }

  const state = crypto.randomUUID();
  window.sessionStorage.setItem(
    NEODB_OAUTH_PENDING_KEY,
    JSON.stringify({ ...client, state }),
  );
  const authorize = new URL(`${NEODB_ORIGIN}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: "read",
    state,
  }).toString();
  window.location.assign(authorize);
}

export async function finishNeoDbLogin(code, returnedState) {
  let pending = null;
  try {
    pending = JSON.parse(
      window.sessionStorage.getItem(NEODB_OAUTH_PENDING_KEY),
    );
  } catch {
    pending = null;
  }
  if (!pending || returnedState !== pending.state) {
    throw new Error("登录校验已过期，请重新连接 NeoDB");
  }
  const response = await fetch(`${NEODB_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: pending.clientId,
      client_secret: pending.clientSecret,
      code,
      redirect_uri: pending.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error("NeoDB 登录没有完成，请重新尝试");
  const token = await response.json();
  window.sessionStorage.setItem(
    NEODB_ACCESS_TOKEN_KEY,
    token.access_token,
  );
  window.sessionStorage.removeItem(NEODB_OAUTH_PENDING_KEY);
  return token.access_token;
}

export async function getNeoDbProfile(token) {
  return fetchNeoDb("/api/me", token);
}

export async function pullNeoDbDelta(
  releases,
  token,
  previousState = {},
  { forceFull = false, identityReleases = releases } = {},
) {
  let canonicalAliases = buildNeoDbCanonicalAliases(identityReleases);
  const localSourceIds = getNeoDbSourceIds(releases);
  const identitySourceIds = getNeoDbSourceIds(identityReleases);
  const orphanLinkedSourceIds = getOrphanNeoDbLinkedSourceIds(releases);
  const unlinkedSourceIds = getUnlinkedNeoDbSourceIds(releases);
  const unlinkedPlatformSourceIds = getUnlinkedPlatformSourceIds(releases);
  const auditableSourceIds = new Set([
    ...localSourceIds,
    ...orphanLinkedSourceIds,
    ...unlinkedPlatformSourceIds,
  ]);
  const knownIds = new Set([
    ...auditableSourceIds,
    ...Object.keys(previousState.snapshot ?? {}),
  ]);
  const pageMap = new Map();
  const firstPages = await Promise.all(
    SHELF_TYPES.map(async (shelfType) => {
      const page = await fetchMarkPage(token, shelfType, 1);
      const normalizedPage = {
        ...page,
        data: page.data.map((mark) =>
          canonicalizeNeoDbMark(mark, canonicalAliases),
        ),
      };
      pageMap.set(`${shelfType}:1`, normalizedPage);
      return [shelfType, normalizedPage];
    }),
  );
  const firstPageByShelf = new Map(firstPages);
  const totalPagesByShelf = Object.fromEntries(
    firstPages.map(([shelfType, page]) => [
      shelfType,
      Math.max(page.pages, 1),
    ]),
  );
  const remoteCount = firstPages.reduce(
    (total, [, page]) => total + page.count,
    0,
  );
  const previousCount =
    previousState.remoteCount == null
      ? localSourceIds.size
      : previousState.remoteCount;
  const shouldReconcile =
    forceFull ||
    (knownIds.size === 0 && remoteCount > 0) ||
    remoteCount < previousCount;

  async function addPage(shelfType, pageNumber) {
    const key = `${shelfType}:${pageNumber}`;
    if (pageMap.has(key)) return pageMap.get(key);
    const page = await fetchMarkPage(token, shelfType, pageNumber);
    const normalizedPage = {
      ...page,
      data: page.data.map((mark) =>
        canonicalizeNeoDbMark(mark, canonicalAliases),
      ),
    };
    pageMap.set(key, normalizedPage);
    return normalizedPage;
  }

  const pagesBeyondFirst = shelfPagesBeyondFirst(totalPagesByShelf);
  if (shouldReconcile) {
    await mapWithConcurrency(
      pagesBeyondFirst,
      4,
      ([shelfType, page]) => addPage(shelfType, page),
    );
  } else {
    if (pagesBeyondFirst.length) {
      const auditIndex =
        Math.max(previousState.auditCursor ?? 0, 0) %
        pagesBeyondFirst.length;
      const [auditShelfType, auditPage] = pagesBeyondFirst[auditIndex];
      await addPage(auditShelfType, auditPage);
    }

    if (remoteCount > previousCount) {
      const expectedNew = remoteCount - previousCount;
      const foundNewIds = new Set(
        firstPages
          .flatMap(([, page]) => page.data)
          .filter((mark) => !knownIds.has(mark.item.uuid))
          .map((mark) => mark.item.uuid),
      );
      let page = 2;
      const maxPages = Math.max(...Object.values(totalPagesByShelf));
      while (
        page <= maxPages &&
        (foundNewIds.size < expectedNew || page === 2)
      ) {
        for (const shelfType of SHELF_TYPES) {
          if (page > totalPagesByShelf[shelfType]) continue;
          const shelfPage = await addPage(shelfType, page);
          shelfPage.data
            .filter((mark) => !knownIds.has(mark.item.uuid))
            .forEach((mark) => foundNewIds.add(mark.item.uuid));
        }
        page += 1;
      }
    }
  }

  const pagedMarks = [...pageMap.values()].flatMap((page) => page.data);
  const pagedSourceIds = new Set(
    pagedMarks.map((mark) => mark.item.uuid).filter(Boolean),
  );
  const knownSourceIdsToAudit = shouldReconcile
    ? []
    : [...auditableSourceIds]
        .filter((sourceItemId) => !pagedSourceIds.has(sourceItemId))
        .sort();
  const knownAuditMarks = knownSourceIdsToAudit.length
    ? await fetchKnownMarks(token, knownSourceIdsToAudit)
    : [];
  let fetchedMarkMap = new Map(
    [...pagedMarks, ...knownAuditMarks]
      .sort(
        (markA, markB) =>
          Date.parse(markA.created_time ?? 0) -
          Date.parse(markB.created_time ?? 0),
      )
      .map((mark) => [mark.item.uuid, mark]),
  );
  const missingOrphanIds = [...orphanLinkedSourceIds].filter(
    (sourceItemId) => !fetchedMarkMap.has(sourceItemId),
  );
  if (missingOrphanIds.length) {
    const orphanMarks = await mapWithConcurrency(
      missingOrphanIds,
      4,
      async (sourceItemId) => {
        const mark = await fetchNeoDb(
          `/api/me/shelf/item/${encodeURIComponent(sourceItemId)}`,
          token,
          { allow404: true },
        );
        return mark
          ? canonicalizeNeoDbMark(mark, canonicalAliases)
          : null;
      },
    );
    for (const mark of orphanMarks) {
      if (mark?.item?.uuid) fetchedMarkMap.set(mark.item.uuid, mark);
    }
  }

  // NeoDB may merge a catalog item and keep the old URL as a redirect while
  // returning the replacement UUID from the shelf API. Resolve only the old
  // local IDs that disappeared in the same run as an unmatched remote ID, so
  // normal incremental sync does not turn into a full-library URL audit.
  const unmatchedRemoteIds = new Set(
    [...fetchedMarkMap.keys()].filter(
      (sourceItemId) =>
        !findReleaseByNeoDbId(releases, sourceItemId) &&
        !findReleaseByNeoDbId(identityReleases, sourceItemId),
    ),
  );
  const missingLocalIds = new Set(
    [...auditableSourceIds].filter(
      (sourceItemId) => !fetchedMarkMap.has(sourceItemId),
    ),
  );
  let syncCanonicalResult = {
    releases,
    changedReleaseIds: [],
  };
  let canonicalIdentityError = null;
  if (unmatchedRemoteIds.size && missingLocalIds.size) {
    const candidateReleases = releases.filter((release) =>
      [
        ...neoDbIdsFromReleaseEntries(release),
        ...neoDbIdsFromReleaseLinks(release),
      ].some((sourceItemId) => missingLocalIds.has(sourceItemId)),
    );
    const candidateUrls = neoDbUrlsFromReleases(candidateReleases).filter(
      (url) => missingLocalIds.has(sourceItemIdFromUrl(url)),
    );
    try {
      const resolvedUrls = await fetchCanonicalNeoDbUrls(candidateUrls);
      const relevantMappings = Object.fromEntries(
        Object.entries(resolvedUrls).filter(([, canonicalUrl]) =>
          unmatchedRemoteIds.has(sourceItemIdFromUrl(canonicalUrl)),
        ),
      );
      if (Object.keys(relevantMappings).length) {
        syncCanonicalResult = applyNeoDbCanonicalMappings(
          releases,
          relevantMappings,
          identityReleases,
        );
        canonicalAliases = buildNeoDbCanonicalAliases([
          ...identityReleases,
          ...syncCanonicalResult.releases,
        ]);
        fetchedMarkMap = new Map(
          [...fetchedMarkMap.values()].map((mark) => {
            const canonicalMark = canonicalizeNeoDbMark(
              mark,
              canonicalAliases,
            );
            return [canonicalMark.item.uuid, canonicalMark];
          }),
        );
      }
    } catch (error) {
      canonicalIdentityError =
        error.message || "NeoDB 合并地址核验暂时不可用";
    }
  }

  const reconciledReleases = syncCanonicalResult.releases;
  const effectiveLocalSourceIds = getNeoDbSourceIds(reconciledReleases);
  const effectiveIdentitySourceIds = getNeoDbSourceIds([
    ...identityReleases,
    ...reconciledReleases,
  ]);
  const effectiveOrphanLinkedSourceIds =
    getOrphanNeoDbLinkedSourceIds(reconciledReleases);
  const effectiveUnlinkedSourceIds =
    getUnlinkedNeoDbSourceIds(reconciledReleases);
  const effectiveUnlinkedPlatformSourceIds =
    getUnlinkedPlatformSourceIds(reconciledReleases);
  const fetchedMarks = [...fetchedMarkMap.values()];
  const previousSnapshot = remapNeoDbSnapshotIds(
    previousState.snapshot ?? {},
    canonicalAliases,
  );
  const previousReviewSnapshot = remapNeoDbSnapshotIds(
    previousState.reviewSnapshot ?? {},
    canonicalAliases,
  );
  const snapshot = shouldReconcile ? {} : { ...previousSnapshot };
  const reviewSnapshot = shouldReconcile ? {} : { ...previousReviewSnapshot };
  const changedMarks = [];
  const changedMarkIds = new Set();
  const pendingSnapshotHashes = new Map();
  for (const mark of fetchedMarks) {
    const hash = neoDbMarkHash(mark);
    const needsLinkAttach =
      effectiveOrphanLinkedSourceIds.has(mark.item.uuid) ||
      effectiveUnlinkedSourceIds.has(mark.item.uuid) ||
      effectiveUnlinkedPlatformSourceIds.has(mark.item.uuid);
    const missingLocally =
      !effectiveLocalSourceIds.has(mark.item.uuid) &&
      !effectiveIdentitySourceIds.has(mark.item.uuid);
    const localRelease = findReleaseByNeoDbId(
      reconciledReleases,
      mark.item.uuid,
    );
    const localOutOfDate =
      Boolean(localRelease) && localNeoDbNeedsMarkRefresh(localRelease, mark);
    if (
      forceFull ||
      previousSnapshot[mark.item.uuid] !== hash ||
      needsLinkAttach ||
      missingLocally ||
      localOutOfDate
    ) {
      changedMarks.push(mark);
      changedMarkIds.add(mark.item.uuid);
      pendingSnapshotHashes.set(mark.item.uuid, hash);
    } else {
      snapshot[mark.item.uuid] = hash;
    }
  }
  const reviewCheckMarks = fetchedMarks.filter(
    (mark) =>
      mark?.item?.uuid &&
      !changedMarkIds.has(mark.item.uuid) &&
      (effectiveLocalSourceIds.has(mark.item.uuid) ||
        effectiveIdentitySourceIds.has(mark.item.uuid) ||
        effectiveOrphanLinkedSourceIds.has(mark.item.uuid)),
  );
  const reviewChecks = await mapWithConcurrency(
    reviewCheckMarks,
    5,
    async (mark) => {
      const review = await fetchNeoDb(
        `/api/me/review/item/${encodeURIComponent(mark.item.uuid)}`,
        token,
        { allow404: true },
      );
      return { mark, review };
    },
  );
  for (const { mark, review } of reviewChecks) {
    const reviewHash = neoDbReviewHash(review);
    if (
      forceFull ||
      previousReviewSnapshot[mark.item.uuid] !== reviewHash
    ) {
      changedMarks.push(mark);
      changedMarkIds.add(mark.item.uuid);
    }
    reviewSnapshot[mark.item.uuid] = reviewHash;
  }
  const enrichedMarks = await mapWithConcurrency(
    changedMarks,
    5,
    async (mark) => {
      const enriched = await enrichChangedMark(
        mark,
        token,
        !effectiveLocalSourceIds.has(mark.item.uuid),
      );
      reviewSnapshot[mark.item.uuid] = neoDbReviewHash(enriched.review);
      return enriched;
    },
  );

  const remoteIds = shouldReconcile
    ? new Set(fetchedMarks.map((mark) => mark.item.uuid))
    : null;
  const effectiveKnownIds = new Set([
    ...effectiveLocalSourceIds,
    ...effectiveOrphanLinkedSourceIds,
    ...effectiveUnlinkedPlatformSourceIds,
    ...Object.keys(previousSnapshot),
  ]);
  const removedSourceIds = shouldReconcile
    ? [...effectiveKnownIds].filter((id) => !remoteIds.has(id))
    : [];
  const auditCandidateCount = pagesBeyondFirst.length;
  const profile = previousState.profile ?? (await getNeoDbProfile(token));
  const nextState = {
    ...previousState,
    schemaVersion: SYNC_SCHEMA_VERSION,
    profile,
    snapshot,
    reviewSnapshot,
    remoteCount,
    auditCursor: auditCandidateCount
      ? ((previousState.auditCursor ?? 0) + 1) %
        auditCandidateCount
      : 0,
    lastSyncedAt: new Date().toISOString(),
    lastFullReconcileAt: shouldReconcile
      ? new Date().toISOString()
      : previousState.lastFullReconcileAt ?? null,
  };
  const plan = buildNeoDbSyncPlan(
    reconciledReleases,
    enrichedMarks,
    removedSourceIds,
  );
  const resolvedSourceIds = new Set([
    ...plan.unchanged,
    ...plan.updates.map((item) => item.sourceItemId),
    ...plan.additions.map((item) => item.sourceItemId),
  ]);
  for (const mark of changedMarks) {
    const sourceItemId = mark.item?.uuid;
    if (!sourceItemId || !resolvedSourceIds.has(sourceItemId)) continue;
    snapshot[sourceItemId] =
      pendingSnapshotHashes.get(sourceItemId) ?? neoDbMarkHash(mark);
  }
  return {
    plan,
    nextState,
    fetchedPages: [...pageMap.keys()].sort(),
    knownAuditCount: knownSourceIdsToAudit.length,
    knownAuditBatchCount: Math.ceil(
      knownSourceIdsToAudit.length / KNOWN_MARK_BATCH_SIZE,
    ),
    fullReconcile: shouldReconcile,
    remoteSourceIds: shouldReconcile ? [...remoteIds] : null,
    reconciledReleases,
    canonicalChangedReleaseIds: syncCanonicalResult.changedReleaseIds,
    canonicalIdentityError,
  };
}

export function getReleaseMetadataFields() {
  return METADATA_FIELDS;
}
