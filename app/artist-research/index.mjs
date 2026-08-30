import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, sendJson } from "../scripts/http-json.mjs";
import {
  applySharedStateChanges,
  getSharedStatePath,
  readSharedState,
} from "../shared-state/index.mjs";
import { ARTIST_PROFILE_STORAGE_KEY } from "../src/lib/sharedStorageKeys.js";
import {
  artistProfileLookupKeys,
  decodeArtistProfileId,
  sanitizeArtistProfileState,
} from "../src/lib/artistProfiles.js";
import {
  cacheArtistMotionArtwork,
  lookupAppleArtistMedia,
  playableAppleHlsUrl,
} from "../scripts/apple-motion-artwork.mjs";

const API_PATH = "/api/artists/research";
const MEDIA_API_PATH = "/api/artists/media";
const MUSICBRAINZ_ORIGIN = "https://musicbrainz.org";
const REQUEST_TIMEOUT_MS = 15_000;
const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1_100;
const UPSTREAM_RETRY_DELAY_MS = 1_200;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_AGENT = "RecordShelf/0.1 (local personal music archive)";
const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIST_RESEARCH_PROMPT_PATH = path.join(
  APP_DIRECTORY,
  "prompts",
  "artist-introduction.v1.md",
);
const CODEX_TIMEOUT_MS = 12 * 60_000;
const CODEX_JOB_RETENTION_MS = 60 * 60_000;
const ARTIST_RESEARCH_JOBS = new Map();
const ACTIVE_RESEARCH_STATUSES = new Set([
  "PREPARING",
  "SEARCHING",
  "VERIFYING",
  "WRITING",
  "SAVING",
]);
const RESEARCH_STAGE_ORDER = [
  "PREPARING",
  "SEARCHING",
  "VERIFYING",
  "WRITING",
  "SAVING",
  "COMPLETED",
];
const RESEARCH_STAGE_MESSAGES = Object.freeze({
  PREPARING: "正在准备艺人身份锚点…",
  SEARCHING: "正在联网检索官方资料、作品 credits 与奖项记录…",
  VERIFYING: "正在核验同名身份、团体成员、奖项与影视关系…",
  WRITING: "正在撰写简体中文艺人介绍与推荐聆听…",
  SAVING: "正在保存核验结果并刷新当前页面…",
  COMPLETED: "艺人介绍已更新。",
  FAILED: "艺人介绍更新失败。",
});

const ARTIST_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "artist_id",
    "artist_name",
    "identity_note",
    "public_facts",
    "introduction",
    "group_members",
    "awards",
    "nominations",
    "film_relationships",
    "recommended_listening",
    "claim_sources",
    "sources",
    "warnings",
  ],
  properties: {
    status: { type: "string", enum: ["OK", "INSUFFICIENT_SOURCES"] },
    artist_id: { type: "string" },
    artist_name: { type: "string" },
    identity_note: { type: "string" },
    public_facts: {
      type: "object",
      additionalProperties: false,
      required: [
        "resolved_name",
        "artist_type",
        "birth_date",
        "active_from",
        "ended_at",
        "birth_place",
        "country",
        "origin",
        "genres",
      ],
      properties: {
        resolved_name: { type: "string" },
        artist_type: { type: "string" },
        birth_date: { type: "string" },
        active_from: { type: "string" },
        ended_at: { type: "string" },
        birth_place: { type: "string" },
        country: { type: "string" },
        origin: { type: "string" },
        genres: { type: "array", items: { type: "string" } },
      },
    },
    introduction: { type: "string" },
    group_members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "active_period", "source_ids"],
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          active_period: { type: "string" },
          source_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    awards: { type: "array", items: { $ref: "#/$defs/award" } },
    nominations: { type: "array", items: { $ref: "#/$defs/award" } },
    film_relationships: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "year",
          "film",
          "work",
          "relationship",
          "award",
          "category",
          "source_ids",
        ],
        properties: {
          year: { type: "string" },
          film: { type: "string" },
          work: { type: "string" },
          relationship: {
            type: "string",
            enum: [
              "won",
              "nominated",
              "shortlisted",
              "performed",
              "wrote",
              "produced",
              "used",
            ],
          },
          award: { type: "string" },
          category: { type: "string" },
          source_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    recommended_listening: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "work_type", "reason"],
        properties: {
          title: { type: "string" },
          work_type: {
            type: "string",
            enum: ["song", "album", "EP", "live", "other"],
          },
          reason: { type: "string" },
        },
      },
    },
    claim_sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "source_ids"],
        properties: {
          claim: { type: "string" },
          source_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "source_id",
          "title",
          "publisher",
          "url",
          "published_at",
          "source_type",
          "supports",
        ],
        properties: {
          source_id: { type: "string" },
          title: { type: "string" },
          publisher: { type: "string" },
          url: { type: "string" },
          published_at: { type: ["string", "null"] },
          source_type: {
            type: "string",
            enum: [
              "official",
              "platform",
              "interview",
              "review",
              "award",
              "credits",
              "publication",
            ],
          },
          supports: { type: "array", items: { type: "string" } },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  $defs: {
    award: {
      type: "object",
      additionalProperties: false,
      required: ["year", "award", "category", "work", "result", "source_ids"],
      properties: {
        year: { type: "string" },
        award: { type: "string" },
        category: { type: "string" },
        work: { type: "string" },
        result: {
          type: "string",
          enum: ["won", "nominated", "shortlisted", "longlisted"],
        },
        source_ids: { type: "array", items: { type: "string" } },
      },
    },
  },
};

