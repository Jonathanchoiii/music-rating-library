import { useState } from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  Copy,
  Trash,
} from "@phosphor-icons/react";
import {
  displayDate,
  getCurrentRating,
  getLatestMarkedAt,
} from "../lib/music.js";
import { Cover } from "./ReleaseViews.jsx";
import { Rating } from "./Rating.jsx";

export function DuplicateManager({
  groups,
  onOpen,
  onResolve,
  onBack,
}) {
  if (!groups.length) {
    return (
      <section className="duplicates-empty">
        <CheckCircle weight="fill" aria-hidden="true" />
        <h2>没有发现相同 NeoDB 链接</h2>
        <p>这里只检查网址完全相同的条目，不会进行模糊匹配。</p>
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          返回设置
        </button>
      </section>
    );
  }

  return (
    <section className="duplicates-page" aria-labelledby="duplicates-title">
      <header className="duplicates-heading">
        <div>
          <span className="eyebrow">需要你确认</span>
          <h2 id="duplicates-title">疑似重复条目</h2>
          <p>
            以下条目指向完全相同的 NeoDB 唱片页面。选择一条保留，再删除同组中的其他条目。
          </p>
        </div>
        <div className="duplicates-heading-actions">
          <span>{groups.length} 组</span>
          <button type="button" className="secondary-button" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            返回设置
          </button>
        </div>
      </header>

      <div className="duplicate-groups">
        {groups.map((group) => (
          <DuplicateGroup
            group={group}
            key={group.id}
            onOpen={onOpen}
            onResolve={onResolve}
          />
        ))}
      </div>
    </section>
  );
}

function DuplicateGroup({ group, onOpen, onResolve }) {
  const inputName = `keep-${encodeURIComponent(group.neodbUrl)}`;
  const [selectedReleaseId, setSelectedReleaseId] = useState(null);

  function resolveGroup() {
    if (!selectedReleaseId) return;
    const keptRelease = group.releases.find(
      (release) => release.id === selectedReleaseId,
    );
    const deleteCount = group.releases.length - 1;
    if (
      window.confirm(
        `保留《${keptRelease.title}》，并删除同组另外 ${deleteCount} 条记录？被删除条目中的评分和评论不会自动合并。`,
      )
    ) {
      onResolve(group, selectedReleaseId);
    }
  }

  return (
    <article className="duplicate-group">
      <header>
        <div>
          <Copy aria-hidden="true" />
          <span>{group.releases.length} 条记录使用同一链接</span>
        </div>
        <a href={group.neodbUrl} target="_blank" rel="noreferrer">
          查看 NeoDB
          <ArrowSquareOut aria-hidden="true" />
        </a>
      </header>
      <div className="duplicate-choices">
        {group.releases.map((release) => {
          const latest = getLatestMarkedAt(release.listeningEntries);
          const rating = getCurrentRating(release.listeningEntries);
          const latestComment = [...release.listeningEntries]
            .filter((entry) => entry.comment?.trim())
            .sort(
              (entryA, entryB) =>
                Date.parse(entryB.createdAt ?? entryB.ratedAt ?? 0) -
                Date.parse(entryA.createdAt ?? entryA.ratedAt ?? 0),
            )[0]?.comment;
          return (
            <label
              className={`duplicate-choice ${
                selectedReleaseId === release.id ? "is-kept" : ""
              }`}
              data-release-id={release.id}
              key={release.id}
            >
              <input
                type="radio"
                name={inputName}
                value={release.id}
                checked={selectedReleaseId === release.id}
                onChange={(event) =>
                  setSelectedReleaseId(event.target.value)
                }
              />
              <span className="duplicate-radio" aria-hidden="true" />
              <Cover release={release} />
              <span className="duplicate-release-info">
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen(release.id);
                  }}
                >
                  {release.title}
                </button>
                <span>{release.artists.join("、")}</span>
                <small>
                  {release.listeningEntries.length} 条收听记录
                  {latest ? ` · 最近 ${displayDate(latest)}` : ""}
                </small>
                <p
                  className={`duplicate-comment ${
                    latestComment ? "" : "is-empty"
                  }`}
                >
                  {latestComment ? `“${latestComment}”` : "尚无评论"}
                </p>
              </span>
              <Rating score={rating} compact />
              <span className="duplicate-decision">
                <CheckCircle className="keep-icon" weight="fill" />
                <Trash className="delete-icon" />
                <span className="keep-copy">保留</span>
                <span className="delete-copy">将删除</span>
              </span>
            </label>
          );
        })}
      </div>
      <footer>
        <span>尚未选择时不会改变音乐库。</span>
        <button
          type="button"
          className="danger-button duplicate-resolve-button"
          onClick={resolveGroup}
          disabled={!selectedReleaseId}
        >
          <Trash aria-hidden="true" />
          保留所选，删除其他
        </button>
      </footer>
    </article>
  );
}
