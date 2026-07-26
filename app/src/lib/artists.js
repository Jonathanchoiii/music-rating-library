import {
  getCurrentRating,
  normalizeText,
  splitArtistCredits,
} from "./music.js";

export const ARTIST_IDENTITY_STORAGE_KEY =
  "recordshelf-artist-identities-v1";
export const ARTIST_IDENTITY_BACKUP_STORAGE_KEY =
  "recordshelf-artist-identities-backups-v1";

const MUSICBRAINZ_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_ARTIST_IDENTITY_STATE = {
  schemaVersion: 2,
  identities: [
    {
      id: "mbid-3821e3ac-4d91-40b8-a669-f58d1fe2c0c4",
      canonicalName: "魏如萱",
      sortName: "魏如萱",
      musicBrainzMbid: "3821e3ac-4d91-40b8-a669-f58d1fe2c0c4",
      source: "MUSICBRAINZ_AND_USER",
      aliases: [
        {
          name: "魏如萱",
          locale: "zh-Hant",
          type: "PRIMARY",
          source: "MUSICBRAINZ",
        },
        {
          name: "魏如萱 Waa",
          locale: "zh-Hant",
          type: "CREDIT_VARIANT",
          source: "USER",
        },
        {
          name: "Waa Wei",
          locale: "en",
          type: "ARTIST_NAME",
          source: "MUSICBRAINZ",
        },
      ],
    },
  ],
};

