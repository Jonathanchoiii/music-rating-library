import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COUNTRY_COORDINATES } from "../src/data/countryCoordinates.js";
import {
  buildRoamModel,
  getRoamCountryRefreshCandidates,
  getRoamCountryAuditFingerprint,
  getRoamRegionsByContinent,
  ROAM_COUNTRY_REFRESH_BATCH_SIZE,
  ROAM_REGIONS,
  resolveRoamCountry,
} from "../src/lib/roam.js";
import { runRoamCountryRefresh } from "../roam-country-refresh/index.mjs";
import { getLibraryRouteState } from "../src/lib/librarySearch.js";

const ratedRelease = {
  id: "release-1",
  title: "A Record",
  artists: ["Tyla"],
  listeningEntries: [
    { id: "listen-1", rating10: 9, ratedAt: "2026-08-20T00:00:00Z" },
  ],
};

function profile(country, overrides = {}) {
  return {
    introductionStatus: "READY",
    publicFacts: { country },
    media: { imageUrl: "https://example.com/artist.jpg" },
    sources: [{ sourceId: "S1", title: "Official", url: "https://example.com" }],
    roamCountryAudit: {
      status: "CONFIRMED",
      checkedAt: "2026-08-27T08:00:00.000Z",
      identityFingerprint: "v1:0000000000000000",
      evidence: "WIKIDATA_COUNTRY",
    },
    ...overrides,
  };
}

test("roam resolves explicit Chinese and English country aliases", () => {
  assert.equal(resolveRoamCountry("南非")?.code, "ZA");
  assert.equal(resolveRoamCountry("中国台湾")?.code, "TW");
  assert.equal(resolveRoamCountry("中国香港特别行政区")?.code, "HK");
  assert.equal(resolveRoamCountry("中华人民共和国澳门特别行政区")?.code, "MO");
  assert.equal(resolveRoamCountry("South Korea")?.code, "KR");
  assert.equal(resolveRoamCountry("来自伦敦")?.code, undefined);
});

test("roam keeps Hong Kong and Macao as standalone regions", () => {
  assert.equal(ROAM_REGIONS.find((region) => region.code === "HK")?.name, "香港");
  assert.equal(ROAM_REGIONS.find((region) => region.code === "MO")?.name, "澳门");
  assert.notEqual(resolveRoamCountry("香港")?.code, "CN");
  assert.notEqual(resolveRoamCountry("澳门")?.code, "CN");
});

test("roam only lights rated artists with completed sourced country research", () => {
  const artistGroups = [
    { id: "raw-tyla", artist: "Tyla", aliases: [], releases: [ratedRelease] },
    {
      id: "raw-unrated",
      artist: "Unrated",
      aliases: [],
      releases: [{ ...ratedRelease, id: "release-2", listeningEntries: [] }],
    },
    { id: "raw-unsourced", artist: "Unsourced", aliases: [], releases: [{ ...ratedRelease, id: "release-3" }] },
  ];
  const model = buildRoamModel({
    artistGroups,
    artistProfileState: {
      profiles: {
        "raw-tyla": profile("南非"),
        "raw-unrated": profile("英国"),
        "raw-unsourced": profile("美国", { sources: [] }),
      },
    },
  });

  assert.equal(model.stats.countryCount, 1);
  assert.equal(model.stats.artistCount, 1);
  assert.equal(model.countryByCode.ZA.artists[0].name, "Tyla");
  assert.equal(model.countryByCode.US, undefined);
});

test("a manually selected country syncs to roam without inventing a web source", () => {
  const model = buildRoamModel({
    artistGroups: [
      { id: "artist-gareth", artist: "Gareth.T", aliases: [], releases: [ratedRelease] },
    ],
    artistProfileState: {
      profiles: {
        "artist-gareth": profile("香港", {
          sources: [],
          roamCountryAudit: {
            status: "CONFIRMED",
            checkedAt: "2026-08-30T10:00:00.000Z",
            identityFingerprint: "v1:1234567890abcdef",
            evidence: "USER_CONFIRMED",
          },
        }),
      },
    },
  });
  assert.equal(model.stats.countryCount, 1);
  assert.equal(model.countryByCode.HK.artists[0].name, "Gareth.T");
});

