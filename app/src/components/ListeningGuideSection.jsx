import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
} from "@phosphor-icons/react";
import { displayDate } from "../lib/music.js";
import { publicListeningGuideIdentity } from "../lib/listeningGuides.js";

function guideEndpoint(release) {
  const params = new URLSearchParams({ title: release.title });
  release.artists.forEach((artist) => params.append("artist", artist));
  return `/api/releases/${encodeURIComponent(release.id)}/listening-guide?${params}`;
}

function sourceMeta(source) {
  return [source.publisher, source.author, source.publishedAt]
    .filter(Boolean)
    .join(" · ");
}

export function ListeningGuideSection({ release }) {
  const [state, setState] = useState({
    loading: true,
    saving: false,
    guide: null,
    error: "",
  });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    setExpanded(false);
    setState({
      loading: true,
      saving: false,
      guide: null,
      error: "",
    });
    fetch(guideEndpoint(release), { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("暂时无法读取聆听指南");
        return response.json();
      })
      .then((payload) => {
        if (!active) return;
        setState({
          loading: false,
          saving: false,
          guide: payload.guide ?? null,
          error: "",
        });
      })
      .catch((error) => {
        if (!active) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error.message,
        }));
      });
    return () => {
      active = false;
    };
  }, [release.id, release.title, release.artists]);

  const generatedLabel = useMemo(() => {
    if (!state.guide?.generatedAt) return "";
    return `最近整理 ${displayDate(state.guide.generatedAt)}`;
  }, [state.guide?.generatedAt]);

  async function generate(refresh = false) {
    setState((current) => ({ ...current, saving: true, error: "" }));
    try {
      const response = await fetch(
        `/api/releases/${encodeURIComponent(release.id)}/listening-guide/${
          refresh ? "refresh" : "generate"
        }`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(publicListeningGuideIdentity(release)),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload.error === "RESEARCH_PROVIDER_UNAVAILABLE"
            ? "尚未配置联网研究服务；现有档案与正文没有被改动"
            : "没有足够的可靠资料，暂未生成",
        );
      }
      setState((current) => ({
        ...current,
        loading: false,
        saving: false,
        guide: payload.guide,
        error: "",
      }));
      setExpanded(true);
    } catch (error) {
      setState((current) => ({
        ...current,
        saving: false,
        error: error.message,
      }));
    }
  }

  const guide = state.guide;
  const hasVisibleBody =
    state.loading || guide?.status === "READY" || Boolean(state.error);

  return (
    <section className="listening-guide" aria-labelledby={`guide-${release.id}`}>
      <header className="listening-guide-header">
        <div>
          <h3 id={`guide-${release.id}`}>专辑聆听指南</h3>
          <p>
            {guide?.status === "READY"
              ? generatedLabel
              : "基于可核验资料整理，不使用你的评分与评论"}
          </p>
        </div>
        {!state.loading ? (
          <button
            type="button"
            className={`listening-guide-update${state.saving ? " is-saving" : ""}`}
            disabled={state.saving}
            aria-label={state.saving ? "正在整理专辑聆听指南" : "联网更新专辑聆听指南"}
            title={state.saving ? "正在整理" : "联网更新聆听指南"}
            onClick={() => generate(Boolean(guide))}
          >
            <ArrowClockwise aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div
        className={`listening-guide-body${hasVisibleBody ? "" : " is-empty"}`}
        aria-live="polite"
      >
        {state.loading ? (
          <div className="listening-guide-status">
            <span className="listening-guide-spinner" aria-hidden="true" />
            正在读取本地指南…
          </div>
        ) : null}

        {guide?.status === "READY" ? (
          <>
            {guide.needsRefresh ? (
              <div className="listening-guide-pilot-note">
                <span>资料变化</span>
                <p>唱片身份信息已有变化；当前正文仍保留，主动更新后才会重新研究。</p>
              </div>
            ) : null}
            <p className={`listening-guide-summary${expanded ? " is-expanded" : ""}`}>
              {guide.summary}
            </p>
            <div className="listening-guide-highlights">
              <span>建议先听</span>
              <div>
                {guide.highlightTracks.map((track) => (
                  <span key={track.title}>{track.title}</span>
                ))}
              </div>
            </div>
            {expanded ? (
              <div className="listening-guide-article">
                {guide.sections.map((section) => (
                  <section key={section.key}>
                    <h4>{section.title}</h4>
                    <p>{section.body}</p>
                  </section>
                ))}
                <section className="listening-guide-track-notes">
                  <h4>重点曲目</h4>
                  <ul>
                    {guide.highlightTracks.map((track) => (
                      <li key={track.title}>
                        <strong>{track.title}</strong>
                        <span>{track.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <details className="listening-guide-sources">
                  <summary>查看资料来源（{guide.sources.length}）</summary>
                  <ol>
                    {guide.sources.map((source) => (
                      <li key={source.id}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          <span>{source.title}</span>
                          <ArrowSquareOut aria-hidden="true" />
                        </a>
                        <small>{sourceMeta(source)}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
            ) : null}
            <button
              type="button"
              className="listening-guide-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起指南" : "展开完整指南"}
              <CaretDown aria-hidden="true" />
            </button>
          </>
        ) : null}

        {state.error ? <p className="listening-guide-error">{state.error}</p> : null}
      </div>
    </section>
  );
}