function cleanText(value, maxLength = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizedName(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function requestError(code, statusCode = 502, message = "") {
  return Object.assign(new Error(code), { code, statusCode, safeMessage: message });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exactCandidateNames(candidate) {
  return [candidate?.name, ...(candidate?.aliases ?? []).map((alias) => alias?.name)]
    .map(normalizedName)
    .filter(Boolean);
}

export function selectExactMusicBrainzCandidate(candidates, names) {
  const expected = new Set((Array.isArray(names) ? names : []).map(normalizedName).filter(Boolean));
  const exact = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const score = Number(candidate?.score ?? 0);
    return score >= 95 && exactCandidateNames(candidate).some((name) => expected.has(name));
  });
  return exact.length === 1 ? exact[0] : null;
}

function uniqueText(values, limit = 12) {
  return [...new Set(values.map((value) => cleanText(value, 120)).filter(Boolean))].slice(0, limit);
}

function relationUrl(relation) {
  return cleanText(relation?.url?.resource, 1_000);
}

function wikipediaRestUrl(resource) {
  try {
    const url = new URL(resource);
    const hostMatch = url.hostname.match(/^([a-z-]+)\.wikipedia\.org$/i);
    const pageMatch = url.pathname.match(/^\/wiki\/(.+)$/);
    if (!hostMatch || !pageMatch) return "";
    return `https://${hostMatch[1]}.wikipedia.org/api/rest_v1/page/summary/${pageMatch[1]}`;
  } catch {
    return "";
  }
}

function wikidataEntityId(resource) {
  try {
    const url = new URL(resource);
    if (!/(^|\.)wikidata\.org$/i.test(url.hostname)) return "";
    return cleanText(url.pathname.match(/\/(Q\d+)(?:\/|$)/i)?.[1], 40);
  } catch {
    return "";
  }
}

function wikipediaUrlFromWikidata(entityId, entityData) {
  const sitelinks = entityData?.entities?.[entityId]?.sitelinks ?? {};
  const preferred = [sitelinks.zhwiki, sitelinks.enwiki].find(
    (sitelink) => sitelink?.url,
  );
  return cleanText(preferred?.url, 1_000);
}

function memberRelations(details) {
  return (Array.isArray(details?.relations) ? details.relations : [])
    .filter((relation) => relation?.artist && /member/i.test(cleanText(relation?.type)))
    .map((relation) => ({
      id: cleanText(relation.artist.id, 80),
      name: cleanText(relation.artist.name, 180),
      role: uniqueText(relation.attributes ?? [], 4).join(" · "),
      begin: cleanText(relation.begin, 30),
      end: cleanText(relation.end, 30),
    }))
    .filter((member) => member.name)
    .filter((member, index, members) => members.findIndex((item) => item.id === member.id && item.name === member.name) === index)
    .slice(0, 30);
}

const REGION_NAMES_ZH = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const PLACE_NAMES_ZH = Object.freeze({
  "los angeles": "洛杉矶",
  tarzana: "塔扎纳",
  brooklyn: "布鲁克林",
  "new york": "纽约",
  london: "伦敦",
  redditch: "雷迪奇",
  seoul: "首尔",
  busan: "釜山",
  tokyo: "东京",
  osaka: "大阪",
  sydney: "悉尼",
  melbourne: "墨尔本",
  toronto: "多伦多",
  auckland: "奥克兰",
});
const ARTIST_TYPE_ZH = Object.freeze({
  Person: "个人",
  Group: "团体",
  Orchestra: "管弦乐团",
  Choir: "合唱团",
  Character: "虚构角色",
  Other: "其他",
});

function translatedCountry(value) {
  const country = cleanText(value, 120);
  if (!country) return "";
  if (/^[A-Z]{2}$/i.test(country)) {
    try {
      return REGION_NAMES_ZH.of(country.toUpperCase()) || country;
    } catch {
      return country;
    }
  }
  return country;
}

function localizedArtistType(value) {
  const artistType = cleanText(value, 80);
  return ARTIST_TYPE_ZH[artistType] || artistType;
}

function localizedPlace(placeValue, countryValue) {
  const rawPlace = cleanText(placeValue, 180);
  const country = translatedCountry(countryValue);
  if (!rawPlace) return country;
  const place = /[\u3400-\u9fff]/.test(rawPlace)
    ? rawPlace
    : PLACE_NAMES_ZH[normalizedName(rawPlace)] || "";
  if (!place) return country;
  if (!country || normalizedName(place).includes(normalizedName(country))) return place;
  return `${country} · ${place}`;
}

function mergeTextField(next, previous, maxLength = 180) {
  return cleanText(next, maxLength) || cleanText(previous, maxLength);
}

function mergePublicFacts(previous, next) {
  const prev = previous && typeof previous === "object" ? previous : {};
  const curr = next && typeof next === "object" ? next : {};
  const prevGenres = uniqueText(prev.genres ?? []);
  const currGenres = uniqueText(curr.genres ?? []);
  const prevMembers = Array.isArray(prev.members) ? prev.members : [];
  const currMembers = Array.isArray(curr.members) ? curr.members : [];
  return {
    resolvedName: mergeTextField(curr.resolvedName, prev.resolvedName, 180),
    artistType: mergeTextField(curr.artistType, prev.artistType, 80),
    gender: mergeTextField(curr.gender, prev.gender, 80),
    birthDate: mergeTextField(curr.birthDate, prev.birthDate, 30),
    activeFrom: mergeTextField(curr.activeFrom, prev.activeFrom, 30),
    endedAt: mergeTextField(curr.endedAt, prev.endedAt, 30),
    birthPlace: mergeTextField(curr.birthPlace, prev.birthPlace, 180),
    origin: mergeTextField(curr.origin, prev.origin, 180),
    country: mergeTextField(curr.country, prev.country, 120),
    musicBrainzId: mergeTextField(curr.musicBrainzId, prev.musicBrainzId, 80),
    genres: currGenres.length ? currGenres : prevGenres,
    members: currMembers.length ? currMembers : prevMembers,
  };
}

export function usefulPublicFacts(facts) {
  const value = facts && typeof facts === "object" ? facts : {};
  return Boolean(
    mergeTextField(value.resolvedName, "", 180) ||
      mergeTextField(value.artistType, "", 80) ||
      mergeTextField(value.birthDate, "", 30) ||
      mergeTextField(value.activeFrom, "", 30) ||
      mergeTextField(value.birthPlace, "", 180) ||
      mergeTextField(value.origin, "", 180) ||
      mergeTextField(value.country, "", 120) ||
      uniqueText(value.genres ?? []).length ||
      (Array.isArray(value.members) &&
        value.members.some((member) => cleanText(member?.name, 180))),
  );
}

export function artistResearchCodexNotice(errorCode) {
  switch (cleanText(errorCode, 80)) {
    case "CODEX_CLI_UNAVAILABLE":
      return "本机未找到 Codex CLI，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。";
    case "CODEX_AUTH_REQUIRED":
      return "Codex 尚未登录，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。";
    case "CODEX_RESEARCH_TIMEOUT":
      return "Codex 联网研究超时，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。";
    case "INSUFFICIENT_SOURCES":
      return "没有足够来源撰写 Codex 长文，已展示可核验公开档案（MusicBrainz / Wikipedia），不是编造。";
    case "CODEX_MODEL_UNSUPPORTED":
      return "本机 Codex 当前模型不被 ChatGPT 登录支持，已改用可核验公开档案（MusicBrainz / Wikipedia），不是编造。";
    default:
      return "Codex 长文未完成，已用可核验公开档案（MusicBrainz / Wikipedia），不是编造。";
  }
}

function artistResearchHardFailureMessage(errorCode, baselineError) {
  const code = cleanText(errorCode, 80);
  const baselineCode = cleanText(baselineError?.code, 80);
  if (code === "ARTIST_IDENTITY_AMBIGUOUS" || baselineCode === "ARTIST_IDENTITY_AMBIGUOUS") {
    return (
      baselineError?.safeMessage ||
      "无法排除同名艺人，原有资料已保留。请先在艺人管理中绑定 MusicBrainz ID。"
    );
  }
  if (code === "CODEX_CLI_UNAVAILABLE") {
    return "本机未找到 Codex CLI，也没有足够的 MusicBrainz / Wikipedia 公开档案。";
  }
  if (code === "CODEX_AUTH_REQUIRED") {
    return "Codex 尚未登录，也没有足够的可核验公开档案。";
  }
  if (code === "CODEX_RESEARCH_TIMEOUT") {
    return "Codex 联网研究超时，也没有足够的可核验公开档案。";
  }
  if (code === "CODEX_MODEL_UNSUPPORTED") {
    return "本机 Codex 当前模型不被 ChatGPT 登录支持，也没有足够的可核验公开档案。";
  }
  if (baselineCode === "ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE") {
    return "MusicBrainz 暂时无法读取，且 Codex 联网研究没有完成。原有资料已保留。";
  }
  if (code === "INSUFFICIENT_SOURCES") {
    return "没有找到足够可靠且能确认属于该艺人的公开资料，原有资料已保留。";
  }
  return "Codex 联网研究没有完成，也没有足够的可核验公开档案。";
}

function baselinePatchForPersist(baselineProfile, previousIntroduction = "") {
  const previousIntro = cleanText(previousIntroduction, 12_000);
  const wikiIntro = cleanText(baselineProfile?.introduction, 8_000);
  const hasFacts = usefulPublicFacts(baselineProfile?.publicFacts);
  if (!hasFacts && !wikiIntro) return null;
  return {
    publicFacts: baselineProfile.publicFacts ?? {},
    sources: Array.isArray(baselineProfile.sources) ? baselineProfile.sources : [],
    ...(previousIntro || !wikiIntro ? {} : { introduction: wikiIntro }),
    introductionStatus: previousIntro || wikiIntro || hasFacts ? "READY" : "INSUFFICIENT_SOURCES",
  };
}

async function loadStoredArtistProfile(artistId, statePath = getSharedStatePath()) {
  const cleanArtistId = cleanText(artistId, 240);
  if (!cleanArtistId) return {};
  try {
    const sharedState = await readSharedState(statePath);
    const current = sanitizeArtistProfileState(
      parsedArtistProfileState(
        sharedState.storage[ARTIST_PROFILE_STORAGE_KEY] ?? null,
      ),
    );
    const previousKey =
      artistProfileLookupKeys(cleanArtistId).find((key) => current.profiles?.[key]) ||
      decodeArtistProfileId(cleanArtistId) ||
      cleanArtistId;
    return current.profiles?.[previousKey] ?? {};
  } catch {
    return {};
  }
}

async function persistBaselineFallback(
  job,
  payload,
  options,
  { baselineProfile, previousIntroduction, errorCode, notice },
) {
  const patch = baselinePatchForPersist(baselineProfile, previousIntroduction);
  if (!patch) return false;
  const persisted = { ...patch, researchError: notice };
  try {
    await persistResearchedArtistProfile(
      payload.artistId,
      persisted,
      options.statePath,
    );
  } catch {
    // Keep the in-memory snapshot even if a later shared-state write fails.
  }
  updateArtistResearchJob(job, {
    status: "COMPLETED",
    resultStatus: "PARTIAL",
    message: notice,
    profile: {
      ...persisted,
      introduction: persisted.introduction || previousIntroduction || "",
    },
    warnings: notice ? [notice] : [],
    error: errorCode || "",
  });
  return true;
}

export function musicBrainzDetailsToProfile(details, introduction = "", wikipediaUrl = "") {
  const type = cleanText(details?.type, 80);
  const isGroup = /group|orchestra|choir/i.test(type);
  const begin = cleanText(details?.["life-span"]?.begin, 30);
  const rawCountry = cleanText(details?.country, 20);
  const country = translatedCountry(rawCountry);
  const sources = [
    details?.id
      ? {
          sourceId: "MB1",
          title: cleanText(details?.name, 180) || "MusicBrainz artist",
          publisher: "MusicBrainz",
          url: `${MUSICBRAINZ_ORIGIN}/artist/${details.id}`,
          publishedAt: "",
          sourceType: "platform",
          supports: ["艺人身份、类型、地区、成员与标签"],
        }
      : null,
    wikipediaUrl
      ? {
          sourceId: "W1",
          title: cleanText(details?.name, 180) || "Wikipedia",
          publisher: "Wikipedia",
          url: wikipediaUrl,
          publishedAt: "",
          sourceType: "publication",
          supports: ["公开生平概述"],
        }
      : null,
  ].filter(Boolean);
  const tags = [...(details?.genres ?? []), ...(details?.tags ?? [])]
    .sort((left, right) => Number(right?.count ?? 0) - Number(left?.count ?? 0))
    .map((item) => item?.name);

  return {
    introduction: cleanText(introduction, 8_000),
    introductionStatus: introduction || details?.id ? "READY" : "INSUFFICIENT_SOURCES",
    publicFacts: {
      resolvedName: cleanText(details?.name, 180),
      artistType: localizedArtistType(type),
      gender: cleanText(details?.gender, 80),
      birthDate: isGroup ? "" : begin,
      activeFrom: isGroup ? begin : "",
      endedAt: cleanText(details?.["life-span"]?.end, 30),
      birthPlace: localizedPlace(
        cleanText(details?.["begin-area"]?.name, 180),
        country || rawCountry,
      ),
      origin: localizedPlace(
        cleanText(details?.area?.name, 180),
        country || rawCountry,
      ),
      country,
      musicBrainzId: cleanText(details?.id, 80),
      genres: uniqueText(tags),
      members: isGroup ? memberRelations(details) : [],
    },
    sources,
    researchError: "",
  };
}

async function fetchJson(url, fetchImpl, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      const canRetry =
        options.retry !== false &&
        (response.status === 429 || response.status >= 500);
      if (canRetry) {
        clearTimeout(timer);
        await (options.delayImpl ?? delay)(UPSTREAM_RETRY_DELAY_MS);
        return fetchJson(url, fetchImpl, { ...options, retry: false });
      }
      throw requestError("ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE");
    }
    return await response.json();
  } catch (error) {
    if (error?.code) throw error;
    throw requestError("ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMusicBrainzId(payload, fetchImpl, delayImpl) {
  const provided = cleanText(payload.musicBrainzId, 80);
  if (MBID_PATTERN.test(provided)) return { id: provided, searched: false };

  const names = uniqueText([payload.name, ...(payload.aliases ?? [])], 10);
  if (!names.length) throw requestError("ARTIST_NAME_REQUIRED", 400, "缺少艺人名称。");
  const url = new URL("/ws/2/artist", MUSICBRAINZ_ORIGIN);
  url.searchParams.set("query", `artist:\"${names[0].replace(/\"/g, "")}\"`);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "8");
  const search = await fetchJson(url, fetchImpl, { delayImpl });
  const candidate = selectExactMusicBrainzCandidate(search?.artists, names);
  if (!candidate?.id) {
    throw requestError(
      "ARTIST_IDENTITY_AMBIGUOUS",
      409,
      "没有找到唯一的精确艺人身份；如存在同名艺人，请先在艺人管理中绑定 MusicBrainz ID。",
    );
  }
  return { id: candidate.id, searched: true };
}