function createLocalId(prefix = "artist") {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function cleanName(value = "") {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sanitizeAlias(alias) {
  const name = cleanName(typeof alias === "string" ? alias : alias?.name);
  if (!name) return null;
  return {
    name,
    locale: cleanName(alias?.locale),
    type: alias?.type || "CREDIT_VARIANT",
    source: alias?.source || "USER",
  };
}

function sanitizeIdentity(identity) {
  const canonicalName = cleanName(identity?.canonicalName);
  if (!canonicalName) return null;
  const aliases = [
    {
      name: canonicalName,
      locale: cleanName(identity?.locale),
      type: "PRIMARY",
      source: identity?.source || "USER",
    },
    ...(identity?.aliases ?? []).map(sanitizeAlias).filter(Boolean),
  ];
  const deduplicatedAliases = [
    ...new Map(
      aliases.map((alias) => [normalizeText(alias.name), alias]),
    ).values(),
  ];
  const durableAliases = deduplicatedAliases.filter(
    (alias) => alias.source !== "MUSICBRAINZ",
  );
  const musicBrainzAliases = deduplicatedAliases
    .filter((alias) => alias.source === "MUSICBRAINZ")
    .sort((left, right) => {
      const localeRank = (alias) => {
        const locale = normalizeText(alias.locale);
        if (locale.startsWith("zh")) return 0;
        if (locale.startsWith("en")) return 1;
        return 2;
      };
      return (
        localeRank(left) - localeRank(right) ||
        left.name.localeCompare(right.name, "zh-CN")
      );
    })
    .slice(0, 12);
  return {
    id: cleanName(identity?.id) || createLocalId(),
    canonicalName,
    sortName: cleanName(identity?.sortName) || canonicalName,
    musicBrainzMbid: cleanName(identity?.musicBrainzMbid),
    source: identity?.source || "USER",
    musicBrainzStatus: cleanName(identity?.musicBrainzStatus),
    musicBrainzCheckedAt: cleanName(identity?.musicBrainzCheckedAt),
    musicBrainzAuditFingerprint: cleanName(
      identity?.musicBrainzAuditFingerprint,
    ),
    musicBrainzEvidence: identity?.musicBrainzEvidence ?? null,
    musicBrainzCandidates: Array.isArray(identity?.musicBrainzCandidates)
      ? identity.musicBrainzCandidates.slice(0, 5)
      : [],
    aliases: [...durableAliases, ...musicBrainzAliases],
  };
}

export function sanitizeArtistIdentityState(state) {
  return {
    schemaVersion: 2,
    identities: (state?.identities ?? [])
      .map(sanitizeIdentity)
      .filter(Boolean),
  };
}

export function loadArtistIdentityState(storage = globalThis.localStorage) {
  let primaryError = null;
  try {
    const saved = storage?.getItem(ARTIST_IDENTITY_STORAGE_KEY);
    if (saved) return sanitizeArtistIdentityState(JSON.parse(saved));
  } catch (error) {
    primaryError = error;
  }
  if (primaryError) {
    try {
      const backups = JSON.parse(
        storage?.getItem(ARTIST_IDENTITY_BACKUP_STORAGE_KEY) ?? "[]",
      );
      const latest = Array.isArray(backups) ? backups.at(-1)?.state : null;
      if (latest) return sanitizeArtistIdentityState(latest);
    } catch (backupError) {
      console.warn("艺人映射备份暂时无法读取", backupError);
    }
    console.warn("艺人映射暂时无法读取", primaryError);
  }
  return sanitizeArtistIdentityState(DEFAULT_ARTIST_IDENTITY_STATE);
}

export function saveArtistIdentityState(
  state,
  storage = globalThis.localStorage,
) {
  const sanitized = sanitizeArtistIdentityState(state);
  try {
    const serialized = JSON.stringify(sanitized);
    let backups = [];
    try {
      const storedBackups = JSON.parse(
        storage?.getItem(ARTIST_IDENTITY_BACKUP_STORAGE_KEY) ?? "[]",
      );
      if (Array.isArray(storedBackups)) backups = storedBackups;
    } catch {
      backups = [];
    }
    const latestFingerprint = backups.at(-1)?.state
      ? JSON.stringify(
          sanitizeArtistIdentityState(backups.at(-1).state),
        )
      : "";
    if (serialized !== latestFingerprint) {
      backups.push({
        savedAt: new Date().toISOString(),
        state: sanitized,
      });
      storage?.setItem(
        ARTIST_IDENTITY_BACKUP_STORAGE_KEY,
        JSON.stringify(backups.slice(-10)),
      );
    }
    storage?.setItem(
      ARTIST_IDENTITY_STORAGE_KEY,
      serialized,
    );
  } catch (error) {
    console.warn("艺人映射暂时无法保存", error);
  }
  return sanitized;
}

export function createArtistIdentity(canonicalName) {
  const name = cleanName(canonicalName);
  if (!name) return null;
  return sanitizeIdentity({
    id: createLocalId(),
    canonicalName: name,
    source: "USER",
    aliases: [],
  });
}

export function findArtistNameConflicts(
  identityState,
  artistNames,
  excludeIdentityId = "",
) {
  const names = Array.isArray(artistNames) ? artistNames : [artistNames];
  const normalizedNames = new Set(names.map(normalizeText).filter(Boolean));
  if (!normalizedNames.size) return [];

  return (identityState?.identities ?? [])
    .filter((identity) => identity.id !== excludeIdentityId)
    .map((identity) => {
      const knownNames = [
        {
          name: identity.canonicalName,
          source: "PRIMARY",
        },
        ...(identity.aliases ?? []).map((alias) => ({
          name: alias.name,
          source: "ALIAS",
        })),
        ...(identity.musicBrainzCandidates ?? []).map((candidate) => ({
          name: candidate.name,
          source: "MUSICBRAINZ_CANDIDATE",
        })),
      ].filter((item) => normalizedNames.has(normalizeText(item.name)));
      if (!knownNames.length) return null;
      return {
        identity,
        matches: [
          ...new Map(
            knownNames.map((item) => [
              `${normalizeText(item.name)}:${item.source}`,
              item,
            ]),
          ).values(),
        ],
      };
    })
    .filter(Boolean);
}

export function getArtistAliasIndex(identityState) {
  const aliasIndex = new Map();
  const ambiguousNames = new Set();
  for (const identity of identityState?.identities ?? []) {
    const sanitizedIdentity = sanitizeIdentity(identity);
    if (!sanitizedIdentity) continue;
    for (const alias of sanitizedIdentity.aliases) {
      const key = normalizeText(alias.name);
      if (!key || ambiguousNames.has(key)) continue;
      const priorOwner = aliasIndex.get(key);
      if (priorOwner && priorOwner.id !== sanitizedIdentity.id) {
        aliasIndex.delete(key);
        ambiguousNames.add(key);
      } else if (!priorOwner) {
        aliasIndex.set(key, sanitizedIdentity);
      }
    }
  }
  return aliasIndex;
}

export function resolveArtistCredit(
  credit,
  identityState,
  aliasIndex = getArtistAliasIndex(identityState),
) {
  const displayName = cleanName(credit);
  const normalizedName = normalizeText(displayName);
  const identity = aliasIndex.get(normalizedName);
  if (identity) {
    return {
      ...identity,
      mapped: true,
      creditName: displayName,
    };
  }
  return {
    id: `raw-${normalizedName}`,
    canonicalName: displayName,
    sortName: displayName,
    musicBrainzMbid: "",
    source: "RELEASE_CREDIT",
    aliases: [],
    mapped: false,
    creditName: displayName,
  };
}

export function releaseMatchesMappedArtistQuery(
  release,
  artistQuery,
  identityState,
) {
  const query = normalizeText(artistQuery);
  if (!query) return false;
  const aliasIndex = getArtistAliasIndex(identityState);
  return splitArtistCredits(release.artists).some((credit) => {
    const identity = resolveArtistCredit(credit, identityState, aliasIndex);
    return [identity.canonicalName, ...identity.aliases.map((alias) => alias.name)]
      .map(normalizeText)
      .some((name) => name.includes(query));
  });
}

export function getReleaseArtistTargets(release, identityState) {
  const aliasIndex = getArtistAliasIndex(identityState);
  const seenArtistIds = new Set();
  return splitArtistCredits(release?.artists ?? []).flatMap((credit) => {
    const identity = resolveArtistCredit(
      credit,
      identityState,
      aliasIndex,
    );
    if (!identity.id || seenArtistIds.has(identity.id)) return [];
    seenArtistIds.add(identity.id);
    return [
      {
        id: identity.id,
        name: credit,
        canonicalName: identity.canonicalName,
        mapped: identity.mapped,
      },
    ];
  });
}

export function groupReleasesByArtistIdentity(
  releases = [],
  identityState,
  artistQuery = "",
) {
  const query = normalizeText(artistQuery);
  const groups = new Map();
  const aliasIndex = getArtistAliasIndex(identityState);

  for (const release of releases) {
    const seenIdentityIds = new Set();
    for (const credit of splitArtistCredits(release.artists)) {
      const identity = resolveArtistCredit(
        credit,
        identityState,
        aliasIndex,
      );
      const searchableNames = [
        identity.canonicalName,
        ...identity.aliases.map((alias) => alias.name),
      ].map(normalizeText);
      if (
        query &&
        !searchableNames.some((name) => name.includes(query))
      ) {
        continue;
      }
      if (!identity.id || seenIdentityIds.has(identity.id)) continue;
      seenIdentityIds.add(identity.id);
      if (!groups.has(identity.id)) {
        groups.set(identity.id, {
          id: identity.id,
          artist: identity.canonicalName,
          sortName: identity.sortName,
          musicBrainzMbid: identity.musicBrainzMbid,
          mapped: identity.mapped,
          aliases: new Set(),
          credits: new Set(),
          releases: [],
        });
      }
      const group = groups.get(identity.id);
      group.credits.add(credit);
      identity.aliases.forEach((alias) => group.aliases.add(alias.name));
      if (!group.releases.some((item) => item.id === release.id)) {
        group.releases.push(release);
      }
    }
  }

  return [...groups.values()]
    .map((group) => {
      const scores = group.releases
        .map((release) => getCurrentRating(release.listeningEntries))
        .filter((score) => score != null);
      return {
        ...group,
        aliases: [...group.aliases].filter(
          (alias) => normalizeText(alias) !== normalizeText(group.artist),
        ),
        credits: [...group.credits],
        average:
          scores.length > 0
            ? scores.reduce((sum, score) => sum + score, 0) / scores.length
            : null,
      };
    })
    .sort(
      (groupA, groupB) =>
        groupB.releases.length - groupA.releases.length ||
        groupA.sortName.localeCompare(groupB.sortName, "zh-CN"),
    );
}

function compareArtistGroupNames(groupA, groupB) {
  const nameA = cleanName(groupA?.sortName || groupA?.artist);
  const nameB = cleanName(groupB?.sortName || groupB?.artist);
  return nameA.localeCompare(nameB, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortArtistGroups(
  groups = [],
  sort = "average_desc",
) {
  return [...groups].sort((groupA, groupB) => {
    if (sort === "name_asc") {
      return compareArtistGroupNames(groupA, groupB);
    }
    if (sort === "name_desc") {
      return compareArtistGroupNames(groupB, groupA);
    }

    const averageA = Number.isFinite(groupA?.average)
      ? groupA.average
      : Number.NEGATIVE_INFINITY;
    const averageB = Number.isFinite(groupB?.average)
      ? groupB.average
      : Number.NEGATIVE_INFINITY;
    return (
      averageB - averageA ||
      (groupB?.releases?.length ?? 0) -
        (groupA?.releases?.length ?? 0) ||
      compareArtistGroupNames(groupA, groupB)
    );
  });
}

export function getRawArtistCreditCounts(releases = []) {
  const counts = new Map();
  for (const release of releases) {
    for (const credit of splitArtistCredits(release.artists)) {
      const key = normalizeText(credit);
      if (!key) continue;
      const current = counts.get(key) ?? { name: credit, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort(
    (itemA, itemB) =>
      itemB.count - itemA.count ||
      itemA.name.localeCompare(itemB.name, "zh-CN"),
  );
}

function addAliasIfAvailable(identity, aliasName, source, aliasOwners) {
  const name = cleanName(aliasName);
  const normalized = normalizeText(name);
  if (!normalized) return { identity, added: false };
  const priorOwner = aliasOwners.get(normalized);
  if (priorOwner && priorOwner !== identity.id) {
    return { identity, added: false };
  }
  if (
    identity.aliases.some(
      (alias) => normalizeText(alias.name) === normalized,
    )
  ) {
    return { identity, added: false };
  }
  aliasOwners.set(normalized, identity.id);
  return {
    identity: {
      ...identity,
      aliases: [
        ...identity.aliases,
        {
          name,
          locale: "",
          type: "SEARCH_ALIAS",
          source,
        },
      ],
    },
    added: true,
  };
}

function stableFingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function artistIdentityAuditFingerprint(identity, releases = []) {
  const names = [
    identity.canonicalName,
    ...(identity.aliases ?? []).map((alias) => alias.name),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .sort();
  const titles = releases
    .map((release) => normalizeText(release.title))
    .filter(Boolean)
    .sort();
  return stableFingerprint(
    JSON.stringify([names, titles, identity.musicBrainzMbid ?? ""]),
  );
}

export function artistIdentityNeedsMusicBrainzAudit(
  identity,
  releases = [],
  now = Date.now(),
) {
  const fingerprint = artistIdentityAuditFingerprint(identity, releases);
  if (identity.musicBrainzAuditFingerprint !== fingerprint) return true;
  const checkedAt = Date.parse(identity.musicBrainzCheckedAt ?? "");
  return (
    !Number.isFinite(checkedAt) ||
    now - checkedAt >= MUSICBRAINZ_AUDIT_TTL_MS
  );
}

export function findDuplicateArtistMbidGroups(identityState) {
  const groups = new Map();
  for (const identity of identityState?.identities ?? []) {
    const mbid = cleanName(identity.musicBrainzMbid).toLocaleLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(mbid)) continue;
    const current = groups.get(mbid) ?? [];
    current.push(identity);
    groups.set(mbid, current);
  }
  return [...groups.entries()]
    .filter(([, identities]) => identities.length > 1)
    .map(([mbid, identities]) => ({ mbid, identities }));
}

export function mergePossibleDuplicateArtists(
  rawState,
  candidate,
  selectedMemberId,
) {
  const state = sanitizeArtistIdentityState(rawState);
  const members = Array.isArray(candidate?.members)
    ? candidate.members
    : [];
  const selectedMember = members.find(
    (member) => member.id === selectedMemberId,
  );
  if (!selectedMember || members.length < 2) {
    throw new Error("请选择关联后保留的主艺人");
  }

  const identityById = new Map(
    state.identities.map((identity) => [identity.id, identity]),
  );
  const mergedIdentityIds = new Set(
    members
      .map((member) => member.identityId || member.id)
      .filter((identityId) => identityById.has(identityId)),
  );
  const musicBrainzMbids = new Set(
    [...mergedIdentityIds]
      .map((identityId) => identityById.get(identityId)?.musicBrainzMbid)
      .filter(Boolean),
  );
  if (musicBrainzMbids.size > 1) {
    throw new Error("候选艺人的 MusicBrainz ID 不同，请先人工核对 ID");
  }

  const selectedExistingIdentity = identityById.get(
    selectedMember.identityId || selectedMember.id,
  );
  const fallbackIdentity = [...mergedIdentityIds]
    .map((identityId) => identityById.get(identityId))
    .find(Boolean);
  const baseIdentity =
    selectedExistingIdentity ??
    fallbackIdentity ??
    createArtistIdentity(selectedMember.canonicalName);
  if (!baseIdentity) {
    throw new Error("无法建立主艺人身份");
  }

  const aliasCandidates = [];
  for (const member of members) {
    aliasCandidates.push(member.canonicalName, ...(member.names ?? []));
    const identity = identityById.get(member.identityId || member.id);
    if (!identity) continue;
    aliasCandidates.push(
      identity.canonicalName,
      ...(identity.aliases ?? []).map((alias) => alias.name),
    );
  }
  const canonicalName = cleanName(selectedMember.canonicalName);
  const aliases = [
    ...(baseIdentity.aliases ?? []),
    ...aliasCandidates.map((name) => ({
      name: cleanName(name),
      locale: "",
      type:
        normalizeText(name) === normalizeText(canonicalName)
          ? "PRIMARY"
          : "CREDIT_VARIANT",
      source: "USER_CONFIRMED_DUPLICATE",
    })),
  ].filter((alias) => alias.name);
  const deduplicatedAliases = [
    ...new Map(
      aliases.map((alias) => [normalizeText(alias.name), alias]),
    ).values(),
  ];
  const targetIdentity = sanitizeIdentity({
    ...baseIdentity,
    id: baseIdentity.id,
    canonicalName,
    sortName: canonicalName,
    musicBrainzMbid:
      [...musicBrainzMbids][0] || baseIdentity.musicBrainzMbid || "",
    source:
      baseIdentity.source === "USER"
        ? "USER_CONFIRMED_DUPLICATE"
        : baseIdentity.source,
    aliases: deduplicatedAliases,
  });
  const identities = state.identities.filter(
    (identity) => !mergedIdentityIds.has(identity.id),
  );
  identities.push(targetIdentity);
  return sanitizeArtistIdentityState({
    ...state,
    identities,
  });
}

export function applyMusicBrainzArtistAuditResults(
  rawState,
  results = [],
) {
  const state = sanitizeArtistIdentityState(rawState);
  const resultById = new Map(results.map((result) => [result.id, result]));
  const aliasOwners = new Map();
  for (const identity of state.identities) {
    for (const alias of identity.aliases) {
      aliasOwners.set(normalizeText(alias.name), identity.id);
    }
  }

  const identities = state.identities.map((identity) => {
    const result = resultById.get(identity.id);
    if (!result) return identity;
    let nextIdentity = {
      ...identity,
      musicBrainzStatus: result.status,
      musicBrainzCheckedAt: result.checkedAt,
      musicBrainzAuditFingerprint: result.fingerprint,
      musicBrainzEvidence: result.evidence ?? null,
      musicBrainzCandidates: result.candidates ?? [],
    };
    const canApply =
      ["MATCHED", "VALID"].includes(result.status) &&
      (!identity.musicBrainzMbid ||
        identity.musicBrainzMbid === result.musicBrainzMbid);
    if (!canApply) return nextIdentity;
    nextIdentity = {
      ...nextIdentity,
      musicBrainzMbid: result.musicBrainzMbid,
      source:
        identity.source === "USER"
          ? "MUSICBRAINZ_AND_USER"
          : identity.source,
    };
    for (const alias of result.aliases ?? []) {
      const applied = addAliasIfAvailable(
        nextIdentity,
        alias.name ?? alias,
        "MUSICBRAINZ",
        aliasOwners,
      );
      nextIdentity = applied.identity;
    }
    return nextIdentity;
  });

  return sanitizeArtistIdentityState({ ...state, identities });
}
