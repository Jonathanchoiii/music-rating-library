import { getArtistProfile } from "./artistProfiles.js";
import { getCurrentRating } from "./music.js";

export const ROAM_CONTINENTS = Object.freeze([
  { id: "AS", name: "亚洲", englishName: "Asia" },
  { id: "EU", name: "欧洲", englishName: "Europe" },
  { id: "NA", name: "北美洲", englishName: "North America" },
  { id: "SA", name: "南美洲", englishName: "South America" },
  { id: "AF", name: "非洲", englishName: "Africa" },
  { id: "OC", name: "大洋洲", englishName: "Oceania" },
]);

const REGION_CODES_BY_CONTINENT = Object.freeze({
  AS: "AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE",
  EU: "AL AD AT BY BE BA BG HR CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA XK",
  NA: "AG BS BB BZ BM CA CR CU DM DO SV GL GD GT HT HN JM MX NI PA KN LC PM VC TT US",
  SA: "AR BO BR CL CO EC FK GF GY PY PE SR UY VE",
  AF: "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW",
  OC: "AS AU CK FJ PF GU KI MH FM NR NC NZ NU MP PW PG WS SB TK TO TV VU WF",
});

const zhRegionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const enRegionNames = new Intl.DisplayNames(["en"], { type: "region" });
const REGION_NAME_OVERRIDES = Object.freeze({
  HK: "香港",
  MO: "澳门",
});

