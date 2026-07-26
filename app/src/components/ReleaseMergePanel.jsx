import { useEffect, useState } from "react";
import {
  CheckCircle,
  LinkSimple,
  MagnifyingGlass,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  displayDate,
  getCurrentRating,
  getLatestMarkedAt,
} from "../lib/music.js";
import { Rating } from "./Rating.jsx";

function latestComment(release) {
  return [...(release.listeningEntries ?? [])]
    .filter((entry) => entry.comment?.trim())
    .sort(
      (entryA, entryB) =>
        Date.parse(entryB.createdAt ?? entryB.ratedAt ?? 0) -
        Date.parse(entryA.createdAt ?? entryA.ratedAt ?? 0),
    )[0]?.comment;
}

function MergeChoice({
  release,
  label,
  selected,
  inputName,
  onSelect,
}) {
  const markedAt = getLatestMarkedAt(release.listeningEntries);
  const comment = latestComment(release);
  return (
    <label className={`release-merge-choice${selected ? " is-kept" : ""}`}>
      <input
        type="radio"
        name={inputName}
        value={release.id}
        checked={selected}
        onChange={() => onSelect(release.id)}
      />
      <span className="release-merge-radio" aria-hidden="true" />
      {release.coverUrl ? (
        <img
          src={release.coverUrl}
          alt={`${release.artists.join("、")}《${release.title}》封面`}
        />
      ) : (
        <span className="release-merge-cover-placeholder" aria-hidden="true">
          {release.title?.[0] ?? "♪"}
        </span>
      )}
      <span className="release-merge-copy">
        <small>{label}</small>
        <strong>{release.title}</strong>
        <span>{release.artists.join("、")}</span>
        <span>
          {release.listeningEntries.length} 条收听记录
          {markedAt ? ` · 最近 ${displayDate(markedAt)}` : ""}
        </span>
        <em>{comment ? `“${comment}”` : "尚无评论"}</em>
      </span>
      <Rating score={getCurrentRating(release.listeningEntries)} compact />
      <span className="release-merge-decision">
        <CheckCircle weight="fill" aria-hidden="true" />
        {selected ? "保留" : "选择保留"}
      </span>
    </label>
  );
}

export function ReleaseMergePanel({
  release,
  onFindCandidate,
  onMerge,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputUrl, setInputUrl] = useState("");
  const [lookupResult, setLookupResult] = useState(null);
  const [keepReleaseId, setKeepReleaseId] = useState("");

  useEffect(() => {
    setIsOpen(false);
    setInputUrl("");
    setLookupResult(null);
    setKeepReleaseId("");
  }, [release.id]);

  function closeEditor() {
    setIsOpen(false);
    setInputUrl("");
    setLookupResult(null);
    setKeepReleaseId("");
  }

  function findCandidate(event) {
    event.preventDefault();
    const result = onFindCandidate?.(release.id, inputUrl.trim());
    setLookupResult(result);
    setKeepReleaseId("");
  }

  function confirmMerge() {
    if (lookupResult?.status !== "FOUND" || !keepReleaseId) return;
    const keptRelease =
      keepReleaseId === release.id ? release : lookupResult.candidate;
    const removedRelease =
      keepReleaseId === release.id ? lookupResult.candidate : release;
    const confirmed = window.confirm(
      `确认保留《${keptRelease.title}》，并删除《${removedRelease.title}》这条发行？\n\n被删除发行中独有的收听历史、评分、评论和不冲突的外链会先合并到保留项。这个操作会立即写入本地音乐库。`,
    );
    if (!confirmed) return;
    onMerge?.({
      currentReleaseId: release.id,
      candidateReleaseId: lookupResult.candidate.id,
      keepReleaseId,
      provider: lookupResult.provider,
    });
    closeEditor();
  }

  return (
    <section className="release-merge-panel" aria-labelledby="release-merge-title">
      {!isOpen ? (
        <div className="release-merge-entry">
          <div>
            <span>数据整理</span>
            <h3 id="release-merge-title">发现这是另一条记录的重复内容？</h3>
            <p>输入同平台的另一条唱片链接，对比后选择保留其中一条。</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setIsOpen(true)}
          >
            <LinkSimple aria-hidden="true" />
            合并其他条目
          </button>
        </div>
      ) : (
        <div className="release-merge-editor">
          <header>
            <div>
              <span>手动合并</span>
              <h3 id="release-merge-title">找到需要合并的另一条记录</h3>
              <p>支持 NeoDB、Apple Music 和 Spotify 的唱片链接。</p>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={closeEditor}
              aria-label="取消合并"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <form onSubmit={findCandidate}>
            <label htmlFor={`merge-url-${release.id}`}>
              另一条记录的同平台链接
            </label>
            <div>
              <input
                id={`merge-url-${release.id}`}
                type="url"
                value={inputUrl}
                onChange={(event) => {
                  setInputUrl(event.target.value);
                  setLookupResult(null);
                  setKeepReleaseId("");
                }}
                placeholder="https://neodb.social/album/..."
                required
              />
              <button
                type="submit"
                className="secondary-button"
                disabled={!inputUrl.trim()}
              >
                <MagnifyingGlass aria-hidden="true" />
                查找
              </button>
            </div>
          </form>

          {lookupResult && lookupResult.status !== "FOUND" ? (
            <p className="release-merge-error" role="alert">
              {lookupResult.message}
            </p>
          ) : null}

          {lookupResult?.status === "FOUND" ? (
            <div className="release-merge-confirmation">
              <p>
                已通过 {lookupResult.providerLabel} 精确找到另一条记录。请选择最终保留项：
              </p>
              <div className="release-merge-choices">
                <MergeChoice
                  release={release}
                  label="当前条目"
                  selected={keepReleaseId === release.id}
                  inputName={`merge-keep-${release.id}`}
                  onSelect={setKeepReleaseId}
                />
                <MergeChoice
                  release={lookupResult.candidate}
                  label="链接命中的条目"
                  selected={keepReleaseId === lookupResult.candidate.id}
                  inputName={`merge-keep-${release.id}`}
                  onSelect={setKeepReleaseId}
                />
              </div>
              <div className="release-merge-actions">
                <span>未选择并确认前，音乐库不会发生变化。</span>
                <button
                  type="button"
                  className="danger-button"
                  disabled={!keepReleaseId}
                  onClick={confirmMerge}
                >
                  <Trash aria-hidden="true" />
                  确认保留所选并合并
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
