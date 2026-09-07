import { ARTIST_PROFILE_STORAGE_KEY } from "./sharedStorageKeys.js";

export const EMPTY_ARTIST_PROFILE_STATE = Object.freeze({
  version: 4,
  profiles: {},
});

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

const ROAM_COUNTRY_AUDIT_STATUSES = new Set([
  "CONFIRMED",
  "NO_COUNTRY",
  "AMBIGUOUS",
]);

const ROAM_COUNTRY_AUDIT_EVIDENCE = new Set([
  "CONFIRMED_MBID",
  "EXACT_RELEASE_GROUP",
  "WIKIDATA_COUNTRY",
  "USER_CONFIRMED_APPLE",
  "USER_CONFIRMED",
]);

const USER_CONFIRMED_ROAM_COUNTRY_EVIDENCE = new Set([
  "USER_CONFIRMED_APPLE",
  "USER_CONFIRMED",
]);

const VERIFIED_ROAM_COUNTRY_EVIDENCE = new Set([
  "WIKIDATA_COUNTRY",
  "USER_CONFIRMED_APPLE",
  "USER_CONFIRMED",
]);

function isUserConfirmedCountryAudit(audit) {
  return Boolean(
    audit?.status === "CONFIRMED" &&
      USER_CONFIRMED_ROAM_COUNTRY_EVIDENCE.has(audit?.evidence),
  );
}

export function hasUserConfirmedArtistCountry(profile) {
  return Boolean(
    cleanText(profile?.publicFacts?.country) &&
      isUserConfirmedCountryAudit(profile?.roamCountryAudit),
  );
}

export function hasVerifiedArtistCountry(profile) {
  return Boolean(
      cleanText(profile?.publicFacts?.country) &&
      profile?.roamCountryAudit?.status === "CONFIRMED" &&
      VERIFIED_ROAM_COUNTRY_EVIDENCE.has(profile?.roamCountryAudit?.evidence),
  );
}

function sanitizeRoamCountryAudit(value) {
  const audit = value && typeof value === "object" ? value : {};
  const status = ROAM_COUNTRY_AUDIT_STATUSES.has(audit.status)
    ? audit.status
    : "EMPTY";
  const checkedAt = cleanText(audit.checkedAt);
  const identityFingerprint = cleanText(audit.identityFingerprint).toLowerCase();
  if (
    status === "EMPTY" ||
    !Number.isFinite(Date.parse(checkedAt)) ||
    !/^v1:[0-9a-f]{16}$/.test(identityFingerprint)
  ) {
    return {
      status: "EMPTY",
      checkedAt: "",
      identityFingerprint: "",
      evidence: "",
    };
  }
  return {
    status,
    checkedAt,
    identityFingerprint,
    evidence: ROAM_COUNTRY_AUDIT_EVIDENCE.has(audit.evidence)
      ? audit.evidence
      : "",
  };
}

