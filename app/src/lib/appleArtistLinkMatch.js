import {
  findConfirmedAppleMusicCatalogAlbum,
  parseAppleMusicArtistUrl,
} from "./appleMusicUrl.js";
import { normalizeArtistPlatformUrl } from "./artistProfiles.js";

function normalizeText(value = "") {
  return String(value)
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

export const MAX_APPLE_ALBUMS_PER_ARTIST = 5;
export const VARIOUS_ARTIST_NAMES = Object.freeze([
  "various artists",
  "various",
  "va",
  "群星",
  "オムニバス",
]);

function cleanName(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isVariousArtistsName(value) {
  return VARIOUS_ARTIST_NAMES.includes(normalizeText(value));
}

export function identityNameKeys(names = []) {
  const keys = new Set();
  for (const name of names) {
    const cleaned = cleanName(name);
    if (!cleaned) continue;
    keys.add(normalizeText(cleaned));
    keys.add(normalizeText(cleaned.replaceAll("-", " ")));
  }
  return keys;
}

function namesFromAppleArtist(artist) {
  const names = [cleanName(artist?.name)];
  const parsed = parseAppleMusicArtistUrl(artist?.url);
  if (parsed) {
    try {
      const segments = new URL(artist.url).pathname.split("/").filter(Boolean);
      const artistIndex = segments.findIndex(
        (part) => part.toLocaleLowerCase() === "artist",
      );
      const slug = artistIndex >= 0 ? segments[artistIndex + 1] : "";
      if (slug && !/^\d+$/.test(slug)) {
        names.push(slug.replaceAll("-", " "));
      }
    } catch {
      // Keep the catalog name even if the public URL cannot be parsed.
    }
  }
  return names.filter(Boolean);
}

export function appleArtistMatchesNameKeys(artist, nameKeys) {
  if (!nameKeys?.size) return false;
  return namesFromAppleArtist(artist).some((name) =>
    nameKeys.has(normalizeText(name)),
  );
}

export function includedAppleArtists(payload) {
  const relationshipIds = new Set(
    (payload?.data?.[0]?.relationships?.artists?.data ?? [])
      .filter((item) => item?.type === "artists" && item?.id)
      .map((item) => String(item.id)),
  );
  return (payload?.included ?? [])
    .filter(
      (item) =>
        item?.type === "artists" &&
        item?.id &&
        (relationshipIds.size === 0 || relationshipIds.has(String(item.id))),
    )
    .map((item) => ({
      id: String(item.id),
      name: cleanName(item.attributes?.name),
      url: cleanName(item.attributes?.url),
    }))
    .filter((item) => item.id && (item.name || item.url));
}

export function canonicalAppleArtistUrl(url, fallbackStorefront = "us") {
  const parsed = parseAppleMusicArtistUrl(url);
  if (!parsed) return "";
  const storefront = parsed.sourceStorefront || fallbackStorefront || "us";
  return `https://music.apple.com/${storefront}/artist/${parsed.sourceArtistId}`;
}

export function matchingAppleArtistFromAlbum(payload, nameKeys) {
  const artists = includedAppleArtists(payload);
  const albumArtistName = cleanName(
    payload?.data?.[0]?.attributes?.artistName,
  );
  if (!artists.length) return { status: "NO_ARTISTS" };
  if (
    artists.length === 1 &&
    isVariousArtistsName(artists[0].name || albumArtistName)
  ) {
    return { status: "VARIOUS_ARTISTS" };
  }
  const matches = artists.filter((artist) =>
    appleArtistMatchesNameKeys(artist, nameKeys),
  );
  if (matches.length === 1) {
    return { status: "MATCHED", artist: matches[0] };
  }
  if (matches.length > 1) return { status: "AMBIGUOUS" };
  return { status: "NAME_MISMATCH" };
}

export function resolveAppleArtistLink(albumResults = []) {
  const matched = [];
  for (const result of albumResults) {
    if (result?.status !== "MATCHED" || !result.artist?.id) continue;
    matched.push(result.artist);
  }
  if (!matched.length) {
    return { status: "NO_EVIDENCE" };
  }
  const uniqueIds = [...new Set(matched.map((artist) => artist.id))];
  if (uniqueIds.length !== 1) {
    return { status: "AMBIGUOUS" };
  }
  const artist = matched.find((item) => item.id === uniqueIds[0]);
  return { status: "MATCHED", artist };
}

export function confirmedAppleAlbumsForArtist(releases = []) {
  const seen = new Set();
  const albums = [];
  for (const release of releases) {
    const parsed = findConfirmedAppleMusicCatalogAlbum(release);
    if (!parsed?.sourceAlbumId) continue;
    const storefront = parsed.sourceStorefront || "us";
    const key = `${storefront}:${parsed.sourceAlbumId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    albums.push({
      storefront,
      albumId: parsed.sourceAlbumId,
      canonicalUrl: parsed.canonicalUrl,
    });
    if (albums.length >= MAX_APPLE_ALBUMS_PER_ARTIST) break;
  }
  return albums;
}

export function appleArtistLinkJobFromGroup(group, profile) {
  if (
    normalizeArtistPlatformUrl(
      "appleMusic",
      profile?.platformLinks?.appleMusic,
    )
  ) {
    return null;
  }
  const albums = confirmedAppleAlbumsForArtist(group?.releases ?? []);
  if (!albums.length) return null;
  const names = [
    group?.artist,
    ...(Array.isArray(group?.aliases) ? group.aliases : []),
    ...(Array.isArray(group?.credits) ? group.credits : []),
  ].filter(Boolean);
  if (!group?.id || !names.length) return null;
  return {
    artistId: group.id,
    names,
    albums,
  };
}
