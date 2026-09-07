import { randomUUID } from "node:crypto";
import { readJsonBody, sendJson } from "../scripts/http-json.mjs";
import {
  persistResearchedArtistProfile,
  researchArtist,
} from "../artist-research/index.mjs";
import {
  getSharedStatePath,
  readSharedState,
} from "../shared-state/index.mjs";
import {
  artistProfileLookupKeys,
  sanitizeArtistProfileState,
} from "../src/lib/artistProfiles.js";
import { resolveRoamCountry } from "../src/lib/roam.js";
import { ARTIST_PROFILE_STORAGE_KEY } from "../src/lib/sharedStorageKeys.js";

const API_PATH = "/api/roam/countries/refresh";
const REQUEST_INTERVAL_MS = 1_150;
const JOB_RETENTION_MS = 60 * 60_000;
const ACTIVE_STATUSES = new Set(["CHECKING", "SAVING"]);
const JOBS = new Map();
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function uniqueText(values, limit = 20) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => cleanText(value)).filter(Boolean))]
    .slice(0, limit);
}

function sanitizeCandidates(value) {
  return (Array.isArray(value) ? value : []).slice(0, 500).flatMap((candidate) => {
    const artistId = cleanText(candidate?.artistId);
    const name = cleanText(candidate?.name, 180);
    if (!artistId || !name) return [];
    const musicBrainzId = cleanText(candidate?.musicBrainzId, 80);
    const identityFingerprint = cleanText(candidate?.identityFingerprint, 80);
    return [{
      artistId,
      name,
      aliases: uniqueText(candidate?.aliases, 16),
      musicBrainzId: MBID_PATTERN.test(musicBrainzId) ? musicBrainzId : "",
      releaseHints: (Array.isArray(candidate?.releaseHints)
        ? candidate.releaseHints
        : [])
        .slice(0, 12)
        .flatMap((release) => {
          const title = cleanText(release?.title, 240);
          if (!title) return [];
          return [{
            title,
            translatedTitle: cleanText(release?.translatedTitle, 240),
            titleAliases: uniqueText(release?.titleAliases, 12),
            releaseType: cleanText(release?.releaseType, 40),
            releaseDate: cleanText(release?.releaseDate, 30),
            artists: uniqueText(release?.artists, 12),
          }];
        }),
      identityFingerprint: /^v1:[0-9a-f]{16}$/i.test(identityFingerprint)
        ? identityFingerprint.toLowerCase()
        : "",
    }];
  });
}

function parseStoredJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function storedProfile(artistId, statePath) {
  const sharedState = await readSharedState(statePath);
  const profileState = sanitizeArtistProfileState(
    parseStoredJson(sharedState.storage[ARTIST_PROFILE_STORAGE_KEY], {}),
  );
  const key = artistProfileLookupKeys(artistId).find(
    (candidate) => profileState.profiles?.[candidate],
  );
  return key ? profileState.profiles[key] : null;
}

function mergeSources(previous = [], incoming = []) {
  const sources = new Map();
  for (const source of [...previous, ...incoming]) {
    const key = source?.url || source?.sourceId;
    if (key) sources.set(key, source);
  }
  return [...sources.values()];
}

function verifiedMusicBrainzIdentity(candidate, result) {
  const resultId = cleanText(result?.publicFacts?.musicBrainzId, 80);
  if (!MBID_PATTERN.test(resultId)) return "";
  if (
    candidate.musicBrainzId &&
    candidate.musicBrainzId.toLowerCase() !== resultId.toLowerCase()
  ) return "";
  const hasExactSource = (result?.sources ?? []).some((source) => {
    try {
      const url = new URL(cleanText(source?.url, 1_000));
      return (
        url.hostname.toLowerCase() === "musicbrainz.org" &&
        url.pathname.toLowerCase() === `/artist/${resultId.toLowerCase()}`
      );
    } catch {
      return false;
    }
  });
  return hasExactSource ? resultId : "";
}