export async function researchArtist(payload, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayImpl = options.delayImpl ?? delay;
  const resolvedIdentity = await resolveMusicBrainzId(
    payload,
    fetchImpl,
    delayImpl,
  );
  const musicBrainzId = resolvedIdentity.id;
  if (resolvedIdentity.searched) {
    await delayImpl(MUSICBRAINZ_REQUEST_INTERVAL_MS);
  }
  const detailUrl = new URL(`/ws/2/artist/${musicBrainzId}`, MUSICBRAINZ_ORIGIN);
  detailUrl.searchParams.set("inc", "aliases+artist-rels+url-rels+genres+tags");
  detailUrl.searchParams.set("fmt", "json");
  const details = await fetchJson(detailUrl, fetchImpl, { delayImpl });
  const wikipediaRelation = (details?.relations ?? []).find(
    (relation) => /wikipedia/i.test(cleanText(relation?.type)) && wikipediaRestUrl(relationUrl(relation)),
  );
  let wikipediaUrl = relationUrl(wikipediaRelation);
  if (!wikipediaUrl) {
    const wikidataRelation = (details?.relations ?? []).find(
      (relation) =>
        /wikidata/i.test(cleanText(relation?.type)) &&
        wikidataEntityId(relationUrl(relation)),
    );
    const entityId = wikidataEntityId(relationUrl(wikidataRelation));
    if (entityId) {
      try {
        const entityData = await fetchJson(
          `https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`,
          fetchImpl,
          { delayImpl },
        );
        wikipediaUrl = wikipediaUrlFromWikidata(entityId, entityData);
      } catch {
        // MusicBrainz facts remain useful when Wikidata is temporarily unavailable.
      }
    }
  }
  let introduction = "";
  if (wikipediaUrl) {
    try {
      const summary = await fetchJson(
        wikipediaRestUrl(wikipediaUrl),
        fetchImpl,
        { delayImpl },
      );
      introduction = cleanText(summary?.extract, 8_000);
    } catch {
      // Structured MusicBrainz facts remain useful when the optional summary is unavailable.
    }
  }
  return musicBrainzDetailsToProfile(details, introduction, wikipediaUrl);
}

