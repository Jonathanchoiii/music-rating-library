import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, Check, Plus, SpinnerGap, X } from "@phosphor-icons/react";
import { findConfirmedAppleMusicCatalogAlbum } from "../lib/appleMusicUrl.js";
import {
  appendManualTrack,
  formatTrackDuration,
  isUserTrack,
  mergeFetchedTracklist,
  parseTrackDurationInput,
  removeManualTrack,
  savedTracklistTracks,
} from "../lib/tracklist.js";

const ERROR_MESSAGES = Object.freeze({
  EXACT_APPLE_MUSIC_LINK_REQUIRED: "需要先添加并确认 Apple Music 专辑链接。",
  EXACT_ALBUM_LINK_REQUIRED: "需要先添加并确认 Apple Music 专辑链接。",
  NO_EXACT_TRACKLIST: "没有找到与当前专辑链接完全一致的曲目。可点右上角加号手动添加。",
  TRACKLIST_UPSTREAM_UNAVAILABLE:
    "Apple Music 曲目暂时无法读取，请稍后重试。也可点加号手动添加。",
  TITLE_REQUIRED: "请填写曲名。",
  DURATION_REQUIRED: "请填写时长，例如 3:45。",
  DURATION_INVALID: "时长格式为 3:45、1:03:22 或秒数。",
});

function trackSequence(track, multipleDiscs) {
  return multipleDiscs
    ? `${track.discNumber}.${track.trackNumber}`
    : String(track.trackNumber).padStart(2, "0");
}

function sourceHint(savedTracklist, exactAlbum, trackCount) {
  const provider = savedTracklist?.provider;
  if (trackCount && provider === "USER") return "手动添加";
  if (trackCount && provider === "MIXED") {
    return savedTracklist?.sourceStorefront
      ? `Apple Music ${savedTracklist.sourceStorefront.toUpperCase()} · 含手动曲目`
      : "Apple Music · 含手动曲目";
  }
  if (trackCount && provider === "APPLE_MUSIC") {
    return savedTracklist?.sourceStorefront
      ? `Apple Music ${savedTracklist.sourceStorefront.toUpperCase()}`
      : "Apple Music";
  }
  if (exactAlbum) return "可从 Apple Music 读取，也可点加号手动补录";
  return "点右上角加号手动填写曲名和时长";
}

const ManualAddForm = memo(function ManualAddForm({ releaseId, onAdd }) {
  const titleRef = useRef(null);
  const durationRef = useRef(null);

  function submit(event) {
    event.preventDefault();
    const added = onAdd({
      title: titleRef.current?.value ?? "",
      duration: durationRef.current?.value ?? "",
    });
    if (!added) return;
    if (titleRef.current) titleRef.current.value = "";
    if (durationRef.current) durationRef.current.value = "";
    titleRef.current?.focus();
  }

  return (
    <form className="release-tracklist-add" onSubmit={submit}>
      <div className="release-tracklist-add-row">
        <label htmlFor={`tracklist-title-${releaseId}`}>
          曲名
          <input
            ref={titleRef}
            id={`tracklist-title-${releaseId}`}
            name="title"
            defaultValue=""
            placeholder="Smooth Operator"
            autoComplete="off"
            autoFocus
          />
        </label>
        <label htmlFor={`tracklist-duration-${releaseId}`}>
          时长
          <input
            ref={durationRef}
            id={`tracklist-duration-${releaseId}`}
            name="duration"
            className="release-tracklist-duration-input"
            defaultValue=""
            placeholder="4:17"
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <button
          type="submit"
          className="secondary-button release-tracklist-add-button"
        >
          添加
        </button>
      </div>
    </form>
  );
});