test("roam groups lit countries by continent and keeps locked regions visible on demand", () => {
  const litCodes = new Set(["ZA", "GB"]);
  const litOnly = getRoamRegionsByContinent(litCodes, true);
  assert.deepEqual(litOnly.map((continent) => continent.id), ["EU", "AF"]);
  assert.equal(litOnly.flatMap((continent) => continent.regions).length, 2);

  const all = getRoamRegionsByContinent(litCodes, false);
  assert.equal(all.length, 6);
  assert.equal(all.find((continent) => continent.id === "AF").regions.find((region) => region.code === "ZA").lit, true);
  assert.equal(all.find((continent) => continent.id === "AS").regions.find((region) => region.code === "JP").lit, false);
});

test("roam routes expose country detail and release return state", () => {
  const countryRoute = getLibraryRouteState({ pathname: "/roam/za", search: "" });
  assert.equal(countryRoute.isRoamRoute, true);
  assert.equal(countryRoute.selectedRoamCountry, "ZA");
  const countryArtistRoute = getLibraryRouteState({
    pathname: "/roam/za",
    search: "?artist=raw-tyla",
  });
  assert.equal(countryArtistRoute.isRoamRoute, true);
  assert.equal(countryArtistRoute.selectedArtistId, "raw-tyla");
  const releaseRoute = getLibraryRouteState({
    pathname: "/releases/release-1",
    search: "?from=roam&country=ZA&artist=raw-tyla",
  });
  assert.equal(releaseRoute.detailReturnTarget, "roam");
  assert.equal(releaseRoute.detailReturnCountryCode, "ZA");
  assert.equal(releaseRoute.detailReturnArtistId, "raw-tyla");
});

