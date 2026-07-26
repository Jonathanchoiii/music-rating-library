import Papa from "papaparse";

export const RELEASE_TYPES = [
  "LP",
  "EP",
  "SINGLE",
  "COMPILATION",
  "MIXTAPE",
  "LIVE",
  "SOUNDTRACK",
  "OTHER",
];

const TYPE_ALIASES = new Map([
  ["album", "LP"],
  ["lp", "LP"],
  ["full-length", "LP"],
  ["专辑", "LP"],
  ["ep", "EP"],
  ["extended play", "EP"],
  ["single", "SINGLE"],
  ["单曲", "SINGLE"],
  ["compilation", "COMPILATION"],
  ["合集", "COMPILATION"],
  ["mixtape", "MIXTAPE"],
  ["live", "LIVE"],
  ["现场", "LIVE"],
  ["soundtrack", "SOUNDTRACK"],
  ["ost", "SOUNDTRACK"],
  ["原声", "SOUNDTRACK"],
]);

export const HEADER_ALIASES = {
  title: ["title", "album", "release", "专辑名", "唱片名"],
  artists: ["artists", "artist", "artist_name", "info", "艺人", "歌手"],
  primaryArtist: ["primary_artist", "primaryartist", "主要艺人"],
  releaseType: ["release_type", "type", "format", "类型"],
  releaseDate: ["release_date", "release_year", "year", "发行年份", "发行日期"],
  genres: ["genres", "genre", "流派"],
  styles: ["styles", "style", "风格"],
  catalogLanguages: [
    "catalog_languages",
    "catalog_language",
    "release_language",
    "目录语言",
  ],
  editionTypes: [
    "edition_types",
    "edition_type",
    "secondary_types",
    "版本属性",
  ],
  releaseCountries: [
    "release_countries",
    "release_country",
    "发行地区",
  ],
  labels: ["labels", "label", "record_label", "厂牌"],
  mediaFormats: ["media_formats", "media_format", "介质"],
  listenedAt: ["listened_at", "date", "listened", "timestamp", "听过日期"],
  ratedAt: ["rated_at", "rating_date", "打分日期"],
  rating10: ["rating_10", "rating", "score", "评分"],
  comment: ["comment", "review", "note", "评论", "短评"],
  coverUrl: ["cover_url", "cover", "image", "封面"],
  neodbUrl: ["neodb_url", "neodb", "neodb地址"],
  spotifyUrl: ["spotify_url", "spotify"],
  appleMusicUrl: ["apple_music_url", "applemusic", "apple_music"],
  source: ["source", "来源"],
  sourceItemId: ["source_item_id", "source_id", "原平台id"],
  isPrivate: ["is_private", "private", "私密"],
  combinedLinks: ["links", "urls", "链接"],
  markStatus: ["status", "mark_status", "状态"],
  tags: ["tags", "标签"],
};

const NEODB_ARTIST_PATH_OVERRIDES = new Map([
  ["/organization/1ykXwtydTz68rbTS1Skr3v", "DOUDOU"],
  ["/person/4hqCNGbaCePZSE4dd9vDLB", "Bruno Mars"],
  ["/person/6Y1bY6r3wUMXZJwAsyvcYt", "谭维维"],
  ["/person/5eX9hBokLUmRc4BSI9dUXl", "魏如萱"],
  ["/person/2x9PvfRaitm1Ps3qNaDup8", "周杰伦"],
  ["/person/2VoiktW7gmIMbZhf6JFD5P", "Charli xcx"],
  ["/person/68ZSGi4P5VE0YZpxJAdm21", "张震岳"],
  ["/person/4inzoGSff6HIM4Zmam2yGr", "Taylor Swift"],
  ["/person/3UZqrgeCAyDOeDBBPdnNAx", "蔡琴"],
  ["/person/43UF3KwoDCRpLSgXC6gksk", "黄立行"],
  ["/person/4yWpDxQbKNJV0Wcy8yK7JO", "Lady Gaga"],
  ["/person/38grOZ6OyVYogCOFxiEfWS", "Lizzo"],
]);

