const SPOTIFY_HOSTNAMES = new Set(["open.spotify.com", "www.open.spotify.com"]);
const ALBUM_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

export function parseSpotifyAlbumUrl(input) {
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
  if (!SPOTIFY_HOSTNAMES.has(parsed.hostname.toLocaleLowerCase())) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  let albumId = null;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index].toLocaleLowerCase() !== "album") continue;
    const candidate = segments[index + 1];
    if (ALBUM_ID_PATTERN.test(candidate)) {
      albumId = candidate;
      break;
    }
  }
  if (!albumId) return null;

  return {
    provider: "spotify",
    sourceAlbumId: albumId,
    canonicalUrl: `https://open.spotify.com/album/${albumId}`,
  };
}

export function findConfirmedSpotifyAlbum(release) {
  return (
    (release?.externalLinks ?? [])
      .filter(
        (link) =>
          link?.provider === "SPOTIFY" &&
          ["CONFIRMED", "AUTO_CONFIRMED"].includes(link?.status),
      )
      .map((link) => parseSpotifyAlbumUrl(link.url))
      .find(Boolean) ?? null
  );
}