function hasVerifiedCountryEvidence(result, region) {
  const evidence = result?.countryEvidence;
  const countryCode = cleanText(evidence?.countryCode, 2).toUpperCase();
  const sourceUrl = cleanText(evidence?.sourceUrl, 1_000);
  if (
    evidence?.status !== "CONFIRMED" ||
    !["WIKIDATA_CITIZENSHIP", "WIKIDATA_COUNTRY_OF_ORIGIN"].includes(
      evidence?.kind,
    ) ||
    countryCode !== region?.code ||
    !sourceUrl
  ) return false;
  return (result?.sources ?? []).some(
    (source) => cleanText(source?.url, 1_000) === sourceUrl,
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runRoamCountryRefresh(candidates, options = {}) {
  const researchArtistImpl = options.researchArtistImpl ?? researchArtist;
  const persistProfileImpl = options.persistProfileImpl ?? persistResearchedArtistProfile;
  const storedProfileImpl = options.storedProfileImpl ?? storedProfile;
  const delayImpl = options.delayImpl ?? delay;
  const statePath = options.statePath ?? getSharedStatePath();
  const onProgress = options.onProgress ?? (() => {});
  const nowImpl = options.nowImpl ?? (() => new Date().toISOString());
  const cleanCandidates = sanitizeCandidates(candidates);
  const summary = {
    total: cleanCandidates.length,
    checked: 0,
    updated: 0,
    noCountry: 0,
    ambiguous: 0,
    failed: 0,
    updates: [],
  };

  for (const [index, candidate] of cleanCandidates.entries()) {
    onProgress({ ...summary, currentArtist: candidate.name });
    try {
      const [previous, result] = await Promise.all([
        storedProfileImpl(candidate.artistId, statePath),
        researchArtistImpl(candidate, options),
      ]);
      const latest = await storedProfileImpl(candidate.artistId, statePath);
      if (
        ["USER_CONFIRMED", "USER_CONFIRMED_APPLE"].includes(
          latest?.roamCountryAudit?.evidence,
        )
      ) {
        summary.checked += 1;
        onProgress({ ...summary, currentArtist: candidate.name });
        if (index < cleanCandidates.length - 1) {
          await delayImpl(REQUEST_INTERVAL_MS);
        }
        continue;
      }
      const region = resolveRoamCountry(result.publicFacts?.country);
      const verifiedMusicBrainzId = verifiedMusicBrainzIdentity(candidate, result);
      const checkedAt = nowImpl();
      if (!verifiedMusicBrainzId) {
        summary.ambiguous += 1;
        const patch = {
          roamCountryAudit: {
            status: "AMBIGUOUS",
            checkedAt,
            identityFingerprint: candidate.identityFingerprint,
          },
        };
        await persistProfileImpl(candidate.artistId, patch, statePath);
        summary.updates.push({ artistId: candidate.artistId, profile: patch });
      } else if (!region || !result.sources?.length) {
        summary.noCountry += 1;
        const patch = {
          roamCountryAudit: {
            status: "NO_COUNTRY",
            checkedAt,
            identityFingerprint: candidate.identityFingerprint,
          },
        };
        await persistProfileImpl(candidate.artistId, patch, statePath);
        summary.updates.push({ artistId: candidate.artistId, profile: patch });
      } else if (!hasVerifiedCountryEvidence(result, region)) {
        summary.noCountry += 1;
        const patch = {
          roamCountryAudit: {
            status: "NO_COUNTRY",
            checkedAt,
            identityFingerprint: candidate.identityFingerprint,
          },
        };
        await persistProfileImpl(candidate.artistId, patch, statePath);
        summary.updates.push({ artistId: candidate.artistId, profile: patch });
      } else {
        const patch = {
          introductionStatus: "READY",
          introduction: result.introduction ?? previous?.introduction ?? "",
          publicFacts: result.publicFacts,
          sources: mergeSources(previous?.sources, result.sources),
          researchError: "",
          roamCountryAudit: {
            status: "CONFIRMED",
            checkedAt,
            identityFingerprint: candidate.identityFingerprint,
            evidence: "WIKIDATA_COUNTRY",
          },
        };
        await persistProfileImpl(candidate.artistId, patch, statePath);
        summary.updated += 1;
        summary.updates.push({ artistId: candidate.artistId, profile: patch });
      }
    } catch (error) {
      if (error?.code === "ARTIST_IDENTITY_AMBIGUOUS") {
        summary.ambiguous += 1;
        const patch = {
          roamCountryAudit: {
            status: "AMBIGUOUS",
            checkedAt: nowImpl(),
            identityFingerprint: candidate.identityFingerprint,
          },
        };
        await persistProfileImpl(candidate.artistId, patch, statePath);
        summary.updates.push({ artistId: candidate.artistId, profile: patch });
      } else {
        summary.failed += 1;
      }
    }
    summary.checked += 1;
    onProgress({ ...summary, currentArtist: candidate.name });
    if (index < cleanCandidates.length - 1) {
      await delayImpl(REQUEST_INTERVAL_MS);
    }
  }
  return summary;
}

function pruneJobs(now = Date.now()) {
  for (const [jobId, job] of JOBS.entries()) {
    if (now - job.updatedAtMs > JOB_RETENTION_MS) JOBS.delete(jobId);
  }
}

function publicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    checked: job.checked,
    updated: job.updated,
    noCountry: job.noCountry,
    ambiguous: job.ambiguous,
    failed: job.failed,
    currentArtist: job.currentArtist,
    updates: job.status === "COMPLETED" ? job.updates : [],
    error: job.error,
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAtMs: Date.now() });
}