test("roam artist detail stays layered on the country route and restores its stack", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(
    app,
    /if \(isRoamRoute\) \{\s+navigate\(`\$\{location\.pathname\}\?\$\{params\.toString\(\)\}`,[\s\S]*?preventScrollReset: true/,
  );
  assert.match(
    app,
    /isArtistRoute \|\| \(isRoamRoute && selectedArtistId\) \? \(\s+<ArtistDetail/,
  );
  assert.match(
    app,
    /if \(from === "roam" && selectedRoamCountry\)[\s\S]*?params\.set\("artist", selectedArtistId\)/,
  );
  assert.match(
    app,
    /detailReturnTarget === "roam"[\s\S]*?params\.set\("artist", detailReturnArtistId\)/,
  );
});

test("roam keeps geographic coordinates for every currently lit demo country", () => {
  for (const code of ["US", "TW", "GB", "KR", "ZA", "JP"]) {
    assert.equal(COUNTRY_COORDINATES[code]?.length, 2, `${code} must have latitude and longitude`);
  }
});

test("roam globe preserves the interactive Three.js lifecycle contract", async () => {
  const source = await readFile(new URL("../src/components/RoamGlobe.jsx", import.meta.url), "utf8");
  assert.match(source, /new OrbitControls\(camera, canvas\)/);
  assert.match(source, /controls\.autoRotate = !window\.matchMedia/);
  assert.match(source, /renderer\.setAnimationLoop/);
  assert.match(source, /resizeObserver\.disconnect\(\)/);
  assert.match(source, /disposeScene\(scene\)/);
  assert.match(source, /renderer\.dispose\(\)/);
});

test("roam heading aligns with root tabs and the globe scales as a square", async () => {
  const source = await readFile(new URL("../src/components/RoamPage.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const introTitleRule = styles.match(/\.roam-intro h1 \{([\s\S]*?)\}/)?.[1] ?? "";
  const globeRule = styles.match(/\.roam-globe \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(source, /<h1>音乐漫游<\/h1>/);
  assert.match(styles, /\.roam-page \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?margin: 0;/);
  assert.match(introTitleRule, /font-size: clamp\(34px, 3\.2vw, 52px\)/);
  assert.match(introTitleRule, /letter-spacing: -0\.055em/);
  assert.match(globeRule, /aspect-ratio: 1 \/ 1/);
  assert.match(globeRule, /min-height: 0/);
});

test("roam summary metrics stay in a two-by-two grid on landscape screens", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const statsRule = styles.match(/\.roam-intro-stats \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(statsRule, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.roam-intro-stats \.roam-stat:nth-child\(n \+ 3\) \{[\s\S]*?border-top:/);
  assert.doesNotMatch(styles, /\.roam-intro-stats \{[\s\S]*?grid-template-columns: repeat\(4,/);
});

test("roam country albums cap mobile rows at three covers without a wider rule override", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /@media \(max-width: 760px\) \{[\s\S]*?\.roam-album-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1180px\)/);
  assert.doesNotMatch(styles, /@media \(max-width: 1180px\)/);
});

test("roam country cards prioritize full mobile titles over flags and status", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /@media \(max-width: 760px\) \{[\s\S]*?\.roam-country-card \{[\s\S]*?grid-template-columns: 38px minmax\(0, 1fr\);[\s\S]*?gap: 12px;/,
  );
  assert.match(
    styles,
    /\.roam-country-card \.roam-country-flag:not\(\.is-label\) \{[\s\S]*?width: 38px;[\s\S]*?height: 38px;/,
  );
  assert.match(
    styles,
    /\.roam-country-card > div strong \{[\s\S]*?text-overflow: clip;[\s\S]*?white-space: normal;/,
  );
  assert.match(
    styles,
    /\.roam-country-card \.roam-country-status \{[\s\S]*?display: none;/,
  );
});

test("roam country cards lazily load open-source flags with a code fallback", async () => {
  const source = await readFile(new URL("../src/components/RoamPage.jsx", import.meta.url), "utf8");
  const flagSource = await readFile(new URL("../src/components/CountryFlag.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /<CountryFlag code=\{region\.code\} name=\{region\.name\} \/>/);
  assert.match(flagSource, /https:\/\/flagcdn\.io\/flags\/4x3\/\$\{normalizedCode\}\.svg/);
  assert.match(flagSource, /loading="lazy"/);
  assert.match(flagSource, /referrerPolicy="no-referrer"/);
  assert.match(flagSource, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(styles, /\.roam-country-flag img[\s\S]*?object-fit: cover/);
});

test("roam globe labels use flags instead of English country codes", async () => {
  const source = await readFile(new URL("../src/components/RoamGlobe.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /<CountryFlag code=\{country\.code\} name=\{country\.name\} variant="label" \/>/);
  assert.doesNotMatch(source, /<span>\{country\.code\}<\/span>/);
  assert.match(styles, /\.roam-country-flag\.is-label \{[\s\S]*?width: 18px;[\s\S]*?height: 14px;/);
});

test("roam globe surfaces stay neutral while lit markers keep the accent", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/components/RoamGlobe.jsx", import.meta.url), "utf8");
  const globeRule = styles.match(/\.roam-globe \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(globeRule, /border: 1px solid var\(--line\)/);
  assert.match(globeRule, /background: transparent/);
  assert.doesNotMatch(globeRule, /var\(--accent\)/);
  assert.doesNotMatch(styles, /\.roam-globe::after/);
  assert.match(styles, /\.roam-country-flag\.is-label\.is-fallback \{[\s\S]*?color: var\(--accent\)/);
  assert.match(source, /HemisphereLight\(0xffffff, 0xb8b5ae, 2\.4\)/);
  assert.doesNotMatch(source, /0x8a79bf/);
});

test("roam visited-continent stat shows only the current count", async () => {
  const source = await readFile(new URL("../src/components/RoamPage.jsx", import.meta.url), "utf8");
  assert.match(source, /value=\{model\.stats\.continentCount\} label="已到访大洲"/);
  assert.doesNotMatch(source, /continentCount\}\/6/);
});

test("roam continent headings omit codes and align with the country grid", async () => {
  const source = await readFile(new URL("../src/components/RoamPage.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const headingRule = styles.match(/\.roam-continent-section > header > div \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.doesNotMatch(source, /<span>\{continent\.id\}<\/span>/);
  assert.match(headingRule, /display: grid/);
  assert.match(headingRule, /gap: 4px/);
  assert.doesNotMatch(headingRule, /grid-template-columns/);
});

test("roam refresh candidates include only rated identities without a current audit", () => {
  const auditedIdentity = {
    id: "artist-audited",
    canonicalName: "Audited",
    aliases: [{ name: "Audited Alias" }],
  };
  const candidates = getRoamCountryRefreshCandidates({
    artistGroups: [
      { id: "artist-ready", artist: "Ready", releases: [ratedRelease] },
      { id: "artist-pending", artist: "Pending", releases: [ratedRelease] },
      { id: "artist-audited", artist: "Audited", releases: [ratedRelease] },
      { id: "artist-unrated", artist: "Unrated", releases: [{ ...ratedRelease, listeningEntries: [] }] },
    ],
    artistIdentityState: {
      identities: [
        { id: "artist-ready", canonicalName: "Ready", aliases: [] },
        { id: "artist-pending", canonicalName: "Pending", aliases: [{ name: "Pending Alias" }], musicBrainzMbid: "123" },
        auditedIdentity,
        { id: "artist-unrated", canonicalName: "Unrated", aliases: [] },
      ],
    },
    artistProfileState: {
      profiles: {
        "artist-ready": profile("英国"),
        "artist-pending": profile("", { introductionStatus: "FAILED" }),
        "artist-audited": profile("", {
          introductionStatus: "FAILED",
          roamCountryAudit: {
            status: "NO_COUNTRY",
            checkedAt: "2026-08-27T08:00:00.000Z",
            identityFingerprint: getRoamCountryAuditFingerprint(auditedIdentity),
          },
        }),
      },
    },
  });
  assert.deepEqual(candidates, [{
    artistId: "artist-pending",
    name: "Pending",
    aliases: ["Pending Alias"],
    musicBrainzId: "123",
    releaseHints: [{
      title: "A Record",
      translatedTitle: undefined,
      titleAliases: undefined,
      releaseType: undefined,
      releaseDate: undefined,
      artists: ["Tyla"],
    }],
    identityFingerprint: getRoamCountryAuditFingerprint({
      canonicalName: "Pending",
      aliases: [{ name: "Pending Alias" }],
      musicBrainzMbid: "123",
    }),
  }]);
});

test("legacy identity-only country matches stop lighting and reenter evidence review", () => {
  const identity = {
    id: "artist-generic-name",
    canonicalName: "D.O.",
    aliases: [{ name: "D.O." }],
    musicBrainzMbid: "",
  };
  const legacyProfile = profile("荷兰", {
    publicFacts: {
      country: "荷兰",
      musicBrainzId: "16907f68-6858-4d64-8ab7-d33495e4e1a5",
    },
    roamCountryAudit: {
      status: "CONFIRMED",
      checkedAt: "2026-08-27T08:00:00.000Z",
      identityFingerprint: getRoamCountryAuditFingerprint(identity),
      evidence: "CONFIRMED_MBID",
    },
  });
  const artistGroups = [{
    id: identity.id,
    artist: identity.canonicalName,
    musicBrainzMbid: "",
    aliases: ["D.O."],
    releases: [ratedRelease],
  }];
  const artistProfileState = { profiles: { [identity.id]: legacyProfile } };
  const model = buildRoamModel({ artistGroups, artistProfileState });
  const candidates = getRoamCountryRefreshCandidates({
    artistGroups,
    artistIdentityState: { identities: [identity] },
    artistProfileState,
  });
  assert.equal(model.stats.artistCount, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].releaseHints[0].title, "A Record");
});

test("roam rechecks an audited artist when stable identity data changes", () => {
  const original = { canonicalName: "Artist", aliases: [] };
  const candidates = getRoamCountryRefreshCandidates({
    artistGroups: [{ id: "artist-1", artist: "Artist", releases: [ratedRelease] }],
    artistIdentityState: {
      identities: [{ id: "artist-1", canonicalName: "Artist", aliases: [{ name: "New Alias" }] }],
    },
    artistProfileState: {
      profiles: {
        "artist-1": profile("", {
          introductionStatus: "FAILED",
          roamCountryAudit: {
            status: "AMBIGUOUS",
            checkedAt: "2026-08-27T08:00:00.000Z",
            identityFingerprint: getRoamCountryAuditFingerprint(original),
          },
        }),
      },
    },
  });
  assert.equal(candidates.length, 1);
});

test("roam country refresh persists only sourced mappable results and preserves sources", async () => {
  const persisted = [];
  const summary = await runRoamCountryRefresh([
    { artistId: "artist-1", name: "Artist One", aliases: [], identityFingerprint: "v1:1111111111111111" },
    { artistId: "artist-2", name: "Artist Two", aliases: [], identityFingerprint: "v1:2222222222222222" },
  ], {
    researchArtistImpl: async ({ artistId }) => artistId === "artist-1"
      ? profile("日本", {
          introduction: "简介",
          publicFacts: { country: "日本", musicBrainzId: "12345678-1234-4123-8123-123456789abc" },
          sources: [
            { sourceId: "S2", url: "https://musicbrainz.org/artist/12345678-1234-4123-8123-123456789abc" },
            { sourceId: "WD1", url: "https://www.wikidata.org/wiki/Q1" },
          ],
          countryEvidence: {
            status: "CONFIRMED",
            kind: "WIKIDATA_CITIZENSHIP",
            countryCode: "JP",
            sourceUrl: "https://www.wikidata.org/wiki/Q1",
          },
        })
      : profile("未知星球", {
          publicFacts: { country: "未知星球", musicBrainzId: "22345678-1234-4123-8123-123456789abc" },
          sources: [{ sourceId: "S3", url: "https://musicbrainz.org/artist/22345678-1234-4123-8123-123456789abc" }],
        }),
    storedProfileImpl: async () => ({ sources: [{ sourceId: "S1", url: "https://example.com/old" }] }),
    persistProfileImpl: async (artistId, patch) => persisted.push({ artistId, patch }),
    delayImpl: async () => {},
    nowImpl: () => "2026-08-27T08:00:00.000Z",
  });
  assert.equal(summary.checked, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.noCountry, 1);
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted[0].patch.sources.map((source) => source.sourceId), ["S1", "S2", "WD1"]);
  assert.equal(persisted[0].patch.roamCountryAudit.status, "CONFIRMED");
  assert.equal(persisted[0].patch.roamCountryAudit.evidence, "WIKIDATA_COUNTRY");
  assert.equal(persisted[1].patch.roamCountryAudit.status, "NO_COUNTRY");
  assert.equal(summary.updates.length, 2);
});

test("roam rejects a MusicBrainz Area country without semantic country evidence", async () => {
  const persisted = [];
  const summary = await runRoamCountryRefresh([
    { artistId: "artist-penny", name: "戴佩妮", identityFingerprint: "v1:1111111111111111" },
  ], {
    researchArtistImpl: async () => profile("台湾", {
      publicFacts: {
        country: "台湾",
        musicBrainzId: "ef7870d0-1c7e-4327-a989-1f92b4dd35f5",
      },
      sources: [{
        sourceId: "MB1",
        url: "https://musicbrainz.org/artist/ef7870d0-1c7e-4327-a989-1f92b4dd35f5",
      }],
      countryEvidence: null,
    }),
    storedProfileImpl: async () => null,
    persistProfileImpl: async (artistId, patch) => persisted.push({ artistId, patch }),
    delayImpl: async () => {},
    nowImpl: () => "2026-08-28T08:00:00.000Z",
  });
  assert.equal(summary.updated, 0);
  assert.equal(summary.noCountry, 1);
  assert.equal(persisted[0].patch.roamCountryAudit.status, "NO_COUNTRY");
  assert.equal(persisted[0].patch.publicFacts, undefined);
});

test("roam leaves country blank when the researched identity is not fully verified", async () => {
  const persisted = [];
  const summary = await runRoamCountryRefresh([
    { artistId: "artist-1", name: "Same Name", identityFingerprint: "v1:1111111111111111" },
  ], {
    researchArtistImpl: async () => profile("荷兰", {
      publicFacts: {
        country: "荷兰",
        musicBrainzId: "12345678-1234-4123-8123-123456789abc",
      },
      sources: [{ sourceId: "S1", url: "https://example.com/same-name" }],
    }),
    storedProfileImpl: async () => null,
    persistProfileImpl: async (artistId, patch) => persisted.push({ artistId, patch }),
    delayImpl: async () => {},
    nowImpl: () => "2026-08-27T08:00:00.000Z",
  });
  assert.equal(summary.updated, 0);
  assert.equal(summary.ambiguous, 1);
  assert.equal(persisted[0].patch.roamCountryAudit.status, "AMBIGUOUS");
  assert.equal(persisted[0].patch.publicFacts, undefined);
});

test("roam records ambiguous identities but leaves transient failures retryable", async () => {
  const persisted = [];
  const summary = await runRoamCountryRefresh([
    { artistId: "artist-ambiguous", name: "Same Name", identityFingerprint: "v1:aaaaaaaaaaaaaaaa" },
    { artistId: "artist-offline", name: "Offline", identityFingerprint: "v1:bbbbbbbbbbbbbbbb" },
  ], {
    researchArtistImpl: async ({ artistId }) => {
      const error = new Error("failed");
      error.code = artistId === "artist-ambiguous"
        ? "ARTIST_IDENTITY_AMBIGUOUS"
        : "NETWORK_FAILED";
      throw error;
    },
    storedProfileImpl: async () => null,
    persistProfileImpl: async (artistId, patch) => persisted.push({ artistId, patch }),
    delayImpl: async () => {},
    nowImpl: () => "2026-08-27T08:00:00.000Z",
  });
  assert.equal(summary.ambiguous, 1);
  assert.equal(summary.failed, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].patch.roamCountryAudit.status, "AMBIGUOUS");
});

test("an in-flight roam refresh cannot overwrite a user-confirmed correction", async () => {
  const persisted = [];
  const summary = await runRoamCountryRefresh([
    {
      artistId: "artist-do",
      name: "D.O.",
      releaseHints: [{ title: "BLOSSOM - THE 3RD MINI ALBUM" }],
      identityFingerprint: "v1:1234567890abcdef",
    },
  ], {
    researchArtistImpl: async () => profile("荷兰"),
    storedProfileImpl: async () => profile("韩国", {
      roamCountryAudit: {
        status: "CONFIRMED",
        checkedAt: "2026-08-27T15:00:00.000Z",
        identityFingerprint: "v1:1234567890abcdef",
        evidence: "USER_CONFIRMED",
      },
    }),
    persistProfileImpl: async (...args) => persisted.push(args),
    delayImpl: async () => {},
  });
  assert.equal(summary.checked, 1);
  assert.equal(summary.updated, 0);
  assert.equal(persisted.length, 0);
});

test("roam directory exposes a half-opacity refresh control and local refresh API", async () => {
  const source = await readFile(new URL("../src/components/RoamPage.jsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /className="roam-country-refresh"/);
  assert.match(source, /ArrowClockwise weight="bold"/);
  assert.match(styles, /\.roam-country-refresh svg[\s\S]*?opacity: 0\.5/);
  assert.match(styles, /\.roam-country-refresh\.is-refreshing svg[\s\S]*?roam-refresh-spin/);
  assert.match(app, /fetch\("\/api\/roam\/countries\/refresh"/);
  assert.equal(ROAM_COUNTRY_REFRESH_BATCH_SIZE, 100);
  assert.match(app, /roamCountryRefreshCandidates\.slice\([\s\S]*?ROAM_COUNTRY_REFRESH_BATCH_SIZE/);
  assert.match(app, /准备核验本批 \$\{batch\.length\} 位艺人/);
  assert.match(app, /仍待处理 \$\{remaining\} 位/);
  assert.match(app, /body: JSON\.stringify\(\{ candidates: batch \}\)/);
  assert.match(app, /search: "\?refreshCountries=1"/);
  assert.match(app, /onSaveCountry=\{readOnly \? undefined : saveSelectedArtistCountry\}/);
  assert.match(app, /evidence: "USER_CONFIRMED"/);
  assert.match(app, /漫游已同步/);
});
