import { useEffect, useMemo, useState } from "react";
import {
  AppleLogo,
  ArrowSquareOut,
  CaretDown,
  SpinnerGap,
} from "@phosphor-icons/react";
import { findConfirmedAppleMusicAlbum } from "../lib/appleMusicUrl.js";
import {
  ALBUM_INTRODUCTION_MAX_LENGTH,
  USER_ALBUM_INTRODUCTION_VERSION_ID,
  editorialVersionLabel,
  editorialVersionRegionNames,
  normalizeAlbumIntroduction,
  selectAlbumIntroductionVersionId,
} from "../lib/appleMusicEditorial.js";

const ERROR_MESSAGES = Object.freeze({
  APPLE_MUSIC_NOT_CONFIGURED:
    "尚未配置 Apple Music 开发者令牌，官方介绍暂不可用。",
  APPLE_MUSIC_UNAUTHORIZED:
    "Apple Music 开发者令牌无效或已过期，请重新配置。",
  APPLE_MUSIC_RATE_LIMITED:
    "Apple Music 暂时限制了请求频率，请稍后重试。",
  APPLE_MUSIC_ALBUM_NOT_FOUND:
    "Apple Music 目录中没有找到这张专辑。",
  INVALID_APPLE_MUSIC_URL: "这条 Apple Music 链接无法识别。",
  UNSUPPORTED_APPLE_MUSIC_RESOURCE:
    "这条 Apple Music 链接不是专辑地址。",
});

function errorMessage(code) {
  return (
    ERROR_MESSAGES[code] ?? "暂时无法读取 Apple Music 官方介绍，可稍后重试。"
  );
}

function productLocale() {
  if (typeof navigator === "undefined") return "zh-CN";
  return navigator.language || "zh-CN";
}

function sectionSubtitle({ editing, showingUser, hasOfficialVersion }) {
  if (editing) return "保存在本机音乐库，不会覆盖 Apple Music 官方原文。";
  if (showingUser) return "你添加的介绍，保存在本机音乐库。";
  if (hasOfficialVersion) return "Apple Music 官方编辑介绍，不改写原文。";
  return "可以自己写，也可以在配置令牌后读取 Apple Music 官方介绍。";
}