function activeJob() {
  return [...JOBS.values()].find((job) => ACTIVE_STATUSES.has(job.status));
}

function startJob(candidates, options = {}) {
  pruneJobs();
  const existing = activeJob();
  if (existing) return existing;
  const cleanCandidates = sanitizeCandidates(candidates);
  const job = {
    jobId: randomUUID(),
    status: "CHECKING",
    total: cleanCandidates.length,
    checked: 0,
    updated: 0,
    noCountry: 0,
    ambiguous: 0,
    failed: 0,
    currentArtist: "",
    updates: [],
    error: "",
    updatedAtMs: Date.now(),
  };
  JOBS.set(job.jobId, job);
  void runRoamCountryRefresh(cleanCandidates, {
    ...options,
    onProgress: (progress) => updateJob(job, progress),
  }).then(
    (summary) => updateJob(job, { ...summary, status: "COMPLETED", currentArtist: "" }),
    () => updateJob(job, { status: "FAILED", error: "ROAM_COUNTRY_REFRESH_FAILED", currentArtist: "" }),
  );
  return job;
}

function isAuthoritativeRequest(request) {
  const host = cleanText(request.headers?.host, 200).toLowerCase();
  return host === "127.0.0.1:4173" || host === "localhost:4173";
}

export async function handleRoamCountryRefreshRequest(request, response, options = {}) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname !== API_PATH) return false;
  if (!isAuthoritativeRequest(request) && options.allowNonAuthoritative !== true) {
    sendJson(response, 403, { error: "ROAM_COUNTRY_REFRESH_LOCAL_ONLY" });
    return true;
  }
  if (request.method === "GET") {
    pruneJobs();
    const job = JOBS.get(cleanText(url.searchParams.get("jobId"), 100));
    if (!job) {
      sendJson(response, 404, { error: "ROAM_COUNTRY_REFRESH_JOB_NOT_FOUND" });
      return true;
    }
    sendJson(response, 200, { job: publicJob(job) });
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  try {
    const payload = await readJsonBody(request, 256_000);
    const job = startJob(payload.candidates, options);
    sendJson(response, 202, { job: publicJob(job) });
  } catch (error) {
    sendJson(response, error?.statusCode ?? 500, {
      error: ["INVALID_JSON", "PAYLOAD_TOO_LARGE"].includes(error?.message)
        ? error.message
        : "ROAM_COUNTRY_REFRESH_UNAVAILABLE",
    });
  }
  return true;
}
