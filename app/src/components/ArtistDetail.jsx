import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppleLogo,
  ArrowClockwise,
  ArrowRight,
  Compass,
  ListBullets,
  LockSimple,
  PencilSimple,
  SpinnerGap,
  SpotifyLogo,
  SquaresFour,
  UsersThree,
  X,
  YoutubeLogo,
} from "@phosphor-icons/react";
import { normalizeArtistPlatformUrl, visibleArtistMediaMessage } from "../lib/artistProfiles.js";
import { readArtistHeroInk } from "../lib/artistHeroInk.js";
import { getCoverPaletteProxyUrl } from "../lib/coverPalette.js";
import {
  displayDate,
  getCurrentRating,
  getLatestListenedAt,
} from "../lib/music.js";
import { Cover } from "./ReleaseViews.jsx";
import { Rating } from "./Rating.jsx";

const TYPE_FILTERS = [
  ["ALL", "全部"],
  ["LP", "LP"],
  ["EP", "EP"],
  ["SINGLE", "Single"],
  ["OTHER", "未分类"],
];

const ARTIST_PLATFORM_SLOTS = [
  ["appleMusic", "Apple Music", AppleLogo],
  ["spotify", "Spotify", SpotifyLogo],
  ["youtubeMusic", "YouTube Music", YoutubeLogo],
];

const ACTIVE_ARTIST_RESEARCH_STATUSES = new Set([
  "PREPARING",
  "SEARCHING",
  "VERIFYING",
  "WRITING",
  "SAVING",
  "RESEARCHING",
]);

function releaseDate(release) {
  return release.releaseDate || getLatestListenedAt(release.listeningEntries);
}

