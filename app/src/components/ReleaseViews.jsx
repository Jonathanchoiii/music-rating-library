import {
  ArrowLeft,
  ArrowRight,
  ImageBroken,
  LockSimple,
} from "@phosphor-icons/react";
import {
  displayDate,
  getCurrentRating,
  getEffectiveMarkStatus,
  getLatestListenedAt,
  getLatestMarkedAt,
  getMarkStatusLabel,
  getReleaseKindLabel,
} from "../lib/music.js";
import { Rating } from "./Rating.jsx";

const QUICK_RELEASE_TYPES = ["OTHER", "LP", "EP", "SINGLE"];
const RELEASES_PER_SHELF = 5;

function coverHue(release) {
  const key = `${release.title}${release.artists.join("")}`;
  const total = [...key].reduce(
    (sum, character) => sum + character.codePointAt(0),
    0,
  );
  return total % 360;
}

export function Cover({ release, className = "" }) {
  return release.coverUrl ? (
    <img
      className={`release-cover ${className}`}
      src={release.coverUrl}
      alt={`${release.artists.join("、")}《${release.title}》封面`}
      loading="lazy"
    />
  ) : (
    <div
      className={`release-cover cover-placeholder ${className}`}
      aria-label={`${release.title} 暂无封面`}
      style={{ "--cover-hue": coverHue(release) }}
    >
      <ImageBroken aria-hidden="true" />
      <span>{release.title.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}

export function ReleaseGrid({
  releases,
  onOpen,
  onChangeType,
  wall = false,
}) {
  return (
    <div className={wall ? "release-wall" : "release-grid"}>
      {releases.map((release) => {
        const rating = getCurrentRating(release.listeningEntries);
        const latestMarkedAt = getLatestMarkedAt(release.listeningEntries);
        return (
          <article
            className={wall ? "wall-item" : "release-card"}
            key={release.id}
          >
            <button
              type="button"
              className="cover-button"
              onClick={() => onOpen(release.id)}
              aria-label={`打开 ${release.artists[0]} 的 ${release.title}`}
            >
              <Cover release={release} />
              {release.isPrivate ? (
                <span className="cover-lock" aria-label="私密记录">
                  <LockSimple weight="fill" />
                </span>
              ) : null}
              {wall ? (
                <span className="wall-overlay">
                  <strong>{release.title}</strong>
                  {release.translatedTitle ? (
                    <span>{release.translatedTitle}</span>
                  ) : null}
                  <span>{release.artists[0]}</span>
                  <Rating score={rating} compact />
                </span>
              ) : null}
            </button>
            {!wall ? (
              <div className="release-card-body">
                <button
                  type="button"
                  className="release-title-button"
                  onClick={() => onOpen(release.id)}
                >
                  {release.title}
                </button>
                {release.translatedTitle ? (
                  <p className="release-title-alias">
                    {release.translatedTitle}
                  </p>
                ) : null}
                <p className="release-artist">{release.artists.join("、")}</p>
                <div className="release-meta">
                  <button
                    type="button"
                    className="release-type-quick"
                    onClick={() => {
                      const currentIndex = QUICK_RELEASE_TYPES.indexOf(
                        release.releaseType,
                      );
                      const nextType =
                        QUICK_RELEASE_TYPES[
                          (Math.max(currentIndex, 0) + 1) %
                            QUICK_RELEASE_TYPES.length
                        ];
                      onChangeType?.(release.id, nextType);
                    }}
                    aria-label={`《${release.title}》当前类型为 ${
                      release.releaseType === "OTHER"
                        ? "未分类"
                        : release.releaseType
                    }，点击切换`}
                    title="快速切换：未分类 → LP → EP → Single"
                  >
                    {release.releaseType === "OTHER"
                      ? "未分类"
                      : release.releaseType}
                  </button>
                  <span aria-hidden="true">·</span>
                  <span>
                    {release.releaseDate
                      ? displayDate(
                          release.releaseDate,
                          release.releaseDatePrecision,
                        )
                      : displayDate(latestMarkedAt)}
                  </span>
                </div>
                <Rating score={rating} compact />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function ReleaseList({ releases, onOpen }) {
  return (
    <div className="release-list">
      {releases.map((release) => {
        const rating = getCurrentRating(release.listeningEntries);
        const latest = getLatestListenedAt(release.listeningEntries);
        const latestMarkedAt = getLatestMarkedAt(release.listeningEntries);
        const effectiveMarkStatus = getEffectiveMarkStatus(release);
        const markStatusLabel = getMarkStatusLabel(effectiveMarkStatus);
        return (
          <button
            type="button"
            className="release-list-row"
            key={release.id}
            onClick={() => onOpen(release.id)}
          >
            <Cover release={release} />
            <span className="list-release-main">
              <strong>{release.title}</strong>
              {release.translatedTitle ? (
                <span className="list-title-alias">
                  {release.translatedTitle}
                </span>
              ) : null}
              <span>{release.artists.join("、")}</span>
            </span>
            <span className="list-release-type">
              {getReleaseKindLabel(release)}
              <small>
                {release.releaseDate
                  ? displayDate(
                      release.releaseDate,
                      release.releaseDatePrecision,
                    )
                  : displayDate(latestMarkedAt)}
              </small>
            </span>
            <span className="list-release-genres">
              {release.genres.join(" · ") || "未标记流派"}
            </span>
            <span
              className={`list-release-status is-${effectiveMarkStatus ?? "unset"}`}
              aria-label={`收藏状态：${markStatusLabel}`}
            >
              {markStatusLabel}
            </span>
            <span className="list-release-date">
              {latest ? displayDate(latest) : displayDate(latestMarkedAt)}
            </span>
            <Rating score={rating} compact />
          </button>
        );
      })}
    </div>
  );
}

function shelfCardStyle(release, index) {
  const seed = [...`${release.id}${release.title}`].reduce(
    (total, character) => total + character.codePointAt(0),
    0,
  );
  return {
    "--shelf-slot": index,
    "--shelf-lean": `${((seed % 17) - 8) / 10}deg`,
    "--shelf-rise": `${seed % 12}px`,
    "--shelf-scale": 0.94 + (seed % 7) / 100,
  };
}

export function ReleaseShelf({ releases, onOpen }) {
  const shelves = Array.from(
    { length: Math.ceil(releases.length / RELEASES_PER_SHELF) },
    (_, index) =>
      releases.slice(
        index * RELEASES_PER_SHELF,
        (index + 1) * RELEASES_PER_SHELF,
      ),
  );

  return (
    <div className="release-shelf-view">
      <header className="release-shelf-intro">
        <span>RECORD SHELF</span>
        <small>{releases.length} 张正在展示</small>
      </header>
      <div className="release-shelf-stream">
        {shelves.map((shelf, shelfIndex) => (
          <section
            className="release-shelf"
            key={shelf.map((release) => release.id).join("-")}
            aria-label={`唱片架 ${shelfIndex + 1}`}
            style={{ "--shelf-count": shelf.length }}
          >
            <span className="release-shelf-index" aria-hidden="true">
              <span>{String(shelfIndex + 1).padStart(2, "0")}</span>
              <span>RECORDS</span>
            </span>
            <div className="release-shelf-row">
              {shelf.map((release, index) => {
                const rating = getCurrentRating(release.listeningEntries);
                return (
                  <article
                    className="release-shelf-record"
                    key={release.id}
                    style={shelfCardStyle(release, index)}
                  >
                    <button
                      type="button"
                      className="release-shelf-cover-button"
                      onClick={() => onOpen(release.id)}
                      aria-label={`打开 ${release.artists.join("、")} 的 ${release.title}`}
                    >
                      <span className="release-shelf-sleeve">
                        <Cover release={release} />
                        <span className="release-shelf-glare" aria-hidden="true" />
                        {release.isPrivate ? (
                          <span className="cover-lock" aria-label="私密记录">
                            <LockSimple weight="fill" />
                          </span>
                        ) : null}
                      </span>
                      <span className="release-shelf-caption">
                        <span>
                          <strong>{release.title}</strong>
                          <small>{release.artists.join("、")}</small>
                        </span>
                        {rating != null ? <em>{rating.toFixed(1)}</em> : null}
                      </span>
                    </button>
                  </article>
                );
              })}
            </div>
            <span className="release-shelf-board" aria-hidden="true" />
          </section>
        ))}
      </div>
    </div>
  );
}

export function ArtistGroups({
  groups,
  selectedArtistId = "",
  view = "grid",
  onSelectArtist,
  onClearArtist,
  onOpen,
  onChangeType,
}) {
  const selectedGroup = selectedArtistId
    ? groups.find((group) => group.id === selectedArtistId)
    : null;

  if (selectedGroup) {
    return (
      <section className="artist-profile">
        <button
          type="button"
          className="artist-profile-back"
          onClick={onClearArtist}
        >
          <ArrowLeft aria-hidden="true" />
          返回艺人索引
        </button>
        <header>
          <div>
            <span className="eyebrow">
              {selectedGroup.mapped ? "统一艺人身份" : "原始艺人署名"}
            </span>
            <h2>{selectedGroup.artist}</h2>
            {selectedGroup.aliases.length ? (
              <p>{selectedGroup.aliases.join(" · ")}</p>
            ) : null}
          </div>
          <div className="artist-profile-stats">
            <strong>{selectedGroup.releases.length}</strong>
            <span>张发行</span>
            {selectedGroup.average != null ? (
              <em>平均 {selectedGroup.average.toFixed(1)}</em>
            ) : null}
          </div>
        </header>
        {view === "list" ? (
          <ReleaseList
            releases={selectedGroup.releases}
            onOpen={onOpen}
          />
        ) : view === "shelf" ? (
          <ReleaseShelf
            releases={selectedGroup.releases}
            onOpen={onOpen}
          />
        ) : (
          <ReleaseGrid
            releases={selectedGroup.releases}
            onOpen={onOpen}
            onChangeType={onChangeType}
            wall={view === "wall"}
          />
        )}
      </section>
    );
  }

  return (
    <div className={`artist-index${view === "list" ? " is-list" : ""}`}>
      {groups.map((group) => (
        <button
          type="button"
          className="artist-index-card"
          key={group.id}
          onClick={() => onSelectArtist(group.id)}
        >
          <span className="artist-cover-stack" aria-hidden="true">
            {group.releases.slice(0, 3).map((release) => (
              <Cover key={release.id} release={release} />
            ))}
          </span>
          <span className="artist-index-copy">
            <strong>{group.artist}</strong>
            {group.aliases.length ? (
              <small>{group.aliases.slice(0, 2).join(" · ")}</small>
            ) : (
              <small>
                {group.mapped ? "已建立统一身份" : "使用原始署名"}
              </small>
            )}
            <span>
              {group.releases.length} 张发行
              {group.average != null
                ? ` · 平均 ${group.average.toFixed(1)}`
                : ""}
            </span>
          </span>
          <ArrowRight className="artist-index-arrow" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
