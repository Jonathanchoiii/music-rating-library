import { useEffect, useMemo, useState } from "react";
import {
  AppleLogo,
  ArrowSquareOut,
  CaretDown,
  SpinnerGap,
} from "@phosphor-icons/react";
import { findConfirmedAppleMusicAlbum } from "../lib/appleMusicUrl.js";
import {
  editorialVersionLabel,
  editorialVersionRegionNames,
  selectDefaultEditorialVersionId,
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

export function AppleMusicEditorialNotes({ release }) {
  const album = useMemo(
    () => findConfirmedAppleMusicAlbum(release),
    [release],
  );
  const locale = useMemo(productLocale, []);
  const [state, setState] = useState({
    status: "idle",
    result: null,
    errorCode: "",
  });
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const canonicalUrl = album?.canonicalUrl ?? "";

  useEffect(() => {
    if (!canonicalUrl) {
      setState({ status: "idle", result: null, errorCode: "" });
      setSelectedVersionId("");
      return undefined;
    }

    let active = true;
    setState({ status: "loading", result: null, errorCode: "" });
    setSelectedVersionId("");
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
        setSelectedVersionId(
          selectDefaultEditorialVersionId(payload.versions ?? [], { locale }),
        );
      })
      .catch(() => {
        if (!active) return;
        setState({ status: "error", result: null, errorCode: "" });
      });

    return () => {
      active = false;
    };
  }, [canonicalUrl, locale]);

  async function loadMoreLanguages() {
    if (loadingMore) return;
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
      // A wider scan must never move the reader off the version they chose.
      setSelectedVersionId((current) =>
        selectDefaultEditorialVersionId(payload.versions ?? [], {
          locale,
          previousVersionId: current,
        }),
      );
    } catch {
      setState((current) => ({ ...current, errorCode: "" }));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!album) return null;

  const versions = state.result?.versions ?? [];
  const selectedVersion =
    versions.find((version) => version.id === selectedVersionId) ??
    versions[0] ??
    null;
  const regionNames = selectedVersion
    ? editorialVersionRegionNames(selectedVersion, locale)
    : [];
  const appleMusicUrl =
    state.result?.album?.appleMusicUrl || album.canonicalUrl;
  const scan = state.result?.scan;
  const canScanMore = scan?.mode === "quick";

  return (
    <section className="apple-editorial" aria-label="Apple Music 官方介绍">
      <header className="apple-editorial-header">
        <div>
          <h3>专辑介绍</h3>
          <p>Apple Music 官方编辑介绍，不改写原文。</p>
        </div>
        {versions.length > 1 ? (
          <label className="apple-editorial-versions">
            <span className="sr-only">文案版本</span>
            <select
              value={selectedVersion?.id ?? ""}
              onChange={(event) => setSelectedVersionId(event.target.value)}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {editorialVersionLabel(version, { locale, versions })}
                </option>
              ))}
            </select>
            <CaretDown aria-hidden="true" />
          </label>
        ) : selectedVersion ? (
          <span className="apple-editorial-single-version">
            {editorialVersionLabel(selectedVersion, { locale, versions })}
          </span>
        ) : null}
      </header>

      <div className="apple-editorial-body">
        {state.status === "loading" ? (
          <p className="apple-editorial-status">
            <SpinnerGap className="spin" aria-hidden="true" />
            正在查找 Apple Music 官方介绍…
          </p>
        ) : null}

        {state.status === "error" ? (
          <p className="apple-editorial-status">
            {errorMessage(state.errorCode)}
          </p>
        ) : null}

        {state.status === "ready" && !selectedVersion ? (
          <p className="apple-editorial-status">
            这张专辑暂未发现 Apple Music 官方介绍。
          </p>
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

        {state.status === "ready" && state.errorCode ? (
          <p className="apple-editorial-status">
            {errorMessage(state.errorCode)}
          </p>
        ) : null}

        {scan?.status === "partial" && !state.errorCode ? (
          <p className="apple-editorial-note">
            部分地区暂时没有返回结果，已展示可用版本。
          </p>
        ) : null}

        <div className="apple-editorial-footer">
          <span>来源：Apple Music Editorial Notes</span>
          <div>
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
            <a href={appleMusicUrl} target="_blank" rel="noopener noreferrer">
              <AppleLogo weight="fill" aria-hidden="true" />
              在 Apple Music 中打开
              <ArrowSquareOut aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
