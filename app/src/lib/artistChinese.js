import OpenCCCnToTraditional from "opencc-js/cn2t";
import OpenCCTraditionalToCn from "opencc-js/t2cn";
import {
  createArtistIdentity,
  sanitizeArtistIdentityState,
} from "./artists.js";
import {
  normalizeText,
  splitArtistCredits,
} from "./music.js";

const toSimplifiedChinese = OpenCCTraditionalToCn.Converter({
  from: "tw",
  to: "cn",
});
const toTraditionalChinese = OpenCCCnToTraditional.Converter({
  from: "cn",
  to: "tw",
});

function cleanName(value = "") {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function containsHanCharacters(value = "") {
  return /\p{Script=Han}/u.test(value);
}

export function getChineseNameVariants(value = "") {
  const name = cleanName(value);
  if (!name || !containsHanCharacters(name)) return [];
  return [
    ...new Map(
      [name, toSimplifiedChinese(name), toTraditionalChinese(name)]
        .map(cleanName)
        .filter(Boolean)
        .map((variant) => [normalizeText(variant), variant]),
    ).values(),
  ];
}

function chineseIdentityKey(value = "") {
  const name = cleanName(value);
  if (!containsHanCharacters(name)) return "";
  return normalizeText(toSimplifiedChinese(name));
}

function releaseEvidenceKeys(release) {
  const exactLinks = (release.externalLinks ?? [])
    .filter(
      (link) =>
        link?.status !== "REJECTED" &&
        ["NEODB", "MUSICBRAINZ", "APPLE_MUSIC", "SPOTIFY", "DISCOGS"].includes(
          link?.provider,
        ),
    )
    .map((link) => `link:${normalizeText(link.url)}`);
  return new Set([
    `title:${normalizeText(release.title)}`,
    ...(release.titleAliases ?? []).map(
      (title) => `title:${normalizeText(title)}`,
    ),
    ...exactLinks,
  ]);
}

function evidenceSetsOverlap(left = new Set(), right = new Set()) {
  return [...left].some((key) => right.has(key));
}

function creditEvidenceByName(releases = []) {
  const result = new Map();
  for (const release of releases) {
    const keys = releaseEvidenceKeys(release);
    for (const credit of splitArtistCredits(release.artists)) {
      const normalized = normalizeText(credit);
      if (!normalized) continue;
      const current = result.get(normalized) ?? {
        name: cleanName(credit),
        count: 0,
        evidence: new Set(),
      };
      current.count += 1;
      keys.forEach((key) => current.evidence.add(key));
      result.set(normalized, current);
    }
  }
  return result;
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

export function reconcileChineseArtistVariants(
  releases = [],
  rawState,
) {
  const state = sanitizeArtistIdentityState(rawState);
  const creditEvidence = creditEvidenceByName(releases);
  const aliasOwners = new Map();
  for (const identity of state.identities) {
    for (const alias of identity.aliases) {
      aliasOwners.set(normalizeText(alias.name), identity.id);
    }
  }

  let aliasesAdded = 0;
  let identities = state.identities.map((identity) => {
    let nextIdentity = identity;
    const identityEvidence = new Set();
    for (const alias of identity.aliases) {
      const credit = creditEvidence.get(normalizeText(alias.name));
      credit?.evidence.forEach((key) => identityEvidence.add(key));
    }

    for (const alias of [...identity.aliases]) {
      for (const variant of getChineseNameVariants(alias.name)) {
        const result = addAliasIfAvailable(
          nextIdentity,
          variant,
          "OPENCC_DERIVED",
          aliasOwners,
        );
        nextIdentity = result.identity;
        if (result.added) aliasesAdded += 1;
      }
    }

    const identityKeys = new Set(
      nextIdentity.aliases.map((alias) => chineseIdentityKey(alias.name)),
    );
    for (const credit of creditEvidence.values()) {
      if (aliasOwners.has(normalizeText(credit.name))) continue;
      const key = chineseIdentityKey(credit.name);
      if (
        !key ||
        !identityKeys.has(key) ||
        !evidenceSetsOverlap(identityEvidence, credit.evidence)
      ) {
        continue;
      }
      const result = addAliasIfAvailable(
        nextIdentity,
        credit.name,
        "OPENCC_RELEASE_EVIDENCE",
        aliasOwners,
      );
      nextIdentity = result.identity;
      if (result.added) aliasesAdded += 1;
    }
    return nextIdentity;
  });

  const remainingCredits = [...creditEvidence.values()].filter(
    (credit) => !aliasOwners.has(normalizeText(credit.name)),
  );
  const scriptBuckets = new Map();
  for (const credit of remainingCredits) {
    const key = chineseIdentityKey(credit.name);
    if (!key) continue;
    const bucket = scriptBuckets.get(key) ?? [];
    bucket.push(credit);
    scriptBuckets.set(key, bucket);
  }

  let created = 0;
  for (const bucket of scriptBuckets.values()) {
    const distinctNames = [
      ...new Map(
        bucket.map((credit) => [normalizeText(credit.name), credit]),
      ).values(),
    ];
    if (distinctNames.length < 2) continue;
    const hasSharedReleaseEvidence = distinctNames.some((credit, index) =>
      distinctNames
        .slice(index + 1)
        .some((other) =>
          evidenceSetsOverlap(credit.evidence, other.evidence),
        ),
    );
    if (!hasSharedReleaseEvidence) continue;
    const canonical = [...distinctNames].sort(
      (left, right) =>
        right.count - left.count ||
        left.name.localeCompare(right.name, "zh-CN"),
    )[0];
    const createdIdentity = createArtistIdentity(canonical.name);
    if (!createdIdentity) continue;
    const identity = {
      ...createdIdentity,
      source: "OPENCC_RELEASE_EVIDENCE",
      aliases: distinctNames.map((credit) => ({
        name: credit.name,
        locale: "",
        type:
          normalizeText(credit.name) === normalizeText(canonical.name)
            ? "PRIMARY"
            : "CREDIT_VARIANT",
        source: "OPENCC_RELEASE_EVIDENCE",
      })),
    };
    identities.push(identity);
    identity.aliases.forEach((alias) =>
      aliasOwners.set(normalizeText(alias.name), identity.id),
    );
    created += 1;
  }

  return {
    state: sanitizeArtistIdentityState({ ...state, identities }),
    created,
    aliasesAdded,
  };
}
