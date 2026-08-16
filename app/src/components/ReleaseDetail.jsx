import { useLayoutEffect, useState } from "react";
import {
  AppleLogo,
  ArrowClockwise,
  CalendarBlank,
  ClockCounterClockwise,
  LinkSimple,
  Plus,
  SpotifyLogo,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import {
  displayDate,
  getCurrentRating,
  getLatestListenedAt,
  getLatestMarkedAt,
  getReleaseKindLabel,
  sortListeningEntriesNewestFirst,
} from "../lib/music.js";
import {
  clearCoverLoadFailures,
  coverLookupRecord,
  markCoverLoadFailed,
} from "../lib/coverStatus.js";
import { Rating } from "./Rating.jsx";
import { ReleaseMergePanel } from "./ReleaseMergePanel.jsx";
import { ListeningGuideSection } from "./ListeningGuideSection.jsx";
import { AppleMusicEditorialNotes } from "./AppleMusicEditorialNotes.jsx";
import { ReleaseArtwork } from "./ReleaseArtwork.jsx";
import { ExternalRatings } from "./ExternalRatings.jsx";
import { Tracklist } from "./Tracklist.jsx";
import {
  MOTION_ARTWORK_SLOT,
  PlatformLinkMenu,
  usePlatformLinkMenu,
} from "./PlatformLinkMenu.jsx";
import {
  convertMotionArtworkToWebp,
  hasLocalMotionArtwork,
  isMotionArtworkEnabled,
  motionArtworkNeedsUpgrade,
  setMotionArtworkEnabled,
} from "../lib/motionArtwork.js";
import { isReadOnlyMode } from "../lib/readonlyMode.js";
import {
  getCoverPaletteProxyUrl,
  readCoverPalette,
} from "../lib/coverPalette.js";

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

export function ReleaseDetail({
  release,
  artistTargets = [],
  onClose,
  onAddListening,
  onChangeType,
  onUpdatePlatformLink,
  onClearPlatformLink,
  onFindMergeCandidate,
  onMergeRelease,
  onOpenArtist,
  onSaveAlbumIntroduction,
  onApplyMotionArtworkUpdates,
  onApplyExternalRatings,
  onApplyTracklist,
  onApplyCoverUpdates,
  onToast,
}) {
  const [editingProvider, setEditingProvider] = useState(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const [coverRefreshing, setCoverRefreshing] = useState(false);
  const [coverPalette, setCoverPalette] = useState(null);
  const [coverPaletteProxyUrl, setCoverPaletteProxyUrl] = useState("");
  const [motionLookup, setMotionLookup] = useState({
    running: false,
    message: "",
  });
  const platformLinkMenu = usePlatformLinkMenu();

  useLayoutEffect(() => {
    setEditingProvider(null);
    setDraftUrl("");
    setLinkError("");
    setCoverLoadFailed(false);
    setCoverRefreshing(false);
    setCoverPalette(null);
    setCoverPaletteProxyUrl("");
    setMotionLookup({ running: false, message: "" });
    platformLinkMenu.closeMenu();
  }, [release?.id]);

  if (!release) return null;
  const rating = getCurrentRating(release.listeningEntries);
  const latest = getLatestListenedAt(release.listeningEntries);
  const latestMarkedAt = getLatestMarkedAt(release.listeningEntries);
  const entries = sortListeningEntriesNewestFirst(release.listeningEntries);
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
  const exactAppleLink = confirmedLinks.get("APPLE_MUSIC");
  const hasMotionArtwork = hasLocalMotionArtwork(release);
  const motionArtworkEnabled = isMotionArtworkEnabled(release);
  const needsMotionArtworkUpgrade = motionArtworkNeedsUpgrade(release);

  function activateMotionArtworkControl() {
    if (motionLookup.running) return;
    if (hasMotionArtwork) {
      toggleMotionArtwork();
      return;
    }
    if (isReadOnlyMode()) return;
    requestMotionArtwork();
  }

  function toggleMotionArtwork() {
    if (!hasMotionArtwork) return;
    onApplyMotionArtworkUpdates?.([
      {
        id: release.id,
        motionArtwork: setMotionArtworkEnabled(
          release.motionArtwork,
          !motionArtworkEnabled,
        ),
      },
    ]);
    setMotionLookup({ running: false, message: "" });
  }

  async function requestMotionArtwork() {
    if (motionLookup.running) return;
    const cachedMotionSource =
      release.motionArtwork?.squareUrl || release.motionArtwork?.sourceUrl;
    if (needsMotionArtworkUpgrade && cachedMotionSource) {
      setMotionLookup({ running: true, message: "正在优化动态封面清晰度…" });
      try {
        const localMotionArtwork = await convertMotionArtworkToWebp(
          release,
          cachedMotionSource,
          (message) => setMotionLookup({ running: true, message }),
        );
        onApplyMotionArtworkUpdates?.([
          { id: release.id, motionArtwork: localMotionArtwork },
        ]);
        setMotionLookup({
          running: false,
          message: "清晰版已写入，旧版文件已安全替换",
        });
      } catch (error) {
        const label =
          error.message === "MOTION_ARTWORK_TOO_LARGE"
            ? "清晰版自动降档后仍超过 8 MB，已保留旧版"
            : "清晰度优化失败，旧版动态封面仍可继续使用";
        setMotionLookup({ running: false, message: label });
      }
      return;
    }
    if (!exactAppleLink) {
      openLinkEditor("APPLE_MUSIC");
      setMotionLookup({
        running: false,
        message: "先添加这张唱片的精确 Apple Music 专辑链接，再进行单张检测。",
      });
      return;
    }
    setMotionLookup({ running: true, message: "正在检测动态封面…" });
    try {
      const response = await fetch("/api/apple-motion-artwork", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          releases: [{ id: release.id, externalLinks: release.externalLinks }],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "动态封面检测失败");
      const lookup = payload.updates?.[0]?.motionArtwork;
      if (lookup?.status === "AVAILABLE" && lookup.squareUrl) {
        const localMotionArtwork = await convertMotionArtworkToWebp(
          release,
          lookup.squareUrl,
          (message) => setMotionLookup({ running: true, message }),
        );
        onApplyMotionArtworkUpdates?.([
          { id: release.id, motionArtwork: localMotionArtwork },
        ]);
      } else {
        onApplyMotionArtworkUpdates?.(payload.updates ?? []);
      }
      setMotionLookup({
        running: false,
        message: payload.available
          ? "动态封面已压缩并写入，正在当前详情页展示"
          : "Apple Music 暂无动态封面",
      });
    } catch (error) {
      const labels = {
        FFMPEG_TIMEOUT: "动态封面下载或压缩超时，请稍后重试",
        MOTION_RUNTIME_DOWNLOAD_FAILED:
          "转码组件下载失败，请检查网络后重试",
        MOTION_RUNTIME_INTEGRITY_FAILED:
          "转码组件校验失败，未执行或写入",
        FFMPEG_FAILED: "Apple 动态封面读取失败，请稍后重试",
        MOTION_CDN_UNREACHABLE:
          "已找到动态封面，但当前网络无法读取 Apple 视频；请检查代理后重试",
        MOTION_SOURCE_DOWNLOAD_FAILED:
          "已找到动态封面，但 Apple 视频下载中断；点击可再次尝试",
        MOTION_SOURCE_HTTP_403:
          "Apple 暂时拒绝读取这张动态封面，请稍后重试",
        MOTION_SOURCE_HTTP_404:
          "Apple 上的动态封面资源已失效，可稍后重新检测",
        MOTION_PLAYLIST_UNSUPPORTED:
          "已找到动态封面，但这张封面的 Apple 格式暂不支持",
        MOTION_SOURCE_TOO_LARGE: "动态封面源文件超过 32 MB，未写入",
        DYNAMIC_ARTWORK_TOO_LARGE: "清晰版自动降档后仍超过 8 MB，未写入",
        INVALID_MOTION_ARTWORK_STREAM: "没有找到可转码的视频片段",
        LOOKUP_TIMEOUT: "Apple 动态封面查询超时，请稍后重试",
        MOTION_LOOKUP_UNREACHABLE:
          "暂时无法连接动态封面资料服务，请检查网络后重试",
        MOTION_LOOKUP_INVALID_RESPONSE:
          "动态封面资料服务返回异常，请稍后重试",
      };
      setMotionLookup({
        running: false,
        message: labels[error.message] || "检测或转码失败，请稍后重试",
      });
    }
  }

  function closeLinkEditor() {
    setEditingProvider(null);
    setDraftUrl("");
    setLinkError("");
  }

  function openLinkEditor(provider, currentUrl = "") {
    platformLinkMenu.closeMenu();
    setEditingProvider(provider);
    setDraftUrl(currentUrl);
    setLinkError("");
  }

  function clearPlatformLink(provider) {
    platformLinkMenu.closeMenu();
    onClearPlatformLink?.(release.id, provider);
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

  async function refreshHeroCover(event) {
    event.preventDefault();
    event.stopPropagation();
    if (coverRefreshing || !onApplyCoverUpdates || isReadOnlyMode()) return;
    const releaseId = release.id;
    setCoverRefreshing(true);
    try {
      const response = await fetch("/api/local-enrich-covers", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          releases: [coverLookupRecord(release, coverLoadFailed)],
          cacheLocal: true,
          wait: true,
          force: true,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          result.error === "COVER_ENRICH_FAILED"
            ? "封面更新服务暂时不可用"
            : result.error || "封面更新失败",
        );
      }
      const updates = result.coverUpdates ?? [];
      onApplyCoverUpdates(updates);
      clearCoverLoadFailures(updates.map((update) => update.id));
      if (updates.some((update) => update.id === releaseId && update.coverUrl)) {
        setCoverLoadFailed(false);
        onToast?.("封面已更新");
      } else if ((result.unresolved ?? 0) > 0) {
        onToast?.("没有找到可靠封面");
      }
    } catch (error) {
      onToast?.(error.message || "封面暂时无法更新");
    } finally {
      setCoverRefreshing(false);
    }
  }

  const canRefreshCover = Boolean(onApplyCoverUpdates) && !isReadOnlyMode();

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        onClose();
      }}
    >
      <aside
        className="release-drawer"
        data-detail-tone={coverPalette?.tone ?? "neutral"}
        style={coverPalette?.style}
        role="dialog"
        aria-modal="true"
        aria-label={`${release.title} 详情`}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="drawer-topbar">
          <button type="button" className="icon-button" onClick={onClose}>
            <X aria-hidden="true" />
            <span className="sr-only">关闭详情</span>
          </button>
        </div>
        <div className="detail-hero">
          <div className="detail-cover">
            {release.coverUrl && !coverLoadFailed ? (
              <ReleaseArtwork
                release={release}
                active
                userRequested
                onLoad={(event) => {
                  const palette = readCoverPalette(
                    event.currentTarget,
                    event.currentTarget.currentSrc || release.coverUrl,
                  );
                  if (palette) {
                    setCoverPalette(palette);
                    setCoverPaletteProxyUrl("");
                    return;
                  }
                  setCoverPaletteProxyUrl(
                    getCoverPaletteProxyUrl(
                      event.currentTarget.currentSrc || release.coverUrl,
                    ),
                  );
                }}
                onStaticError={() => {
                  setCoverLoadFailed(true);
                  markCoverLoadFailed(release.id);
                }}
              />
            ) : (
              <div className="detail-cover-placeholder">{release.title[0]}</div>
            )}
            {canRefreshCover ? (
              <button
                type="button"
                className="detail-cover-refresh"
                aria-label={coverRefreshing ? "正在重新获取封面" : "重新获取封面"}
                title="重新获取封面"
                disabled={coverRefreshing}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={refreshHeroCover}
              >
                <ArrowClockwise
                  className={coverRefreshing ? "is-spinning" : undefined}
                  aria-hidden="true"
                />
              </button>
            ) : null}
          </div>
          {coverPaletteProxyUrl && !coverPalette ? (
            <img
              src={coverPaletteProxyUrl}
              alt=""
              aria-hidden="true"
              className="cover-palette-proxy"
              onLoad={(event) => {
                const palette = readCoverPalette(
                  event.currentTarget,
                  `palette-proxy:${release.coverUrl}`,
                );
                if (palette) setCoverPalette(palette);
                setCoverPaletteProxyUrl("");
              }}
              onError={() => setCoverPaletteProxyUrl("")}
            />
          ) : null}
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
            <span className="detail-tool-caption">发行类型</span>
            <div className="detail-release-tools">
              <div className="detail-type-buttons" role="group" aria-label="发行类型">
                {[
                  ["LP", "LP"],
                  ["EP", "EP"],
                  ["SINGLE", "Single"],
                  ["OTHER", "未分类"],
                ].map(([value, label]) => (
                  onChangeType ? (
                    <button
                      type="button"
                      key={value}
                      className={release.releaseType === value ? "is-active" : ""}
                      onClick={() => onChangeType(release.id, value)}
                    >
                      {label}
                    </button>
                  ) : (
                    <span
                      key={value}
                      className={release.releaseType === value ? "is-active" : ""}
                    >
                      {label}
                    </span>
                  )
                ))}
              </div>
              <span className="detail-tool-caption detail-listen-links-label">
                收听链接
              </span>
              <div className="detail-utility-icons" aria-label="发行工具">
                {PLATFORM_SLOTS.map((slot) => {
                  const link = confirmedLinks.get(slot.provider);
                  const Icon = slot.Icon;
                  const menuBind = platformLinkMenu.bindSlot(slot, link);
                  if (link) {
                    return (
                      <a
                        className="detail-utility-icon"
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        key={slot.provider}
                        aria-label={slot.label}
                        title={`${slot.label}。右键或长按可修改链接`}
                        {...menuBind}
                        onClick={(event) => {
                          platformLinkMenu.swallowSuppressedClick(
                            event,
                            slot.provider,
                          );
                        }}
                      >
                        <Icon weight="fill" aria-hidden="true" />
                      </a>
                    );
                  }
                  if (!onUpdatePlatformLink) {
                    return (
                      <span
                        className="detail-utility-icon is-missing"
                        key={slot.provider}
                        aria-label={slot.label}
                        title={slot.label}
                      >
                        <Icon aria-hidden="true" />
                      </span>
                    );
                  }
                  return (
                    <button
                      type="button"
                      key={slot.provider}
                      className={`detail-utility-icon is-missing${
                        editingProvider === slot.provider ? " is-editing" : ""
                      }`}
                      {...menuBind}
                      onClick={(event) => {
                        if (
                          platformLinkMenu.swallowSuppressedClick(
                            event,
                            slot.provider,
                          )
                        ) {
                          return;
                        }
                        openLinkEditor(slot.provider);
                      }}
                      aria-label={slot.addLabel}
                      title={`${slot.addLabel}。右键或长按可修改`}
                    >
                      <Icon aria-hidden="true" />
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`detail-utility-icon motion-artwork-icon${
                    hasMotionArtwork && motionArtworkEnabled ? " is-active" : ""
                  }`}
                  {...platformLinkMenu.bindSlot(
                    MOTION_ARTWORK_SLOT,
                    hasMotionArtwork ? { url: "local" } : null,
                  )}
                  onClick={(event) => {
                    if (
                      platformLinkMenu.swallowSuppressedClick(
                        event,
                        MOTION_ARTWORK_SLOT.provider,
                      )
                    ) {
                      return;
                    }
                    activateMotionArtworkControl();
                  }}
                  disabled={motionLookup.running}
                  aria-label={
                    hasMotionArtwork
                      ? `动态封面已${motionArtworkEnabled ? "开启，点击关闭" : "关闭，点击开启"}`
                      : "请求动态封面"
                  }
                  title={
                    hasMotionArtwork
                      ? `动态封面：${motionArtworkEnabled ? "开启" : "关闭"}。右键或长按可重新检测`
                      : "请求动态封面。右键或长按可重新检测"
                  }
                >
                  {motionLookup.running ? (
                    <SpinnerGap className="spin" aria-hidden="true" />
                  ) : (
                    <span className="motion-artwork-glyph" aria-hidden="true" />
                  )}
                  {hasMotionArtwork ? (
                    <span className="motion-artwork-indicator" aria-hidden="true" />
                  ) : null}
                </button>
              </div>
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
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => {
                      setDraftUrl(event.target.value);
                      setLinkError("");
                    }}
                  />
                  <button type="submit" className="secondary-button">
                    保存链接
                  </button>
                  <button type="button" className="text-button" onClick={closeLinkEditor}>
                    取消
                  </button>
                </div>
                {linkError ? <p className="platform-link-error">{linkError}</p> : null}
              </form>
            ) : null}
            {motionLookup.message ? (
              <small className="motion-artwork-message">{motionLookup.message}</small>
            ) : null}
          </div>
        </div>
        <ExternalRatings release={release} onApply={onApplyExternalRatings} />
        <AppleMusicEditorialNotes
          release={release}
          onSaveIntroduction={onSaveAlbumIntroduction}
        />
        <Tracklist release={release} onApply={onApplyTracklist} />
        <div className="timeline-header">
          <div>
            <h3>收听时间</h3>
            <p>每次评分与评论都会独立保留</p>
          </div>
          {onAddListening ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAddListening(release.id)}
            >
              <Plus aria-hidden="true" />
              添加评论
            </button>
          ) : null}
        </div>
        <ol className={`timeline${entries.length < 2 ? " is-single" : ""}`}>
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
        <ListeningGuideSection release={release} />
        {onMergeRelease ? (
          <ReleaseMergePanel
            release={release}
            onFindCandidate={onFindMergeCandidate}
            onMerge={onMergeRelease}
          />
        ) : null}
      </aside>
      <PlatformLinkMenu
        menu={platformLinkMenu.menu}
        onClose={platformLinkMenu.closeMenu}
        onEdit={(slot, link) => openLinkEditor(slot.provider, link?.url ?? "")}
        onClear={(slot) => clearPlatformLink(slot.provider)}
        onAdd={(slot) => openLinkEditor(slot.provider)}
        onRefreshMotion={() => {
          platformLinkMenu.closeMenu();
          requestMotionArtwork();
        }}
      />
    </div>
  );
}
