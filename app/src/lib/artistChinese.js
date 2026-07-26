import OpenCCCnToTraditional from "opencc-js/cn2t";
import OpenCCTraditionalToCn from "opencc-js/t2cn";
import {
  createArtistIdentity,
  groupReleasesByArtistIdentity,
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
    .map((link) => normalizeText(link.url))
    .filter(Boolean)
    .map((url) => `link:${url}`);
  const exactTitles = [
    release.title,
    ...(release.titleAliases ?? []),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .map((title) => `title:${title}`);
  return new Set([...exactTitles, ...exactLinks]);
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

function comparableArtistName(value = "") {
  return cleanName(value)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function characterWindows(value = "", size = 3) {
  const characters = [...value];
  const windows = [];
  for (let index = 0; index <= characters.length - size; index += 1) {
    windows.push(characters.slice(index, index + size).join(""));
  }
  return windows;
}

function sharedReleaseEvidence(left, right) {
  const matches = [...(left.releaseEvidence ?? [])].filter((key) =>
    right.releaseEvidence?.has(key),
  );
  const exactLink = matches.find((key) => key.startsWith("link:"));
  const exactTitle = matches.find((key) => key.startsWith("title:"));
  if (exactLink) {
    return {
      type: "SHARED_RELEASE",
      label: "共同的精确作品链接",
    };
  }
  if (exactTitle) {
    return {
      type: "SHARED_RELEASE",
      label: "共同的完整作品标题",
    };
  }
  return null;
}

function isCrossScriptAliasContainment(
  shorter,
  longer,
  shorterLength,
) {
  if (shorterLength < 3 || !/^\p{Script=Han}+$/u.test(shorter)) {
    return false;
  }
  const remainder = longer.replace(shorter, "");
  return (
    remainder !== longer &&
    Boolean(remainder) &&
    /^[\p{Script=Latin}\p{Number}]+$/u.test(remainder)
  );
}

function levenshteinDistance(left = "", right = "") {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  let previous = rightCharacters.map((_, index) => index + 1);
  previous.unshift(0);
  for (let leftIndex = 0; leftIndex < leftCharacters.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (
      let rightIndex = 0;
      rightIndex < rightCharacters.length;
      rightIndex += 1
    ) {
      current.push(
        Math.min(
          current[rightIndex] + 1,
          previous[rightIndex + 1] + 1,
          previous[rightIndex] +
            (leftCharacters[leftIndex] === rightCharacters[rightIndex]
              ? 0
              : 1),
        ),
      );
    }
    previous = current;
  }
  return previous.at(-1) ?? 0;
}

function candidateEntities(releases = [], rawState) {
  const state = sanitizeArtistIdentityState(rawState);
  const identityById = new Map(
    state.identities.map((identity) => [identity.id, identity]),
  );
  const grouped = groupReleasesByArtistIdentity(releases, state);
  const entities = grouped.map((group) => {
    const identity = identityById.get(group.id);
    const names = [
      group.artist,
      ...(group.aliases ?? []),
      ...(group.credits ?? []),
      ...(identity?.aliases ?? []).map((alias) => alias.name),
    ];
    return {
      id: group.id,
      identityId: identity?.id ?? "",
      canonicalName: group.artist,
      names: [
        ...new Map(
          names
            .map(cleanName)
            .filter(Boolean)
            .map((name) => [normalizeText(name), name]),
        ).values(),
      ],
      musicBrainzMbid:
        identity?.musicBrainzMbid ?? group.musicBrainzMbid ?? "",
      mapped: Boolean(identity),
      releaseCount: group.releases.length,
      releaseEvidence: new Set(
        group.releases.flatMap((release) => [
          ...releaseEvidenceKeys(release),
        ]),
      ),
    };
  });
  const includedIds = new Set(entities.map((entity) => entity.identityId));
  for (const identity of state.identities) {
    if (includedIds.has(identity.id)) continue;
    entities.push({
      id: identity.id,
      identityId: identity.id,
      canonicalName: identity.canonicalName,
      names: [
        ...new Map(
          [
            identity.canonicalName,
            ...(identity.aliases ?? []).map((alias) => alias.name),
          ]
            .map(cleanName)
            .filter(Boolean)
            .map((name) => [normalizeText(name), name]),
        ).values(),
      ],
      musicBrainzMbid: identity.musicBrainzMbid ?? "",
      mapped: true,
      releaseCount: 0,
      releaseEvidence: new Set(),
    });
  }
  return entities;
}

function pairKey(leftId, rightId) {
  return [leftId, rightId].sort().join("::");
}

function evidenceForEntityPair(left, right) {
  const evidence = new Map();
  let confidence = 0;
  const releaseEvidence = sharedReleaseEvidence(left, right);
  const leftMbid = normalizeText(left.musicBrainzMbid);
  const rightMbid = normalizeText(right.musicBrainzMbid);
  if (leftMbid && leftMbid === rightMbid) {
    evidence.set("SAME_MBID", {
      type: "SAME_MBID",
      label: "MusicBrainz ID 相同",
    });
    confidence = 100;
  }

  for (const leftName of left.names) {
    const leftComparable = comparableArtistName(leftName);
    if (!leftComparable) continue;
    for (const rightName of right.names) {
      const rightComparable = comparableArtistName(rightName);
      if (!rightComparable) continue;
      const shorter =
        [...leftComparable].length <= [...rightComparable].length
          ? leftComparable
          : rightComparable;
      const longer =
        shorter === leftComparable ? rightComparable : leftComparable;
      const shorterLength = [...shorter].length;
      const longerLength = [...longer].length;
      const containmentCoverage = shorterLength / longerLength;

      if (leftComparable === rightComparable) {
        evidence.set("NORMALIZED_NAME", {
          type: "NORMALIZED_NAME",
          label: "规范化名字一致",
        });
        confidence = Math.max(confidence, 96);
      }
      const leftScriptKey = chineseIdentityKey(leftName);
      const rightScriptKey = chineseIdentityKey(rightName);
      if (
        leftScriptKey &&
        leftScriptKey === rightScriptKey &&
        leftComparable !== rightComparable
      ) {
        evidence.set("SCRIPT_VARIANT", {
          type: "SCRIPT_VARIANT",
          label: "简繁体规范名一致",
        });
        confidence = Math.max(confidence, 94);
      }
      if (
        leftComparable !== rightComparable &&
        longer.includes(shorter) &&
        (isCrossScriptAliasContainment(
          shorter,
          longer,
          shorterLength,
        ) ||
          (shorterLength >= 5 &&
            containmentCoverage >= 0.8 &&
            releaseEvidence))
      ) {
        evidence.set("NAME_CONTAINS", {
          type: "NAME_CONTAINS",
          label: "完整艺名与别名结构一致",
        });
        confidence = Math.max(confidence, releaseEvidence ? 91 : 88);
      }

      if (longerLength >= 5 && releaseEvidence) {
        const similarity =
          1 -
          levenshteinDistance(leftComparable, rightComparable) /
            longerLength;
        if (similarity >= 0.9 && leftComparable !== rightComparable) {
          evidence.set("SIMILAR_NAME", {
            type: "SIMILAR_NAME",
            label: `名字高度相似（${Math.round(similarity * 100)}%）`,
          });
          confidence = Math.max(confidence, Math.round(similarity * 95));
        }
      }
    }
  }

  if (releaseEvidence && evidence.size) {
    evidence.set(releaseEvidence.type, releaseEvidence);
  }

  return {
    evidence: [...evidence.values()],
    confidence,
  };
}

export function findPossibleDuplicateArtistGroups(
  releases = [],
  rawState,
) {
  const entities = candidateEntities(releases, rawState);
  const entityById = new Map(
    entities.map((entity) => [entity.id, entity]),
  );
  const buckets = new Map();
  const addToBucket = (key, entityId) => {
    if (!key) return;
    const bucket = buckets.get(key) ?? new Set();
    bucket.add(entityId);
    buckets.set(key, bucket);
  };

  for (const entity of entities) {
    const mbid = normalizeText(entity.musicBrainzMbid);
    if (mbid) addToBucket(`mbid:${mbid}`, entity.id);
    for (const name of entity.names) {
      const comparable = comparableArtistName(name);
      if (!comparable) continue;
      addToBucket(`exact:${comparable}`, entity.id);
      const scriptKey = chineseIdentityKey(name);
      if (scriptKey) addToBucket(`script:${scriptKey}`, entity.id);
      for (const window of characterWindows(comparable, 4)) {
        addToBucket(`window:${window}`, entity.id);
      }
      for (const hanRun of comparable.match(/\p{Script=Han}+/gu) ?? []) {
        if ([...hanRun].length >= 3) {
          addToBucket(`han-name:${hanRun}`, entity.id);
        }
      }
    }
  }

  const possiblePairs = new Set();
  for (const bucket of buckets.values()) {
    const ids = [...bucket];
    if (ids.length < 2 || ids.length > 24) continue;
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < ids.length;
        rightIndex += 1
      ) {
        possiblePairs.add(pairKey(ids[leftIndex], ids[rightIndex]));
      }
    }
  }

  const pairCandidates = [...possiblePairs]
    .map((key) => {
      const [leftId, rightId] = key.split("::");
      const left = entityById.get(leftId);
      const right = entityById.get(rightId);
      if (!left || !right) return null;
      const result = evidenceForEntityPair(left, right);
      if (!result.evidence.length) return null;
      const mbids = new Set(
        [left.musicBrainzMbid, right.musicBrainzMbid].filter(Boolean),
      );
      return {
        key,
        confidence: result.confidence,
        evidence: result.evidence,
        hasMbidConflict: mbids.size > 1,
        members: [left, right],
      };
    })
    .filter(Boolean);
  const primaryPairs = pairCandidates;
  const parent = new Map();
  const findRoot = (id) => {
    const currentParent = parent.get(id) ?? id;
    if (currentParent === id) {
      parent.set(id, id);
      return id;
    }
    const root = findRoot(currentParent);
    parent.set(id, root);
    return root;
  };
  const union = (leftId, rightId) => {
    const leftRoot = findRoot(leftId);
    const rightRoot = findRoot(rightId);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const candidate of primaryPairs) {
    union(candidate.members[0].id, candidate.members[1].id);
  }

  const componentByRoot = new Map();
  for (const candidate of primaryPairs) {
    const root = findRoot(candidate.members[0].id);
    const component = componentByRoot.get(root) ?? {
      memberIds: new Set(),
      evidence: new Map(),
      confidence: 0,
    };
    candidate.members.forEach((member) =>
      component.memberIds.add(member.id),
    );
    candidate.evidence.forEach((evidence) =>
      component.evidence.set(evidence.type, evidence),
    );
    component.confidence = Math.max(
      component.confidence,
      candidate.confidence,
    );
    componentByRoot.set(root, component);
  }

  const primaryComponents = [...componentByRoot.values()].map(
    (component) => {
      const members = [...component.memberIds]
        .map((id) => entityById.get(id))
        .filter(Boolean)
        .sort(
          (left, right) =>
            right.releaseCount - left.releaseCount ||
            left.canonicalName.localeCompare(
              right.canonicalName,
              "zh-CN",
            ),
        );
      const mbids = new Set(
        members
          .map((member) => member.musicBrainzMbid)
          .filter(Boolean),
      );
      return {
        key: `group:${members
          .map((member) => member.id)
          .sort()
          .join("::")}`,
        confidence: component.confidence,
        evidence: [...component.evidence.values()],
        hasMbidConflict: mbids.size > 1,
        members,
      };
    },
  );
  return primaryComponents
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        right.members.reduce(
          (sum, member) => sum + member.releaseCount,
          0,
        ) -
          left.members.reduce(
            (sum, member) => sum + member.releaseCount,
            0,
          ) ||
        left.key.localeCompare(right.key, "zh-CN"),
    );
}
