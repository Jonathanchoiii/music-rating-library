import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, SpinnerGap } from "@phosphor-icons/react";
import { findConfirmedAppleMusicCatalogAlbum } from "../lib/appleMusicUrl.js";
import { findConfirmedSpotifyAlbum } from "../lib/spotifyUrl.js";

const ERROR_MESSAGES = Object.freeze({
  EXACT_ALBUM_LINK_REQUIRED:
    "需要先添加并确认 Apple Music 或 Spotify 专辑链接。",
  EXACT_APPLE_MUSIC_LINK_REQUIRED:
    "需要先添加并确认 Apple Music 或 Spotify 专辑链接。",
  NO_EXACT_TRACKLIST: "没有找到与当前专辑链接完全一致的曲目。",
  SPOTIFY_CREDENTIALS_REQUIRED:
    "本机尚未配置 Spotify Client ID / Secret，无法读取 Spotify 曲目。",
  TRACKLIST_UPSTREAM_UNAVAILABLE: "曲目暂时无法读取，请稍后重试。",
});

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function trackSequence(track, multipleDiscs) {
  return multipleDiscs
    ? `${track.discNumber}.${track.trackNumber}`
    : String(track.trackNumber).padStart(2, "0");
}

function sourceHint(exactAppleAlbum, exactSpotifyAlbum, savedProvider) {
  if (exactAppleAlbum) return "优先从已确认的 Apple Music 专辑读取";
  if (exactSpotifyAlbum) return "从已确认的 Spotify 专辑读取";
  if (savedProvider === "APPLE_MUSIC") return "已保存自 Apple Music";
  if (savedProvider === "SPOTIFY") return "已保存自 Spotify";
  return "";
}

export function Tracklist({ release, onApply }) {
  const exactAppleAlbum = useMemo(
    () => findConfirmedAppleMusicCatalogAlbum(release),
    [release],
  );
  const exactSpotifyAlbum = useMemo(
    () => findConfirmedSpotifyAlbum(release),
    [release],
  );
  const canRefresh = Boolean(exactAppleAlbum || exactSpotifyAlbum);
  const savedTracklist = release?.tracklist;
  const tracks =
    savedTracklist?.status === "SUCCESS" &&
    Array.isArray(savedTracklist.tracks)
      ? savedTracklist.tracks
      : [];
  const [state, setState] = useState({ running: false, error: "" });

  useEffect(() => {
    setState({ running: false, error: "" });
  }, [release?.id]);

  if (!canRefresh && !tracks.length) return null;

  const multipleDiscs = new Set(tracks.map((track) => track.discNumber)).size > 1;
  const hint = sourceHint(
    exactAppleAlbum,
    exactSpotifyAlbum,
    savedTracklist?.provider,
  );

  async function refresh() {
    if (state.running || !canRefresh) return;
    setState({ running: true, error: "" });
    try {
      const response = await fetch("/api/tracklists/refresh", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          release: {
            id: release.id,
            externalLinks: (release.externalLinks ?? []).filter((link) =>
              ["APPLE_MUSIC", "SPOTIFY"].includes(link.provider),
            ),
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.tracklist) {
        throw new Error(payload.error || "TRACKLIST_UNAVAILABLE");
      }
      onApply?.(release.id, payload.tracklist);
      setState({ running: false, error: "" });
    } catch (error) {
      setState({
        running: false,
        error:
          ERROR_MESSAGES[error?.message] ??
          "曲目暂时无法读取，请稍后重试。",
      });
    }
  }

  return (
    <section className="release-tracklist" aria-labelledby={`tracklist-${release.id}`}>
      <header className="release-tracklist-header">
        <div>
          <h3 id={`tracklist-${release.id}`}>曲目列表</h3>
          {tracks.length ? (
            <p>
              {tracks.length} 首曲目
              {savedTracklist?.provider === "SPOTIFY"
                ? " · Spotify"
                : savedTracklist?.provider === "APPLE_MUSIC"
                  ? " · Apple Music"
                  : ""}
            </p>
          ) : hint ? (
            <p>{hint}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button release-tracklist-refresh"
          aria-label={tracks.length ? "更新曲目列表" : "获取曲目列表"}
          title={tracks.length ? "更新曲目列表" : "获取曲目列表"}
          disabled={state.running || !canRefresh}
          onClick={refresh}
        >
          {state.running ? (
            <SpinnerGap className="spin" aria-hidden="true" />
          ) : (
            <ArrowClockwise aria-hidden="true" />
          )}
        </button>
      </header>

      {tracks.length ? (
        <ol className="release-tracklist-list">
          {tracks.map((track) => (
            <li key={track.id}>
              <span className="release-track-number">
                {trackSequence(track, multipleDiscs)}
              </span>
              <span className="release-track-title">{track.title}</span>
              <time className="release-track-duration">
                {formatDuration(track.durationMs)}
              </time>
            </li>
          ))}
        </ol>
      ) : null}
      {state.error ? <p className="release-tracklist-error">{state.error}</p> : null}
    </section>
  );
}
