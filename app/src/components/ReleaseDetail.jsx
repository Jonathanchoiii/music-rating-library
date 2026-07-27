import { useEffect, useState } from "react";
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

const PLATFORM_SLOTS = [
  {
    provider: "NEODB",
    label: "查看 NeoDB 记录",
    addLabel: "添加 NeoDB 链接",
    Icon: LinkSimple,
  },
  {
    provider: "APPLE_MUSIC",
    label: "在 Apple Music 打开",
    addLabel: "添加 Apple Music 链接",
    Icon: AppleLogo,
  },
  {
    provider: "SPOTIFY",
    label: "在 Spotify 打开",
    addLabel: "添加 Spotify 链接",
    Icon: SpotifyLogo,
  },
];

const GENRE_SOURCE_LABELS = {
  APPLE_LOOKUP: "Apple Music",
  APPLE_MUSIC: "Apple Music",
  APPLE_MUSIC_EXACT: "Apple Music",
  MUSICBRAINZ: "MusicBrainz",
  MUSICBRAINZ_EXACT: "MusicBrainz",
};

function genreSourceLabels(release) {
  const evidenceSources =
    release.metadataEvidence?.genres?.sources?.map((source) => source.source) ??
    [];
  const sourceValues = evidenceSources.length
    ? evidenceSources
    : String(release.genreSource ?? "").split("_AND_");
  return [
    ...new Set(
      sourceValues
        .map((source) => GENRE_SOURCE_LABELS[source])
        .filter(Boolean),
    ),
  ];
}

export function ReleaseDetail({
  release,
  artistTargets = [],
  onClose,
  onAddListening,
  onChangeType,
  onUpdatePlatformLink,
  onFindMergeCandidate,
  onMergeRelease,
  onOpenArtist,
}) {
  const [editingProvider, setEditingProvider] = useState(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [linkError, setLinkError] = useState("");

  useEffect(() => {
    setEditingProvider(null);
    setDraftUrl("");
    setLinkError("");
  }, [release?.id]);

  if (!release) return null;
  const rating = getCurrentRating(release.listeningEntries);
  const latest = getLatestListenedAt(release.listeningEntries);
  const latestMarkedAt = getLatestMarkedAt(release.listeningEntries);
  const entries = [...release.listeningEntries].sort(
    (a, b) =>
      Date.parse(b.ratedAt ?? b.createdAt) -
      Date.parse(a.ratedAt ?? a.createdAt),
  );
  const confirmedLinks = new Map(
    (release.externalLinks ?? [])
      .filter((link) =>
        ["CONFIRMED", "AUTO_CONFIRMED"].includes(link.status),
      )
      .filter((link) =>
        PLATFORM_SLOTS.some((slot) => slot.provider === link.provider),
      )
      .map((link) => [link.provider, link]),
  );
  const genreSources = genreSourceLabels(release);
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
  const editingSlot = PLATFORM_SLOTS.find(
    (slot) => slot.provider === editingProvider,
  );

  function closeLinkEditor() {
    setEditingProvider(null);
    setDraftUrl("");
    setLinkError("");
  }

  function openLinkEditor(provider) {
    setEditingProvider(provider);
    setDraftUrl("");
    setLinkError("");
  }

  function savePlatformLink(event) {
    event.preventDefault();
    if (!editingProvider) return;
    const saved = onUpdatePlatformLink?.(
      release.id,
      editingProvider,
      draftUrl.trim(),
    );
    if (saved !== true) {
      setLinkError(
        typeof saved === "string"
          ? saved
          : "请粘贴该平台的精确专辑链接",
      );
      return;
    }
    closeLinkEditor();
  }

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
        </div>
        {release.genres.length ? (
          <div className="detail-genres">
            <div className="genre-row">
              {release.genres.map((genre) => (
                <span key={genre}>{genre}</span>
              ))}
            </div>
            {genreSources.length ? (
              <p className="genre-source">
                精确信源：{genreSources.join("、")}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="platform-row">
          <div className="platform-row-slots">
            {PLATFORM_SLOTS.map((slot) => {
              const link = confirmedLinks.get(slot.provider);
              const Icon = slot.Icon;
              if (link) {
                return (
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    key={slot.provider}
                  >
                    <Icon weight="fill" aria-hidden="true" />
                    {slot.label}
                    <ArrowSquareOut aria-hidden="true" />
                  </a>
                );
              }
              return (
                <button
                  type="button"
                  key={slot.provider}
                  className={`platform-link-missing${
                    editingProvider === slot.provider ? " is-editing" : ""
                  }`}
                  onClick={() => openLinkEditor(slot.provider)}
                >
                  <Plus aria-hidden="true" />
                  {slot.addLabel}
                </button>
              );
            })}
          </div>
          {editingSlot ? (
            <form className="platform-link-editor" onSubmit={savePlatformLink}>
              <label htmlFor={`platform-link-${release.id}`}>
                粘贴精确的 {editingSlot.addLabel.replace(/^添加 /, "")}
              </label>
              <div>
                <input
                  id={`platform-link-${release.id}`}
                  type="url"
                  value={draftUrl}
                  placeholder="https://"
                  autoFocus
                  onChange={(event) => {
                    setDraftUrl(event.target.value);
                    setLinkError("");
                  }}
                />
                <button type="submit" className="secondary-button">
                  保存链接
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={closeLinkEditor}
                >
                  取消
                </button>
              </div>
              {linkError ? <p className="platform-link-error">{linkError}</p> : null}
            </form>
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