function snakeList(value, mapper, limit = 40) {
  return (Array.isArray(value) ? value : []).map(mapper).filter(Boolean).slice(0, limit);
}

function normalizeSourceIds(value) {
  return uniqueText(Array.isArray(value) ? value : [], 12);
}

function normalizeAward(item, fallbackResult) {
  const year = cleanText(item?.year, 20);
  const award = cleanText(item?.award, 220);
  const category = cleanText(item?.category, 220);
  if (!year || !award || !category) return null;
  return {
    year,
    award,
    category,
    work: cleanText(item?.work, 240),
    result: cleanText(item?.result, 40) || fallbackResult,
    sourceIds: normalizeSourceIds(item?.source_ids),
  };
}

export function normalizeCodexArtistResearchResult(
  payload,
  baselineProfile = {},
) {
  const facts = payload?.public_facts ?? {};
  const baselineFacts = baselineProfile?.publicFacts ?? {};
  const country = translatedCountry(facts.country || baselineFacts.country);
  const birthPlace = localizedPlace(
    facts.birth_place || baselineFacts.birthPlace,
    country,
  );
  const origin = localizedPlace(facts.origin || baselineFacts.origin, country);
  const members = snakeList(payload?.group_members, (member) => {
    const name = cleanText(member?.name, 180);
    if (!name) return null;
    return {
      id: "",
      name,
      role: cleanText(member?.role, 180),
      activePeriod: cleanText(member?.active_period, 100),
      sourceIds: normalizeSourceIds(member?.source_ids),
      begin: "",
      end: "",
    };
  }, 30);
  const isOk = payload?.status === "OK";
  return {
    introduction: isOk ? cleanText(payload?.introduction, 12_000) : "",
    introductionStatus: isOk ? "READY" : "INSUFFICIENT_SOURCES",
    identityNote: cleanText(payload?.identity_note, 1_000),
    publicFacts: {
      resolvedName:
        cleanText(facts.resolved_name, 180) || baselineFacts.resolvedName || "",
      artistType: localizedArtistType(
        facts.artist_type || baselineFacts.artistType,
      ),
      gender: baselineFacts.gender || "",
      birthDate:
        cleanText(facts.birth_date, 30) || baselineFacts.birthDate || "",
      activeFrom:
        cleanText(facts.active_from, 30) || baselineFacts.activeFrom || "",
      endedAt: cleanText(facts.ended_at, 30) || baselineFacts.endedAt || "",
      birthPlace,
      origin,
      country,
      musicBrainzId: baselineFacts.musicBrainzId || "",
      genres: uniqueText([
        ...(Array.isArray(facts.genres) ? facts.genres : []),
        ...(baselineFacts.genres ?? []),
      ]),
      members: members.length ? members : baselineFacts.members ?? [],
    },
    recommendedListening: snakeList(payload?.recommended_listening, (item) => {
      const title = cleanText(item?.title, 240);
      const reason = cleanText(item?.reason, 800);
      if (!title || !reason) return null;
      return {
        title,
        workType: cleanText(item?.work_type, 40) || "other",
        reason,
      };
    }, 8),
    awards: snakeList(payload?.awards, (item) => normalizeAward(item, "won")),
    nominations: snakeList(
      payload?.nominations,
      (item) => normalizeAward(item, "nominated"),
    ),
    filmRelationships: snakeList(payload?.film_relationships, (item) => {
      const film = cleanText(item?.film, 240);
      const work = cleanText(item?.work, 240);
      if (!film || !work) return null;
      return {
        year: cleanText(item?.year, 20),
        film,
        work,
        relationship: cleanText(item?.relationship, 40) || "used",
        award: cleanText(item?.award, 220),
        category: cleanText(item?.category, 220),
        sourceIds: normalizeSourceIds(item?.source_ids),
      };
    }, 30),
    claimSources: snakeList(payload?.claim_sources, (item) => {
      const claim = cleanText(item?.claim, 1_000);
      const sourceIds = normalizeSourceIds(item?.source_ids);
      return claim && sourceIds.length ? { claim, sourceIds } : null;
    }, 80),
    sources: snakeList(payload?.sources, (source) => {
      const url = cleanText(source?.url, 1_000);
      const title = cleanText(source?.title, 300);
      if (!title || !/^https:\/\//i.test(url)) return null;
      return {
        sourceId: cleanText(source?.source_id, 60),
        title,
        publisher: cleanText(source?.publisher, 180),
        url,
        publishedAt: cleanText(source?.published_at, 40),
        sourceType: cleanText(source?.source_type, 60),
        supports: uniqueText(source?.supports ?? [], 12),
      };
    }, 40),
    warnings: uniqueText(payload?.warnings ?? [], 20),
    researchError: "",
  };
}

async function resolveCodexExecutable() {
  const configured = cleanText(process.env.RECORDSHELF_CODEX_CLI, 1_000);
  const candidates = [
    configured,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next trusted local installation path.
    }
  }
  return "codex";
}