export function ArtistDetail({
  artist,
  profile,
  collaborators = [],
  onClose,
  onOpenRelease,
  onOpenArtist,
  onToggleExploration,
  onChangeReleaseView,
  onRequestIntroduction,
  onSavePlatformLinks,
  onMatchAppleLink,
  onRequestMedia,
  onToggleMotion,
}) {
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [releaseView, setReleaseView] = useState(
    profile?.releaseView === "grid" ? "grid" : "list",
  );
  const [editingLinks, setEditingLinks] = useState(false);
  const [linkDraft, setLinkDraft] = useState(profile?.platformLinks ?? {});
  const [confirmedLinks, setConfirmedLinks] = useState(
    profile?.platformLinks ?? {},
  );
  const [linkError, setLinkError] = useState("");
  const [matchingAppleLink, setMatchingAppleLink] = useState(false);
  const [heroPhotoFailed, setHeroPhotoFailed] = useState(false);
  const [closeOnPhoto, setCloseOnPhoto] = useState(false);
  const [heroInk, setHeroInk] = useState("dark");
  const [heroInkProxyUrl, setHeroInkProxyUrl] = useState("");
  const [motionFailed, setMotionFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const researchActive = ACTIVE_ARTIST_RESEARCH_STATUSES.has(
    profile?.introductionStatus,
  );
  const drawerRef = useRef(null);
  const visualRef = useRef(null);
  const heroMediaRef = useRef(null);
  const localMotionUrl = profile?.media?.localMotionUrl || "";
  const staticImageUrl = profile?.media?.imageUrl || "";
  const mediaMessage = visibleArtistMediaMessage(profile?.media);
  const motionEnabled = profile?.media?.motionEnabled !== false;
  const motionAvailable = Boolean(localMotionUrl) && !motionFailed;
  const motionOn = motionAvailable && motionEnabled;
  const showingMotion = motionOn && !reduceMotion;
  const isMotionVideo = /\.mp4$/i.test(localMotionUrl);
  const heroPhotoUrl = (showingMotion ? localMotionUrl : staticImageUrl) || "";
  const hasHeroPhoto = Boolean(heroPhotoUrl) && !heroPhotoFailed;
  const blurPhotoUrl =
    showingMotion && isMotionVideo
      ? staticImageUrl
      : heroPhotoUrl;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    function sync() {
      setReduceMotion(media.matches);
    }
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  function applyHeroInkFromImage(image) {
    const ink = readArtistHeroInk(image);
    if (ink) {
      setHeroInk(ink);
      setHeroInkProxyUrl("");
      return;
    }
    setHeroInkProxyUrl(
      getCoverPaletteProxyUrl(image?.currentSrc || image?.src || heroPhotoUrl),
    );
  }

  useEffect(() => {
    setHeroPhotoFailed(false);
    setMotionFailed(false);
    setHeroInk("dark");
    setHeroInkProxyUrl("");
  }, [artist?.id, localMotionUrl, staticImageUrl, motionEnabled]);

  useEffect(() => {
    if (!hasHeroPhoto) return;
    const media = heroMediaRef.current;
    if (
      (media?.complete && media.naturalWidth) ||
      media?.videoWidth
    ) {
      applyHeroInkFromImage(media);
    }
  }, [artist?.id, heroPhotoUrl, hasHeroPhoto]);

  useEffect(() => {
    setCloseOnPhoto(hasHeroPhoto);
    if (!hasHeroPhoto) return undefined;
    const drawer = drawerRef.current;
    const visual = visualRef.current;
    if (!drawer || !visual) return undefined;

    function updateCloseTone() {
      const drawerTop = drawer.getBoundingClientRect().top;
      const visualRect = visual.getBoundingClientRect();
      const photoBandBottom = visualRect.top + visualRect.height * 0.48;
      setCloseOnPhoto(photoBandBottom > drawerTop + 24);
    }

    updateCloseTone();
    drawer.addEventListener("scroll", updateCloseTone, { passive: true });
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(updateCloseTone)
        : null;
    observer?.observe(visual);
    return () => {
      drawer.removeEventListener("scroll", updateCloseTone);
      observer?.disconnect();
    };
  }, [artist?.id, hasHeroPhoto, heroPhotoUrl]);

  useEffect(() => {
    setReleaseView(profile?.releaseView === "grid" ? "grid" : "list");
  }, [artist?.id, profile?.releaseView]);

  useEffect(() => {
    const nextLinks = profile?.platformLinks ?? {};
    setLinkDraft(nextLinks);
    setConfirmedLinks(nextLinks);
    setEditingLinks(false);
    setLinkError("");
  }, [
    artist?.id,
    profile?.platformLinks?.appleMusic,
    profile?.platformLinks?.spotify,
    profile?.platformLinks?.youtubeMusic,
  ]);

  function saveLinks() {
    const providers = ["appleMusic", "spotify", "youtubeMusic"];
    const next = {};
    for (const provider of providers) {
      const raw = String(linkDraft?.[provider] ?? "").trim();
      const normalized = normalizeArtistPlatformUrl(provider, raw);
      if (raw && !normalized) {
        setLinkError("请填写对应平台的 HTTPS 艺人主页链接。");
        return;
      }
      next[provider] = normalized;
    }
    setConfirmedLinks(next);
    setLinkDraft(next);
    onSavePlatformLinks?.(next);
    setEditingLinks(false);
    setLinkError("");
  }

  async function matchAppleLinkFromAlbums() {
    if (!onMatchAppleLink || matchingAppleLink) return;
    setMatchingAppleLink(true);
    setLinkError("");
    try {
      const result = await onMatchAppleLink();
      if (result?.matchedCount) setEditingLinks(false);
    } catch (error) {
      setLinkError(
        error instanceof Error
          ? error.message
          : "Apple Music 艺人主页暂时无法匹配。",
      );
    } finally {
      setMatchingAppleLink(false);
    }
  }

  function changeReleaseView(nextView) {
    setReleaseView(nextView);
    onChangeReleaseView?.(nextView);
  }

  const releases = useMemo(
    () =>
      artist?.releases
        ?.filter(
          (release) =>
            typeFilter === "ALL" || release.releaseType === typeFilter,
        )
        .sort(
          (a, b) =>
            String(releaseDate(b) || "").localeCompare(
              String(releaseDate(a) || ""),
            ) || a.title.localeCompare(b.title, "zh-CN"),
        ) ?? [],
    [artist, typeFilter],
  );

  if (!artist) return null;

  return (
    <div
      className="drawer-backdrop artist-detail-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <aside
        ref={drawerRef}
        className={`release-drawer artist-detail-drawer${
          hasHeroPhoto ? " has-hero-photo" : ""
        }`}
        data-close-on-photo={closeOnPhoto ? "true" : "false"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`artist-detail-${artist.id}`}
      >
        <div className="artist-detail-topbar">
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭艺人详情"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <header className="artist-detail-hero">
          <div
            ref={visualRef}
            className={`artist-detail-visual${
              hasHeroPhoto ? "" : " artist-detail-collage"
            }`}
            aria-hidden="true"
          >
            {hasHeroPhoto ? (
              <>
                {showingMotion && isMotionVideo ? (
                  <video
                    ref={heroMediaRef}
                    className="artist-detail-media is-motion is-motion-video"
                    src={localMotionUrl}
                    muted
                    loop
                    playsInline
                    autoPlay
                    onLoadedData={(event) =>
                      applyHeroInkFromImage(event.currentTarget)
                    }
                    onError={() => setMotionFailed(true)}
                  />
                ) : (
                  <img
                    ref={heroMediaRef}
                    className={`artist-detail-media${
                      showingMotion ? " is-motion" : ""
                    }`}
                    src={heroPhotoUrl}
                    alt=""
                    onLoad={(event) =>
                      applyHeroInkFromImage(event.currentTarget)
                    }
                    onError={() => {
                      if (showingMotion) setMotionFailed(true);
                      else setHeroPhotoFailed(true);
                    }}
                  />
                )}
                {blurPhotoUrl ? (
                  <img
                    className="artist-detail-media-blur"
                    src={blurPhotoUrl}
                    alt=""
                  />
                ) : null}
                <div className="artist-detail-visual-veil" />
              </>
            ) : (
              <>
                {artist.releases.slice(0, 3).map((release) => (
                  <Cover key={release.id} release={release} />
                ))}
                {!artist.releases.length ? <UsersThree weight="duotone" /> : null}
              </>
            )}
          </div>
          <div
            className="artist-detail-identity"
            data-hero-ink={hasHeroPhoto ? heroInk : "dark"}
          >
            <h2 id={`artist-detail-${artist.id}`}>{artist.artist}</h2>
            {artist.aliases.length ? (
              <p className="artist-detail-aliases">
                {artist.aliases.slice(0, 3).join(" · ")}
              </p>
            ) : null}
            <p className="artist-detail-summary">
              {artist.releases.length} 张已收录发行
              {artist.average != null
                ? ` · 平均 ${artist.average.toFixed(1)}`
                : ""}
            </p>
            <div className="artist-identity-tools">
              <div className="artist-platform-tools" aria-label="艺人主页">
              {ARTIST_PLATFORM_SLOTS.map(([provider, label, Icon]) => {
                const href = normalizeArtistPlatformUrl(
                  provider,
                  confirmedLinks?.[provider],
                );
                return href ? (
                  <a
                    key={provider}
                    className="is-connected"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`打开 ${label} 艺人主页`}
                    aria-label={`打开 ${label} 艺人主页`}
                  >
                    <Icon weight="fill" aria-hidden="true" />
                  </a>
                ) : (
                  <button
                    key={provider}
                    type="button"
                    className="is-missing"
                    disabled
                    aria-disabled="true"
                    title={`${label} 艺人主页尚未添加`}
                    aria-label={`${label} 艺人主页尚未添加`}
                  >
                    <Icon weight="fill" aria-hidden="true" />
                  </button>
                );
              })}
              {localMotionUrl ? (
                <button
                  type="button"
                  className={`motion-artwork-icon${motionOn ? " is-active" : ""}`}
                  onClick={() => onToggleMotion?.(!motionEnabled)}
                  disabled={!onToggleMotion}
                  aria-pressed={motionOn}
                  aria-label={
                    motionOn
                      ? "动态头图已开启，点击恢复静态图"
                      : "动态头图已关闭，点击开启"
                  }
                  title={
                    motionOn
                      ? "动态头图：开启。点击恢复静态图"
                      : "动态头图：关闭。点击播放动态"
                  }
                >
                  <span className="motion-artwork-glyph" aria-hidden="true" />
                  <span className="motion-artwork-indicator" aria-hidden="true" />
                </button>
              ) : null}
              </div>
              <div className="artist-identity-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setEditingLinks(true)}
                  title="编辑艺人主页链接"
                  aria-label="编辑艺人主页链接"
                >
                  <PencilSimple aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`icon-button${
                    profile?.media?.status === "CHECKING" ? " is-saving" : ""
                  }`}
                  disabled={!onRequestMedia || profile?.media?.status === "CHECKING"}
                  onClick={() =>
                    confirmedLinks?.appleMusic
                      ? onRequestMedia?.()
                      : setEditingLinks(true)
                  }
                  title={
                    localMotionUrl || staticImageUrl
                      ? "更新 Apple Music 艺人素材"
                      : "请求 Apple Music 艺人素材"
                  }
                  aria-label={
                    localMotionUrl || staticImageUrl
                      ? "更新 Apple Music 艺人素材"
                      : "请求 Apple Music 艺人素材"
                  }
                >
                  {profile?.media?.status === "CHECKING" ? (
                    <SpinnerGap aria-hidden="true" />
                  ) : (
                    <ArrowClockwise aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            {mediaMessage ? (
              <p className="artist-media-message" role="status">
                {mediaMessage}
              </p>
            ) : null}
          </div>
          {heroInkProxyUrl && hasHeroPhoto ? (
            <img
              src={heroInkProxyUrl}
              alt=""
              aria-hidden="true"
              className="cover-palette-proxy"
              onLoad={(event) => {
                const ink = readArtistHeroInk(event.currentTarget);
                if (ink) setHeroInk(ink);
                setHeroInkProxyUrl("");
              }}
              onError={() => setHeroInkProxyUrl("")}
            />
          ) : null}
        </header>

        {editingLinks ? (
          <section className="artist-platform-editor" aria-label="编辑艺人主页链接">
            <div className="artist-platform-editor-heading">
              <div><strong>艺人主页</strong><p>保存精确艺人主页；素材请求只读取当前艺人的 Apple Music 链接。</p></div>
              <button type="button" className="icon-button" onClick={() => setEditingLinks(false)} aria-label="关闭链接编辑"><X aria-hidden="true" /></button>
            </div>
            {[
              ["appleMusic", "Apple Music", "https://music.apple.com/.../artist/..."],
              ["spotify", "Spotify", "https://open.spotify.com/artist/..."],
              ["youtubeMusic", "YouTube Music", "https://music.youtube.com/channel/..."],
            ].map(([provider, label, placeholder]) => (
              <label key={provider}><span>{label}</span><input type="url" value={linkDraft?.[provider] ?? ""} placeholder={placeholder} onChange={(event) => setLinkDraft((current) => ({ ...current, [provider]: event.target.value }))} /></label>
            ))}
            {linkError ? <p className="artist-platform-error" role="alert">{linkError}</p> : null}
            <div className="artist-platform-editor-actions">
              {onMatchAppleLink ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={matchingAppleLink}
                  onClick={matchAppleLinkFromAlbums}
                >
                  {matchingAppleLink ? "正在匹配…" : "从已确认专辑匹配 Apple Music"}
                </button>
              ) : null}
              <button type="button" className="secondary-button" onClick={() => setEditingLinks(false)}>取消</button>
              <button type="button" className="primary-button" onClick={saveLinks}>保存链接</button>
            </div>
          </section>
        ) : null}

        <section className="artist-detail-section artist-archive-section">
          <header>
            <div>
              <h3>我的收录</h3>
              <p>只展示 RecordShelf 中已经收录的作品</p>
            </div>
            <div
              className="artist-release-view-switch"
              role="group"
              aria-label="专辑视图"
            >
              <button
                type="button"
                className={releaseView === "list" ? "is-active" : ""}
                aria-label="列表视图"
                aria-pressed={releaseView === "list"}
                title="列表视图"
                onClick={() => changeReleaseView("list")}
              >
                <ListBullets aria-hidden="true" />
              </button>
              <button
                type="button"
                className={releaseView === "grid" ? "is-active" : ""}
                aria-label="封面宫格视图"
                aria-pressed={releaseView === "grid"}
                title="封面宫格视图"
                onClick={() => changeReleaseView("grid")}
              >
                <SquaresFour aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="artist-release-tabs" role="tablist" aria-label="发行类型">
            {TYPE_FILTERS.map(([value, label]) => {
              const count =
                value === "ALL"
                  ? artist.releases.length
                  : artist.releases.filter(
                      (release) => release.releaseType === value,
                    ).length;
              if (value !== "ALL" && count === 0) return null;
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={typeFilter === value}
                  className={typeFilter === value ? "is-active" : ""}
                  onClick={() => setTypeFilter(value)}
                >
                  {label} <span>{count}</span>
                </button>
              );
            })}
          </div>
          <div
            className={
              releaseView === "grid"
                ? "artist-release-grid"
                : "artist-release-list"
            }
          >
            {releases.map((release) => {
              const rating = getCurrentRating(release.listeningEntries);
              return (
                <button
                  key={release.id}
                  type="button"
                  className={
                    releaseView === "grid"
                      ? "artist-release-card"
                      : "artist-release-row"
                  }
                  onClick={() => onOpenRelease(release.id)}
                >
                  <Cover release={release} />
                  <span className="artist-release-copy">
                    <strong>{release.title}</strong>
                    {release.translatedTitle ? (
                      <small>{release.translatedTitle}</small>
                    ) : null}
                    <span>
                      {release.releaseType === "OTHER"
                        ? "未分类"
                        : release.releaseType}
                      {" · "}
                      {releaseDate(release)
                        ? displayDate(releaseDate(release))
                        : "日期未确认"}
                    </span>
                  </span>
                  <span className="artist-release-rating">
                    <Rating score={rating} compact />
                  </span>
                  {releaseView === "list" ? (
                    <ArrowRight aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="artist-detail-section artist-exploration-section">
          <header>
            <div>
              <h3>探索模式</h3>
              <p>发现尚未收录、尚未听过的精确作品目录</p>
            </div>
            <button
              type="button"
              className="listening-guide-update"
              aria-pressed={profile.explorationEnabled}
              aria-label={
                profile.explorationEnabled ? "关闭探索模式" : "开启探索模式"
              }
              title={
                profile.explorationEnabled ? "关闭探索模式" : "开启探索模式"
              }
              onClick={() => onToggleExploration(!profile.explorationEnabled)}
            >
              <ArrowClockwise aria-hidden="true" />
            </button>
          </header>
          {profile.explorationEnabled ? (
            <div className="artist-exploration-empty">
              <LockSimple aria-hidden="true" />
              <div>
                <strong>等待精确目录</strong>
                <p>
                  只有主动刷新并核验艺人身份后，未听作品才会以灰色待解锁状态出现。
                </p>
              </div>
            </div>
          ) : null}
        </section>

        <section className="artist-detail-section artist-introduction-section">
          <header>
            <div>
              <h3>艺人介绍</h3>
              <p>基于可核验公开资料整理，不使用你的评分与评论</p>
            </div>
            <button
              type="button"
              className={`listening-guide-update${
                researchActive ? " is-saving" : ""
              }`}
              aria-label={
                researchActive
                  ? "正在更新艺人介绍"
                  : profile?.introduction
                    ? "更新艺人介绍"
                    : "生成艺人介绍"
              }
              title={
                researchActive
                  ? "正在核验公开资料"
                  : profile?.introduction
                    ? "更新艺人介绍"
                    : "生成艺人介绍"
              }
              disabled={!onRequestIntroduction || researchActive}
              onClick={onRequestIntroduction}
            >
              <ArrowClockwise aria-hidden="true" />
            </button>
          </header>
          <ArtistPublicFacts facts={profile?.publicFacts} />
          {researchActive ? (
            <div className="artist-research-status" role="status">
              <ArrowClockwise aria-hidden="true" />
              <div>
                <strong>{profile?.researchMessage || "正在核验公开资料"}</strong>
                <p>身份锚定、联网检索、交叉核验、撰写与保存会依次完成。</p>
              </div>
            </div>
          ) : null}
          {["INSUFFICIENT_SOURCES", "FAILED"].includes(profile?.introductionStatus) ? (
            <p className="artist-research-error" role="status">
              {profile?.researchError || "暂时没有足够可靠的公开资料，请稍后重试。"}
            </p>
          ) : profile?.researchError ? (
            <p className="artist-research-notice" role="status">
              {profile.researchError}
            </p>
          ) : null}
          {profile?.introduction ? (
            <p className="artist-introduction-body">{profile.introduction}</p>
          ) : null}
          <ArtistResearchDetails profile={profile} />
        </section>

        {collaborators.length ? (
          <section className="artist-detail-section artist-collaborators-section">
            <header>
              <div>
                <h3>合作关系</h3>
                <p>按 RecordShelf 中共同署名的发行精确统计</p>
              </div>
            </header>
            <div className="artist-collaborator-list">
              {collaborators.map((collaborator) => (
                <button
                  key={collaborator.id}
                  type="button"
                  className="artist-collaborator-row"
                  onClick={() => onOpenArtist(collaborator.id)}
                >
                  <span className="artist-collaborator-avatar" aria-hidden="true">
                    {collaborator.releases[0] ? (
                      <Cover release={collaborator.releases[0]} />
                    ) : (
                      <UsersThree />
                    )}
                  </span>
                  <span>
                    <strong>{collaborator.name}</strong>
                    <small>共同收录 {collaborator.count} 张</small>
                  </span>
                  <ArrowRight aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <footer className="artist-detail-footer">
          <Compass aria-hidden="true" />
          <span>公开资料、探索目录与动态视觉仅在你主动请求后更新。</span>
        </footer>
      </aside>
    </div>
  );
}

const HIDDEN_MEMBER_ROLES = new Set([
  "original",
  "原始",
  "原始成员",
  "原成员",
]);

function publicMemberRole(role) {
  return String(role ?? "")
    .split(/\s*[·,/|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !HIDDEN_MEMBER_ROLES.has(part.toLocaleLowerCase().replace(/\s+/g, "")))
    .join(" · ");
}

function publicMemberLabel(member) {
  const role = publicMemberRole(member?.role);
  const name = String(member?.name ?? "").trim();
  if (!name) return "";
  return role ? `${name} · ${role}` : name;
}

function ArtistPublicFacts({ facts }) {
  const artistType = String(facts?.artistType ?? "").trim();
  const isGroup = /group|团体|orchestra|choir|管弦|合唱/i.test(artistType);
  const members = [...new Set(
    (facts?.members ?? [])
      .map((member) => publicMemberLabel({ ...member, role: "" }))
      .filter(Boolean),
  )];
  const from = String(
    isGroup
      ? facts?.origin || facts?.birthPlace || ""
      : facts?.birthPlace || facts?.origin || "",
  ).trim();
  const country = String(facts?.country ?? "").trim();
  const rows = [
    [isGroup ? "成立" : "出生", facts?.birthDate || facts?.activeFrom],
    ["来自", from && from !== country ? from : ""],
    ["地区", country],
    ["类型", artistType],
  ].filter(([, value]) => value);
  const hasFacts = rows.length || facts?.genres?.length || members.length;
  if (!hasFacts) return null;
  return (
    <div className="artist-public-profile">
      <dl className="artist-public-facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {members.length ? (
          <div className="artist-public-members-fact">
            <dt>团体成员</dt>
            <dd>{members.join(" / ")}</dd>
          </div>
        ) : null}
        {facts.genres?.length ? (
          <div className="artist-public-genres-fact">
            <dt>流派</dt>
            <dd className="artist-public-genres">
              {facts.genres.map((genre) => (
                <span className="listening-guide-chip" key={genre}>{genre}</span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

const AWARD_RESULT_LABELS = {
  won: "获奖",
  nominated: "提名",
  shortlisted: "入围 / 短名单",
  longlisted: "长名单",
};

const FILM_RELATIONSHIP_LABELS = {
  won: "获奖",
  nominated: "提名",
  shortlisted: "入围",
  performed: "演唱",
  wrote: "创作",
  produced: "制作",
  used: "影片使用",
};

function ArtistResearchDetails({ profile }) {
  const awards = profile?.awards ?? [];
  const nominations = profile?.nominations ?? [];
  const films = profile?.filmRelationships ?? [];
  const listening = profile?.recommendedListening ?? [];
  const sources = profile?.sources ?? [];
  if (
    !awards.length &&
    !nominations.length &&
    !films.length &&
    !listening.length &&
    !sources.length
  ) {
    return null;
  }
  return (
    <div className="artist-research-details">
      {awards.length ? (
        <ArtistFactSection title="获奖">
          <ArtistRecognitionList items={awards} />
        </ArtistFactSection>
      ) : null}
      {nominations.length ? (
        <ArtistFactSection title="提名与入围">
          <ArtistRecognitionList items={nominations} />
        </ArtistFactSection>
      ) : null}
      {films.length ? (
        <ArtistFactSection title="影视作品关系">
          <ul className="artist-recognition-list">
            {films.map((item, index) => (
              <li key={`${item.year}-${item.film}-${item.work}-${index}`}>
                <span className="artist-research-result">
                  {FILM_RELATIONSHIP_LABELS[item.relationship] || item.relationship}
                </span>
                <div>
                  <strong>{[item.year, item.film].filter(Boolean).join(" · ")}</strong>
                  <p>{item.work}</p>
                  {item.award || item.category ? (
                    <small>{[item.award, item.category].filter(Boolean).join(" · ")}</small>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </ArtistFactSection>
      ) : null}
      {listening.length ? (
        <ArtistFactSection title="推荐聆听">
          <div className="artist-recommended-listening">
            {listening.map((item) => (
              <article key={`${item.workType}-${item.title}`}>
                <span>{item.workType}</span>
                <strong>{item.title}</strong>
                <p>{item.reason}</p>
              </article>
            ))}
          </div>
        </ArtistFactSection>
      ) : null}
      {sources.length ? (
        <details className="artist-research-sources">
          <summary>查看资料来源（{sources.length}）</summary>
          <ul>
            {sources.map((source) => (
              <li key={source.sourceId || source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
                {source.publisher ? <small>{source.publisher}</small> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ArtistFactSection({ title, children }) {
  return (
    <section className="artist-research-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function ArtistRecognitionList({ items }) {
  return (
    <ul className="artist-recognition-list">
      {items.map((item, index) => (
        <li key={`${item.year}-${item.award}-${item.category}-${index}`}>
          <span className="artist-research-result">
            {AWARD_RESULT_LABELS[item.result] || item.result}
          </span>
          <div>
            <strong>{[item.year, item.award].filter(Boolean).join(" · ")}</strong>
            <p>{item.category}</p>
            {item.work ? <small>{item.work}</small> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