function normalizedArtistNameHint(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

export function decodeArtistProfileId(artistId) {
  const trimmed = cleanText(artistId);
  if (!trimmed) return "";
  const plusNormalized = trimmed.replaceAll("+", " ");
  if (!/%[0-9a-fA-F]{2}/.test(plusNormalized)) return plusNormalized;
  try {
    return decodeURIComponent(plusNormalized);
  } catch {
    return plusNormalized;
  }
}

export function artistProfileLookupKeys(artistId, nameHints = []) {
  const keys = [];
  const seen = new Set();
  const add = (value) => {
    const trimmed = cleanText(value);
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    keys.push(trimmed);
  };
  add(artistId);
  add(decodeArtistProfileId(artistId));
  const raw = String(artistId ?? "");
  add(raw.replaceAll("+", " "));
  add(raw.replaceAll(" ", "+"));
  for (const name of nameHints) {
    const normalized = normalizedArtistNameHint(name);
    if (normalized) add(`raw-${normalized}`);
  }
  return keys;
}

function preferText(primary, fallback) {
  return cleanText(primary) || cleanText(fallback);
}

function preferPlatformLinks(primary, fallback) {
  const left = sanitizePlatformLinks(primary);
  const right = sanitizePlatformLinks(fallback);
  return {
    appleMusic: preferText(left.appleMusic, right.appleMusic),
    spotify: preferText(left.spotify, right.spotify),
    youtubeMusic: preferText(left.youtubeMusic, right.youtubeMusic),
  };
}

function preferMedia(primary, fallback) {
  const left = sanitizeMedia(primary);
  const right = sanitizeMedia(fallback);
  return {
    ...right,
    ...left,
    imageUrl: preferText(left.imageUrl, right.imageUrl),
    localImageUrl: preferText(left.localImageUrl, right.localImageUrl),
    localMotionUrl: preferText(left.localMotionUrl, right.localMotionUrl),
    sourceVideoUrl: preferText(left.sourceVideoUrl, right.sourceVideoUrl),
    source: preferText(left.source, right.source),
    checkedAt: preferText(left.checkedAt, right.checkedAt),
    notice: preferText(left.notice, right.notice),
    error: left.error || right.error,
    status: left.status !== "EMPTY" ? left.status : right.status,
    motionEnabled: left.motionEnabled,
    truncated: left.truncated === true || right.truncated === true,
  };
}

function preferExplorationCatalog(primary, fallback) {
  const left = sanitizeExplorationCatalog(primary);
  const right = sanitizeExplorationCatalog(fallback);
  if (left.status === "READY" && left.releases.length) return left;
  if (right.status === "READY" && right.releases.length) return right;
  return left.checkedAt || left.status !== "EMPTY" ? left : right;
}

function preferRoamCountryAudit(primary, fallback) {
  const left = sanitizeRoamCountryAudit(primary);
  const right = sanitizeRoamCountryAudit(fallback);
  if (isUserConfirmedCountryAudit(left)) return left;
  if (isUserConfirmedCountryAudit(right)) return right;
  return left.status !== "EMPTY" ? left : right;
}

function mergePreferredArtistProfile(primary, fallback) {
  const left = sanitizeArtistProfile(primary);
  const right = sanitizeArtistProfile(fallback);
  const roamCountryAudit = preferRoamCountryAudit(
    left.roamCountryAudit,
    right.roamCountryAudit,
  );
  const publicFacts = mergePublicFacts(right.publicFacts, left.publicFacts);
  if (hasUserConfirmedArtistCountry(left)) {
    publicFacts.country = left.publicFacts.country;
  } else if (hasUserConfirmedArtistCountry(right)) {
    publicFacts.country = right.publicFacts.country;
  }
  return sanitizeArtistProfile({
    ...right,
    ...left,
    introduction: preferText(left.introduction, right.introduction),
    platformLinks: preferPlatformLinks(left.platformLinks, right.platformLinks),
    media: preferMedia(left.media, right.media),
    explorationCatalog: preferExplorationCatalog(
      left.explorationCatalog,
      right.explorationCatalog,
    ),
    roamCountryAudit,
    publicFacts,
    sources: left.sources.length ? left.sources : right.sources,
    updatedAt: preferText(left.updatedAt, right.updatedAt),
  });
}

export function getArtistProfile(state, artistId, nameHints = []) {
  const profiles =
    state && typeof state === "object" && state.profiles && typeof state.profiles === "object"
      ? state.profiles
      : {};
  for (const key of artistProfileLookupKeys(artistId, nameHints)) {
    if (profiles[key]) return profiles[key];
  }
  const wanted = new Set(
    artistProfileLookupKeys(artistId, nameHints).map(decodeArtistProfileId),
  );
  for (const [key, profile] of Object.entries(profiles)) {
    if (wanted.has(decodeArtistProfileId(key))) return profile;
  }
  return EMPTY_ARTIST_PROFILE;
}

function cleanTextList(value, limit = 12) {
  return Array.isArray(value)
    ? [...new Set(value.map(cleanText).filter(Boolean))].slice(0, limit)
    : [];
}

const ARTIST_PLATFORM_RULES = Object.freeze({
  appleMusic: {
    host: /(^|\.)music\.apple\.com$/i,
    path: /\/artist\//i,
  },
  spotify: {
    host: /(^|\.)open\.spotify\.com$/i,
    path: /^\/artist\//i,
  },
  youtubeMusic: {
    host: /(^|\.)music\.youtube\.com$/i,
    path: /^\/(?:channel|browse)\//i,
  },
});

export function normalizeArtistPlatformUrl(provider, value) {
  const rule = ARTIST_PLATFORM_RULES[provider];
  if (!rule || !cleanText(value)) return "";
  try {
    const url = new URL(cleanText(value));
    if (url.protocol !== "https:" || !rule.host.test(url.hostname) || !rule.path.test(url.pathname)) {
      return "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sanitizePlatformLinks(value) {
  const links = value && typeof value === "object" ? value : {};
  return {
    appleMusic: normalizeArtistPlatformUrl("appleMusic", links.appleMusic),
    spotify: normalizeArtistPlatformUrl("spotify", links.spotify),
    youtubeMusic: normalizeArtistPlatformUrl("youtubeMusic", links.youtubeMusic),
  };
}

function looksLikeArtistMotionStill(value) {
  const href = String(value ?? "");
  return (
    /nonvideo|previewimage|preview[_-]?image|\/image\/thumb\//i.test(href) ||
    /\.(webp|png|jpe?g|gif)(?:$|[/?#])/i.test(href)
  );
}

function looksLikePlayableAppleHls(value) {
  try {
    const url = new URL(String(value ?? ""));
    return (
      url.protocol === "https:" &&
      /(^|\.)itunes\.apple\.com$/i.test(url.hostname) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

function privateArtistMotionUrl(value) {
  return /^\/private-motion-artwork\/[a-zA-Z0-9._-]+\.(?:webp|mp4)$/.test(
    cleanText(value),
  )
    ? cleanText(value)
    : "";
}

function privateArtistImageUrl(value) {
  return /^\/private-motion-artwork\/[a-zA-Z0-9._-]+\.(?:webp|png|jpe?g)$/.test(
    cleanText(value),
  )
    ? cleanText(value)
    : "";
}

export function visibleArtistMediaMessage(media) {
  const notice = cleanText(media?.notice);
  const error = cleanText(media?.error);
  const source = cleanText(media?.sourceVideoUrl);
  const localMotionUrl = privateArtistMotionUrl(media?.localMotionUrl);
  if (/地址无效/.test(error)) {
    if (
      localMotionUrl ||
      looksLikeArtistMotionStill(source) ||
      looksLikePlayableAppleHls(source) ||
      !source
    ) {
      return notice;
    }
  }
  return error || notice;
}

function sanitizeMediaError(media) {
  const error = cleanText(media.error);
  return visibleArtistMediaMessage({ ...media, error, notice: "" }) ? error : "";
}

function sanitizeMedia(value) {
  const media = value && typeof value === "object" ? value : {};
  const localMotionUrl = privateArtistMotionUrl(media.localMotionUrl);
  return {
    status: ["EMPTY", "CHECKING", "READY", "IMAGE_ONLY", "UNAVAILABLE", "FAILED"].includes(media.status)
      ? media.status
      : "EMPTY",
    imageUrl: cleanText(media.imageUrl),
    localImageUrl: privateArtistImageUrl(media.localImageUrl),
    localMotionUrl,
    sourceVideoUrl: cleanText(media.sourceVideoUrl),
    motionEnabled: media.motionEnabled !== false,
    source: cleanText(media.source),
    checkedAt: cleanText(media.checkedAt),
    truncated: media.truncated === true,
    notice: cleanText(media.notice),
    error: sanitizeMediaError({ ...media, localMotionUrl }),
  };
}

function safeHttpsUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function sanitizeExplorationTrack(value) {
  const track = value && typeof value === "object" ? value : {};
  const id = cleanText(track.id);
  const title = cleanText(track.title);
  if (!id || !title) return null;
  return {
    id,
    isrc: cleanText(track.isrc),
    title,
    artistName: cleanText(track.artistName),
    durationMs: Math.max(0, Math.round(Number(track.durationMs) || 0)),
    discNumber: Math.max(1, Math.round(Number(track.discNumber) || 1)),
    trackNumber: Math.max(1, Math.round(Number(track.trackNumber) || 1)),
    url: safeHttpsUrl(track.url),
  };
}

function sanitizeExplorationRelease(value) {
  const release = value && typeof value === "object" ? value : {};
  const id = cleanText(release.id);
  const title = cleanText(release.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    artistName: cleanText(release.artistName),
    releaseType: ["LP", "EP", "SINGLE"].includes(release.releaseType)
      ? release.releaseType
      : "LP",
    releaseDate: cleanText(release.releaseDate),
    artworkUrl: safeHttpsUrl(release.artworkUrl),
    url: safeHttpsUrl(release.url),
    trackCount: Math.max(0, Math.round(Number(release.trackCount) || 0)),
    upc: cleanText(release.upc),
    isCompilation: release.isCompilation === true,
    tracks: Array.isArray(release.tracks)
      ? release.tracks.map(sanitizeExplorationTrack).filter(Boolean).slice(0, 300)
      : [],
  };
}

function sanitizeExplorationCatalog(value) {
  const catalog = value && typeof value === "object" ? value : {};
  return {
    status: ["EMPTY", "CHECKING", "READY", "FAILED"].includes(catalog.status)
      ? catalog.status
      : "EMPTY",
    source: cleanText(catalog.source),
    artistId: cleanText(catalog.artistId),
    storefront: /^[a-z]{2}$/i.test(cleanText(catalog.storefront))
      ? cleanText(catalog.storefront).toLocaleLowerCase()
      : "",
    artistName: cleanText(catalog.artistName),
    artistUrl: normalizeArtistPlatformUrl("appleMusic", catalog.artistUrl),
    checkedAt: cleanText(catalog.checkedAt),
    releases: Array.isArray(catalog.releases)
      ? catalog.releases
          .map(sanitizeExplorationRelease)
          .filter(Boolean)
          .slice(0, 400)
      : [],
    error: cleanText(catalog.error),
  };
}

function sanitizeMembers(value) {
  return Array.isArray(value)
    ? value
        .map((member) => ({
          id: cleanText(member?.id),
          name: cleanText(member?.name),
          role: cleanText(member?.role),
          activePeriod: cleanText(member?.activePeriod),
          sourceIds: cleanTextList(member?.sourceIds, 8),
          begin: cleanText(member?.begin),
          end: cleanText(member?.end),
        }))
        .filter((member) => member.name)
        .slice(0, 30)
    : [];
}

function sanitizeRecommendedListening(value) {
  return Array.isArray(value)
    ? value
        .map((item) => ({
          title: cleanText(item?.title),
          workType: ["song", "album", "EP", "live", "other"].includes(item?.workType)
            ? item.workType
            : "other",
          reason: cleanText(item?.reason),
        }))
        .filter((item) => item.title && item.reason)
        .slice(0, 8)
    : [];
}

function sanitizeAwardItems(value, allowedResults) {
  return Array.isArray(value)
    ? value
        .map((item) => ({
          year: cleanText(item?.year),
          award: cleanText(item?.award),
          category: cleanText(item?.category),
          work: cleanText(item?.work),
          result: allowedResults.includes(item?.result) ? item.result : allowedResults[0],
          sourceIds: cleanTextList(item?.sourceIds, 8),
        }))
        .filter((item) => item.year && item.award && item.category)
        .slice(0, 40)
    : [];
}

function sanitizeFilmRelationships(value) {
  const relationships = ["won", "nominated", "shortlisted", "performed", "wrote", "produced", "used"];
  return Array.isArray(value)
    ? value
        .map((item) => ({
          year: cleanText(item?.year),
          film: cleanText(item?.film),
          work: cleanText(item?.work),
          relationship: relationships.includes(item?.relationship) ? item.relationship : "used",
          award: cleanText(item?.award),
          category: cleanText(item?.category),
          sourceIds: cleanTextList(item?.sourceIds, 8),
        }))
        .filter((item) => item.film && item.work)
        .slice(0, 30)
    : [];
}

function sanitizeClaimSources(value) {
  return Array.isArray(value)
    ? value
        .map((item) => ({ claim: cleanText(item?.claim), sourceIds: cleanTextList(item?.sourceIds, 12) }))
        .filter((item) => item.claim && item.sourceIds.length)
        .slice(0, 80)
    : [];
}

function sanitizePublicFacts(value) {
  const facts = value && typeof value === "object" ? value : {};
  return {
    resolvedName: cleanText(facts.resolvedName),
    artistType: cleanText(facts.artistType),
    gender: cleanText(facts.gender),
    birthDate: cleanText(facts.birthDate),
    activeFrom: cleanText(facts.activeFrom),
    endedAt: cleanText(facts.endedAt),
    birthPlace: cleanText(facts.birthPlace),
    origin: cleanText(facts.origin),
    country: cleanText(facts.country),
    musicBrainzId: cleanText(facts.musicBrainzId),
    genres: cleanTextList(facts.genres),
    members: sanitizeMembers(facts.members),
  };
}

export function hasUsefulArtistPublicFacts(facts) {
  const value = sanitizePublicFacts(facts);
  return Boolean(
    value.resolvedName ||
      value.artistType ||
      value.birthDate ||
      value.activeFrom ||
      value.birthPlace ||
      value.origin ||
      value.country ||
      value.genres.length ||
      value.members.some((member) => member.name),
  );
}

const ACTIVE_ARTIST_RESEARCH_JOB_STATUSES = new Set([
  "PREPARING",
  "SEARCHING",
  "VERIFYING",
  "WRITING",
  "SAVING",
  "RESEARCHING",
]);

export const ARTIST_RESEARCH_ERROR_MESSAGES = Object.freeze({
  CODEX_CLI_UNAVAILABLE: "本机未找到 Codex CLI，也没有足够的 MusicBrainz / Wikipedia 公开档案。",
  CODEX_AUTH_REQUIRED: "Codex 尚未登录，也没有足够的可核验公开档案。",
  CODEX_NOT_LOGGED_IN: "Codex 尚未登录，也没有足够的可核验公开档案。",
  CODEX_RESEARCH_TIMEOUT: "Codex 联网研究超时，也没有足够的可核验公开档案。",
  ARTIST_RESEARCH_TIMEOUT: "Codex 联网研究超时，也没有足够的可核验公开档案。",
  CODEX_RESEARCH_FAILED: "Codex 联网研究没有完成，也没有足够的可核验公开档案。",
  CODEX_MODEL_UNSUPPORTED:
    "本机 Codex 当前模型不被 ChatGPT 登录支持，也没有足够的可核验公开档案。",
  ARTIST_IDENTITY_AMBIGUOUS:
    "无法排除同名艺人，原有资料已保留。请先在艺人管理中绑定 MusicBrainz ID。",
  ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE:
    "MusicBrainz 暂时无法读取，且 Codex 联网研究没有完成。原有资料已保留。",
  INSUFFICIENT_SOURCES:
    "没有找到足够可靠且能确认属于该艺人的公开资料，原有资料已保留。",
});

export const ARTIST_RESEARCH_PARTIAL_NOTICE = Object.freeze({
  CODEX_CLI_UNAVAILABLE:
    "本机未找到 Codex CLI，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  CODEX_AUTH_REQUIRED:
    "Codex 尚未登录，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  CODEX_NOT_LOGGED_IN:
    "Codex 尚未登录，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  CODEX_RESEARCH_TIMEOUT:
    "Codex 联网研究超时，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  ARTIST_RESEARCH_TIMEOUT:
    "Codex 联网研究超时，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  CODEX_RESEARCH_FAILED:
    "Codex 长文未完成，已用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  CODEX_MODEL_UNSUPPORTED:
    "本机 Codex 当前模型不被 ChatGPT 登录支持，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
  INSUFFICIENT_SOURCES:
    "没有足够来源撰写 Codex 长文，已展示可核验公开档案（MusicBrainz / Wikipedia），不是编造。",
});

function artistResearchJobFactsPatch(job) {
  const profile = job?.profile && typeof job.profile === "object" ? job.profile : null;
  if (!profile?.publicFacts) return {};
  return {
    publicFacts: profile.publicFacts,
    sources: profile.sources,
    ...(cleanText(profile.introduction)
      ? { introduction: profile.introduction }
      : {}),
  };
}

export function artistResearchFailureMessage(code, { hasBaseline = false } = {}) {
  const key = cleanText(code);
  if (hasBaseline) {
    return (
      ARTIST_RESEARCH_PARTIAL_NOTICE[key] ||
      ARTIST_RESEARCH_PARTIAL_NOTICE.CODEX_RESEARCH_FAILED
    );
  }
  return (
    ARTIST_RESEARCH_ERROR_MESSAGES[key] ||
    ARTIST_RESEARCH_ERROR_MESSAGES.CODEX_RESEARCH_FAILED
  );
}

export function artistResearchJobPatch(job) {
  if (!job) {
    return { kind: "idle", patch: {}, toast: "" };
  }
  const facts = artistResearchJobFactsPatch(job);
  const hasBaseline = hasUsefulArtistPublicFacts(facts.publicFacts);
  if (ACTIVE_ARTIST_RESEARCH_JOB_STATUSES.has(job.status)) {
    return {
      kind: "progress",
      toast: "",
      patch: {
        introductionStatus: job.status || "PREPARING",
        researchMessage: job.message || "正在准备艺人身份锚点…",
        researchError: "",
        ...facts,
      },
    };
  }
  if (job.status === "COMPLETED") {
    if (job.resultStatus === "OK" && job.profile) {
      return {
        kind: "ok",
        toast: "艺人介绍与公开档案已更新",
        patch: {
          ...job.profile,
          researchMessage: "",
          researchError: "",
        },
      };
    }
    if (job.resultStatus === "PARTIAL" || hasBaseline) {
      const notice =
        cleanText(job.profile?.researchError) ||
        cleanText(job.message) ||
        artistResearchFailureMessage(job.error || job.resultStatus, {
          hasBaseline: true,
        });
      return {
        kind: "partial",
        toast: "已写入公开档案；Codex 长文未完成",
        patch: {
          ...job.profile,
          ...facts,
          introductionStatus: "READY",
          researchMessage: "",
          researchError: notice,
        },
      };
    }
    return {
      kind: "insufficient",
      toast: "资料不足，原有艺人资料已保留",
      patch: {
        introductionStatus: "INSUFFICIENT_SOURCES",
        researchMessage: "",
        researchError:
          job.warnings?.join("；") ||
          ARTIST_RESEARCH_ERROR_MESSAGES.INSUFFICIENT_SOURCES,
        ...facts,
      },
    };
  }
  if (job.status === "FAILED") {
    if (hasBaseline) {
      const notice = artistResearchFailureMessage(job.error, { hasBaseline: true });
      return {
        kind: "partial",
        toast: "已写入公开档案；Codex 长文未完成",
        patch: {
          ...job.profile,
          ...facts,
          introductionStatus: "READY",
          researchMessage: "",
          researchError: notice,
        },
      };
    }
    return {
      kind: "failed",
      toast: "艺人资料更新失败",
      patch: {
        introductionStatus: "FAILED",
        researchMessage: "",
        researchError: artistResearchFailureMessage(job.error),
        ...facts,
      },
    };
  }
  return {
    kind: "progress",
    toast: "",
    patch: {
      introductionStatus: job.status || "PREPARING",
      researchMessage: job.message || "正在准备艺人身份锚点…",
      researchError: "",
      ...facts,
    },
  };
}

function sanitizeSources(value) {
  return Array.isArray(value)
    ? value
        .map((source) => ({
          sourceId: cleanText(source?.sourceId),
          title: cleanText(source?.title || source?.label),
          publisher: cleanText(source?.publisher),
          url: cleanText(source?.url),
          publishedAt: cleanText(source?.publishedAt),
          sourceType: cleanText(source?.sourceType),
          supports: cleanTextList(source?.supports, 12),
        }))
        .filter(
          (source) =>
            source.title && /^https:\/\//i.test(source.url),
        )
        .slice(0, 40)
    : [];
}

function mergePublicFacts(previous, next) {
  const prev = sanitizePublicFacts(previous);
  const curr = sanitizePublicFacts(next);
  return {
    resolvedName: curr.resolvedName || prev.resolvedName,
    artistType: curr.artistType || prev.artistType,
    gender: curr.gender || prev.gender,
    birthDate: curr.birthDate || prev.birthDate,
    activeFrom: curr.activeFrom || prev.activeFrom,
    endedAt: curr.endedAt || prev.endedAt,
    birthPlace: curr.birthPlace || prev.birthPlace,
    origin: curr.origin || prev.origin,
    country: curr.country || prev.country,
    musicBrainzId: curr.musicBrainzId || prev.musicBrainzId,
    genres: curr.genres.length ? curr.genres : prev.genres,
    members: curr.members.length ? curr.members : prev.members,
  };
}

function sanitizeArtistProfile(profile) {
  const value = profile && typeof profile === "object" ? profile : {};
  return {
    explorationEnabled: value.explorationEnabled === true,
    releaseView: value.releaseView === "grid" ? "grid" : "list",
    introduction: cleanText(value.introduction),
    introductionStatus: [
      "EMPTY",
      "PREPARING",
      "SEARCHING",
      "VERIFYING",
      "WRITING",
      "SAVING",
      "RESEARCHING",
      "READY",
      "INSUFFICIENT_SOURCES",
      "FAILED",
    ].includes(value.introductionStatus)
      ? value.introductionStatus
      : "EMPTY",
    publicFacts: sanitizePublicFacts(value.publicFacts),
    identityNote: cleanText(value.identityNote),
    recommendedListening: sanitizeRecommendedListening(value.recommendedListening),
    awards: sanitizeAwardItems(value.awards, ["won"]),
    nominations: sanitizeAwardItems(value.nominations, ["nominated", "shortlisted", "longlisted"]),
    filmRelationships: sanitizeFilmRelationships(value.filmRelationships),
    claimSources: sanitizeClaimSources(value.claimSources),
    warnings: cleanTextList(value.warnings, 20),
    platformLinks: sanitizePlatformLinks(value.platformLinks),
    media: sanitizeMedia(value.media),
    explorationCatalog: sanitizeExplorationCatalog(value.explorationCatalog),
    roamCountryAudit: sanitizeRoamCountryAudit(value.roamCountryAudit),
    sources: sanitizeSources(value.sources),
    researchMessage: cleanText(value.researchMessage),
    researchError: cleanText(value.researchError),
    updatedAt: cleanText(value.updatedAt),
  };
}

export const EMPTY_ARTIST_PROFILE = Object.freeze(sanitizeArtistProfile({}));

function coalesceArtistProfileIds(profiles) {
  const coalesced = {};
  for (const [artistId, profile] of Object.entries(profiles)) {
    const canonicalId = decodeArtistProfileId(artistId);
    if (!canonicalId) continue;
    coalesced[canonicalId] = coalesced[canonicalId]
      ? mergePreferredArtistProfile(profile, coalesced[canonicalId])
      : profile;
  }
  return coalesced;
}

function adoptArtistProfiles(state, artistId, nameHints = []) {
  const canonicalId = decodeArtistProfileId(artistId) || artistId;
  const profiles = { ...state.profiles };
  let adopted = profiles[canonicalId] ?? null;
  for (const key of artistProfileLookupKeys(artistId, nameHints)) {
    const candidates = [key, decodeArtistProfileId(key)].filter(Boolean);
    for (const matchKey of candidates) {
      if (!profiles[matchKey] || matchKey === canonicalId) continue;
      adopted = adopted
        ? mergePreferredArtistProfile(adopted, profiles[matchKey])
        : profiles[matchKey];
      delete profiles[matchKey];
    }
  }
  if (adopted) profiles[canonicalId] = adopted;
  return { ...state, profiles };
}

export function sanitizeArtistProfileState(value) {
  const profiles = {};
  if (value && typeof value === "object" && value.profiles) {
    Object.entries(value.profiles).forEach(([artistId, profile]) => {
      if (!artistId || !profile || typeof profile !== "object") return;
      profiles[artistId] = sanitizeArtistProfile(profile);
    });
  }
  return { version: 4, profiles: coalesceArtistProfileIds(profiles) };
}

export function mergeArtistProfileStatesPreferPrimary(primary, fallback) {
  const preferred = sanitizeArtistProfileState(primary);
  const backup = sanitizeArtistProfileState(fallback);
  const profiles = { ...backup.profiles };
  for (const [artistId, profile] of Object.entries(preferred.profiles)) {
    profiles[artistId] = profiles[artistId]
      ? mergePreferredArtistProfile(profile, profiles[artistId])
      : profile;
  }
  return sanitizeArtistProfileState({ version: 4, profiles });
}

export function mergeArtistProfilesForIdentities(
  state,
  identityIds,
  selectedIdentityId,
  nameHints = [],
) {
  const current = sanitizeArtistProfileState(state);
  const targetId =
    decodeArtistProfileId(selectedIdentityId) || cleanText(selectedIdentityId);
  if (!targetId) return current;

  const keys = new Set([targetId]);
  const ids = Array.isArray(identityIds) ? identityIds : [identityIds];
  for (const identityId of ids) {
    for (const key of artistProfileLookupKeys(identityId)) {
      if (key) keys.add(key);
      const decoded = decodeArtistProfileId(key);
      if (decoded) keys.add(decoded);
    }
  }
  for (const hint of nameHints) {
    for (const key of artistProfileLookupKeys("", [hint])) {
      if (key) keys.add(key);
      const decoded = decodeArtistProfileId(key);
      if (decoded) keys.add(decoded);
    }
  }

  const profiles = { ...current.profiles };
  let merged = null;
  const orderedKeys = [targetId, ...[...keys].filter((key) => key !== targetId)];
  for (const key of orderedKeys) {
    const profile = profiles[key];
    if (!profile) continue;
    merged = merged
      ? mergePreferredArtistProfile(merged, profile)
      : sanitizeArtistProfile(profile);
    if (key !== targetId) delete profiles[key];
  }
  if (merged) profiles[targetId] = merged;
  return sanitizeArtistProfileState({ ...current, profiles });
}

export function loadArtistProfileState(storage = window.localStorage) {
  try {
    const raw = storage.getItem(ARTIST_PROFILE_STORAGE_KEY);
    return raw
      ? sanitizeArtistProfileState(JSON.parse(raw))
      : sanitizeArtistProfileState(EMPTY_ARTIST_PROFILE_STATE);
  } catch {
    return sanitizeArtistProfileState(EMPTY_ARTIST_PROFILE_STATE);
  }
}

export function saveArtistProfileState(
  value,
  storage = window.localStorage,
  { notify = true } = {},
) {
  try {
    storage.setItem(
      ARTIST_PROFILE_STORAGE_KEY,
      JSON.stringify(sanitizeArtistProfileState(value)),
    );
    if (notify) {
      void import("./sharedLocalState.js").then((module) => {
        module.notifySharedLocalStateChanged();
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function updateArtistProfile(state, artistId, patch, nameHints = []) {
  if (!artistId) return sanitizeArtistProfileState(state);
  const current = adoptArtistProfiles(
    sanitizeArtistProfileState(state),
    artistId,
    nameHints,
  );
  const canonicalId = decodeArtistProfileId(artistId) || artistId;
  const previous = current.profiles[canonicalId] ?? EMPTY_ARTIST_PROFILE;
  const hasPublicFactsPatch = Object.prototype.hasOwnProperty.call(
    patch,
    "publicFacts",
  );
  const hasCountryAuditPatch = Object.prototype.hasOwnProperty.call(
    patch,
    "roamCountryAudit",
  );
  const incomingAudit = hasCountryAuditPatch
    ? sanitizeRoamCountryAudit(patch.roamCountryAudit)
    : previous.roamCountryAudit;
  const keepPreviousUserCountry =
    isUserConfirmedCountryAudit(previous.roamCountryAudit) &&
    (!hasCountryAuditPatch || !isUserConfirmedCountryAudit(incomingAudit));
  const mergedPublicFacts = hasPublicFactsPatch
    ? mergePublicFacts(previous.publicFacts, patch.publicFacts)
    : previous.publicFacts;
  return sanitizeArtistProfileState({
    ...current,
    profiles: {
      ...current.profiles,
      [canonicalId]: {
        ...previous,
        ...patch,
        publicFacts: keepPreviousUserCountry
          ? { ...mergedPublicFacts, country: previous.publicFacts.country }
          : mergedPublicFacts,
        roamCountryAudit: keepPreviousUserCountry
          ? previous.roamCountryAudit
          : incomingAudit,
        introduction: Object.prototype.hasOwnProperty.call(patch, "introduction")
          ? cleanText(patch.introduction) || previous.introduction
          : previous.introduction,
        platformLinks: Object.prototype.hasOwnProperty.call(patch, "platformLinks")
          ? sanitizePlatformLinks({
              ...previous.platformLinks,
              ...patch.platformLinks,
            })
          : previous.platformLinks,
        media: Object.prototype.hasOwnProperty.call(patch, "media")
          ? sanitizeMedia({
              ...previous.media,
              ...patch.media,
              imageUrl: patch.media?.imageUrl || previous.media?.imageUrl,
              localImageUrl:
                patch.media?.localImageUrl || previous.media?.localImageUrl,
              localMotionUrl:
                patch.media?.localMotionUrl || previous.media?.localMotionUrl,
              sourceVideoUrl:
                patch.media?.sourceVideoUrl || previous.media?.sourceVideoUrl,
            })
          : previous.media,
        explorationCatalog: Object.prototype.hasOwnProperty.call(
          patch,
          "explorationCatalog",
        )
          ? sanitizeExplorationCatalog({
              ...previous.explorationCatalog,
              ...patch.explorationCatalog,
              releases: Object.prototype.hasOwnProperty.call(
                patch.explorationCatalog ?? {},
                "releases",
              )
                ? patch.explorationCatalog.releases
                : previous.explorationCatalog.releases,
            })
          : previous.explorationCatalog,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}
