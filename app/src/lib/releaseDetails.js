import { getDatePrecision } from "./music.js";

export function buildReleaseDetailsPatch(release, draft, now = new Date().toISOString()) {
  const title = String(draft.title ?? "").trim();
  const translatedTitle = String(draft.translatedTitle ?? "").trim() || null;
  // One credit per line: slashes and commas can be part of a real artist name.
  const artists = [...new Set(String(draft.artists ?? "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
  const releaseDate = String(draft.releaseDate ?? "").trim() || null;
  if (!title) throw new Error("请填写专辑名");
  if (!artists.length) throw new Error("请至少填写一位艺人");
  if (releaseDate) {
    const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(releaseDate);
    const year = Number(match?.[1]);
    const month = Number(match?.[2] ?? 1);
    const day = Number(match?.[3] ?? 1);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!match || year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
      throw new Error("请填写有效发行日期，例如 2019、2019-11 或 2019-11-13");
    }
  }
  const patch = {};
  if (title !== release.title) Object.assign(patch, {
    title, titleUserConfirmed: true, titleSource: "USER_CONFIRMED",
    titleMatchedFrom: [], titleMatchedAt: now,
  });
  if (translatedTitle !== (release.translatedTitle || null)) Object.assign(patch, {
    translatedTitle, translatedTitleUserConfirmed: true,
    titleAliases: (release.titleAliases ?? []).filter((alias) => alias !== release.translatedTitle),
  });
  if (JSON.stringify(artists) !== JSON.stringify(release.artists)) Object.assign(patch, {
    artists, artistsUserConfirmed: true,
  });
  if (releaseDate !== (release.releaseDate || null)) Object.assign(patch, {
    releaseDate, releaseDatePrecision: getDatePrecision(releaseDate),
    releaseDateUserConfirmed: true, releaseDateSource: "USER_CONFIRMED",
    releaseDateMatchedFrom: [], releaseDateEvidence: [], releaseDateConflict: [],
    releaseDateCheckedAt: now, releaseDateMatchedAt: now,
  });
  return patch;
}
