import fs from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import {
  applyCanonicalTitleEvidence,
  csvRowToRelease,
  detectHeaderMap,
  releaseImportIdentityKey,
} from "../src/lib/music.js";

const inputPath = process.argv[2];
const outputPath =
  process.argv[3] ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");
const localCanonicalTitleEvidencePath = path.resolve(
  import.meta.dirname,
  "../.private/canonical-title-evidence.local.json",
);
const publicCanonicalTitleEvidencePath = path.resolve(
  import.meta.dirname,
  "../src/data/canonical-title-evidence.json",
);
const canonicalTitleEvidencePath = await fs
  .access(localCanonicalTitleEvidencePath)
  .then(() => localCanonicalTitleEvidencePath)
  .catch(() => publicCanonicalTitleEvidencePath);

if (!inputPath) {
  throw new Error(
    "Usage: node scripts/import-neodb-csv.mjs <input.csv> [output.json]",
  );
}

const csvText = await fs.readFile(inputPath, "utf8");
const parsed = Papa.parse(csvText, {
  header: true,
  skipEmptyLines: "greedy",
  transformHeader: (header) => header.trim(),
});

if (parsed.errors.length) {
  throw new Error(
    `NeoDB CSV has ${parsed.errors.length} parse errors: ${parsed.errors[0].message}`,
  );
}

const headerMap = detectHeaderMap(parsed.meta.fields ?? []);
const requiredNeoDbHeaders = ["title", "info", "links", "timestamp"];
const missingHeaders = requiredNeoDbHeaders.filter(
  (header) => !(parsed.meta.fields ?? []).includes(header),
);

if (missingHeaders.length) {
  throw new Error(`Missing NeoDB headers: ${missingHeaders.join(", ")}`);
}

const releasesByIdentity = new Map();
let listeningEntryCount = 0;

for (const [index, row] of parsed.data.entries()) {
  const candidate = csvRowToRelease(row, headerMap, index + 2);
  if (candidate.status === "INVALID") {
    throw new Error(
      `Invalid NeoDB row ${index + 2}: ${candidate.errors.join("; ")}`,
    );
  }

  const release = candidate.release;
  const identityKey = releaseImportIdentityKey(release);
  const existing = releasesByIdentity.get(identityKey);

  if (!existing) {
    releasesByIdentity.set(identityKey, release);
    listeningEntryCount += release.listeningEntries.length;
    continue;
  }

  const knownLinkKeys = new Set(
    existing.externalLinks.map((link) => `${link.provider}|${link.url}`),
  );
  for (const link of release.externalLinks) {
    const key = `${link.provider}|${link.url}`;
    if (!knownLinkKeys.has(key)) {
      existing.externalLinks.push(link);
      knownLinkKeys.add(key);
    }
  }

  const knownEntryIds = new Set(
    existing.listeningEntries.map((entry) => entry.id),
  );
  for (const entry of release.listeningEntries) {
    if (!knownEntryIds.has(entry.id)) {
      existing.listeningEntries.push(entry);
      listeningEntryCount += 1;
    }
  }

  existing.tags = [...new Set([...(existing.tags ?? []), ...(release.tags ?? [])])];
  if (
    Date.parse(release.listeningEntries[0]?.createdAt ?? 0) >=
    Date.parse(existing.listeningEntries[0]?.createdAt ?? 0)
  ) {
    existing.markStatus = release.markStatus;
  }
}

const canonicalTitleEvidence = JSON.parse(
  await fs.readFile(canonicalTitleEvidencePath, "utf8"),
);
const releases = [...releasesByIdentity.values()]
  .map((release) => {
    const neoDbUrl = release.externalLinks.find(
      (link) => link.provider === "NEODB",
    )?.url;
    const evidence = canonicalTitleEvidence[neoDbUrl];
    return evidence
      ? applyCanonicalTitleEvidence(release, evidence)
      : release;
  })
  .sort((releaseA, releaseB) => {
  const dateA = Math.max(
    ...releaseA.listeningEntries.map((entry) => Date.parse(entry.createdAt) || 0),
  );
  const dateB = Math.max(
    ...releaseB.listeningEntries.map((entry) => Date.parse(entry.createdAt) || 0),
  );
  return dateB - dateA;
  });

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(releases, null, 2)}\n`);

const statusCounts = releases.reduce((counts, release) => {
  counts[release.markStatus] = (counts[release.markStatus] ?? 0) + 1;
  return counts;
}, {});

console.log(
  JSON.stringify(
    {
      inputRows: parsed.data.length,
      releases: releases.length,
      listeningEntries: listeningEntryCount,
      statusCounts,
      spotifyLinks: releases.filter((release) =>
        release.externalLinks.some((link) => link.provider === "SPOTIFY"),
      ).length,
      appleMusicLinks: releases.filter((release) =>
        release.externalLinks.some((link) => link.provider === "APPLE_MUSIC"),
      ).length,
      outputPath,
    },
    null,
    2,
  ),
);
