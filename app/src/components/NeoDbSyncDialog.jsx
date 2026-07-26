import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  SignIn,
  SignOut,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  advanceNeoDbRemovalReview,
  applyNeoDbCanonicalMappings,
  applyNeoDbSyncPlan,
  beginNeoDbLogin,
  buildVerifiedNeoDbRemovalCandidates,
  clearNeoDbAccessToken,
  finishNeoDbLogin,
  getNeoDbAccessToken,
  getNeoDbProfile,
  loadNeoDbSyncState,
  pullNeoDbDelta,
  refreshNeoDbCanonicalIdentity,
  saveNeoDbSyncState,
  verifyChangedReleaseTypes,
} from "../lib/neodbSync.js";
import { findExactNeoDbDuplicateGroups } from "../lib/music.js";

let callbackLoginPromise = null;

function formatSyncTime(value) {
  if (!value) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function changeCount(plan) {
  return plan.additions.length + plan.updates.length;
}

export function NeoDbSyncDialog({
  releases,
  identityReleases,
  onClose,
  onApply,
  onReviewDuplicates,
  onToast,
}) {
  const [token, setToken] = useState(getNeoDbAccessToken);
  const [syncState, setSyncState] = useState(loadNeoDbSyncState);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const [pendingRemovals, setPendingRemovals] = useState(
    () => loadNeoDbSyncState().pendingRemovals ?? [],
  );

  useEffect(() => {
    const safeState = loadNeoDbSyncState();
    setSyncState(safeState);
    setPendingRemovals(safeState.pendingRemovals ?? []);
  }, []);

  const runSync = useCallback(
    async (accessToken, { forceFull = false } = {}) => {
      setPhase("syncing");
      setError("");
      try {
        const currentState = loadNeoDbSyncState();
        const identityPool = [
          ...(identityReleases ?? []),
          ...releases,
        ];
        const knownCanonicalResult = applyNeoDbCanonicalMappings(
          releases,
          {},
          identityPool,
        );
        const reconciledReleases = knownCanonicalResult.releases;
        const result = await pullNeoDbDelta(
          reconciledReleases,
          accessToken,
          currentState,
          {
            forceFull,
            identityReleases: [
              ...(identityReleases ?? []),
              ...reconciledReleases,
            ],
          },
        );
        const safePlan = { ...result.plan, removals: [] };
        let nextReleases = applyNeoDbSyncPlan(
          reconciledReleases,
          safePlan,
        );
        const typeRelevantReleaseIds = [
          ...new Set([
            ...result.plan.additions.map((item) => item.release.id),
            ...result.plan.updates
              .filter((item) => item.typeVerificationRelevant)
              .map((item) => item.releaseId),
          ]),
        ];
        let removals = result.fullReconcile
          ? []
          : currentState.pendingRemovals ?? [];
        const quickState = {
          ...result.nextState,
          pendingRemovals: removals,
          removalEvidenceVersion: 2,
          removalCandidateStreaks:
            currentState.removalCandidateStreaks ?? {},
          canonicalAuditCursor: currentState.canonicalAuditCursor ?? 0,
          typeVerificationCache:
            currentState.typeVerificationCache ?? {},
        };
        if (
          changeCount(result.plan) ||
          knownCanonicalResult.changedReleaseIds.length
        ) {
          onApply(nextReleases);
        }
        saveNeoDbSyncState(quickState);
        setSyncState(quickState);
        setPendingRemovals(removals);
        setLastResult({
          ...result,
          plan: { ...result.plan, removals: [] },
          canonicalResult: null,
          duplicateGroups: [],
          typeVerification: null,
          removalReviewCandidates: [],
          backgroundPending: true,
        });
        setPhase("background");
        onToast(
          changeCount(result.plan)
            ? `NeoDB 变化已写入：新增 ${result.plan.additions.length}，更新 ${result.plan.updates.length}；正在后台核验`
            : "已读取 NeoDB 最新变化；正在后台抽查地址与元数据",
        );

        const canonicalResult = await refreshNeoDbCanonicalIdentity(
          nextReleases,
          [...identityPool, ...nextReleases],
          {
            auditCursor: currentState.canonicalAuditCursor ?? 0,
            forceFull: forceFull || result.fullReconcile,
          },
        );
        nextReleases = canonicalResult.releases;
        let typeVerification = {
          checked: 0,
          matched: 0,
          unresolved: 0,
          conflicts: 0,
          cacheHits: 0,
          queried: 0,
          skippedUserConfirmed: 0,
          nextCache: currentState.typeVerificationCache ?? {},
          error: null,
        };
        if (typeRelevantReleaseIds.length) {
          try {
            typeVerification = await verifyChangedReleaseTypes(
              nextReleases,
              typeRelevantReleaseIds,
              currentState.typeVerificationCache ?? {},
            );
            nextReleases = typeVerification.releases;
          } catch (typeError) {
            typeVerification.error =
              typeError.message || "发行类型校验暂时不可用";
          }
        }
        let removalCandidateStreaks =
          currentState.removalCandidateStreaks ?? {};
        let removalReviewCandidates = [];
        if (result.fullReconcile) {
          const verifiedCandidates =
            buildVerifiedNeoDbRemovalCandidates(
              nextReleases,
              result.remoteSourceIds ?? [],
              [...identityPool, ...nextReleases],
            );
          const removalReview = advanceNeoDbRemovalReview(
            verifiedCandidates,
            currentState.removalCandidateStreaks ?? {},
          );
          removals = removalReview.pendingRemovals;
          removalReviewCandidates = removalReview.reviewCandidates;
          removalCandidateStreaks = removalReview.streaks;
        }
        const duplicateGroups = findExactNeoDbDuplicateGroups(nextReleases);
        if (
          canonicalResult.changedReleaseIds.length ||
          typeVerification.checked
        ) {
          onApply(nextReleases);
        }

        const nextState = {
          ...quickState,
          pendingRemovals: removals,
          removalEvidenceVersion: 2,
          removalCandidateStreaks,
          canonicalAuditCursor: canonicalResult.nextAuditCursor,
          typeVerificationCache:
            typeVerification.nextCache ??
            currentState.typeVerificationCache ??
            {},
        };
        saveNeoDbSyncState(nextState);
        setSyncState(nextState);
        setPendingRemovals(removals);
        setLastResult({
          ...result,
          plan: { ...result.plan, removals },
          canonicalResult,
          duplicateGroups,
          typeVerification,
          removalReviewCandidates,
          backgroundPending: false,
        });
        setPhase("done");

        const changed = changeCount(result.plan);
        const needsTypeReview =
          typeVerification.unresolved + typeVerification.conflicts;
        if (duplicateGroups.length) {
          onToast(
            `NeoDB 已同步；规范地址对照后发现 ${duplicateGroups.length} 组疑似重复，请确认保留项`,
          );
        } else if (needsTypeReview) {
          onToast(
            `NeoDB 已同步；类型已确认 ${typeVerification.matched} 张，${needsTypeReview} 张保持未分类待处理`,
          );
        } else if (typeVerification.error) {
          onToast(
            `NeoDB 数据已同步；${typeVerification.error}`,
          );
        } else if (changed || canonicalResult.changedReleaseIds.length) {
          onToast(
            `后台校验完成：类型复用缓存 ${typeVerification.cacheHits}，联网核验 ${typeVerification.queried}，地址更新 ${canonicalResult.changedReleaseIds.length}`,
          );
        } else if (!removals.length) {
          onToast(
            `已和 NeoDB 对比，没有发现新变化；后台抽查完成`,
          );
        }
      } catch (syncError) {
        if (syncError.code === "NEODB_AUTH") {
          clearNeoDbAccessToken();
          setToken(null);
        }
        setError(syncError.message || "同步没有完成，请稍后再试");
        setPhase("error");
      }
    },
    [identityReleases, onApply, onToast, releases],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return;
    let active = true;
    setPhase("connecting");
    callbackLoginPromise ??= finishNeoDbLogin(code, params.get("state"));
    callbackLoginPromise
      .then(async (accessToken) => {
        if (!active) return;
        setToken(accessToken);
        window.history.replaceState({}, "", "/sync");
        const profile = await getNeoDbProfile(accessToken);
        const nextState = { ...loadNeoDbSyncState(), profile };
        saveNeoDbSyncState(nextState);
        setSyncState(nextState);
        await runSync(accessToken);
      })
      .catch((loginError) => {
        if (!active) return;
        setError(loginError.message || "NeoDB 登录没有完成");
        setPhase("error");
      });
    return () => {
      active = false;
    };
  }, [runSync]);

  async function connect() {
    setPhase("connecting");
    setError("");
    try {
      await beginNeoDbLogin();
    } catch (loginError) {
      setError(loginError.message || "暂时无法打开 NeoDB 登录");
      setPhase("error");
    }
  }

  function disconnect() {
    clearNeoDbAccessToken();
    setToken(null);
    setPhase("idle");
    setLastResult(null);
    onToast("已断开 NeoDB；同步记录仍保留在本机");
  }

  function applyRemovals() {
    const plan = {
      additions: [],
      updates: [],
      removals: pendingRemovals,
      unchanged: [],
    };
    onApply(applyNeoDbSyncPlan(releases, plan, { applyRemovals: true }));
    const currentState = loadNeoDbSyncState();
    const removedIds = new Set(
      pendingRemovals.map((item) => item.sourceItemId),
    );
    const nextState = {
      ...currentState,
      pendingRemovals: [],
      removalCandidateStreaks: Object.fromEntries(
        Object.entries(
          currentState.removalCandidateStreaks ?? {},
        ).filter(([sourceItemId]) => !removedIds.has(sourceItemId)),
      ),
    };
    saveNeoDbSyncState(nextState);
    setSyncState(nextState);
    setPendingRemovals([]);
    onToast(`已移除 ${plan.removals.length} 条不再存在于 NeoDB 的记录`);
  }

  const profile = syncState.profile;
  const busy =
    phase === "connecting" ||
    phase === "syncing" ||
    phase === "background";

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="sync-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">只读取你的收藏</span>
            <h2 id="sync-title">与 NeoDB 同步</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {!token ? (
          <div className="sync-connect">
            <div className="sync-service-mark" aria-hidden="true">
              N
            </div>
            <h3>连接你的 NeoDB 音乐收藏</h3>
            <p>
              登录后会返回当前页面，并自动对比
              <strong>「听过 · 音乐」</strong>
              中的新唱片、评分、短评、长评和专辑资料。
            </p>
            <button
              type="button"
              className="primary-button sync-primary"
              onClick={connect}
              disabled={busy}
            >
              {busy ? (
                <ArrowClockwise className="is-spinning" aria-hidden="true" />
              ) : (
                <SignIn aria-hidden="true" />
              )}
              {busy ? "正在打开 NeoDB…" : "登录 NeoDB 并连接"}
            </button>
            <small>
              只申请读取权限。访问令牌仅保留在本次浏览器会话中。
            </small>
          </div>
        ) : (
          <>
            <div className="sync-account-card">
              {profile?.avatar ? (
                <img src={profile.avatar} alt="" />
              ) : (
                <span aria-hidden="true">
                  {(profile?.display_name || "N").slice(0, 1)}
                </span>
              )}
              <div>
                <strong>{profile?.display_name || "NeoDB 用户"}</strong>
                <small>
                  {profile?.username ? `@${profile.username} · ` : ""}
                  {formatSyncTime(syncState.lastSyncedAt)}
                </small>
              </div>
              <button type="button" onClick={disconnect}>
                <SignOut aria-hidden="true" />
                断开
              </button>
            </div>

            {phase === "syncing" || phase === "connecting" ? (
              <div className="sync-progress" role="status">
                <ArrowClockwise className="is-spinning" aria-hidden="true" />
                <div>
                  <strong>正在对比变化</strong>
                  <span>
                    正在读取收藏变化、核验规范地址与可靠来源中的发行类型…
                  </span>
                </div>
              </div>
            ) : null}

            {phase === "background" ? (
              <div className="sync-progress sync-progress-background" role="status">
                <ArrowClockwise className="is-spinning" aria-hidden="true" />
                <div>
                  <strong>收藏变化已经写入</strong>
                  <span>
                    正在后台抽查旧地址，并只核验类型相关的变化；完成前可以继续查看本轮结果。
                  </span>
                </div>
              </div>
            ) : null}

            {lastResult ? (
              <div className="sync-result" aria-live="polite">
                <div className="sync-result-heading">
                  <CheckCircle weight="fill" aria-hidden="true" />
                  <div>
                    <strong>
                      {lastResult.backgroundPending
                        ? "NeoDB 增量对比完成"
                        : "本轮同步与后台校验完成"}
                    </strong>
                    <span>
                      {lastResult.backgroundPending
                        ? "新增、评分、评论与时间变化已先写入"
                        : lastResult.fullReconcile
                        ? "已完整核对全部记录"
                        : `本轮只读取 ${lastResult.fetchedPages.length} 个增量页面`}
                    </span>
                  </div>
                </div>
                <div className="sync-counts">
                  <div>
                    <strong>{lastResult.plan.additions.length}</strong>
                    <span>新增</span>
                  </div>
                  <div>
                    <strong>{lastResult.plan.updates.length}</strong>
                    <span>更新</span>
                  </div>
                  <div>
                    <strong>{lastResult.plan.removals.length}</strong>
                    <span>移除</span>
                  </div>
                  <div>
                    <strong>{lastResult.plan.unchanged.length}</strong>
                    <span>无变化</span>
                  </div>
                </div>
                {lastResult.typeVerification &&
                !lastResult.backgroundPending ? (
                  <p className="sync-cache-summary">
                    类型校验：缓存复用{" "}
                    {lastResult.typeVerification.cacheHits ?? 0} 张，联网核验{" "}
                    {lastResult.typeVerification.queried ?? 0} 张。
                  </p>
                ) : null}
              </div>
            ) : null}

            {pendingRemovals.length ? (
              <div className="sync-removal-notice">
                <WarningCircle weight="fill" aria-hidden="true" />
                <div>
                  <strong>
                    连续两次完整核对都缺少 {pendingRemovals.length} 条记录
                  </strong>
                  <p>
                    系统已先核验旧地址、合并地址及四种收藏状态，并在两次
                    完整核对中都没有找到。仍不会自动删除；下面的操作只会
                    从本地音乐库移除，不会修改 NeoDB。
                  </p>
                  <details>
                    <summary>查看待移除唱片</summary>
                    <ul>
                      {pendingRemovals.slice(0, 12).map((item) => (
                        <li key={item.sourceItemId}>{item.title}</li>
                      ))}
                      {pendingRemovals.length > 12 ? (
                        <li>以及另外 {pendingRemovals.length - 12} 张</li>
                      ) : null}
                    </ul>
                  </details>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={applyRemovals}
                  >
                    从本地音乐库移除这 {pendingRemovals.length} 条
                  </button>
                </div>
              </div>
            ) : null}

            {lastResult?.removalReviewCandidates?.length ? (
              <div className="sync-removal-review">
                <WarningCircle weight="fill" aria-hidden="true" />
                <div>
                  <strong>
                    {lastResult.removalReviewCandidates.length} 条记录需要再次复核
                  </strong>
                  <p>
                    本轮在 NeoDB 暂时没有找到，但尚未进入可移除清单。只有
                    下一次完整核对在规范地址和全部收藏状态中仍然缺失，才会
                    请你决定是否从本地移除。
                  </p>
                </div>
              </div>
            ) : null}

            {lastResult?.duplicateGroups?.length ? (
              <div className="sync-duplicate-notice">
                <WarningCircle weight="fill" aria-hidden="true" />
                <div>
                  <strong>
                    规范地址对照后发现{" "}
                    {lastResult.duplicateGroups.length} 组疑似重复
                  </strong>
                  <p>
                    NeoDB 的条目可能发生合并或旧地址跳转。系统没有自动删除，
                    请比较每条记录的评分、时间和评论后选择保留项。
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onReviewDuplicates}
                  >
                    前往处理疑似重复条目
                  </button>
                </div>
              </div>
            ) : null}

            {lastResult?.typeVerification &&
            (lastResult.typeVerification.unresolved ||
              lastResult.typeVerification.conflicts ||
              lastResult.typeVerification.error) ? (
              <div className="sync-type-notice">
                <WarningCircle weight="fill" aria-hidden="true" />
                <div>
                  <strong>
                    {lastResult.typeVerification.error
                      ? "本轮类型校验未完成"
                      : `${
                          lastResult.typeVerification.unresolved +
                          lastResult.typeVerification.conflicts
                        } 张唱片需要你确认类型`}
                  </strong>
                  <p>
                    {lastResult.typeVerification.error
                      ? `${lastResult.typeVerification.error}。新增唱片会保持“未分类”，已有人工分类不会被覆盖。`
                      : `可靠来源没有给出明确结果，或不同精确来源存在冲突；这些唱片已保持“未分类”，可在音乐库中快速设为 LP、EP 或 Single。`}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="sync-actions">
              <button
                type="button"
                className="primary-button sync-primary"
                onClick={() => runSync(token)}
                disabled={busy}
              >
                <ArrowClockwise
                  className={busy ? "is-spinning" : ""}
                  aria-hidden="true"
                />
                {busy ? "正在同步…" : "立即同步"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => runSync(token, { forceFull: true })}
                disabled={busy}
              >
                完整核对
              </button>
            </div>
            <p className="sync-footnote">
              NeoDB 增量变化会先写入，旧地址抽查和类型核验随后在后台完成。
              评分、评论或收听时间单独变化不会重查类型；标题、来源类型、
              精确外链和规范地址未变时直接复用上次证据。地址最终相同的记录
              仍进入“疑似重复条目”，不会自动删除或静默合并。
            </p>
          </>
        )}

        {error ? (
          <div className="sync-error" role="alert">
            <WarningCircle weight="fill" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