function safeArtistIdentity(payload) {
  return {
    artist_name: cleanText(payload?.name, 180),
    artist_id: cleanText(payload?.artistId, 240),
    aliases: uniqueText(payload?.aliases ?? [], 20),
    musicbrainz_id: cleanText(payload?.musicBrainzId, 80),
    confirmed_external_ids: {
      musicbrainz: cleanText(payload?.musicBrainzId, 80),
    },
    confirmed_artist_urls: {
      apple_music: cleanText(payload?.platformLinks?.appleMusic, 1_000),
      spotify: cleanText(payload?.platformLinks?.spotify, 1_000),
      youtube_music: cleanText(payload?.platformLinks?.youtubeMusic, 1_000),
    },
    confirmed_works: (Array.isArray(payload?.releaseHints)
      ? payload.releaseHints
      : [])
      .map((release) => ({
        title: cleanText(release?.title, 240),
        type: cleanText(release?.type, 40),
        release_date: cleanText(release?.releaseDate, 30),
        credited_artists: uniqueText(release?.artists ?? [], 12),
      }))
      .filter((release) => release.title)
      .slice(0, 30),
  };
}

function codexArtistPrompt(identity, template) {
  return `${template.replace(
    "{{ARTIST_IDENTITY_JSON}}",
    JSON.stringify(identity, null, 2),
  )}\n\n额外执行要求：必须使用本次 Codex 任务提供的实时网页搜索，打开原始页面核验。不要读取或修改 RecordShelf 文件，也不要使用用户评分、评论、听过日期或私人艺人映射。最终只返回符合指定 JSON Schema 的 JSON。`;
}

export function buildCodexArtistExecArgs({
  schemaPath,
  outputPath,
  workingDirectory,
  model = "",
  ignoreUserConfig = true,
} = {}) {
  const args = [
    "--search",
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
  ];
  if (ignoreUserConfig) args.push("--ignore-user-config");
  args.push(
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-C",
    workingDirectory,
  );
  const selectedModel = cleanText(model, 120);
  if (selectedModel) args.push("--model", selectedModel);
  args.push("-");
  return args;
}

export function extractCodexCliDiagnostic(stdout = "", stderr = "") {
  const chunks = [cleanText(stderr, 8_000)];
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      const message =
        cleanText(event?.error?.message, 4_000) ||
        cleanText(event?.message, 4_000) ||
        cleanText(event?.item?.message, 4_000);
      if (message) chunks.push(message);
    } catch {
      // Progress JSONL is optional and never shown raw.
    }
  }
  return chunks.filter(Boolean).join("\n").slice(-8_000);
}

export function classifyCodexCliFailure({
  stdout = "",
  stderr = "",
  spawnError,
} = {}) {
  if (spawnError?.code === "ENOENT") return "CODEX_CLI_UNAVAILABLE";
  const diagnostic = extractCodexCliDiagnostic(stdout, stderr);
  if (/not supported when using Codex with a ChatGPT account/i.test(diagnostic)) {
    return "CODEX_MODEL_UNSUPPORTED";
  }
  if (/login|auth|sign.?in|unauthorized/i.test(diagnostic)) {
    return "CODEX_AUTH_REQUIRED";
  }
  return "CODEX_RESEARCH_FAILED";
}

function runCodexArtistProcess({
  cliPath,
  args,
  prompt,
  workingDirectory,
  timeoutMs,
  onProgress,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: workingDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let stdoutBuffer = "";
    let settled = false;
    let latestStage = "";
    const reportStage = (stage) => {
      if (!ACTIVE_RESEARCH_STATUSES.has(stage) || latestStage === stage) return;
      latestStage = stage;
      onProgress({ stage });
    };
    reportStage("SEARCHING");
    const verifyTimer = setTimeout(() => reportStage("VERIFYING"), 20_000);
    const writingTimer = setTimeout(() => reportStage("WRITING"), 55_000);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(requestError("CODEX_RESEARCH_TIMEOUT", 504)));
    }, timeoutMs);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(verifyTimer);
      clearTimeout(writingTimer);
      callback();
    };
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = `${stdout}${text}`.slice(-32_000);
      stdoutBuffer = `${stdoutBuffer}${text}`;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const eventType = cleanText(event?.type, 100).toLowerCase();
          const itemType = cleanText(event?.item?.type, 100).toLowerCase();
          if (eventType.includes("web_search") || itemType.includes("web_search")) {
            reportStage("SEARCHING");
          } else if (itemType === "reasoning") {
            reportStage("VERIFYING");
          } else if (itemType === "agent_message") {
            reportStage("WRITING");
          }
        } catch {
          // Progress output is optional and never exposed raw.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", (error) => {
      finish(() =>
        reject(
          requestError(classifyCodexCliFailure({ spawnError: error }), 503),
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) return finish(resolve);
      finish(() =>
        reject(
          requestError(classifyCodexCliFailure({ stdout, stderr }), 502),
        ),
      );
    });
    child.stdin.end(prompt);
  });
}

