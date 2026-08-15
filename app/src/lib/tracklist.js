const USER_TRACK_PREFIX = "user:";

function cleanTitle(value) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function formatTrackDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function parseTrackDurationInput(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/：/g, ":");
  if (!raw) return { durationMs: null, error: "DURATION_REQUIRED" };
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (seconds > 24 * 60 * 60) return { durationMs: null, error: "DURATION_INVALID" };
    return { durationMs: seconds * 1_000, error: null };
  }
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return { durationMs: null, error: "DURATION_INVALID" };
  }
  const numbers = parts.map((part) => Number(part));
  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2) ?? 0;
  const hours = numbers.at(-3) ?? 0;
  if (seconds > 59 || minutes > 59) {
    return { durationMs: null, error: "DURATION_INVALID" };
  }
  const totalSeconds = hours * 3_600 + minutes * 60 + seconds;
  if (totalSeconds > 24 * 60 * 60) {
    return { durationMs: null, error: "DURATION_INVALID" };
  }
  return { durationMs: totalSeconds * 1_000, error: null };
}

export function isUserTrack(track) {
  return String(track?.id ?? "").startsWith(USER_TRACK_PREFIX);
}

function tracklistProvider(tracks) {
  if (!tracks.length) return "USER";
  const hasUser = tracks.some(isUserTrack);
  const hasCatalog = tracks.some((track) => !isUserTrack(track));
  if (hasUser && hasCatalog) return "MIXED";
  if (hasUser) return "USER";
  return "APPLE_MUSIC";
}

function nextManualPosition(tracks) {
  if (!tracks.length) return { discNumber: 1, trackNumber: 1 };
  const last = tracks[tracks.length - 1];
  return {
    discNumber: positiveInteger(last.discNumber) ?? 1,
    trackNumber: (positiveInteger(last.trackNumber) ?? tracks.length) + 1,
  };
}

export function savedTracklistTracks(tracklist) {
  return tracklist?.status === "SUCCESS" && Array.isArray(tracklist.tracks)
    ? tracklist.tracks
    : [];
}

export function buildManualTrack({ title, durationMs, id } = {}, tracks = []) {
  const cleanedTitle = cleanTitle(title);
  const duration = nonNegativeInteger(durationMs);
  if (!cleanedTitle) return { track: null, error: "TITLE_REQUIRED" };
  if (duration == null) return { track: null, error: "DURATION_INVALID" };
  const position = nextManualPosition(tracks);
  return {
    track: {
      id: String(id ?? "").startsWith(USER_TRACK_PREFIX)
        ? id
        : `${USER_TRACK_PREFIX}${crypto.randomUUID()}`,
      discNumber: position.discNumber,
      trackNumber: position.trackNumber,
      title: cleanedTitle,
      durationMs: duration,
    },
    error: null,
  };
}

function withTracks(existing, tracks) {
  return {
    version: 1,
    provider: tracklistProvider(tracks),
    status: "SUCCESS",
    sourceAlbumId: existing?.sourceAlbumId ?? null,
    sourceStorefront: existing?.sourceStorefront ?? null,
    sourceUrl: existing?.sourceUrl ?? null,
    checkedAt: new Date().toISOString(),
    trackCount: tracks.length,
    tracks,
  };
}

export function appendManualTrack(existing, input) {
  const tracks = savedTracklistTracks(existing);
  const { track, error } = buildManualTrack(input, tracks);
  if (error) return { tracklist: existing ?? null, error };
  return { tracklist: withTracks(existing, [...tracks, track]), error: null };
}

export function removeManualTrack(existing, trackId) {
  const tracks = savedTracklistTracks(existing).filter(
    (track) => track.id !== trackId || !isUserTrack(track),
  );
  return { tracklist: withTracks(existing, tracks) };
}

export function mergeFetchedTracklist(fetched, previous) {
  const extras = savedTracklistTracks(previous).filter(isUserTrack);
  if (!extras.length) return fetched;
  let next = fetched;
  for (const extra of extras) {
    const appended = appendManualTrack(next, extra);
    if (!appended.error) next = appended.tracklist;
  }
  return next;
}
