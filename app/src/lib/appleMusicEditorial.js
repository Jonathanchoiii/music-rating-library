function displayNames(type, locale) {
  try {
    return new Intl.DisplayNames([locale || "zh-CN"], {
      type,
      fallback: "none",
    });
  } catch {
    return null;
  }
}

export function displayLanguageName(languageTag, locale = "") {
  const tag = String(languageTag ?? "").trim();
  if (!tag) return "";
  try {
    return displayNames("language", locale)?.of(tag) || tag;
  } catch {
    return tag;
  }
}

export function displayRegionName(source, locale = "") {
  const storefront = String(source?.storefront ?? "").trim();
  if (storefront) {
    try {
      const name = displayNames("region", locale)?.of(
        storefront.toLocaleUpperCase(),
      );
      if (name) return name;
    } catch {
      // Fall through to the name Apple returned for the storefront.
    }
  }
  return String(source?.regionName ?? "").trim() || storefront;
}

export function editorialVersionRegionNames(version, locale = "") {
  return [
    ...new Set(
      (version?.sources ?? []).map((source) =>
        displayRegionName(source, locale),
      ),
    ),
  ].filter(Boolean);
}

export function editorialVersionLabel(
  version,
  { locale = "", versions = [] } = {},
) {
  if (!version) return "";
  const primaryTag = version.languageTags?.[0] ?? "";
  const language = displayLanguageName(primaryTag, locale) || primaryTag;
  const sameLanguage = versions.filter(
    (candidate) => (candidate.languageTags?.[0] ?? "") === primaryTag,
  );
  const name =
    sameLanguage.length > 1
      ? `${language}（${displayRegionName(version.sources?.[0], locale)}）`
      : language;
  const regionCount = version.sources?.length ?? 0;

  if (version.noteType === "short") {
    return regionCount > 1
      ? `${name} · 短导语 · ${regionCount} 个地区`
      : `${name} · 短导语`;
  }
  return regionCount > 1
    ? `${name} · ${regionCount} 个地区`
    : `${name} · 完整介绍`;
}

function baseLanguage(tag) {
  return String(tag ?? "")
    .toLocaleLowerCase()
    .split("-")[0];
}

function versionRank(version, { locale, sourceDefaultLanguageTag }) {
  const tags = (version.languageTags ?? []).map((tag) =>
    String(tag).toLocaleLowerCase(),
  );
  const target = String(locale ?? "").toLocaleLowerCase();
  const sourceDefault = String(
    sourceDefaultLanguageTag ?? "",
  ).toLocaleLowerCase();

  let tier = 4;
  if (target && tags.includes(target)) tier = 0;
  else if (sourceDefault && tags.includes(sourceDefault)) tier = 1;
  else if (target && tags.some((tag) => baseLanguage(tag) === baseLanguage(target)))
    tier = 2;
  else if (tags.some((tag) => baseLanguage(tag) === "en")) tier = 3;

  return tier * 2 + (version.noteType === "standard" ? 0 : 1);
}

export function selectDefaultEditorialVersionId(
  versions = [],
  { locale = "", sourceDefaultLanguageTag = "", previousVersionId = "" } = {},
) {
  if (!versions.length) return "";
  if (
    previousVersionId &&
    versions.some((version) => version.id === previousVersionId)
  ) {
    return previousVersionId;
  }
  let best = versions[0];
  let bestRank = versionRank(best, { locale, sourceDefaultLanguageTag });
  for (const version of versions.slice(1)) {
    const rank = versionRank(version, { locale, sourceDefaultLanguageTag });
    if (rank < bestRank) {
      best = version;
      bestRank = rank;
    }
  }
  return best.id;
}
