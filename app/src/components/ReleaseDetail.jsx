import {
  AppleLogo,
  ArrowSquareOut,
  CalendarBlank,
  ClockCounterClockwise,
  LinkSimple,
  Plus,
  SpotifyLogo,
  X,
} from "@phosphor-icons/react";
import {
  displayDate,
  getCurrentRating,
  getLatestListenedAt,
  getLatestMarkedAt,
  getReleaseKindLabel,
} from "../lib/music.js";
import { Rating } from "./Rating.jsx";
import { ReleaseMergePanel } from "./ReleaseMergePanel.jsx";

const providerConfig = {
  APPLE_MUSIC: { label: "在 Apple Music 打开", Icon: AppleLogo },
  SPOTIFY: { label: "在 Spotify 打开", Icon: SpotifyLogo },
  NEODB: { label: "查看 NeoDB 记录", Icon: LinkSimple },
};

export function ReleaseDetail({
  release,
  artistTargets = [],
  onClose,
  onAddListening,
  onChangeType,
  onFindMergeCandidate,
  onMergeRelease,
  onOpenArtist,
}) {
  if (!release) return null;
  const rating = getCurrentRating(release.listeningEntries);
  const latest = getLatestListenedAt(release.listeningEntries);
  const latestMarkedAt = getLatestMarkedAt(release.listeningEntries);
  const entries = [...release.listeningEntries].sort(
    (a, b) =>
      Date.parse(b.ratedAt ?? b.createdAt) -
      Date.parse(a.ratedAt ?? a.createdAt),
  );
  const confirmedLinks = release.externalLinks.filter((link) =>
    ["CONFIRMED", "AUTO_CONFIRMED"].includes(link.status),
  );
  const displayedLinks = [
    ...new Map(
      confirmedLinks
        .filter((link) => providerConfig[link.provider])
        .map((link) => [link.provider, link]),
    ).values(),
  ];
  const hasStreamingLink = confirmedLinks.some((link) =>
    ["APPLE_MUSIC", "SPOTIFY"].includes(link.provider),
  );
  const titleAliases = [
    ...new Map(
      [release.translatedTitle, ...(release.titleAliases ?? [])]
        .map((title) => String(title ?? "").trim())
        .filter(
          (title) =>
            title &&
            !["null", "undefined", "nan"].includes(
              title.toLocaleLowerCase(),
            ),
        )
        .filter(
          (title) =>
            title.normalize("NFKC").toLocaleLowerCase() !==
            release.title.normalize("NFKC").toLocaleLowerCase(),
        )
        .map((title) => [
          title.normalize("NFKC").toLocaleLowerCase(),
          title,
        ]),
    ).values(),
  ];

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="release-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${release.title} 详情`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-topbar">
          <span>发行详情</span>
          <button type="button" className="icon-button" onClick={onClose}>
            <X aria-hidden="true" />
            <span className="sr-only">关闭详情</span>
          </button>
        </div>
        <div className="detail-hero">
          {release.coverUrl ? (
            <img
              src={release.coverUrl}
              alt={`${release.artists.join("、")}《${release.title}》封面`}
            />
          ) : (
            <div className="detail-cover-placeholder">{release.title[0]}</div>
          )}
          <div className="detail-summary">
            <span className="detail-kicker">
              {getReleaseKindLabel(release)} ·{" "}
              {release.releaseDate
                ? displayDate(
                    release.releaseDate,
                    release.releaseDatePrecision,
                  )
                : displayDate(latestMarkedAt)}
            </span>
            <h2>{release.title}</h2>
            {titleAliases.length ? (
              <p className="detail-title-alias">
                译名 / 别名：{titleAliases.join("、")}
              </p>
            ) : null}
            <p className="detail-artist">
              {artistTargets.length
                ? artistTargets.map((artist, index) => (
                    <span key={artist.id}>
                      {index > 0 ? <span aria-hidden="true"> / </span> : null}
                      <button
                        type="button"
                        onClick={() => onOpenArtist?.(artist.id)}
                        title={`查看 ${artist.canonicalName} 的全部作品`}
                      >
                        {artist.name}
                      </button>
                    </span>
                  ))
                : release.artists.join("、")}
            </p>
            <Rating score={rating} />
          </div>
          <div className="detail-type-editor">
            <span>发行类型</span>
            <div role="group" aria-label="快速设置发行类型">
              {[
                ["LP", "LP"],
                ["EP", "EP"],
                ["SINGLE", "Single"],
                ["OTHER", "未分类"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={release.releaseType === value ? "is-active" : ""}
                  onClick={() => onChangeType?.(release.id, value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="detail-facts">
            <span>
              <CalendarBlank aria-hidden="true" />
              最近听过 {latest ? displayDate(latest) : "未记录"}
            </span>
            <span>
              <ClockCounterClockwise aria-hidden="true" />
              {release.listeningEntries.length} 次记录
            </span>
          </div>
        </div>
        {release.genres.length ? (
          <div className="genre-row">
            {release.genres.map((genre) => (
              <span key={genre}>{genre}</span>
            ))}
          </div>
        ) : null}
        <div className="platform-row">
          {displayedLinks.map((link) => {
            const config = providerConfig[link.provider];
            const Icon = config.Icon;
            return (
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                key={link.provider}
              >
                <Icon weight="fill" aria-hidden="true" />
                {config.label}
                <ArrowSquareOut aria-hidden="true" />
              </a>
            );
          })}
          {!hasStreamingLink ? (
            <span className="match-pending">
              尚未确认 Apple Music / Spotify 链接
            </span>
          ) : null}
        </div>
        <div className="timeline-header">
          <div>
            <h3>收听时间线</h3>
            <p>每次评分与评论都会独立保留</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onAddListening(release.id)}
          >
            <Plus aria-hidden="true" />
            记录这次收听
          </button>
        </div>
        <ol className="timeline">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="timeline-dot" aria-hidden="true" />
              <div className="timeline-card">
                <div className="timeline-meta">
                  <span>
                    听过：
                    {entry.listenedAt
                      ? displayDate(
                          entry.listenedAt,
                          entry.listenedAtPrecision,
                        )
                      : "日期未记录"}
                  </span>
                </div>
                <Rating score={entry.rating10} compact />
                {entry.comment ? <p>{entry.comment}</p> : <p>没有留下评论。</p>}
                <small>来源：{entry.source}</small>
              </div>
            </li>
          ))}
        </ol>
        <ReleaseMergePanel
          release={release}
          onFindCandidate={onFindMergeCandidate}
          onMerge={onMergeRelease}
        />
      </aside>
    </div>
  );
}