export async function requestCodexArtistResearch({
  identity,
  timeoutMs = CODEX_TIMEOUT_MS,
  executable,
  model = process.env.RECORDSHELF_CODEX_MODEL,
  onProgress = () => {},
} = {}) {
  if (!cleanText(identity?.artist_id, 240) || !cleanText(identity?.artist_name, 180)) {
    throw requestError("INVALID_ARTIST_IDENTITY", 400);
  }
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-codex-artist-"),
  );
  const schemaPath = path.join(temporaryDirectory, "schema.json");
  const outputPath = path.join(temporaryDirectory, "result.json");
  const promptTemplate = await fs.readFile(ARTIST_RESEARCH_PROMPT_PATH, "utf8");
  const cliPath = executable || (await resolveCodexExecutable());
  const prompt = codexArtistPrompt(identity, promptTemplate);
  const requestedModel = cleanText(model, 120);
  const modelsToTry = requestedModel ? [requestedModel, ""] : [""];
  try {
    onProgress({ stage: "PREPARING" });
    await fs.writeFile(schemaPath, `${JSON.stringify(ARTIST_RESEARCH_SCHEMA)}\n`, {
      mode: 0o600,
    });
    let lastError = requestError("CODEX_RESEARCH_FAILED", 502);
    for (const selectedModel of modelsToTry) {
      try {
        await runCodexArtistProcess({
          cliPath,
          args: buildCodexArtistExecArgs({
            schemaPath,
            outputPath,
            workingDirectory: temporaryDirectory,
            model: selectedModel,
          }),
          prompt,
          workingDirectory: temporaryDirectory,
          timeoutMs,
          onProgress,
        });
        try {
          return JSON.parse(await fs.readFile(outputPath, "utf8"));
        } catch {
          throw requestError("CODEX_RESEARCH_FAILED", 502);
        }
      } catch (error) {
        lastError = error;
        if (error?.code !== "CODEX_MODEL_UNSUPPORTED" || !selectedModel) {
          throw error;
        }
      }
    }
    throw lastError;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function parsedArtistProfileState(value) {
  try {
    const parsed = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && parsed.profiles
      ? parsed
      : { version: 3, profiles: {} };
  } catch {
    return { version: 3, profiles: {} };
  }
}

export async function persistResearchedArtistProfile(
  artistId,
  profile,
  statePath = getSharedStatePath(),
) {
  const cleanArtistId = cleanText(artistId, 240);
  if (!cleanArtistId) {
    throw requestError("ARTIST_ID_REQUIRED", 400, "缺少艺人身份。");
  }
  const sharedState = await readSharedState(statePath);
  const previousValue = sharedState.storage[ARTIST_PROFILE_STORAGE_KEY] ?? null;
  const current = sanitizeArtistProfileState(
    parsedArtistProfileState(previousValue),
  );
  const canonicalId = decodeArtistProfileId(cleanArtistId) || cleanArtistId;
  const previousKey =
    artistProfileLookupKeys(cleanArtistId).find((key) => current.profiles?.[key]) ||
    canonicalId;
  const previousProfile = current.profiles?.[previousKey] ?? {};
  const profiles = { ...(current.profiles ?? {}) };
  if (previousKey !== canonicalId) delete profiles[previousKey];
  const nextValue = JSON.stringify(
    sanitizeArtistProfileState({
      ...current,
      version: 3,
      profiles: {
        ...profiles,
        [canonicalId]: {
          ...previousProfile,
          ...profile,
          explorationEnabled: previousProfile.explorationEnabled === true,
          releaseView: previousProfile.releaseView === "grid" ? "grid" : "list",
          introduction:
            cleanText(profile.introduction, 12_000) ||
            previousProfile.introduction ||
            "",
          publicFacts: Object.prototype.hasOwnProperty.call(profile, "publicFacts")
            ? mergePublicFacts(previousProfile.publicFacts, profile.publicFacts)
            : previousProfile.publicFacts,
          platformLinks: Object.prototype.hasOwnProperty.call(
            profile,
            "platformLinks",
          )
            ? {
                ...(previousProfile.platformLinks ?? {}),
                ...profile.platformLinks,
              }
            : previousProfile.platformLinks,
          media: Object.prototype.hasOwnProperty.call(profile, "media")
            ? {
                ...(previousProfile.media ?? {}),
                ...profile.media,
                imageUrl:
                  profile.media?.imageUrl || previousProfile.media?.imageUrl || "",
                localMotionUrl:
                  profile.media?.localMotionUrl ||
                  previousProfile.media?.localMotionUrl ||
                  "",
              }
            : previousProfile.media,
          sources:
            Array.isArray(profile.sources) && profile.sources.length
              ? profile.sources
              : previousProfile.sources ?? [],
          updatedAt: new Date().toISOString(),
        },
      },
    }),
  );
  await applySharedStateChanges(
    { [ARTIST_PROFILE_STORAGE_KEY]: nextValue },
    statePath,
    {
      baseStorage: { [ARTIST_PROFILE_STORAGE_KEY]: previousValue },
      mergeMode: "three-way",
    },
  );
}

function pruneArtistResearchJobs(now = Date.now()) {
  for (const [jobId, job] of ARTIST_RESEARCH_JOBS.entries()) {
    if (now - job.updatedAtMs > CODEX_JOB_RETENTION_MS) {
      ARTIST_RESEARCH_JOBS.delete(jobId);
    }
  }
}

function publicArtistResearchJob(job) {
  return {
    jobId: job.jobId,
    artistId: job.artistId,
    status: job.status,
    message: job.message,
    resultStatus: job.resultStatus || "",
    profile: job.profile || null,
    warnings: job.warnings || [],
    error: job.error || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function updateArtistResearchJob(job, changes) {
  Object.assign(job, changes, {
    updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now(),
  });
  return job;
}

function activeArtistResearchJob(artistId) {
  return [...ARTIST_RESEARCH_JOBS.values()].find(
    (job) => job.artistId === artistId && ACTIVE_RESEARCH_STATUSES.has(job.status),
  );
}

export async function runArtistResearchJob(job, payload, options = {}) {
  const researchArtistImpl = options.researchArtistImpl ?? researchArtist;
  const requestCodexArtistResearchImpl =
    options.requestCodexArtistResearchImpl ?? requestCodexArtistResearch;
  const previousProfile = await loadStoredArtistProfile(
    payload.artistId,
    options.statePath,
  );
  const previousIntroduction = previousProfile.introduction || "";
  let baselineProfile = {};
  let baselineError = null;
  try {
    baselineProfile = await researchArtistImpl(payload, options);
    const earlyPatch = baselinePatchForPersist(
      baselineProfile,
      previousIntroduction,
    );
    if (earlyPatch) {
      await persistResearchedArtistProfile(
        payload.artistId,
        earlyPatch,
        options.statePath,
      );
      updateArtistResearchJob(job, {
        profile: {
          ...earlyPatch,
          introduction: earlyPatch.introduction || previousIntroduction,
        },
      });
    }
  } catch (error) {
    baselineError = error;
    if (error?.code === "ARTIST_IDENTITY_AMBIGUOUS") {
      updateArtistResearchJob(job, {
        status: "FAILED",
        resultStatus: "FAILED",
        message: artistResearchHardFailureMessage(
          "ARTIST_IDENTITY_AMBIGUOUS",
          error,
        ),
        profile: null,
        error: "ARTIST_IDENTITY_AMBIGUOUS",
      });
      return;
    }
  }
  try {
    const rawResult = await requestCodexArtistResearchImpl({
      identity: safeArtistIdentity(payload),
      timeoutMs: options.codexTimeoutMs ?? CODEX_TIMEOUT_MS,
      executable: options.codexExecutable,
      onProgress: ({ stage }) => {
        if (!ACTIVE_RESEARCH_STATUSES.has(stage)) return;
        updateArtistResearchJob(job, {
          status: stage,
          message: RESEARCH_STAGE_MESSAGES[stage],
        });
      },
    });
    updateArtistResearchJob(job, {
      status: "SAVING",
      message: RESEARCH_STAGE_MESSAGES.SAVING,
    });
    const profile = normalizeCodexArtistResearchResult(rawResult, baselineProfile);
    if (profile.introductionStatus !== "READY") {
      const combined = {
        introduction: baselineProfile.introduction || "",
        publicFacts: profile.publicFacts,
        sources: profile.sources?.length ? profile.sources : baselineProfile.sources,
      };
      const persisted = await persistBaselineFallback(job, payload, options, {
        baselineProfile: combined,
        previousIntroduction,
        errorCode: "INSUFFICIENT_SOURCES",
        notice: artistResearchCodexNotice("INSUFFICIENT_SOURCES"),
      });
      if (persisted) return;
      updateArtistResearchJob(job, {
        status: "COMPLETED",
        resultStatus: "INSUFFICIENT_SOURCES",
        message: artistResearchHardFailureMessage("INSUFFICIENT_SOURCES"),
        profile: job.profile || null,
        warnings: profile.warnings,
        error: "INSUFFICIENT_SOURCES",
      });
      return;
    }
    await persistResearchedArtistProfile(
      payload.artistId,
      profile,
      options.statePath,
    );
    updateArtistResearchJob(job, {
      status: "COMPLETED",
      resultStatus: "OK",
      message: RESEARCH_STAGE_MESSAGES.COMPLETED,
      profile,
      warnings: profile.warnings,
    });
  } catch (error) {
    const errorCode = error?.code || error?.message || "ARTIST_RESEARCH_UNAVAILABLE";
    const persisted = await persistBaselineFallback(job, payload, options, {
      baselineProfile,
      previousIntroduction,
      errorCode,
      notice: artistResearchCodexNotice(errorCode),
    });
    if (persisted) return;
    updateArtistResearchJob(job, {
      status: "FAILED",
      resultStatus: "FAILED",
      message: artistResearchHardFailureMessage(errorCode, baselineError),
      profile: job.profile || null,
      error:
        baselineError?.code === "ARTIST_IDENTITY_AMBIGUOUS"
          ? "ARTIST_IDENTITY_AMBIGUOUS"
          : baselineError?.code === "ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE" &&
              ![
                "CODEX_CLI_UNAVAILABLE",
                "CODEX_AUTH_REQUIRED",
                "CODEX_RESEARCH_TIMEOUT",
                "CODEX_MODEL_UNSUPPORTED",
              ].includes(errorCode)
            ? "ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE"
            : errorCode,
    });
  }
}

function startArtistResearchJob(payload, options = {}) {
  pruneArtistResearchJobs();
  const artistId = cleanText(payload?.artistId, 240);
  const artistName = cleanText(payload?.name, 180);
  if (!artistId) throw requestError("ARTIST_ID_REQUIRED", 400, "缺少艺人身份。");
  if (!artistName) throw requestError("ARTIST_NAME_REQUIRED", 400, "缺少艺人名称。");
  const activeJob = activeArtistResearchJob(artistId);
  if (activeJob) return activeJob;
  const now = new Date().toISOString();
  const job = {
    jobId: randomUUID(),
    artistId,
    status: "PREPARING",
    message: RESEARCH_STAGE_MESSAGES.PREPARING,
    resultStatus: "",
    profile: null,
    warnings: [],
    error: "",
    createdAt: now,
    updatedAt: now,
    updatedAtMs: Date.now(),
  };
  ARTIST_RESEARCH_JOBS.set(job.jobId, job);
  void runArtistResearchJob(job, payload, options);
  return job;
}

function playableArtistMotionUrl(value) {
  return /^\/private-motion-artwork\/[a-zA-Z0-9._-]+\.(?:webp|mp4)$/.test(
    cleanText(value, 400),
  )
    ? cleanText(value, 400)
    : "";
}

function artistMotionTruncationNotice(durationSeconds) {
  return `动态视频已截短至 ${durationSeconds} 秒，以控制在 8 MB 以内。`;
}

export function artistMotionFailureMessage(
  error,
  { preservedMotion = false, preservedImage = false } = {},
) {
  const code = String(error?.message ?? "").split(":")[0];
  const suffix = preservedMotion
    ? "已保留上次成功的动态视频。"
    : preservedImage
      ? "已保留高清艺人图片。"
      : "请稍后重试。";
  if (code === "MOTION_ARTWORK_TOO_LARGE") {
    return `动态视频压缩后仍超过 8 MB，${suffix}`;
  }
  if (code === "MOTION_CDN_UNREACHABLE" || code.startsWith("MOTION_SOURCE_HTTP_")) {
    return `Apple 动态视频暂时无法下载，${suffix}`;
  }
  if (code === "MOTION_PLAYLIST_UNSUPPORTED") {
    return `Apple 动态视频格式暂不支持，${suffix}`;
  }
  if (code === "FFMPEG_FAILED" || code === "FFMPEG_TIMEOUT") {
    return `动态视频转码失败，${suffix}`;
  }
  if (code === "INVALID_ARTIST_MOTION_SOURCE") {
    return `动态视频地址无效，${suffix}`;
  }
  if (code === "INVALID_ARTIST_MOTION_ID") {
    return `艺人素材无法写入本机，${suffix}`;
  }
  return `动态视频压缩失败，${suffix}`;
}

export async function requestArtistMedia(payload, options = {}) {
  const artistId = cleanText(payload.artistId, 240);
  const appleMusicUrl = cleanText(payload.appleMusicUrl, 1_000);
  if (!artistId) throw requestError("ARTIST_ID_REQUIRED", 400, "缺少艺人身份。");
  if (!appleMusicUrl) {
    throw requestError(
      "APPLE_MUSIC_ARTIST_URL_REQUIRED",
      400,
      "请先添加 Apple Music 艺人主页链接。",
    );
  }
  const sharedState = await readSharedState(
    options.statePath ?? getSharedStatePath(),
  );
  const previousValue = sharedState.storage[ARTIST_PROFILE_STORAGE_KEY] ?? null;
  const current = sanitizeArtistProfileState(
    parsedArtistProfileState(previousValue),
  );
  const previousKey =
    artistProfileLookupKeys(artistId).find((key) => current.profiles?.[key]) ||
    decodeArtistProfileId(artistId) ||
    artistId;
  const previousProfile = current.profiles?.[previousKey] ?? {};
  const previousMedia = previousProfile.media ?? {};
  let catalog;
  try {
    const lookupArtistMediaImpl =
      options.lookupArtistMediaImpl ?? lookupAppleArtistMedia;
    catalog = await lookupArtistMediaImpl(
      appleMusicUrl,
      options.fetchImpl ?? fetch,
    );
  } catch (error) {
    if (error?.message === "INVALID_APPLE_MUSIC_ARTIST_URL") {
      throw requestError(
        "INVALID_APPLE_MUSIC_ARTIST_URL",
        400,
        "Apple Music 链接必须是艺人主页。",
      );
    }
    throw requestError(
      "ARTIST_MEDIA_UPSTREAM_UNAVAILABLE",
      502,
      "Apple Music 艺人素材暂时无法读取，请稍后重试。",
    );
  }
  let localMotionUrl = "";
  let motionError = "";
  let motionNotice = "";
  let truncated = false;
  const sourceVideoUrl = playableAppleHlsUrl(catalog.sourceVideoUrl);
  if (sourceVideoUrl) {
    try {
      const cacheArtistMotionArtworkImpl =
        options.cacheArtistMotionArtworkImpl ?? cacheArtistMotionArtwork;
      const cached = await cacheArtistMotionArtworkImpl(
        artistId,
        sourceVideoUrl,
        options.fetchImpl ?? fetch,
      );
      localMotionUrl = playableArtistMotionUrl(cached.localUrl);
      truncated = cached.motionArtwork?.truncated === true;
      if (truncated) {
        motionNotice = artistMotionTruncationNotice(
          cached.motionArtwork?.durationSeconds ?? 8,
        );
      }
    } catch (error) {
      localMotionUrl = playableArtistMotionUrl(previousMedia.localMotionUrl);
      motionError = artistMotionFailureMessage(error, {
        preservedMotion: Boolean(localMotionUrl),
        preservedImage: Boolean(catalog.imageUrl || previousMedia.imageUrl),
      });
    }
  } else {
    localMotionUrl = playableArtistMotionUrl(previousMedia.localMotionUrl);
  }
  const imageUrl =
    cleanText(catalog.imageUrl, 2_000) ||
    cleanText(previousMedia.imageUrl, 2_000);
  const media = {
    status: localMotionUrl
      ? "READY"
      : imageUrl
        ? "IMAGE_ONLY"
        : "UNAVAILABLE",
    imageUrl,
    localMotionUrl,
    sourceVideoUrl:
      sourceVideoUrl || playableAppleHlsUrl(previousMedia.sourceVideoUrl) || "",
    motionEnabled: previousMedia.motionEnabled !== false,
    source: "Apple Music",
    checkedAt: new Date().toISOString(),
    truncated,
    notice: motionNotice,
    error: motionError,
  };
  await persistResearchedArtistProfile(
    artistId,
    {
      platformLinks: {
        ...(previousProfile.platformLinks ?? {}),
        appleMusic: catalog.normalizedUrl,
      },
      media,
    },
    options.statePath,
  );
  return { media, appleMusicUrl: catalog.normalizedUrl };
}

export async function handleArtistResearchRequest(request, response, options = {}) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (![API_PATH, MEDIA_API_PATH].includes(url.pathname)) return false;
  if (url.pathname === API_PATH && request.method === "GET") {
    pruneArtistResearchJobs();
    const job = ARTIST_RESEARCH_JOBS.get(cleanText(url.searchParams.get("jobId"), 100));
    if (!job) {
      sendJson(response, 404, { error: "ARTIST_RESEARCH_JOB_NOT_FOUND" });
      return true;
    }
    sendJson(response, 200, { job: publicArtistResearchJob(job) });
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  try {
    const payload = await readJsonBody(request, 64_000);
    if (url.pathname === MEDIA_API_PATH) {
      const result = await requestArtistMedia(payload, options);
      sendJson(response, 200, result);
      return true;
    }
    const job = startArtistResearchJob(payload, options);
    sendJson(response, 202, { job: publicArtistResearchJob(job) });
  } catch (error) {
    const safeCodes = new Set([
      "ARTIST_IDENTITY_AMBIGUOUS",
      "ARTIST_ID_REQUIRED",
      "ARTIST_NAME_REQUIRED",
      "APPLE_MUSIC_ARTIST_URL_REQUIRED",
      "INVALID_APPLE_MUSIC_ARTIST_URL",
      "ARTIST_MEDIA_UPSTREAM_UNAVAILABLE",
      "ARTIST_RESEARCH_UPSTREAM_UNAVAILABLE",
      "INVALID_JSON",
      "PAYLOAD_TOO_LARGE",
      "ARTIST_RESEARCH_JOB_NOT_FOUND",
    ]);
    const code = safeCodes.has(error?.code ?? error?.message)
      ? error?.code ?? error?.message
      : "ARTIST_RESEARCH_UNAVAILABLE";
    sendJson(response, error?.statusCode ?? 502, {
      error: code,
      message: error?.safeMessage || "艺人公开资料暂时无法更新，请稍后重试。",
    });
  }
  return true;
}
