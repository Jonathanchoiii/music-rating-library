const APPLE_MUSIC_HOSTNAMES = new Set([
  "music.apple.com",
  "www.music.apple.com",
]);
const STOREFRONT_PATTERN = /^[a-z]{2}$/i;
const ALBUM_ID_PATTERN = /^\d+$/;

export function parseAppleMusicAlbumUrl(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!APPLE_MUSIC_HOSTNAMES.has(parsed.hostname.toLocaleLowerCase())) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  if (segments[1].toLocaleLowerCase() !== "album") return null;

  const storefront = segments[0].toLocaleLowerCase();
  if (!STOREFRONT_PATTERN.test(storefront)) return null;

  // A shared song URL keeps the album path and moves the track into `?i=`,
  // so the album ID always remains the final path segment.
  const albumId = segments.at(-1);
  if (!ALBUM_ID_PATTERN.test(albumId)) return null;

  return {
    provider: "appleMusic",
    sourceStorefront: storefront,
    sourceAlbumId: albumId,
    canonicalUrl: `https://music.apple.com/${storefront}/${segments
      .slice(1)
      .join("/")}`,
  };
}

export function parseAppleMusicArtistUrl(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!APPLE_MUSIC_HOSTNAMES.has(parsed.hostname.toLocaleLowerCase())) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const artistIndex = segments.findIndex(
    (part) => part.toLocaleLowerCase() === "artist",
  );
  if (artistIndex < 0) return null;
  const artistId = segments
    .slice(artistIndex + 1)
    .find((part) => ALBUM_ID_PATTERN.test(part));
  if (!artistId) return null;

  const possibleStorefront =
    artistIndex > 0 ? segments[artistIndex - 1].toLocaleLowerCase() : "";
  const storefront = STOREFRONT_PATTERN.test(possibleStorefront)
    ? possibleStorefront
    : null;

  return {
    provider: "appleMusic",
    sourceStorefront: storefront,
    sourceArtistId: artistId,
    canonicalUrl: storefront
      ? `https://music.apple.com/${storefront}/artist/${artistId}`
      : `https://music.apple.com/artist/${artistId}`,
  };
}

export function parseAppleMusicCatalogAlbumUrl(input) {
  const storefrontAlbum = parseAppleMusicAlbumUrl(input);
  if (storefrontAlbum) return storefrontAlbum;

  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !APPLE_MUSIC_HOSTNAMES.has(parsed.hostname.toLocaleLowerCase())
    ) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (
      segments.length !== 2 ||
      segments[0].toLocaleLowerCase() !== "album" ||
      !ALBUM_ID_PATTERN.test(segments[1])
    ) {
      return null;
    }
    return {
      provider: "appleMusic",
      sourceStorefront: null,
      sourceAlbumId: segments[1],
      canonicalUrl: `https://music.apple.com/album/${segments[1]}`,
    };
  } catch {
    return null;
  }
}

export function findConfirmedAppleMusicAlbum(release) {
  return (
    (release?.externalLinks ?? [])
      .filter(
        (link) =>
          link?.provider === "APPLE_MUSIC" &&
          ["CONFIRMED", "AUTO_CONFIRMED"].includes(link?.status),
      )
      .map((link) => parseAppleMusicAlbumUrl(link.url))
      .find(Boolean) ?? null
  );
}

export function findConfirmedAppleMusicCatalogAlbum(release) {
  return (
    (release?.externalLinks ?? [])
      .filter(
        (link) =>
          link?.provider === "APPLE_MUSIC" &&
          ["CONFIRMED", "AUTO_CONFIRMED"].includes(link?.status),
      )
      .map((link) => parseAppleMusicCatalogAlbumUrl(link.url))
      .find(Boolean) ?? null
  );
}
