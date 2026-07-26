#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const libraryPath =
  process.argv.find((argument) => argument.endsWith(".json")) ??
  path.resolve(import.meta.dirname, "../.private/neodb-library.local.json");
const concurrencyArgument = process.argv.find((argument) =>
  argument.startsWith("--concurrency="),
);
const concurrency = concurrencyArgument
  ? Math.max(1, Number.parseInt(concurrencyArgument.split("=")[1], 10))
  : 10;
const requestTimeoutMs = 15_000;
const userAgent = "RecordShelf/0.1 (local personal music archive)";

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isNeoDbUrl(url) {
  try {
    const host = new URL(url).hostname.toLocaleLowerCase();
    return host === "neodb.social" || host.startsWith("neodb.");
  } catch {
    return false;
  }
}

async function fetchManual(url, method = "HEAD", attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        Accept: "text/html",
        "User-Agent": userAgent,
      },
      signal: controller.signal,
    });
    if (
      attempt < 2 &&
      (response.status === 429 || response.status >= 500)
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1_200 * 2 ** attempt),
      );
      return fetchManual(url, method, attempt + 1);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCanonicalUrl(sourceUrl) {
  let current = normalizeUrl(sourceUrl);
  if (!current) return null;
  for (let hop = 0; hop < 5; hop += 1) {
    let response;
    try {
      response = await fetchManual(current, "HEAD");
      if (response.status === 405) {
        response = await fetchManual(current, "GET");
      }
    } catch {
      return current;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return current;
    }
    const location = response.headers.get("location");
    if (!location) return current;
    const next = normalizeUrl(new URL(location, current).toString());
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

async function saveLibrary(releases) {
  await fs.writeFile(libraryPath, `${JSON.stringify(releases, null, 2)}\n`);
}

const releases = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const urls = [
  ...new Set(
    releases.flatMap((release) => [
      ...(release.externalLinks ?? [])
        .filter((link) => link.provider === "NEODB")
        .map((link) => link.url),
      ...(release.listeningEntries ?? [])
        .filter((entry) => entry.source === "NEODB")
        .map((entry) => entry.sourceUrl),
    ]),
  ),
].filter((url) => url && isNeoDbUrl(url));
const canonicalByUrl = new Map();
let redirected = 0;
let checked = 0;

console.log(
  `NeoDB canonical URL enrichment: ${urls.length} unique URLs, ${concurrency} concurrent checks`,
);

for (let offset = 0; offset < urls.length; offset += concurrency) {
  const batch = urls.slice(offset, offset + concurrency);
  await Promise.all(
    batch.map(async (url) => {
      const canonicalUrl = await resolveCanonicalUrl(url);
      canonicalByUrl.set(url, canonicalUrl ?? normalizeUrl(url));
      if (canonicalUrl && normalizeUrl(url) !== canonicalUrl) redirected += 1;
      checked += 1;
    }),
  );
  if ((offset + batch.length) % 100 < concurrency) {
    console.log(
      `Checked ${Math.min(offset + batch.length, urls.length)}/${urls.length}: ${redirected} redirected`,
    );
  }
}

let updatedLinks = 0;
let updatedEntries = 0;
const checkedAt = new Date().toISOString();
for (const release of releases) {
  for (const link of release.externalLinks ?? []) {
    if (link.provider !== "NEODB" || !link.url) continue;
    const canonicalUrl = canonicalByUrl.get(link.url);
    if (!canonicalUrl || canonicalUrl === normalizeUrl(link.url)) continue;
    link.originalUrl ??= link.url;
    link.url = canonicalUrl;
    link.canonicalizedAt = checkedAt;
    updatedLinks += 1;
  }
  for (const entry of release.listeningEntries ?? []) {
    if (entry.source !== "NEODB" || !entry.sourceUrl) continue;
    const canonicalUrl = canonicalByUrl.get(entry.sourceUrl);
    if (!canonicalUrl || canonicalUrl === normalizeUrl(entry.sourceUrl)) {
      continue;
    }
    entry.originalSourceUrl ??= entry.sourceUrl;
    entry.sourceUrl = canonicalUrl;
    entry.sourceItemId =
      new URL(canonicalUrl).pathname.split("/").filter(Boolean).at(-1) ??
      entry.sourceItemId;
    entry.sourceUrlCanonicalizedAt = checkedAt;
    updatedEntries += 1;
  }
}

await saveLibrary(releases);
console.log(
  JSON.stringify(
    {
      checked,
      redirectedUrls: redirected,
      updatedLinks,
      updatedEntries,
    },
    null,
    2,
  ),
);
