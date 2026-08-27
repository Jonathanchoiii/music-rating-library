import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COUNTRY_COORDINATES } from "../src/data/countryCoordinates.js";
import {
  buildRoamModel,
  getRoamCountryRefreshCandidates,
  getRoamRegionsByContinent,
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
  const releaseRoute = getLibraryRouteState({
    pathname: "/releases/release-1",
    search: "?from=roam&country=ZA",
  });
  assert.equal(releaseRoute.detailReturnTarget, "roam");
  assert.equal(releaseRoute.detailReturnCountryCode, "ZA");
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

test("roam country cards lazily load open-source flags with a code fallback", async () => {
  const source = await readFile(new URL("../src/components/RoamPage.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /https:\/\/flagcdn\.io\/flags\/4x3\/\$\{normalizedCode\}\.svg/);
  assert.match(source, /loading="lazy"/);
  assert.match(source, /referrerPolicy="no-referrer"/);
  assert.match(source, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(styles, /\.roam-country-flag img[\s\S]*?object-fit: cover/);
});

test("roam globe surfaces stay neutral while lit markers keep the accent", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/components/RoamGlobe.jsx", import.meta.url), "utf8");
  const globeRule = styles.match(/\.roam-globe \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(globeRule, /border: 1px solid var\(--line\)/);
  assert.match(globeRule, /background: transparent/);
  assert.doesNotMatch(globeRule, /var\(--accent\)/);
  assert.doesNotMatch(styles, /\.roam-globe::after/);
  assert.match(styles, /\.roam-globe-label > span[\s\S]*?color: var\(--accent\)/);
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

test("roam refresh candidates include only rated stable identities missing reliable countries", () => {
  const candidates = getRoamCountryRefreshCandidates({
    artistGroups: [
      { id: "artist-ready", artist: "Ready", releases: [ratedRelease] },
      { id: "artist-pending", artist: "Pending", releases: [ratedRelease] },
      { id: "artist-unrated", artist: "Unrated", releases: [{ ...ratedRelease, listeningEntries: [] }] },
    ],
    artistIdentityState: {
      identities: [
        { id: "artist-ready", canonicalName: "Ready", aliases: [] },
        { id: "artist-pending", canonicalName: "Pending", aliases: [{ name: "Pending Alias" }], musicBrainzMbid: "123" },
        { id: "artist-unrated", canonicalName: "Unrated", aliases: [] },
      ],
    },
    artistProfileState: {
      profiles: {
        "artist-ready": profile("英国"),
        "artist-pending": profile("", { introductionStatus: "FAILED" }),
      },
    },
  });
  assert.deepEqual(candidates, [{
    artistId: "artist-pending",
    name: "Pending",
    aliases: ["Pending Alias"],
    musicBrainzId: "123",
  }]);
});

test("roam country refresh persists only sourced mappable results and preserves sources", async () => {
  const persisted = [];
  const summary = await runRoamCountryRefresh([
    { artistId: "artist-1", name: "Artist One", aliases: [] },
    { artistId: "artist-2", name: "Artist Two", aliases: [] },
  ], {
    researchArtistImpl: async ({ artistId }) => artistId === "artist-1"
      ? profile("日本", { introduction: "简介", sources: [{ sourceId: "S2", url: "https://example.com/new" }] })
      : profile("未知星球"),
    storedProfileImpl: async () => ({ sources: [{ sourceId: "S1", url: "https://example.com/old" }] }),
    persistProfileImpl: async (artistId, patch) => persisted.push({ artistId, patch }),
    delayImpl: async () => {},
  });
  assert.equal(summary.checked, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.noCountry, 1);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].patch.sources.map((source) => source.sourceId), ["S1", "S2"]);
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
  assert.match(app, /search: "\?refreshCountries=1"/);
});