function TracklistPanel({ release, onApply }) {
  const exactAlbum = useMemo(
    () => findConfirmedAppleMusicCatalogAlbum(release),
    [release],
  );
  const savedTracklist = release?.tracklist;
  const savedTracklistRef = useRef(savedTracklist);
  savedTracklistRef.current = savedTracklist;
  const tracks = savedTracklistTracks(savedTracklist);
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState({ running: false, error: "" });

  useEffect(() => {
    setAdding(false);
    setState({ running: false, error: "" });
  }, [release?.id]);

  const multipleDiscs = new Set(tracks.map((track) => track.discNumber)).size > 1;
  const hint = sourceHint(savedTracklist, exactAlbum, tracks.length);

  const applySavedTracklist = useCallback(
    (tracklist) => {
      onApply?.(release.id, tracklist);
    },
    [onApply, release.id],
  );

  const addManualTrack = useCallback(
    ({ title, duration }) => {
      const parsed = parseTrackDurationInput(duration);
      if (parsed.error) {
        setState({ running: false, error: ERROR_MESSAGES[parsed.error] });
        return false;
      }
      const result = appendManualTrack(savedTracklistRef.current, {
        title,
        durationMs: parsed.durationMs,
      });
      if (result.error) {
        setState({ running: false, error: ERROR_MESSAGES[result.error] });
        return false;
      }
      applySavedTracklist(result.tracklist);
      setState({ running: false, error: "" });
      return true;
    },
    [applySavedTracklist],
  );

  async function refresh() {
    if (state.running || !exactAlbum) return;
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
            externalLinks: (release.externalLinks ?? []).filter(
              (link) => link.provider === "APPLE_MUSIC",
            ),
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.tracklist) {
        throw new Error(payload.error || "TRACKLIST_UNAVAILABLE");
      }
      applySavedTracklist(mergeFetchedTracklist(payload.tracklist, savedTracklist));
      setState({ running: false, error: "" });
    } catch (error) {
      setState({
        running: false,
        error:
          ERROR_MESSAGES[error?.message] ??
          "曲目暂时无法读取，请稍后重试。也可点加号手动添加。",
      });
    }
  }

  function removeTrack(trackId) {
    const result = removeManualTrack(savedTracklist, trackId);
    applySavedTracklist(result.tracklist);
  }

  return (
    <section className="release-tracklist" aria-labelledby={`tracklist-${release.id}`}>
      <header className="release-tracklist-header">
        <div>
          <h3 id={`tracklist-${release.id}`}>曲目列表</h3>
          <p>
            {tracks.length ? `${tracks.length} 首曲目 · ${hint}` : hint}
          </p>
        </div>
        <div className="release-tracklist-actions">
          {onApply ? (
            <button
            type="button"
            className="release-tracklist-refresh"
            aria-label={adding ? "完成添加" : "添加曲目"}
            aria-pressed={adding}
            aria-expanded={adding}
            title={adding ? "完成添加" : "添加曲目"}
            disabled={state.running}
            onClick={() => {
              setAdding((current) => !current);
              setState((current) => ({ ...current, error: "" }));
            }}
          >
            {adding ? (
              <Check aria-hidden="true" />
            ) : (
              <Plus aria-hidden="true" />
            )}
          </button>
          ) : null}
          {onApply && exactAlbum ? (
            <button
              type="button"
              className="release-tracklist-refresh"
              aria-label={tracks.length ? "从 Apple Music 更新曲目列表" : "获取曲目列表"}
              title={tracks.length ? "从 Apple Music 更新曲目列表" : "获取曲目列表"}
              disabled={state.running}
              onClick={refresh}
            >
              {state.running ? (
                <SpinnerGap className="spin" aria-hidden="true" />
              ) : (
                <ArrowClockwise aria-hidden="true" />
              )}
            </button>
          ) : null}
          </div>
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
                {formatTrackDuration(track.durationMs)}
              </time>
              {onApply && isUserTrack(track) ? (
                <button
                  type="button"
                  className="icon-button release-track-remove"
                  aria-label={`删除 ${track.title}`}
                  title="删除这首手动曲目"
                  onClick={() => removeTrack(track.id)}
                >
                  <X aria-hidden="true" />
                </button>
              ) : (
                <span className="release-track-remove-spacer" />
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {onApply && adding ? (
        <ManualAddForm releaseId={release.id} onAdd={addManualTrack} />
      ) : null}
      {state.error ? <p className="release-tracklist-error">{state.error}</p> : null}
    </section>
  );
}

function tracklistPanelPropsAreEqual(prev, next) {
  return (
    prev.onApply === next.onApply &&
    prev.release?.id === next.release?.id &&
    prev.release?.tracklist === next.release?.tracklist &&
    prev.release?.externalLinks === next.release?.externalLinks
  );
}

export const Tracklist = memo(TracklistPanel, tracklistPanelPropsAreEqual);