export function normalizeText(value = "") {
  return String(value)
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function cleanDisplayTitle(value = "") {
  if (value == null) return "";
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function applyCanonicalTitleEvidence(release, evidence) {
  const canonicalTitle = cleanDisplayTitle(evidence?.title);
  if (!canonicalTitle) return release;

  const aliasCandidates = [
    evidence.translatedTitle,
    release.translatedTitle,
    release.title,
    release.sourceTitle,
    ...(release.titleAliases ?? []),
  ]
    .map(cleanDisplayTitle)
    .filter(Boolean)
    .filter(
      (title) => normalizeText(title) !== normalizeText(canonicalTitle),
    );
  const titleAliases = [
    ...new Map(
      aliasCandidates.map((title) => [normalizeText(title), title]),
    ).values(),
  ];

  return {
    ...release,
    title: canonicalTitle,
    translatedTitle: titleAliases[0] ?? null,
    titleAliases,
    titleSource: evidence.source,
    titleMatchedFrom: evidence.matchedFrom,
    titleMatchedAt: evidence.verifiedAt ?? new Date().toISOString(),
    ...(evidence.platformTitle
      ? { platformTitle: cleanDisplayTitle(evidence.platformTitle) }
      : {}),
  };
}

export function reconcileCanonicalTitleOverride(baseRelease, override = {}) {
  const mergedOverride = { ...override };
  if (
    (baseRelease?.titleAliases?.length ?? 0) ||
    (override.titleAliases?.length ?? 0)
  ) {
    mergedOverride.titleAliases = [
      ...new Map(
        [
          ...(baseRelease.titleAliases ?? []),
          ...(override.titleAliases ?? []),
        ]
          .map(cleanDisplayTitle)
          .filter(Boolean)
          .map((title) => [normalizeText(title), title]),
      ).values(),
    ];
  }
  if (!baseRelease?.titleSource) return mergedOverride;
  const overrideTitle = cleanDisplayTitle(mergedOverride.title);
  const overrideTranslatedTitle = cleanDisplayTitle(
    mergedOverride.translatedTitle,
  );
  const canonicalTitleWasStoredAsAlias =
    overrideTranslatedTitle &&
    normalizeText(overrideTranslatedTitle) ===
      normalizeText(baseRelease.title);
  const oldPrimaryTitleIsNowTheAlias =
    !overrideTitle ||
    normalizeText(overrideTitle) ===
      normalizeText(baseRelease.translatedTitle);

  if (!canonicalTitleWasStoredAsAlias || !oldPrimaryTitleIsNowTheAlias) {
    return mergedOverride;
  }

  const reconciled = { ...mergedOverride };
  delete reconciled.title;
  delete reconciled.translatedTitle;
  if (Array.isArray(reconciled.titleAliases)) {
    const aliases = reconciled.titleAliases.filter(
      (title) =>
        normalizeText(title) !== normalizeText(baseRelease.title) &&
        normalizeText(title) !== normalizeText(baseRelease.translatedTitle),
    );
    if (aliases.length) reconciled.titleAliases = aliases;
    else delete reconciled.titleAliases;
  }
  return reconciled;
}

export function reconcileCanonicalExternalLinkOverride(
  baseRelease,
  override = {},
) {
  if (!Array.isArray(override.externalLinks)) return override;
  const baseNeoDbLink = (baseRelease.externalLinks ?? []).find(
    (link) => link.provider === "NEODB",
  );
  const canonicalUrl = normalizeNeoDbUrl(
    baseNeoDbLink?.canonicalUrl ?? baseNeoDbLink?.url,
  );
  const knownUrls = new Set(
    [
      baseNeoDbLink?.url,
      baseNeoDbLink?.originalUrl,
      baseNeoDbLink?.canonicalUrl,
    ]
      .map(normalizeNeoDbUrl)
      .filter(Boolean),
  );
  if (!baseNeoDbLink || !canonicalUrl || !knownUrls.size) return override;

  const overrideNeoDbUrls = override.externalLinks
    .filter((link) => link.provider === "NEODB")
    .map((link) => normalizeNeoDbUrl(link.canonicalUrl ?? link.url))
    .filter(Boolean);
  if (
    overrideNeoDbUrls.length &&
    overrideNeoDbUrls.some((url) => !knownUrls.has(url))
  ) {
    const reconciled = { ...override };
    delete reconciled.externalLinks;
    return reconciled;
  }

  let reconciled = false;
  const links = override.externalLinks.map((link) => {
    if (
      link.provider !== "NEODB" ||
      !knownUrls.has(normalizeNeoDbUrl(link.url))
    ) {
      return link;
    }
    reconciled = true;
    return baseNeoDbLink;
  });
  if (!reconciled) return override;
  return {
    ...override,
    externalLinks: [
      ...new Map(
        links.map((link) => [`${link.provider}|${link.url}`, link]),
      ).values(),
    ],
  };
}

export function reconcileCanonicalCoverOverride(
  baseRelease,
  override = {},
) {
  if (!override.coverUrl || override.coverUserConfirmed === true) {
    return override;
  }
  const exactEvidenceUrls = new Set(
    (baseRelease.coverEvidence ?? [])
      .filter((evidence) =>
        ["APPLE_LOOKUP", "SPOTIFY_OEMBED"].includes(evidence.source),
      )
      .map((evidence) => String(evidence.url ?? "").trim())
      .filter(Boolean),
  );
  if (
    baseRelease.coverSource !== "EXACT_PLATFORM_CONSENSUS" ||
    exactEvidenceUrls.size < 2 ||
    exactEvidenceUrls.has(String(override.coverUrl).trim())
  ) {
    return override;
  }
  const reconciled = { ...override };
  delete reconciled.coverUrl;
  return reconciled;
}

export function normalizeArtistField(value = "") {
  const artistName = String(value)
    .trim()
    .replace(/^artist\s*[:：]\s*/i, "")
    .trim();
  let resolvedCredit = artistName;
  for (const [entityPath, displayName] of NEODB_ARTIST_PATH_OVERRIDES) {
    resolvedCredit = resolvedCredit.replaceAll(entityPath, displayName);
  }
  if (/\/(?:person|organization)\//i.test(resolvedCredit)) return "";
  return resolvedCredit.replace(/\/{2,}/g, "/");
}

export function splitArtistCredits(artists = []) {
  const values = Array.isArray(artists) ? artists : [artists];
  return values
    .flatMap((artist) => String(artist).split(/\s*(?:\/|、)\s*/))
    .map((artist) => artist.trim())
    .filter(Boolean);
}

export function releaseMatchesArtistQuery(release, artistQuery = "") {
  const query = normalizeText(artistQuery);
  return (
    Boolean(query) &&
    splitArtistCredits(release.artists).some((artist) =>
      normalizeText(artist).includes(query),
    )
  );
}

export function releaseMatchesPrimarySearch(release, searchQuery = "") {
  const query = normalizeText(searchQuery);
  if (!query) return true;
  return (
    normalizeText(release.title).includes(query) ||
    splitArtistCredits(release.artists).some((artist) =>
      normalizeText(artist).includes(query),
    )
  );
}

export function getReleaseContextMatches(release, searchQuery = "") {
  const query = normalizeText(searchQuery);
  if (!query) return [];
  const matches = [];
  const seenText = new Set();
  const addMatch = (kind, label, text, key) => {
    const value = String(text ?? "").trim();
    const normalizedValue = normalizeText(value);
    if (
      !value ||
      !normalizedValue.includes(query) ||
      seenText.has(normalizedValue)
    ) {
      return;
    }
    seenText.add(normalizedValue);
    matches.push({ kind, label, text: value, key });
  };

  addMatch(
    "TRANSLATED_TITLE",
    "译名",
    release.translatedTitle,
    `${release.id}-translated-title`,
  );
  (release.titleAliases ?? []).forEach((title, index) =>
    addMatch("TITLE_ALIAS", "别名", title, `${release.id}-alias-${index}`),
  );
  (release.genres ?? []).forEach((genre, index) =>
    addMatch("GENRE", "流派", genre, `${release.id}-genre-${index}`),
  );
  (release.tags ?? []).forEach((tag, index) =>
    addMatch("TAG", "标签", tag, `${release.id}-tag-${index}`),
  );
  (release.listeningEntries ?? []).forEach((entry, index) =>
    addMatch(
      "COMMENT",
      "评论",
      entry.comment,
      entry.id ?? `${release.id}-comment-${index}`,
    ),
  );
  return matches;
}

export function normalizeNeoDbUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLocaleLowerCase();
    if (!(host === "neodb.social" || host.startsWith("neodb."))) {
      return null;
    }
    parsed.hostname = host;
    parsed.protocol = "https:";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeSupportedReleaseUrl(value = "") {
  const neoDbUrl = normalizeNeoDbUrl(value);
  if (neoDbUrl) {
    return {
      provider: "NEODB",
      providerLabel: "NeoDB",
      normalizedUrl: neoDbUrl,
    };
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLocaleLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    let provider = null;
    let providerLabel = "";
    if (host === "music.apple.com" && pathname.includes("/album/")) {
      provider = "APPLE_MUSIC";
      providerLabel = "Apple Music";
    }
    if (
      host === "open.spotify.com" &&
      /\/(?:intl-[^/]+\/)?album\//i.test(pathname)
    ) {
      provider = "SPOTIFY";
      providerLabel = "Spotify";
    }
    if (!provider) return null;
    parsed.protocol = "https:";
    parsed.hostname = host;
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = pathname;
    return {
      provider,
      providerLabel,
      normalizedUrl: parsed.toString().replace(/\/$/, ""),
    };
  } catch {
    return null;
  }
}

export function getRecordShelfReleaseId(value = "", currentOrigin = "") {
  const rawValue = String(value).trim();
  if (!rawValue) return null;
  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(rawValue);
    const parsed = new URL(
      rawValue,
      currentOrigin || "http://recordshelf.local",
    );
    const isCurrentOrigin =
      currentOrigin && parsed.origin === new URL(currentOrigin).origin;
    const isLocalHost = ["127.0.0.1", "localhost", "[::1]"].includes(
      parsed.hostname.toLocaleLowerCase(),
    );
    if (isAbsolute && !isCurrentOrigin && !isLocalHost) return null;
    const match = parsed.pathname.match(/^\/releases\/([^/]+)\/?$/);
    if (!match) return null;
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function getReleasePlatformUrls(release, provider) {
  const values = [
    ...(release?.externalLinks ?? [])
      .filter((link) => link.provider === provider)
      .flatMap((link) => [link.canonicalUrl, link.url]),
    ...(release?.listeningEntries ?? [])
      .filter(
        (entry) =>
          String(entry.source ?? entry.sourceProvider ?? "").toUpperCase() ===
          provider,
      )
      .flatMap((entry) => [entry.canonicalSourceUrl, entry.sourceUrl]),
  ];
  return [
    ...new Set(
      values
        .map(normalizeSupportedReleaseUrl)
        .filter((item) => item?.provider === provider)
        .map((item) => item.normalizedUrl),
    ),
  ];
}

export function findReleaseByReferenceUrl(
  releases,
  currentReleaseId,
  inputUrl,
  currentOrigin = "",
) {
  const internalReleaseId = getRecordShelfReleaseId(inputUrl, currentOrigin);
  if (internalReleaseId) {
    if (internalReleaseId === currentReleaseId) {
      return {
        status: "CURRENT_URL",
        provider: "RECORDSHELF",
        providerLabel: "RecordShelf",
        message: "这个链接指向当前发行，请输入另一个条目的链接。",
      };
    }
    const candidate = releases.find(
      (release) => release.id === internalReleaseId,
    );
    if (!candidate) {
      return {
        status: "NOT_FOUND",
        provider: "RECORDSHELF",
        providerLabel: "RecordShelf",
        message: "该 RecordShelf 链接对应的发行不在当前音乐库中。",
      };
    }
    return {
      status: "FOUND",
      provider: "RECORDSHELF",
      providerLabel: "RecordShelf",
      normalizedUrl: `/releases/${encodeURIComponent(internalReleaseId)}`,
      candidate,
    };
  }
  const platform = normalizeSupportedReleaseUrl(inputUrl);
  if (!platform) {
    return {
      status: "UNSUPPORTED_URL",
      message:
        "请输入 RecordShelf 发行详情、NeoDB、Apple Music 或 Spotify 的唱片链接。",
    };
  }
  const currentRelease = releases.find(
    (release) => release.id === currentReleaseId,
  );
  if (!currentRelease) {
    return {
      status: "CURRENT_NOT_FOUND",
      message: "当前发行已不存在，请关闭详情后重试。",
    };
  }
  if (!getReleasePlatformUrls(currentRelease, platform.provider).length) {
    return {
      status: "PLATFORM_MISMATCH",
      provider: platform.provider,
      providerLabel: platform.providerLabel,
      message: `当前发行没有 ${platform.providerLabel} 链接，不能用该平台确认合并关系。`,
    };
  }
  const matches = releases.filter(
    (release) =>
      release.id !== currentReleaseId &&
      getReleasePlatformUrls(release, platform.provider).includes(
        platform.normalizedUrl,
      ),
  );
  if (!matches.length) {
    const pointsToCurrent = getReleasePlatformUrls(
      currentRelease,
      platform.provider,
    ).includes(platform.normalizedUrl);
    return {
      status: pointsToCurrent ? "CURRENT_URL" : "NOT_FOUND",
      provider: platform.provider,
      providerLabel: platform.providerLabel,
      message: pointsToCurrent
        ? "这个链接指向当前发行，请输入另一个条目的链接。"
        : `音乐库中没有找到使用该 ${platform.providerLabel} 链接的其他条目。`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "AMBIGUOUS",
      provider: platform.provider,
      providerLabel: platform.providerLabel,
      matches,
      message: `该链接命中 ${matches.length} 条记录，请先在“设置 → 疑似重复条目”中处理。`,
    };
  }
  return {
    status: "FOUND",
    provider: platform.provider,
    providerLabel: platform.providerLabel,
    normalizedUrl: platform.normalizedUrl,
    candidate: matches[0],
  };
}

export function getReleaseNeoDbUrls(release) {
  const urls = [
    ...(release.externalLinks ?? [])
      .filter((link) => link.provider === "NEODB")
      .flatMap((link) => [link.canonicalUrl, link.url]),
    ...(release.listeningEntries ?? [])
      .filter((entry) => entry.source === "NEODB")
      .flatMap((entry) => [entry.canonicalSourceUrl, entry.sourceUrl]),
  ]
    .map(normalizeNeoDbUrl)
    .filter(Boolean);
  return [...new Set(urls)];
}

export function getReleaseSourceIdentityKeys(release) {
  const keys = [];
  for (const entry of release?.listeningEntries ?? []) {
    const source = String(entry.source ?? "").trim().toUpperCase();
    if (!source) continue;
    const sourceItemId = String(entry.sourceItemId ?? "").trim();
    if (sourceItemId) {
      keys.push(`${source}:ID:${sourceItemId}`);
      continue;
    }
    const sourceUrl =
      source === "NEODB"
        ? normalizeNeoDbUrl(entry.canonicalSourceUrl ?? entry.sourceUrl)
        : String(entry.canonicalSourceUrl ?? entry.sourceUrl ?? "").trim();
    if (sourceUrl) keys.push(`${source}:URL:${sourceUrl}`);
  }
  if (!keys.length) {
    for (const link of release?.externalLinks ?? []) {
      const provider = String(link.provider ?? "").trim().toUpperCase();
      if (!provider) continue;
      const url =
        provider === "NEODB"
          ? normalizeNeoDbUrl(link.canonicalUrl ?? link.url)
          : String(link.canonicalUrl ?? link.url ?? "").trim();
      if (url) keys.push(`${provider}:URL:${url}`);
    }
  }
  return [...new Set(keys)];
}

export function releaseImportIdentityKey(release) {
  const sourceIdentity = getReleaseSourceIdentityKeys(release)[0];
  if (sourceIdentity) return sourceIdentity;
  return `FALLBACK:${releaseFingerprint(release)}`;
}

export function releasesHaveConflictingSourceIdentities(
  releaseA,
  releaseB,
) {
  const identitiesA = getReleaseSourceIdentityKeys(releaseA);
  const identitiesB = getReleaseSourceIdentityKeys(releaseB);
  if (!identitiesA.length || !identitiesB.length) return false;
  const identitiesBSet = new Set(identitiesB);
  return !identitiesA.some((identity) => identitiesBSet.has(identity));
}

export function findExactNeoDbDuplicateGroups(releases = []) {
  const releasesByUrl = new Map();
  for (const release of releases) {
    for (const url of getReleaseNeoDbUrls(release)) {
      if (!releasesByUrl.has(url)) releasesByUrl.set(url, new Map());
      releasesByUrl.get(url).set(release.id, release);
    }
  }
  return [...releasesByUrl.entries()]
    .map(([url, releaseMap]) => ({
      id: `duplicate-${url}`,
      neodbUrl: url,
      releases: [...releaseMap.values()],
    }))
    .filter((group) => group.releases.length > 1)
    .sort(
      (groupA, groupB) =>
        groupB.releases.length - groupA.releases.length ||
        groupA.releases[0].title.localeCompare(
          groupB.releases[0].title,
          "zh-CN",
        ),
    );
}

export function groupReleasesByArtist(releases = [], artistQuery = "") {
  const query = normalizeText(artistQuery);
  const groups = new Map();

  for (const release of releases) {
    const matchingCredits = query
      ? splitArtistCredits(release.artists).filter((artist) =>
          normalizeText(artist).includes(query),
        )
      : [];
    const groupLabels = matchingCredits.length
      ? matchingCredits
      : release.artists;
    const seenLabels = new Set();

    for (const artist of groupLabels) {
      const key = query ? normalizeText(artist) : artist;
      if (!key || seenLabels.has(key)) continue;
      seenLabels.add(key);
      if (!groups.has(key)) {
        groups.set(key, { artist, releases: [] });
      }
      const group = groups.get(key);
      if (!group.releases.some((item) => item.id === release.id)) {
        group.releases.push(release);
      }
    }
  }

  return [...groups.values()];
}

export function normalizeReleaseType(value) {
  if (!value) return "OTHER";
  const normalized = normalizeText(value);
  if (RELEASE_TYPES.includes(String(value).trim().toUpperCase())) {
    return String(value).trim().toUpperCase();
  }
  return TYPE_ALIASES.get(normalized) ?? "OTHER";
}

export function normalizeExternalReleaseType(value = "") {
  const normalized = normalizeText(value);
  const matches = new Set();
  if (/(^|\W)single(\W|$)/i.test(normalized)) matches.add("SINGLE");
  if (/(^|\W)ep(\W|$)/i.test(normalized)) matches.add("EP");
  if (/(^|\W)(album|lp|long play)(\W|$)/i.test(normalized)) matches.add("LP");
  return matches.size === 1 ? [...matches][0] : null;
}

export function inferReleaseTypeFromOfficialTitle(title = "") {
  const value = String(title).trim();
  if (/(?:\s[-–—]\s*|\s*\()single\)?$/i.test(value)) return "SINGLE";
  if (/(?:\s[-–—]\s*|\s*\()ep\)?$/i.test(value)) return "EP";
  return null;
}

export function getDatePrecision(value) {
  if (!value) return "UNKNOWN";
  const text = String(value).trim();
  if (/^\d{4}$/.test(text)) return "YEAR";
  if (/^\d{4}-\d{2}$/.test(text)) return "MONTH";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "DAY";
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(text) &&
    !Number.isNaN(Date.parse(text))
  ) {
    return "DAY";
  }
  return "UNKNOWN";
}

export function displayDate(value, precision = getDatePrecision(value)) {
  if (!value) return "未记录";
  if (precision === "YEAR") return String(value).slice(0, 4);
  if (precision === "MONTH") return String(value).slice(0, 7);
  return String(value).slice(0, 10);
}

export function getCurrentRating(entries = []) {
  const rated = entries
    .filter((entry) => Number.isInteger(entry.rating10))
    .sort((a, b) => {
      const dateA = Date.parse(a.ratedAt ?? a.createdAt ?? 0);
      const dateB = Date.parse(b.ratedAt ?? b.createdAt ?? 0);
      return dateB - dateA;
    });
  return rated[0]?.rating10 ?? null;
}

export function getLatestListenedAt(entries = []) {
  return (
    entries
      .map((entry) => entry.listenedAt)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  );
}

export function getLatestMarkedAt(entries = []) {
  return (
    entries
      .map(
        (entry) =>
          entry.markedAt ??
          entry.listenedAt ??
          entry.ratedAt ??
          entry.createdAt ??
          null,
      )
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  );
}

export function getReleaseKindLabel(release) {
  if (release.releaseType !== "OTHER") return release.releaseType;
  return (
    {
      complete: "听过",
      progress: "在听",
      wishlist: "想听",
    }[release.markStatus] ?? "未分类"
  );
}

export function scoreToStars(score) {
  return score == null ? null : score / 2;
}

export function getNextVisibleLimit(current, total, pageSize = 84) {
  return Math.min(Math.max(0, current) + pageSize, Math.max(0, total));
}

export function compareReleaseDates(
  releaseA,
  releaseB,
  direction = "desc",
) {
  const dateA = releaseA.releaseDate;
  const dateB = releaseB.releaseDate;
  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;
  const comparableA = Number(dateA.replaceAll("-", "").padEnd(8, "0"));
  const comparableB = Number(dateB.replaceAll("-", "").padEnd(8, "0"));
  return direction === "asc"
    ? comparableA - comparableB
    : comparableB - comparableA;
}

export function releaseFingerprint({
  title,
  artists = [],
  releaseDate = "",
  releaseType = "OTHER",
}) {
  const artistValue = Array.isArray(artists) ? artists[0] : artists;
  return [
    normalizeText(title),
    normalizeText(artistValue),
    String(releaseDate).slice(0, 4),
    normalizeReleaseType(releaseType),
  ].join("|");
}

function releaseTitleFingerprints(release) {
  return [
    release.title,
    release.translatedTitle,
    ...(release.titleAliases ?? []),
  ]
    .filter(Boolean)
    .map((title) => releaseFingerprint({ ...release, title }));
}

export function detectHeaderMap(headers = []) {
  const normalizedHeaders = new Map(
    headers.map((header) => [normalizeText(header).replace(/\s/g, "_"), header]),
  );
  return Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([field, aliases]) => {
      const originalHeader = aliases
        .map((alias) => normalizeText(alias).replace(/\s/g, "_"))
        .map((alias) => normalizedHeaders.get(alias))
        .find(Boolean);
      return [field, originalHeader ?? null];
    }),
  );
}

export function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.trim(),
      complete: (result) => resolve(result),
      error: reject,
    });
  });
}

