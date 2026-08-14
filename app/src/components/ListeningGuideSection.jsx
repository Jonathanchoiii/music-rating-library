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

const GENERATION_ERROR_MESSAGES = Object.freeze({
  RESEARCH_PROVIDER_UNAVAILABLE:
    "尚未配置联网研究服务；现有档案与正文没有被改动",
  GEMINI_QUOTA_EXCEEDED:
    "Gemini 当前配额不足或请求过于频繁；请在 Google AI Studio 检查额度后重试",
  GEMINI_API_KEY_INVALID:
    "Gemini 密钥无效或没有调用权限；请前往设置重新填写",
  GEMINI_MODEL_UNAVAILABLE:
    "当前 Gemini 模型不可用；请前往设置更换模型后重试",
  GEMINI_REQUEST_INVALID:
    "Gemini 拒绝了本次请求；请检查设置中的模型名称",
  GEMINI_TEMPORARILY_UNAVAILABLE:
    "Gemini 服务暂时不可用，请稍后重试",
  GEMINI_EMPTY_RESPONSE:
    "Gemini 已响应，但没有返回可用正文；请稍后重试",
  OPENAI_REQUEST_FAILED:
    "OpenAI 请求未成功；请检查密钥、模型与账户额度",
  OPENAI_EMPTY_RESPONSE:
    "OpenAI 已响应，但没有返回可用正文；请稍后重试",
  CODEX_CLI_UNAVAILABLE:
    "没有找到本机 Codex；请先安装或打开 ChatGPT/Codex 桌面应用",
  CODEX_AUTH_REQUIRED:
    "本机 Codex 尚未登录；请先在 ChatGPT/Codex 中完成登录",
  CODEX_RESEARCH_TIMEOUT:
    "本次 Codex 联网研究超时；旧指南仍然保留，可以稍后重试",
  CODEX_RESEARCH_FAILED:
    "Codex 联网研究未成功；旧指南仍然保留，可以稍后重试",
  CODEX_JOB_INTERRUPTED:
    "本地服务在研究期间发生重启；请再次点击更新",
});

const LISTENING_GUIDE_POLL_INTERVAL_MS = 3_000;
const CODEX_PROGRESS_STEPS = Object.freeze([
  { stage: "PREPARING", label: "准备资料", detail: "确认专辑名称、艺人与公开平台身份" },
  { stage: "SEARCHING", label: "联网检索", detail: "查找官方资料、采访、专业评论与公共讨论" },
  { stage: "VERIFYING", label: "核验来源", detail: "排除错配内容，并交叉确认可引用事实" },
  { stage: "WRITING", label: "撰写指南", detail: "整理听感、背景、评价与重点曲目" },
  { stage: "SAVING", label: "写入本地", detail: "校验结构并保存到 RecordShelf" },
]);