export function AppleMusicEditorialNotes({ release, onSaveIntroduction }) {
  const album = useMemo(
    () => findConfirmedAppleMusicAlbum(release),
    [release],
  );
  const locale = useMemo(productLocale, []);
  const userIntroduction = normalizeAlbumIntroduction(
    release.albumIntroduction,
  );
  const hasUserIntroduction = Boolean(userIntroduction);
  const [state, setState] = useState({
    status: "idle",
    result: null,
    errorCode: "",
  });
  const [selectedVersionId, setSelectedVersionId] = useState(
    hasUserIntroduction ? USER_ALBUM_INTRODUCTION_VERSION_ID : "",
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const canonicalUrl = album?.canonicalUrl ?? "";
  const releaseId = release?.id ?? "";

  useEffect(() => {
    setEditing(false);
    setDraft("");
    setSelectedVersionId(
      normalizeAlbumIntroduction(release.albumIntroduction)
        ? USER_ALBUM_INTRODUCTION_VERSION_ID
        : "",
    );
  }, [releaseId]);

  useEffect(() => {
    if (!canonicalUrl) {
      setState({ status: "idle", result: null, errorCode: "" });
      setLoadingMore(false);
      return undefined;
    }

    let active = true;
    setState({ status: "loading", result: null, errorCode: "" });
    setLoadingMore(false);

    const params = new URLSearchParams({
      url: canonicalUrl,
      mode: "quick",
      locale,
    });
    fetch(`/api/apple-music/editorial-notes?${params}`, {
      headers: { accept: "application/json" },
    })
      .then(async (response) => ({
        ok: response.ok,
        payload: await response.json().catch(() => ({})),
      }))
      .then(({ ok, payload }) => {
        if (!active) return;
        if (!ok) {
          setState({
            status: "error",
            result: null,
            errorCode: payload.error ?? "",
          });
          return;
        }
        setState({ status: "ready", result: payload, errorCode: "" });
        setSelectedVersionId((current) =>
          selectAlbumIntroductionVersionId(payload.versions ?? [], {
            locale,
            previousVersionId: current,
            hasUserIntroduction:
              current === USER_ALBUM_INTRODUCTION_VERSION_ID,
          }),
        );
      })
      .catch(() => {
        if (!active) return;
        setState({ status: "error", result: null, errorCode: "" });
      });

    return () => {
      active = false;
    };
  }, [canonicalUrl, locale, releaseId]);

  async function loadMoreLanguages() {
    if (loadingMore || !canonicalUrl) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        url: canonicalUrl,
        mode: "full",
        locale,
      });
      const response = await fetch(
        `/api/apple-music/editorial-notes?${params}`,
        { headers: { accept: "application/json" } },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setState((current) => ({
          ...current,
          errorCode: payload.error ?? "",
        }));
        return;
      }
      setState((current) => ({
        status: "ready",
        result: payload,
        errorCode: current.errorCode,
      }));
      setSelectedVersionId((current) =>
        selectAlbumIntroductionVersionId(payload.versions ?? [], {
          locale,
          previousVersionId: current,
          hasUserIntroduction:
            current === USER_ALBUM_INTRODUCTION_VERSION_ID,
        }),
      );
    } catch {
      setState((current) => ({ ...current, errorCode: "" }));
    } finally {
      setLoadingMore(false);
    }
  }

  const versions = state.result?.versions ?? [];

  function officialVersionId() {
    return selectAlbumIntroductionVersionId(versions, { locale });
  }

  function startEditing() {
    setDraft(userIntroduction);
    setEditing(true);
    setSelectedVersionId(USER_ALBUM_INTRODUCTION_VERSION_ID);
  }

  function cancelEditing() {
    setDraft("");
    setEditing(false);
    setSelectedVersionId(
      selectAlbumIntroductionVersionId(versions, {
        locale,
        hasUserIntroduction,
      }),
    );
  }

  function saveIntroduction() {
    const text = normalizeAlbumIntroduction(draft);
    onSaveIntroduction?.(release.id, text);
    setEditing(false);
    setDraft("");
    setSelectedVersionId(
      text ? USER_ALBUM_INTRODUCTION_VERSION_ID : officialVersionId(),
    );
  }

  function clearIntroduction() {
    if (!hasUserIntroduction) return;
    if (!window.confirm("清除这篇介绍？官方原文不会被改动。")) return;
    onSaveIntroduction?.(release.id, "");
    setEditing(false);
    setDraft("");
    setSelectedVersionId(officialVersionId());
  }
  const showingUser =
    hasUserIntroduction &&
    (editing ||
      selectedVersionId === USER_ALBUM_INTRODUCTION_VERSION_ID ||
      (!selectedVersionId && hasUserIntroduction));
  const selectedVersion =
    showingUser || editing
      ? null
      : (versions.find((version) => version.id === selectedVersionId) ??
        versions[0] ??
        null);
  const regionNames = selectedVersion
    ? editorialVersionRegionNames(selectedVersion, locale)
    : [];
  const appleMusicUrl =
    state.result?.album?.appleMusicUrl || album?.canonicalUrl || "";
  const scan = state.result?.scan;
  const canScanMore = Boolean(album) && scan?.mode === "quick";
  const canEdit = typeof onSaveIntroduction === "function";
  const versionOptions = [
    ...(hasUserIntroduction
      ? [{ id: USER_ALBUM_INTRODUCTION_VERSION_ID, label: "我写的" }]
      : []),
    ...versions.map((version) => ({
      id: version.id,
      label: editorialVersionLabel(version, { locale, versions }),
    })),
  ];
  const showOfficialError =
    Boolean(album) &&
    !editing &&
    !showingUser &&
    (state.status === "error" || (state.status === "ready" && state.errorCode));
  const showOfficialEmpty =
    Boolean(album) &&
    !editing &&
    !showingUser &&
    !selectedVersion &&
    state.status === "ready";
  const showLoading =
    Boolean(album) &&
    !editing &&
    !showingUser &&
    !selectedVersion &&
    state.status === "loading";

  return (
    <section className="apple-editorial" aria-label="专辑介绍">
      <header className="apple-editorial-header">
        <div>
          <h3>专辑介绍</h3>
          <p>
            {sectionSubtitle({
              editing,
              showingUser,
              hasOfficialVersion: Boolean(selectedVersion),
            })}
          </p>
        </div>
        {!editing && versionOptions.length > 1 ? (
          <label className="apple-editorial-versions">
            <span className="sr-only">文案版本</span>
            <select
              value={
                showingUser
                  ? USER_ALBUM_INTRODUCTION_VERSION_ID
                  : (selectedVersion?.id ?? "")
              }
              onChange={(event) => setSelectedVersionId(event.target.value)}
            >
              {versionOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <CaretDown aria-hidden="true" />
          </label>
        ) : !editing && selectedVersion ? (
          <span className="apple-editorial-single-version">
            {editorialVersionLabel(selectedVersion, { locale, versions })}
          </span>
        ) : null}
      </header>

      <div className="apple-editorial-body">
        {editing ? (
          <form
            className="apple-editorial-editor"
            onSubmit={(event) => {
              event.preventDefault();
              saveIntroduction();
            }}
          >
            <label className="sr-only" htmlFor={`album-introduction-${release.id}`}>
              专辑介绍正文
            </label>
            <textarea
              id={`album-introduction-${release.id}`}
              value={draft}
              autoFocus
              rows={12}
              maxLength={ALBUM_INTRODUCTION_MAX_LENGTH}
              placeholder="在这里写下或粘贴专辑介绍。"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="apple-editorial-editor-actions">
              <button type="submit" className="secondary-button">
                保存介绍
              </button>
              <button
                type="button"
                className="text-button"
                onClick={cancelEditing}
              >
                取消
              </button>
              {hasUserIntroduction ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={clearIntroduction}
                >
                  清除
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        {showLoading ? (
          <p className="apple-editorial-status">
            <SpinnerGap className="spin" aria-hidden="true" />
            正在查找 Apple Music 官方介绍…
          </p>
        ) : null}

        {showOfficialError ? (
          <p className="apple-editorial-status">
            {errorMessage(state.errorCode)}
          </p>
        ) : null}

        {showOfficialEmpty ? (
          <p className="apple-editorial-status">
            这张专辑暂未发现 Apple Music 官方介绍。
          </p>
        ) : null}

        {!editing && !showingUser && !album && !hasUserIntroduction ? (
          <p className="apple-editorial-status">还没有介绍。</p>
        ) : null}

        {showingUser && !editing ? (
          <div className="apple-editorial-prose is-user">{userIntroduction}</div>
        ) : null}

        {selectedVersion ? (
          <>
            <div
              className="apple-editorial-prose"
              // The server sanitizes Apple's notes down to a <b>/<i>/<br> allowlist.
              dangerouslySetInnerHTML={{ __html: selectedVersion.html }}
            />
            {regionNames.length ? (
              <p className="apple-editorial-regions">
                可用地区：{regionNames.join("、")}
              </p>
            ) : null}
          </>
        ) : null}

        {scan?.status === "partial" && !state.errorCode && selectedVersion ? (
          <p className="apple-editorial-note">
            部分地区暂时没有返回结果，已展示可用版本。
          </p>
        ) : null}

        {!editing && (canEdit || canScanMore || appleMusicUrl) ? (
          <div className="apple-editorial-footer">
            <div className="apple-editorial-footer-actions">
              {canEdit ? (
                <button
                  type="button"
                  className="apple-editorial-muted-button"
                  onClick={startEditing}
                >
                  {hasUserIntroduction ? "编辑" : "添加介绍"}
                </button>
              ) : null}
              {canEdit && showingUser && hasUserIntroduction ? (
                <button
                  type="button"
                  className="apple-editorial-muted-button"
                  onClick={clearIntroduction}
                >
                  清除
                </button>
              ) : null}
            </div>
            <div className="apple-editorial-footer-links">
              {canScanMore ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={loadMoreLanguages}
                  disabled={loadingMore}
                >
                  {loadingMore ? "正在查找…" : "查找更多语言版本"}
                </button>
              ) : null}
              {appleMusicUrl ? (
                <a href={appleMusicUrl} target="_blank" rel="noopener noreferrer">
                  <AppleLogo weight="fill" aria-hidden="true" />
                  在 Apple Music 中打开
                  <ArrowSquareOut aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
