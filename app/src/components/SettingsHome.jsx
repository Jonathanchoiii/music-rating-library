import { useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  Copy,
  DownloadSimple,
  ImageSquare,
  Key,
  SpinnerGap,
  UploadSimple,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import {
  clearCoverLoadFailures,
  getFailedCoverReleaseIds,
} from "../lib/coverStatus.js";

function coverLookupRecord(release, loadFailed = false) {
  return {
    id: release.id,
    title: release.title,
    artists: release.artists,
    coverUrl: loadFailed ? "" : release.coverUrl ?? "",
    coverRemoteUrl: release.coverRemoteUrl ?? "",
    coverSource: release.coverSource ?? "",
    coverMatchedFrom: release.coverMatchedFrom ?? "",
    externalLinks: (release.externalLinks ?? []).filter((link) =>
      ["CONFIRMED", "AUTO_CONFIRMED"].includes(link.status),
    ),
  };
}


export function SettingsHome({
  releases,
  identityState,
  onOpenArtistManager,
  duplicateGroupCount,
  duplicateReleaseCount,
  onOpenDuplicateManager,
  onOpenSync,
  onClose,
  onExport,
  backupText,
  onMergeBackup,
  onRestore,
  onToast,
  onApplyCoverUpdates,
}) {
  const mergeBackupInputRef = useRef(null);
  const [coverUpdate, setCoverUpdate] = useState({
    running: false,
    processed: 0,
    total: 0,
    updated: 0,
    unresolved: 0,
    message: "",
  });
  const [guideProvider, setGuideProvider] = useState({
    loading: true,
    activeProvider: "OPENAI",
    providers: {
      OPENAI: { configured: false, model: "gpt-5.6-terra", label: "OpenAI" },
      GEMINI: { configured: false, model: "gemini-3.6-flash", label: "Google Gemini" },
    },
    configured: false,
    model: "",
    editing: false,
    saving: false,
    message: "",
  });
  const [providerKeyDraft, setProviderKeyDraft] = useState("");
  const [providerModelDraft, setProviderModelDraft] = useState("gpt-5.6-terra");
  const aliasCount = (identityState.identities ?? []).reduce(
    (sum, identity) => sum + identity.aliases.length,
    0,
  );

  useEffect(() => {
    let active = true;
    fetch("/api/listening-guides/provider", { headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setGuideProvider((current) => ({
          ...current,
          loading: false,
          activeProvider: payload.activeProvider ?? "OPENAI",
          providers: payload.providers ?? current.providers,
          configured: Boolean(payload.configured),
          model: payload.model ?? "",
        }));
        setProviderModelDraft(payload.model ?? "gpt-5.6-terra");
      })
      .catch(() => {
        if (!active) return;
        setGuideProvider((current) => ({ ...current, loading: false }));
      });
    return () => {
      active = false;
    };
  }, []);

  function selectGuideProvider(provider) {
    const details = guideProvider.providers[provider] ?? {};
    setProviderKeyDraft("");
    setProviderModelDraft(
      details.model || (provider === "GEMINI" ? "gemini-3.6-flash" : "gpt-5.6-terra"),
    );
    setGuideProvider((current) => ({
      ...current,
      activeProvider: provider,
      configured: Boolean(details.configured),
      model: details.model ?? "",
      message: "",
    }));
  }

  async function saveGuideProvider() {
    const currentProvider = guideProvider.activeProvider;
    const currentDetails = guideProvider.providers[currentProvider] ?? {};
    if (!providerKeyDraft.trim() && !currentDetails.configured) return;
    setGuideProvider((current) => ({ ...current, saving: true, message: "" }));
    const response = await fetch("/api/listening-guides/provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: currentProvider,
        apiKey: providerKeyDraft.trim() || undefined,
        model: providerModelDraft.trim(),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setGuideProvider((current) => ({
        ...current,
        saving: false,
        message:
          payload.error === "INVALID_PROVIDER_API_KEY"
            ? "密钥格式不完整"
            : payload.error === "INVALID_PROVIDER_MODEL"
              ? "模型名称格式不正确"
              : "保存失败，请检查密钥与模型名称",
      }));
      return;
    }
    setProviderKeyDraft("");
    setGuideProvider((current) => ({
      ...current,
      saving: false,
      activeProvider: payload.activeProvider,
      providers: payload.providers,
      configured: Boolean(payload.configured),
      model: payload.model ?? "",
      editing: false,
      message: "已仅保存在本机私人目录",
    }));
    onToast?.(`${currentDetails.label || currentProvider} 密钥已安全保存在本机`);
  }

  async function removeGuideProvider() {
    const currentProvider = guideProvider.activeProvider;
    const currentDetails = guideProvider.providers[currentProvider] ?? {};
    const response = await fetch(
      `/api/listening-guides/provider?provider=${encodeURIComponent(currentProvider)}`,
      { method: "DELETE" },
    );
    const payload = await response.json().catch(() => ({}));
    setProviderKeyDraft("");
    setGuideProvider((current) => ({
      ...current,
      providers: payload.providers ?? current.providers,
      configured: Boolean(payload.configured),
      editing: false,
      message: payload.configured
        ? "环境变量仍提供连接，需在启动环境中移除"
        : "本机密钥已移除",
    }));
    onToast?.(`已断开 ${currentDetails.label || currentProvider} 聆听指南`);
  }

  async function updateAlbumCovers() {
    if (coverUpdate.running) return;
    const failedIds = new Set(getFailedCoverReleaseIds());
    const priority = releases.filter(
      (release) => !release.coverUrl || failedIds.has(release.id),
    );
    const priorityIds = new Set(priority.map((release) => release.id));
    const remote = releases.filter(
      (release) =>
        !priorityIds.has(release.id) &&
        /^https?:\/\//i.test(String(release.coverUrl ?? "")),
    );
    const targets = [...priority, ...remote];
    if (!targets.length) {
      const message = "没有发现空缺、加载失败或尚未本地缓存的封面";
      setCoverUpdate((current) => ({ ...current, message }));
      onToast?.(message);
      return;
    }

    setCoverUpdate({
      running: true,
      processed: 0,
      total: targets.length,
      updated: 0,
      unresolved: 0,
      message: priority.length
        ? `优先处理 ${priority.length} 张空缺或加载失败的封面`
        : "正在缓存仍引用远程地址的封面",
    });

    let processed = 0;
    let updated = 0;
    let unresolved = 0;
    try {
      for (
        let offset = 0;
        offset < targets.length;
        offset += COVER_UPDATE_BATCH_SIZE
      ) {
        const batch = targets.slice(offset, offset + COVER_UPDATE_BATCH_SIZE);
        const response = await fetch("/api/local-enrich-covers", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            releases: batch.map((release) =>
              coverLookupRecord(release, failedIds.has(release.id)),
            ),
            cacheLocal: true,
            wait: true,
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
        onApplyCoverUpdates?.(updates);
        clearCoverLoadFailures(updates.map((update) => update.id));
        processed += batch.length;
        const originals = new Map(
          batch.map((release) => [release.id, release.coverUrl ?? ""]),
        );
        updated += updates.filter(
          (update) =>
            update.coverUrl && update.coverUrl !== originals.get(update.id),
        ).length;
        unresolved += result.unresolved ?? 0;
        setCoverUpdate({
          running: true,
          processed,
          total: targets.length,
          updated,
          unresolved,
          message: `已检查 ${processed} / ${targets.length} 张`,
        });
      }
      const message = `封面更新完成：更新 ${updated} 张${
        unresolved ? `，${unresolved} 张没有找到可靠图片` : ""
      }`;
      setCoverUpdate((current) => ({
        ...current,
        running: false,
        message,
      }));
      onToast?.(message);
    } catch (error) {
      const message = error.message || "封面更新失败，请稍后再试";
      setCoverUpdate((current) => ({
        ...current,
        running: false,
        message,
      }));
      onToast?.(message);
    }
  }

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">整理你的资料库</span>
          <h2 id="settings-title">设置</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">关闭</span>
        </button>
      </header>

      <div className="settings-section">
        <p className="settings-section-label">资料管理</p>
        <button
          type="button"
          className="settings-entry"
          onClick={onOpenArtistManager}
        >
          <span className="settings-entry-icon">
            <UsersThree weight="fill" aria-hidden="true" />
          </span>
          <span>
            <strong>艺人管理</strong>
            <small>
              统一别名与人物 ID · {identityState.identities.length} 位艺人 /{" "}
              {aliasCount} 个名字
            </small>
          </span>
          <span className="settings-entry-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <button
          type="button"
          className="settings-entry"
          onClick={onOpenDuplicateManager}
        >
          <span className="settings-entry-icon">
            <Copy weight="fill" aria-hidden="true" />
          </span>
          <span>
            <strong>疑似重复条目</strong>
            <small>
              按相同 NeoDB 地址人工确认保留与删除
              {duplicateGroupCount
                ? ` · ${duplicateGroupCount} 组 / ${duplicateReleaseCount} 条`
                : " · 当前没有待处理条目"}
            </small>
          </span>
          <span className="settings-entry-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <button
          type="button"
          className="settings-entry"
          onClick={updateAlbumCovers}
          disabled={coverUpdate.running}
        >
          <span className="settings-entry-icon">
            {coverUpdate.running ? (
              <SpinnerGap className="spin" aria-hidden="true" />
            ) : (
              <ImageSquare weight="fill" aria-hidden="true" />
            )}
          </span>
          <span>
            <strong>更新专辑封面图</strong>
            <small>
              {coverUpdate.message ||
                "优先修复空缺与加载失败封面，再缓存精确平台图片"}
            </small>
          </span>
          {!coverUpdate.running ? (
            <span className="settings-entry-arrow" aria-hidden="true">
              →
            </span>
          ) : null}
        </button>
      </div>

      <div className="settings-section">
        <p className="settings-section-label">AI 服务</p>
        <button
          type="button"
          className="settings-entry"
          onClick={() =>
            setGuideProvider((current) => ({ ...current, editing: !current.editing }))
          }
        >
          <span className="settings-entry-icon">
            <Key weight="fill" aria-hidden="true" />
          </span>
          <span>
            <strong>备用 AI 接口</strong>
            <small>
              {guideProvider.loading
                ? "正在读取本机配置"
                : guideProvider.configured
                  ? `刷新默认使用本机 Codex · 已保留 ${guideProvider.providers[guideProvider.activeProvider]?.label || guideProvider.activeProvider} 备用配置`
                  : "刷新默认使用本机 Codex；可在此保留 OpenAI 或 Gemini 备用配置"}
            </small>
          </span>
          <span className="settings-entry-arrow" aria-hidden="true">→</span>
        </button>
        {guideProvider.editing ? (
          <div className="settings-provider-form">
            <label htmlFor="recordshelf-ai-provider">模型提供商</label>
            <select
              id="recordshelf-ai-provider"
              value={guideProvider.activeProvider}
              onChange={(event) => selectGuideProvider(event.target.value)}
            >
              <option value="OPENAI">OpenAI</option>
              <option value="GEMINI">Google Gemini</option>
            </select>
            <label htmlFor="recordshelf-provider-model">模型名称</label>
            <input
              id="recordshelf-provider-model"
              type="text"
              autoComplete="off"
              value={providerModelDraft}
              placeholder={
                guideProvider.activeProvider === "GEMINI"
                  ? "gemini-3.6-flash"
                  : "gpt-5.6-terra"
              }
              onChange={(event) => setProviderModelDraft(event.target.value)}
            />
            <label htmlFor="recordshelf-provider-key">
              {guideProvider.providers[guideProvider.activeProvider]?.label || "AI"} API Key
            </label>
            <input
              id="recordshelf-provider-key"
              type="password"
              autoComplete="new-password"
              value={providerKeyDraft}
              placeholder={
                guideProvider.providers[guideProvider.activeProvider]?.configured
                  ? "留空则继续使用本机已保存的密钥"
                  : guideProvider.activeProvider === "GEMINI"
                    ? "输入 Gemini API Key"
                    : "sk-…"
              }
              onChange={(event) => setProviderKeyDraft(event.target.value)}
            />
            <p>
              密钥分别保存在这台 Mac 的私人目录，页面不会读回明文；不进入音乐数据库、备份、日志、安装包或 Git。为防止密钥被转发，暂不支持任意自定义接口地址。
              详情页刷新不会自动调用这里的 API。
            </p>
            {guideProvider.message ? <small>{guideProvider.message}</small> : null}
            <div>
              {guideProvider.providers[guideProvider.activeProvider]?.configured ? (
                <button type="button" className="secondary-button" onClick={removeGuideProvider}>
                  断开
                </button>
              ) : null}
              <button
                type="button"
                className="primary-button"
                disabled={
                  guideProvider.saving ||
                  !providerModelDraft.trim() ||
                  (!providerKeyDraft.trim() &&
                    !guideProvider.providers[guideProvider.activeProvider]?.configured)
                }
                onClick={saveGuideProvider}
              >
                {guideProvider.saving ? "正在保存" : "保存并连接"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-section">
        <p className="settings-section-label">数据</p>
        <button
          type="button"
          className="settings-entry"
          onClick={onOpenSync}
        >
          <span className="settings-entry-icon">
            <ArrowsClockwise weight="fill" aria-hidden="true" />
          </span>
          <span>
            <strong>NeoDB 同步</strong>
            <small>同步新增与变化、完整校对及待移除复核</small>
          </span>
          <span className="settings-entry-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <button type="button" className="settings-entry" onClick={onExport}>
          <span className="settings-entry-icon">
            <DownloadSimple aria-hidden="true" />
          </span>
          <span>
            <strong>备份音乐库</strong>
            <small>下载完整 JSON，包含唱片、收听记录、评论与平台链接</small>
          </span>
          <span className="settings-entry-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <button
          type="button"
          className="settings-entry"
          onClick={() => mergeBackupInputRef.current?.click()}
        >
          <span className="settings-entry-icon">
            <UploadSimple aria-hidden="true" />
          </span>
          <span>
            <strong>导入音乐库备份</strong>
            <small>从 RecordShelf JSON 备份增量合并，不覆盖现有资料</small>
          </span>
          <span className="settings-entry-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <input
          ref={mergeBackupInputRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try {
              onMergeBackup(JSON.parse(await file.text()), file.name);
            } catch (error) {
              onToast?.(error.message || "JSON 备份无法读取");
            }
          }}
        />
        <textarea
          hidden
          readOnly
          data-testid="library-json-export"
          value={backupText}
        />
      </div>

      <div className="settings-reset-zone">
        <p>高级操作 · 清除 Web 与 Mac 共用的本地修改与同步状态</p>
        <button
          type="button"
          className="settings-reset-button"
          onClick={onRestore}
        >
          恢复出厂设置
        </button>
      </div>
    </>
  );
}