function elapsedLabel(startedAt, now) {
  const elapsed = Math.max(0, now - Date.parse(startedAt || now));
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function guideRevision(guide) {
  if (!guide) return "EMPTY";
  return [guide.id, guide.updatedAt, guide.status].filter(Boolean).join(":");
}

export function ListeningGuideSection({ release }) {
  const [state, setState] = useState({
    loading: true,
    saving: false,
    guide: null,
    codexJob: null,
    error: "",
  });
  const [expanded, setExpanded] = useState(false);
  const [progressNow, setProgressNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    let requestInFlight = false;
    setExpanded(false);
    setState({
      loading: true,
      saving: false,
      guide: null,
      codexJob: null,
      error: "",
    });
    async function loadGuide({ initial = false } = {}) {
      if (!active || requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch(guideEndpoint(release), {
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("暂时无法读取聆听指南");
        const payload = await response.json();
        if (!active) return;
        const nextGuide = payload.guide ?? null;
        const nextJob = payload.codexJob ?? null;
        setState((current) => {
          const nextBase = {
            ...current,
            loading: false,
            saving:
              nextJob?.status === "RUNNING" ||
              (current.saving && !nextJob),
            codexJob: nextJob,
          };
          if (!initial && current.guide && !nextGuide) return nextBase;
          const currentUpdatedAt = Date.parse(current.guide?.updatedAt ?? 0);
          const nextUpdatedAt = Date.parse(nextGuide?.updatedAt ?? 0);
          if (
            !initial &&
            current.guide &&
            nextGuide &&
            Number.isFinite(currentUpdatedAt) &&
            Number.isFinite(nextUpdatedAt) &&
            nextUpdatedAt < currentUpdatedAt
          ) {
            return nextBase;
          }
          if (
            !initial &&
            guideRevision(current.guide) === guideRevision(nextGuide) &&
            !current.error
          ) {
            return nextBase;
          }
          return {
            ...nextBase,
            guide: nextGuide,
            error: "",
          };
        });
      } catch (error) {
        if (!active) return;
        if (initial) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error.message,
          }));
        }
      } finally {
        requestInFlight = false;
      }
    }

    loadGuide({ initial: true });
    const poll = () => {
      if (document.visibilityState === "visible") loadGuide();
    };
    const intervalId = window.setInterval(
      poll,
      LISTENING_GUIDE_POLL_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", poll);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [release.id, release.title, release.artists.join("\u0000")]);

  useEffect(() => {
    if (!state.saving) return undefined;
    setProgressNow(Date.now());
    const intervalId = window.setInterval(() => setProgressNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [state.saving]);

  const generatedLabel = useMemo(() => {
    if (!state.guide?.generatedAt) return "";
    return `最近整理 ${displayDate(state.guide.generatedAt)}`;
  }, [state.guide?.generatedAt]);

  async function waitForCodexJob(initialPayload) {
    let payload = initialPayload;
    while (payload.codexJob?.status === "RUNNING") {
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      const response = await fetch(guideEndpoint(release), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("暂时无法读取 Codex 研究进度");
      payload = await response.json();
      setState((current) => ({
        ...current,
        saving: payload.codexJob?.status === "RUNNING",
        codexJob: payload.codexJob ?? current.codexJob,
      }));
      if (!payload.codexJob && initialPayload.codexJob) {
        throw new Error(GENERATION_ERROR_MESSAGES.CODEX_JOB_INTERRUPTED);
      }
    }
    if (payload.codexJob?.status === "FAILED") {
      throw new Error(
        GENERATION_ERROR_MESSAGES[payload.codexJob.error] ||
          GENERATION_ERROR_MESSAGES.CODEX_RESEARCH_FAILED,
      );
    }
    return payload;
  }

  async function generate() {
    const startedAt = new Date().toISOString();
    setState((current) => ({
      ...current,
      saving: true,
      codexJob: {
        status: "RUNNING",
        stage: "PREPARING",
        startedAt,
        updatedAt: startedAt,
        activity: [{ stage: "PREPARING", at: startedAt }],
      },
      error: "",
    }));
    try {
      const response = await fetch(
        `/api/releases/${encodeURIComponent(release.id)}/listening-guide/codex-refresh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(publicListeningGuideIdentity(release)),
        },
      );
      let payload = await response.json();
      if (!response.ok) {
        throw new Error(
          GENERATION_ERROR_MESSAGES[payload.error] ||
            "联网整理未成功；现有聆听指南没有被改动",
        );
      }
      if (payload.codexJob?.status === "RUNNING") {
        setState((current) => ({
          ...current,
          codexJob: payload.codexJob,
        }));
        payload = await waitForCodexJob(payload);
      }
      setState((current) => ({
        ...current,
        loading: false,
        saving: false,
        guide: payload.guide,
        codexJob: payload.codexJob ?? null,
        error: "",
      }));
      window.dispatchEvent(
        new CustomEvent("recordshelf-listening-guide-changed", {
          detail: { releaseId: release.id, status: payload.guide?.status ?? "EMPTY" },
        }),
      );
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
    state.loading || state.saving || guide?.status === "READY" || Boolean(state.error);
  const activeStage = state.codexJob?.stage || "PREPARING";
  const activeStageIndex = Math.max(
    0,
    CODEX_PROGRESS_STEPS.findIndex((step) => step.stage === activeStage),
  );
  const activeProgressStep = CODEX_PROGRESS_STEPS[activeStageIndex];

  return (
    <section className="listening-guide" aria-labelledby={`guide-${release.id}`}>
      <header className="listening-guide-header">
        <div>
          <h3 id={`guide-${release.id}`}>专辑聆听指南</h3>
          <p>
            {state.saving
              ? `Codex 正在${activeProgressStep.label} · 已用 ${elapsedLabel(
                  state.codexJob?.startedAt,
                  progressNow,
                )}`
              : guide?.status === "READY"
              ? generatedLabel
              : "基于可核验资料整理，不使用你的评分与评论"}
          </p>
        </div>
        {!state.loading ? (
          <button
            type="button"
            className={`listening-guide-update${state.saving ? " is-saving" : ""}`}
            disabled={state.saving}
            aria-label={state.saving ? "Codex 正在整理专辑聆听指南" : "使用本机 Codex 联网更新专辑聆听指南"}
            title={state.saving ? "Codex 正在联网整理" : "使用本机 Codex 更新聆听指南"}
            onClick={generate}
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

        {state.saving ? (
          <div className="listening-guide-progress" role="status">
            <div className="listening-guide-progress-heading">
              <div>
                <strong>Codex 正在处理这张专辑</strong>
                <span>{activeProgressStep.detail}</span>
              </div>
              <time>{elapsedLabel(state.codexJob?.startedAt, progressNow)}</time>
            </div>
            <ol>
              {CODEX_PROGRESS_STEPS.map((step, index) => {
                const status =
                  index < activeStageIndex
                    ? "is-complete"
                    : index === activeStageIndex
                      ? "is-active"
                      : "";
                return (
                  <li className={status} key={step.stage}>
                    <span aria-hidden="true" />
                    <div>
                      <strong>{step.label}</strong>
                      {status === "is-active" ? <small>{step.detail}</small> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            <p>你可以继续浏览；完成后本页会自动写入并展开新指南。</p>
          </div>
        ) : null}

        {guide?.status === "READY" ? (
          <>
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