function valueFromRow(row, headerMap, key) {
  const header = headerMap[key];
  return header ? row[header] : "";
}

function parseBoolean(value) {
  return ["true", "1", "yes", "是"].includes(normalizeText(value));
}

function urlsFromValue(value) {
  return String(value ?? "").match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
}

function providerFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLocaleLowerCase();
    if (hostname === "open.spotify.com") return "SPOTIFY";
    if (hostname === "music.apple.com") return "APPLE_MUSIC";
    if (hostname === "music.douban.com") return "DOUBAN";
    if (hostname === "rateyourmusic.com") return "RYM";
    if (hostname === "musicbrainz.org") return "MUSICBRAINZ";
    if (hostname.endsWith("discogs.com")) return "DISCOGS";
    if (hostname.startsWith("neodb.") || hostname === "neodb.social") {
      return "NEODB";
    }
    return "OTHER";
  } catch {
    return null;
  }
}

function platformLinksFromRow(row, headerMap) {
  const directLinks = [
    ["NEODB", valueFromRow(row, headerMap, "neodbUrl")],
    ["SPOTIFY", valueFromRow(row, headerMap, "spotifyUrl")],
    ["APPLE_MUSIC", valueFromRow(row, headerMap, "appleMusicUrl")],
  ];
  const combinedLinks = urlsFromValue(
    valueFromRow(row, headerMap, "combinedLinks"),
  ).map((url) => [providerFromUrl(url), url]);
  const seen = new Set();
  return [...directLinks, ...combinedLinks]
    .filter(([, url]) => /^https?:\/\//i.test(String(url).trim()))
    .filter(([provider]) => provider)
    .map(([provider, url]) => ({
      provider,
      url: String(url).trim(),
      status: "CONFIRMED",
    }))
    .filter((link) => {
      const key = `${link.provider}|${link.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sourceItemIdFromUrl(url) {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function csvRowToRelease(row, headerMap, rowNumber = 1) {
  const title = String(valueFromRow(row, headerMap, "title") ?? "").trim();
  const artistString = String(
    valueFromRow(row, headerMap, "artists") ??
      valueFromRow(row, headerMap, "primaryArtist") ??
      "",
  ).trim();
  const artists = artistString
    .split(";")
    .map(normalizeArtistField)
    .filter(Boolean);
  const externalLinks = platformLinksFromRow(row, headerMap);
  const neodbLink = externalLinks.find((link) => link.provider === "NEODB");
  const isNeoDbPreset =
    Boolean(neodbLink) ||
    normalizeText(headerMap.artists) === "info" ||
    normalizeText(headerMap.combinedLinks) === "links";
  const ratingValue = Number(valueFromRow(row, headerMap, "rating10"));
  const rating10 =
    Number.isInteger(ratingValue) && ratingValue >= 1 && ratingValue <= 10
      ? ratingValue
      : null;
  const rawTimestamp =
    String(valueFromRow(row, headerMap, "listenedAt") ?? "").trim() || null;
  const markStatus =
    normalizeText(valueFromRow(row, headerMap, "markStatus")) || "complete";
  const listenedAt =
    isNeoDbPreset && markStatus === "wishlist" ? null : rawTimestamp;
  const ratedAt =
    (String(valueFromRow(row, headerMap, "ratedAt") ?? "").trim() ||
      (isNeoDbPreset && rating10 != null ? rawTimestamp : "")) ||
    null;
  const releaseDate =
    String(valueFromRow(row, headerMap, "releaseDate") ?? "").trim() || null;
  const declaredSource =
    String(valueFromRow(row, headerMap, "source") ?? "CSV")
      .trim()
      .toUpperCase() || "CSV";
  const source = isNeoDbPreset ? "NEODB" : declaredSource;
  const sourceItemId =
    String(valueFromRow(row, headerMap, "sourceItemId") ?? "").trim() ||
    sourceItemIdFromUrl(neodbLink?.url);

  const errors = [];
  const warnings = [];
  if (!title) errors.push("缺少发行标题");
  if (!artists.length) errors.push("缺少艺人");
  if (
    valueFromRow(row, headerMap, "rating10") &&
    rating10 == null
  ) {
    errors.push("评分必须是 1–10 的整数");
  }
  if (releaseDate && getDatePrecision(releaseDate) === "UNKNOWN") {
    errors.push("发行日期格式无法识别");
  }
  const releaseType = normalizeReleaseType(
    valueFromRow(row, headerMap, "releaseType"),
  );
  if (
    valueFromRow(row, headerMap, "releaseType") &&
    releaseType === "OTHER"
  ) {
    warnings.push("未知发行类型，已归为 Other");
  }
  if (!valueFromRow(row, headerMap, "coverUrl")) {
    warnings.push("没有封面，可稍后补充");
  }

  const createdAt = rawTimestamp || new Date().toISOString();
  const importedFacets = Object.fromEntries(
    [
      "genres",
      "styles",
      "catalogLanguages",
      "editionTypes",
      "releaseCountries",
      "labels",
      "mediaFormats",
    ].map((field) => [
      field,
      String(valueFromRow(row, headerMap, field) ?? "")
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  );
  const stableReleaseKey =
    sourceItemId || `${title}|${artists.join(";")}|${rowNumber}`;
  const stableEntryKey = `${stableReleaseKey}|${rawTimestamp}|${rating10}|${rowNumber}`;
  const id = `release-import-${source.toLowerCase()}-${stableHash(stableReleaseKey)}`;
  return {
    status: errors.length ? "INVALID" : warnings.length ? "WARNING" : "READY",
    errors,
    warnings,
    release: {
      id,
      title,
      artists,
      releaseType,
      releaseDate,
      releaseDatePrecision: getDatePrecision(releaseDate),
      ...importedFacets,
      ...(importedFacets.genres.length
        ? { genreSource: "USER_PROVIDED_IMPORT" }
        : {}),
      ...(importedFacets.styles.length
        ? { styleSource: "USER_PROVIDED_IMPORT" }
        : {}),
      ...(importedFacets.catalogLanguages.length
        ? { catalogLanguageSource: "USER_PROVIDED_IMPORT" }
        : {}),
      ...(importedFacets.editionTypes.length
        ? { editionTypeSource: "USER_PROVIDED_IMPORT" }
        : {}),
      ...(importedFacets.releaseCountries.length
        ? { releaseCountrySource: "USER_PROVIDED_IMPORT" }
        : {}),
      ...(importedFacets.labels.length
        ? { labelSource: "USER_PROVIDED_IMPORT" }
        : {}),
      ...(importedFacets.mediaFormats.length
        ? { mediaFormatSource: "USER_PROVIDED_IMPORT" }
        : {}),
      coverUrl:
        String(valueFromRow(row, headerMap, "coverUrl") ?? "").trim() || null,
      isPrivate: parseBoolean(valueFromRow(row, headerMap, "isPrivate")),
      externalLinks,
      markStatus,
      tags: String(valueFromRow(row, headerMap, "tags") ?? "")
        .split("|")
        .map((tag) => tag.trim())
        .filter(Boolean),
      listeningEntries: [
        {
          id: `entry-import-${source.toLowerCase()}-${stableHash(stableEntryKey)}`,
          listenedAt,
          listenedAtPrecision: getDatePrecision(listenedAt),
          ratedAt,
          rating10,
          comment:
            String(valueFromRow(row, headerMap, "comment") ?? "").trim() || null,
          source,
          sourceUrl: externalLinks.find((link) => link.provider === source)?.url ?? null,
          sourceItemId,
          markStatus,
          markedAt: rawTimestamp,
          importRowNumber: rowNumber,
          createdAt,
        },
      ],
    },
  };
}

export function classifyImportedRelease(candidate, existingReleases) {
  const entry = candidate.release.listeningEntries[0];
  if (candidate.status === "INVALID") return candidate;
  const strongDuplicate = existingReleases.find((release) =>
    release.listeningEntries.some(
      (existingEntry) =>
        entry.sourceItemId &&
        existingEntry.source === entry.source &&
        existingEntry.sourceItemId === entry.sourceItemId,
    ),
  );
  if (strongDuplicate) {
    return {
      ...candidate,
      status: "DUPLICATE",
      duplicateOf: strongDuplicate.id,
      warnings: [...candidate.warnings, "相同来源 ID 已存在，将默认跳过"],
    };
  }
  const fingerprint = releaseFingerprint(candidate.release);
  const probableDuplicate = existingReleases.find(
    (release) =>
      !releasesHaveConflictingSourceIdentities(candidate.release, release) &&
      releaseTitleFingerprints(release).includes(fingerprint),
  );
  if (probableDuplicate) {
    return {
      ...candidate,
      status: "DUPLICATE",
      duplicateOf: probableDuplicate.id,
      warnings: [
        ...candidate.warnings,
        "找到相同发行，将作为新的听歌记录追加",
      ],
    };
  }
  return candidate;
}
