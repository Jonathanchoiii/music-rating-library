import fs from "node:fs/promises";
import path from "node:path";

const correctedImportPath = process.argv[2];
const libraryPath =
  process.argv[3] ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");

if (!correctedImportPath) {
  throw new Error(
    "Usage: node scripts/split-merged-neodb-identities.mjs <identity-safe-import.json> [library.json]",
  );
}

const [library, correctedImport] = await Promise.all([
  fs.readFile(libraryPath, "utf8").then(JSON.parse),
  fs.readFile(correctedImportPath, "utf8").then(JSON.parse),
]);

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sourceUrls(release) {
  return new Set(
    [
      ...(release.externalLinks ?? []).flatMap((link) => [
        link.url,
        link.originalUrl,
        link.canonicalUrl,
      ]),
      ...(release.listeningEntries ?? []).flatMap((entry) => [
        entry.sourceUrl,
        entry.originalSourceUrl,
        entry.canonicalSourceUrl,
      ]),
    ]
      .map(normalizedUrl)
      .filter(Boolean),
  );
}

function matchedFromBelongsToRelease(value, releaseUrls) {
  const normalized = normalizedUrl(value);
  return Boolean(normalized && releaseUrls.has(normalized));
}

function currentLinksForRawRelease(current, raw) {
  const rawLinks = new Map(
    (raw.externalLinks ?? []).map((link) => [
      `${link.provider}|${normalizedUrl(link.url)}`,
      link,
    ]),
  );
  const matched = (current.externalLinks ?? []).filter((link) =>
    [link.url, link.originalUrl, link.canonicalUrl].some((value) =>
      rawLinks.has(`${link.provider}|${normalizedUrl(value)}`),
    ),
  );
  return matched.length ? matched : raw.externalLinks;
}

function copyEvidenceBoundFields(split, current, prefix, releaseUrls) {
  const matchedFromField = `${prefix}MatchedFrom`;
  if (!matchedFromBelongsToRelease(current[matchedFromField], releaseUrls)) {
    return split;
  }
  const next = { ...split };
  for (const [field, value] of Object.entries(current)) {
    if (
      field === prefix ||
      field.startsWith(`${prefix}Source`) ||
      field.startsWith(`${prefix}Matched`) ||
      field.startsWith(`${prefix}Evidence`)
    ) {
      next[field] = value;
    }
  }
  return next;
}

function splitRelease(current, raw) {
  const externalLinks = currentLinksForRawRelease(current, raw);
  const releaseUrls = sourceUrls({ ...raw, externalLinks });
  let split = {
    ...raw,
    artists: current.artists,
    externalLinks,
  };

  if (
    matchedFromBelongsToRelease(current.coverMatchedFrom, releaseUrls) &&
    current.coverUrl
  ) {
    split = {
      ...split,
      coverUrl: current.coverUrl,
      coverSource: current.coverSource,
      coverMatchedFrom: current.coverMatchedFrom,
      coverMatchedAt: current.coverMatchedAt,
    };
  }

  if (matchedFromBelongsToRelease(current.titleMatchedFrom, releaseUrls)) {
    split = {
      ...split,
      title: current.title,
      translatedTitle: current.translatedTitle,
      titleAliases: current.titleAliases,
      titleSource: current.titleSource,
      titleMatchedFrom: current.titleMatchedFrom,
      titleMatchedAt: current.titleMatchedAt,
    };
  }

  split = copyEvidenceBoundFields(
    split,
    current,
    "releaseType",
    releaseUrls,
  );

  const dateEvidence = [
    ...(current.releaseDateEvidence ?? []),
    ...(current.releaseDateConflict ?? []),
  ].filter((evidence) =>
    matchedFromBelongsToRelease(evidence.matchedFrom, releaseUrls),
  );
  const uniqueDates = [...new Set(dateEvidence.map((evidence) => evidence.date))];
  if (uniqueDates.length === 1) {
    split = {
      ...split,
      releaseDate: uniqueDates[0],
      releaseDatePrecision: "DAY",
      releaseDateSource:
        dateEvidence.length > 1
          ? "EXACT_CONSENSUS"
          : dateEvidence[0]?.source ?? "EXACT_SOURCE",
      releaseDateMatchedFrom: dateEvidence[0]?.matchedFrom,
      releaseDateEvidence: dateEvidence,
      releaseDateMatchedAt:
        current.releaseDateMatchedAt ?? current.releaseDateCheckedAt,
      releaseDateCheckedAt: current.releaseDateCheckedAt,
    };
  }

  return split;
}

const rawReleaseByEntryId = new Map(
  correctedImport.flatMap((release) =>
    (release.listeningEntries ?? []).map((entry) => [entry.id, release]),
  ),
);
const output = [];
const splitReport = [];
let preservedEntryCount = 0;

for (const release of library) {
  const entries = release.listeningEntries ?? [];
  if (entries.length < 2) {
    output.push(release);
    preservedEntryCount += entries.length;
    continue;
  }

  const rawReleases = entries.map((entry) => rawReleaseByEntryId.get(entry.id));
  if (rawReleases.some((raw) => !raw)) {
    throw new Error(
      `Cannot safely split ${release.id} (${release.title}): a listening entry is missing from the corrected import`,
    );
  }
  const rawIds = new Set(rawReleases.map((raw) => raw.id));
  if (rawIds.size !== entries.length) {
    output.push(release);
    preservedEntryCount += entries.length;
    continue;
  }

  const splits = rawReleases.map((raw) => splitRelease(release, raw));
  output.push(...splits);
  preservedEntryCount += splits.reduce(
    (count, split) => count + split.listeningEntries.length,
    0,
  );
  splitReport.push({
    previousReleaseId: release.id,
    title: release.title,
    splitReleaseIds: splits.map((split) => split.id),
    neoDbUrls: splits.map(
      (split) =>
        split.externalLinks.find((link) => link.provider === "NEODB")?.url,
    ),
  });
}

const previousEntryCount = library.reduce(
  (count, release) => count + (release.listeningEntries ?? []).length,
  0,
);
if (preservedEntryCount !== previousEntryCount) {
  throw new Error(
    `Listening entry safety check failed: ${previousEntryCount} before, ${preservedEntryCount} after`,
  );
}

await fs.writeFile(libraryPath, `${JSON.stringify(output, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      releasesBefore: library.length,
      releasesAfter: output.length,
      listeningEntriesBefore: previousEntryCount,
      listeningEntriesAfter: preservedEntryCount,
      splitGroups: splitReport.length,
      restoredReleases: output.length - library.length,
      splitReport,
    },
    null,
    2,
  ),
);