function normalizeCountryName(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[·•'’`.,，。()（）\[\]【】/_-]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export const ROAM_REGIONS = Object.freeze(
  ROAM_CONTINENTS.flatMap((continent) =>
    REGION_CODES_BY_CONTINENT[continent.id].split(" ").map((code) => ({
      code,
      name: REGION_NAME_OVERRIDES[code] ?? zhRegionNames.of(code),
      englishName: enRegionNames.of(code),
      continentId: continent.id,
      continentName: continent.name,
    })),
  ),
);

const COUNTRY_ALIASES = Object.freeze({
  US: ["美国", "美利坚合众国", "USA", "U.S.A.", "United States of America"],
  GB: ["英国", "大不列颠", "UK", "U.K.", "Britain", "Great Britain"],
  CN: ["中国", "中国大陆", "中华人民共和国", "Mainland China", "PRC"],
  TW: ["中国台湾", "台湾", "Taiwan, China"],
  HK: [
    "中国香港",
    "中国香港特别行政区",
    "中华人民共和国香港特别行政区",
    "香港",
    "香港特别行政区",
    "Hong Kong SAR",
  ],
  MO: [
    "中国澳门",
    "中国澳门特别行政区",
    "中华人民共和国澳门特别行政区",
    "澳门",
    "澳门特别行政区",
    "Macao SAR",
    "Macau",
  ],
  KR: ["韩国", "大韩民国", "South Korea", "Korea, Republic of"],
  KP: ["朝鲜", "朝鲜民主主义人民共和国", "North Korea", "DPRK"],
  RU: ["俄罗斯", "俄罗斯联邦", "Russian Federation"],
  CZ: ["捷克", "捷克共和国", "Czech Republic"],
  TR: ["土耳其", "Türkiye", "Republic of Türkiye"],
  VN: ["越南", "Viet Nam"],
  LA: ["老挝", "Lao PDR", "Lao People's Democratic Republic"],
  IR: ["伊朗", "Iran, Islamic Republic of"],
  SY: ["叙利亚", "Syrian Arab Republic"],
  BO: ["玻利维亚", "Bolivia, Plurinational State of"],
  VE: ["委内瑞拉", "Venezuela, Bolivarian Republic of"],
  TZ: ["坦桑尼亚", "Tanzania, United Republic of"],
  MD: ["摩尔多瓦", "Moldova, Republic of"],
  BN: ["文莱", "Brunei Darussalam"],
  CV: ["佛得角", "Cabo Verde"],
  SZ: ["斯威士兰", "Eswatini"],
  CD: ["刚果民主共和国", "刚果（金）", "DR Congo", "Democratic Republic of the Congo"],
  CG: ["刚果共和国", "刚果（布）", "Republic of the Congo"],
  CI: ["科特迪瓦", "象牙海岸", "Côte d’Ivoire", "Ivory Coast"],
  PS: ["巴勒斯坦", "State of Palestine", "Palestinian Territories"],
  XK: ["科索沃", "Kosovo"],
});

const regionLookup = new Map();
for (const region of ROAM_REGIONS) {
  const names = [
    region.code,
    region.name,
    region.englishName,
    ...(COUNTRY_ALIASES[region.code] ?? []),
  ];
  for (const name of names) {
    const key = normalizeCountryName(name);
    if (key) regionLookup.set(key, region);
  }
}

export function resolveRoamCountry(value) {
  return regionLookup.get(normalizeCountryName(value)) ?? null;
}

function getListeningDate(release) {
  const timestamps = (release.listeningEntries ?? [])
    .flatMap((entry) => [entry.listenedAt, entry.markedAt, entry.createdAt])
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : "";
}

export function isRoamReadyProfile(profile) {
  return (
    profile?.introductionStatus === "READY" &&
    profile?.sources?.length > 0 &&
    Boolean(resolveRoamCountry(profile?.publicFacts?.country))
  );
}

export function getRoamCountryRefreshCandidates({
  artistGroups = [],
  artistIdentityState,
  artistProfileState,
} = {}) {
  const groupsById = new Map(artistGroups.map((group) => [group.id, group]));
  return (artistIdentityState?.identities ?? []).flatMap((identity) => {
    const group = groupsById.get(identity.id);
    if (
      !(group?.releases ?? []).some(
        (release) => getCurrentRating(release.listeningEntries) != null,
      )
    ) {
      return [];
    }
    const aliases = (identity.aliases ?? [])
      .map((alias) => (typeof alias === "string" ? alias : alias?.name))
      .filter(Boolean);
    const profile = getArtistProfile(artistProfileState, identity.id, [
      identity.canonicalName,
      ...aliases,
    ]);
    if (isRoamReadyProfile(profile)) return [];
    return [{
      artistId: identity.id,
      name: identity.canonicalName,
      aliases,
      musicBrainzId: identity.musicBrainzMbid ?? "",
    }];
  });
}

export function buildRoamModel({ artistGroups = [], artistProfileState } = {}) {
  const countries = new Map();

  for (const group of artistGroups) {
    const listenedReleases = (group.releases ?? []).filter(
      (release) => getCurrentRating(release.listeningEntries) != null,
    );
    if (!listenedReleases.length) continue;

    const profile = getArtistProfile(artistProfileState, group.id, [
      group.artist,
      ...(group.aliases ?? []),
    ]);
    if (!isRoamReadyProfile(profile)) continue;
    const region = resolveRoamCountry(profile.publicFacts.country);
    if (!region) continue;

    const scoredReleases = listenedReleases.map((release) => ({
      release,
      rating: getCurrentRating(release.listeningEntries),
    }));
    const artist = {
      id: group.id,
      name: group.artist,
      imageUrl: profile.media?.imageUrl ?? "",
      releases: scoredReleases,
      average:
        scoredReleases.reduce((sum, item) => sum + item.rating, 0) /
        scoredReleases.length,
      firstListenedAt: listenedReleases
        .map(getListeningDate)
        .filter(Boolean)
        .sort()[0] ?? "",
    };

    const current = countries.get(region.code) ?? {
      ...region,
      artists: [],
      releases: [],
      firstListenedAt: "",
    };
    current.artists.push(artist);
    current.releases.push(...scoredReleases.map((item) => item.release));
    if (
      artist.firstListenedAt &&
      (!current.firstListenedAt || artist.firstListenedAt < current.firstListenedAt)
    ) {
      current.firstListenedAt = artist.firstListenedAt;
    }
    countries.set(region.code, current);
  }

  const litCountries = [...countries.values()]
    .map((country) => {
      const ratings = country.artists.flatMap((artist) =>
        artist.releases.map((item) => item.rating),
      );
      return {
        ...country,
        artists: country.artists.sort(
          (a, b) => b.releases.length - a.releases.length || a.name.localeCompare(b.name, "zh-CN"),
        ),
        average: ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length,
      };
    })
    .sort(
      (a, b) =>
        b.artists.length - a.artists.length ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
  const litCodes = new Set(litCountries.map((country) => country.code));
  const litContinents = new Set(litCountries.map((country) => country.continentId));
  const artistCount = litCountries.reduce((sum, country) => sum + country.artists.length, 0);
  const releaseCount = litCountries.reduce((sum, country) => sum + country.releases.length, 0);

  return {
    countries: litCountries,
    countryByCode: Object.fromEntries(litCountries.map((country) => [country.code, country])),
    litCodes,
    stats: {
      countryCount: litCountries.length,
      continentCount: litContinents.size,
      artistCount,
      releaseCount,
    },
  };
}

export function getRoamRegionsByContinent(litCodes = new Set(), onlyLit = true) {
  return ROAM_CONTINENTS.map((continent) => ({
    ...continent,
    regions: ROAM_REGIONS.filter(
      (region) =>
        region.continentId === continent.id &&
        (!onlyLit || litCodes.has(region.code)),
    ).map((region) => ({ ...region, lit: litCodes.has(region.code) })),
  })).filter((continent) => !onlyLit || continent.regions.length);
}
