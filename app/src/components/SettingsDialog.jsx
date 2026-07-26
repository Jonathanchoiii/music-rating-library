import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  ArrowsClockwise,
  CheckCircle,
  Copy,
  Database,
  DownloadSimple,
  IdentificationCard,
  Plus,
  SpinnerGap,
  Trash,
  UploadSimple,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  applyMusicBrainzArtistAuditResults,
  artistIdentityAuditFingerprint,
  artistIdentityNeedsMusicBrainzAudit,
  createArtistIdentity,
  findArtistNameConflicts,
  findDuplicateArtistMbidGroups,
  getArtistAliasIndex,
  getRawArtistCreditCounts,
  groupReleasesByArtistIdentity,
} from "../lib/artists.js";
import { normalizeText } from "../lib/music.js";

function updatedState(state, updater) {
  return {
    ...state,
    identities: updater(state.identities ?? []),
  };
}

export function SettingsDialog({
  mode = "home",
  releases,
  identityState,
  onChangeIdentityState,
  onOpenArtistManager,
  duplicateGroupCount,
  duplicateReleaseCount,
  onOpenDuplicateManager,
  onOpenSync,
  onBack,
  onClose,
  onExport,
  backupText,
  onMergeBackup,
  onRestore,
  onToast,
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className={`settings-dialog${
          mode === "artists" ? " artist-settings-dialog" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {mode === "artists" ? (
          <ArtistManager
            releases={releases}
            identityState={identityState}
            onChange={onChangeIdentityState}
            onBack={onBack}
            onClose={onClose}
            onToast={onToast}
          />
        ) : (
          <SettingsHome
            identityState={identityState}
            onOpenArtistManager={onOpenArtistManager}
            duplicateGroupCount={duplicateGroupCount}
            duplicateReleaseCount={duplicateReleaseCount}
            onOpenDuplicateManager={onOpenDuplicateManager}
            onOpenSync={onOpenSync}
            onClose={onClose}
            onExport={onExport}
            backupText={backupText}
            onMergeBackup={onMergeBackup}
            onRestore={onRestore}
            onToast={onToast}
          />
        )}
      </section>
    </div>
  );
}

function SettingsHome({
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
}) {
  const mergeBackupInputRef = useRef(null);
  const aliasCount = (identityState.identities ?? []).reduce(
    (sum, identity) => sum + identity.aliases.length,
    0,
  );
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
        <div className="settings-entry is-coming">
          <span className="settings-entry-icon">
            <IdentificationCard aria-hidden="true" />
          </span>
          <span>
            <strong>外部 ID 与字段</strong>
            <small>以后可在这里维护唱片、厂牌与其他资料字段</small>
          </span>
          <span className="settings-coming-label">后续</span>
        </div>
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
            <strong>导出完整 JSON</strong>
            <small>包含唱片、每次收听、评论与平台链接</small>
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
            <strong>合并 JSON 备份</strong>
            <small>只增量合并新增或不同内容，不会清空现有资料</small>
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

      <div className="settings-danger-zone">
        <p>当前为本地 MVP，资料保存在这个浏览器中。</p>
        <button type="button" className="danger-button" onClick={onRestore}>
          恢复演示数据
        </button>
      </div>
    </>
  );
}

function ArtistManager({
  releases,
  identityState,
  onChange,
  onBack,
  onClose,
  onToast,
}) {
  const [selectedId, setSelectedId] = useState(
    identityState.identities[0]?.id ?? "",
  );
  const [newArtistName, setNewArtistName] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [creditSearch, setCreditSearch] = useState("");
  const [canonicalNameDraft, setCanonicalNameDraft] = useState("");
  const [scriptReady, setScriptReady] = useState(false);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditProgress, setAuditProgress] = useState({ done: 0, total: 0 });
  const [auditSummary, setAuditSummary] = useState("");
  const scriptReconciledRef = useRef(false);
  const automaticAuditStartedRef = useRef(false);

  const groups = useMemo(
    () => groupReleasesByArtistIdentity(releases, identityState),
    [identityState, releases],
  );
  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const aliasIndex = useMemo(
    () => getArtistAliasIndex(identityState),
    [identityState],
  );
  const rawCredits = useMemo(
    () => getRawArtistCreditCounts(releases),
    [releases],
  );
  const unmappedCredits = useMemo(
    () =>
      rawCredits.filter(
        (credit) => !aliasIndex.has(normalizeText(credit.name)),
      ),
    [aliasIndex, rawCredits],
  );
  const selectedIdentity =
    identityState.identities.find((identity) => identity.id === selectedId) ??
    identityState.identities[0] ??
    null;
  const selectedGroup = selectedIdentity
    ? groupById.get(selectedIdentity.id)
    : null;
  const filteredCredits = unmappedCredits
    .filter((credit) =>
      normalizeText(credit.name).includes(normalizeText(creditSearch)),
    )
    .slice(0, 12);
  const duplicateMbidGroups = useMemo(
    () => findDuplicateArtistMbidGroups(identityState),
    [identityState],
  );
  const persistedAuditStats = useMemo(() => {
    const checked = identityState.identities.filter(
      (identity) => identity.musicBrainzStatus,
    );
    return {
      checked: checked.length,
      confirmed: checked.filter((identity) =>
        ["MATCHED", "VALID"].includes(identity.musicBrainzStatus),
      ).length,
      review: checked.filter((identity) =>
        ["AMBIGUOUS", "NEEDS_REVIEW"].includes(
          identity.musicBrainzStatus,
        ),
      ).length,
    };
  }, [identityState]);

  useEffect(() => {
    if (
      selectedId &&
      identityState.identities.some((identity) => identity.id === selectedId)
    ) {
      return;
    }
    setSelectedId(identityState.identities[0]?.id ?? "");
  }, [identityState.identities, selectedId]);

  useEffect(() => {
    setCanonicalNameDraft(selectedIdentity?.canonicalName ?? "");
  }, [selectedIdentity?.canonicalName, selectedIdentity?.id]);

  useEffect(() => {
    if (scriptReconciledRef.current) return;
    scriptReconciledRef.current = true;
    let cancelled = false;
    import("../lib/artistChinese.js")
      .then(({ reconcileChineseArtistVariants }) => {
        if (cancelled) return;
        const reconciliation = reconcileChineseArtistVariants(
          releases,
          identityState,
        );
        if (reconciliation.created || reconciliation.aliasesAdded) {
          onChange((currentState) =>
            reconcileChineseArtistVariants(releases, currentState).state,
          );
          onToast?.(
            `简繁体核对完成：新建 ${reconciliation.created} 位艺人，补充 ${reconciliation.aliasesAdded} 个别名`,
          );
        }
        setScriptReady(true);
      })
      .catch(() => {
        if (!cancelled) setScriptReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [identityState, onChange, onToast, releases]);

  useEffect(() => {
    if (
      !scriptReady ||
      automaticAuditStartedRef.current ||
      auditRunning
    ) {
      return;
    }
    automaticAuditStartedRef.current = true;
    runMusicBrainzAudit(false);
  }, [auditRunning, identityState, releases, scriptReady]);

  async function runMusicBrainzAudit(force = false) {
    if (auditRunning) return;
    const { getChineseNameVariants } = await import(
      "../lib/artistChinese.js"
    );
    const currentGroups = groupReleasesByArtistIdentity(
      releases,
      identityState,
    );
    const currentGroupById = new Map(
      currentGroups.map((group) => [group.id, group]),
    );
    const eligible = identityState.identities.filter((identity) => {
      const groupReleases = currentGroupById.get(identity.id)?.releases ?? [];
      return (
        groupReleases.length > 0 &&
        (force ||
          artistIdentityNeedsMusicBrainzAudit(
            identity,
            groupReleases,
          ))
      );
    });
    if (!eligible.length) {
      const confirmed = identityState.identities.filter((identity) =>
        ["MATCHED", "VALID"].includes(identity.musicBrainzStatus),
      ).length;
      setAuditSummary(
        `所有艺人身份都在 30 天核验有效期内 · 已确认 ${confirmed} / ${identityState.identities.length} 位`,
      );
      return;
    }

    setAuditRunning(true);
    setAuditProgress({ done: 0, total: eligible.length });
    setAuditSummary("");
    const allResults = [];
    try {
      for (let offset = 0; offset < eligible.length; offset += 5) {
        const batch = eligible.slice(offset, offset + 5);
        const response = await fetch("/api/metadata/artist-identities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identities: batch.map((identity) => {
              const groupReleases =
                currentGroupById.get(identity.id)?.releases ?? [];
              const aliases = [
                identity.canonicalName,
                ...identity.aliases.flatMap((alias) =>
                  getChineseNameVariants(alias.name).length
                    ? getChineseNameVariants(alias.name)
                    : [alias.name],
                ),
              ];
              return {
                id: identity.id,
                canonicalName: identity.canonicalName,
                aliases,
                musicBrainzMbid: identity.musicBrainzMbid,
                releaseTitles: [
                  ...new Set(
                    groupReleases.flatMap((release) => [
                      release.title,
                      ...(release.titleAliases ?? []),
                    ]),
                  ),
                ],
                fingerprint: artistIdentityAuditFingerprint(
                  identity,
                  groupReleases,
                ),
              };
            }),
          }),
        });
        if (!response.ok) {
          throw new Error(`MusicBrainz 核验失败（${response.status}）`);
        }
        const payload = await response.json();
        const results = payload.results ?? [];
        allResults.push(...results);
        const resultIds = new Set(results.map((result) => result.id));
        onChange((currentState) => {
          const auditedState = applyMusicBrainzArtistAuditResults(
            currentState,
            results,
          );
          return {
            ...auditedState,
            identities: auditedState.identities.map((identity) => {
              if (!resultIds.has(identity.id)) return identity;
              const groupReleases =
                currentGroupById.get(identity.id)?.releases ?? [];
              return {
                ...identity,
                musicBrainzAuditFingerprint:
                  artistIdentityAuditFingerprint(identity, groupReleases),
              };
            }),
          };
        });
        setAuditProgress({
          done: Math.min(offset + batch.length, eligible.length),
          total: eligible.length,
        });
      }
      const matched = allResults.filter((result) =>
        ["MATCHED", "VALID"].includes(result.status),
      ).length;
      const review = allResults.filter((result) =>
        ["AMBIGUOUS", "NEEDS_REVIEW"].includes(result.status),
      ).length;
      setAuditSummary(
        `已核验 ${allResults.length} 位：确认 ${matched} 位，需判断 ${review} 位，其余未找到足够证据`,
      );
    } catch (error) {
      setAuditSummary(error.message || "MusicBrainz 暂时无法核验");
    } finally {
      setAuditRunning(false);
    }
  }

  function updateIdentity(identityId, patch) {
    onChange(
      (currentState) => updatedState(currentState, (identities) =>
        identities.map((identity) =>
          identity.id === identityId
            ? {
                ...identity,
                ...patch,
                aliases:
                  patch.aliases ??
                  (patch.canonicalName &&
                  normalizeText(patch.canonicalName) !==
                    normalizeText(identity.canonicalName)
                    ? [
                        {
                          name: patch.canonicalName,
                          locale: "",
                          type: "PRIMARY",
                          source: "USER",
                        },
                        ...identity.aliases.filter(
                          (alias) =>
                            normalizeText(alias.name) !==
                            normalizeText(identity.canonicalName),
                        ),
                      ]
                    : identity.aliases),
              }
            : identity,
        ),
      ),
    );
  }

  async function artistNameVariants(name) {
    if (!/[\u3400-\u9fff]/u.test(name)) return [name];
    try {
      const { getChineseNameVariants } = await import(
        "../lib/artistChinese.js"
      );
      return getChineseNameVariants(name).length
        ? getChineseNameVariants(name)
        : [name];
    } catch {
      return [name];
    }
  }

  function conflictDescription(conflict) {
    const identity = conflict.identity;
    const externalDetail = identity.musicBrainzMbid
      ? ` · MBID ${identity.musicBrainzMbid}`
      : identity.musicBrainzCandidates?.[0]?.disambiguation
        ? ` · MusicBrainz：${identity.musicBrainzCandidates[0].disambiguation}`
        : "";
    return `• ${identity.canonicalName}${externalDetail}`;
  }

  async function confirmDifferentArtist(
    name,
    excludeIdentityId,
    actionLabel,
  ) {
    const variants = await artistNameVariants(name);
    const conflicts = findArtistNameConflicts(
      identityState,
      variants,
      excludeIdentityId,
    );
    if (!conflicts.length) return true;
    return window.confirm(
      `“${name}”已经与以下艺人身份或识别结果重名：\n${conflicts
        .map(conflictDescription)
        .join(
          "\n",
        )}\n\n如果这是同一个艺人，请取消并编辑已有身份。\n只有确认这是同名但不同艺人时，才点击“确定”继续${actionLabel}。`,
    );
  }

  async function addIdentity() {
    const identity = createArtistIdentity(newArtistName);
    if (!identity) return;
    const canContinue = await confirmDifferentArtist(
      identity.canonicalName,
      "",
      "新建",
    );
    if (!canContinue) {
      const variants = await artistNameVariants(identity.canonicalName);
      const existing = findArtistNameConflicts(identityState, variants)[0]
        ?.identity;
      if (existing) setSelectedId(existing.id);
      onToast?.("已取消新建，请检查已有艺人身份");
      return;
    }
    onChange(
      (currentState) =>
        updatedState(currentState, (identities) => {
          if (
            identities.some((item) => item.id === identity.id)
          ) {
            return identities;
          }
          return [...identities, identity];
        }),
    );
    setSelectedId(identity.id);
    setNewArtistName("");
    onToast?.(`已建立艺人「${identity.canonicalName}」`);
  }

  async function assignAlias(aliasName) {
    const name = String(aliasName).normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!selectedIdentity || !name) return;
    const normalized = normalizeText(name);
    const currentIdentityAlreadyHasName = [
      selectedIdentity.canonicalName,
      ...selectedIdentity.aliases.map((alias) => alias.name),
    ].some((item) => normalizeText(item) === normalized);
    if (currentIdentityAlreadyHasName) {
      onToast?.("这个名字已经在当前艺人下");
      return;
    }
    const canContinue = await confirmDifferentArtist(
      name,
      selectedIdentity.id,
      "添加",
    );
    if (!canContinue) {
      onToast?.("已取消添加，原有艺人映射保持不变");
      return;
    }
    const variants = await artistNameVariants(name);
    const hasOtherOwner = findArtistNameConflicts(
      identityState,
      variants,
      selectedIdentity.id,
    ).length > 0;
    onChange(
      (currentState) => updatedState(currentState, (identities) =>
        identities.map((identity) => {
          if (identity.id !== selectedIdentity.id) return identity;
          const withoutAlias = identity.aliases.filter(
            (alias) => normalizeText(alias.name) !== normalized,
          );
          return {
            ...identity,
            aliases: [
              ...withoutAlias,
              {
                name,
                locale: "",
                type: "CREDIT_VARIANT",
                source: "USER",
              },
            ],
          };
        }),
      ),
    );
    setNewAlias("");
    onToast?.(
      hasOtherOwner
        ? `已确认「${name}」为同名不同艺人；相关署名暂不自动归类`
        : `已把「${name}」归入「${selectedIdentity.canonicalName}」`,
    );
  }

  async function commitCanonicalName() {
    if (!selectedIdentity) return;
    const nextName = canonicalNameDraft
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    if (!nextName) {
      setCanonicalNameDraft(selectedIdentity.canonicalName);
      onToast?.("主显示名不能为空");
      return;
    }
    if (
      normalizeText(nextName) ===
      normalizeText(selectedIdentity.canonicalName)
    ) {
      return;
    }
    const canContinue = await confirmDifferentArtist(
      nextName,
      selectedIdentity.id,
      "修改",
    );
    if (!canContinue) {
      setCanonicalNameDraft(selectedIdentity.canonicalName);
      onToast?.("已取消修改，请检查已有艺人身份");
      return;
    }
    updateIdentity(selectedIdentity.id, {
      canonicalName: nextName,
      sortName: nextName,
    });
  }

  function removeAlias(aliasName) {
    if (!selectedIdentity) return;
    if (
      normalizeText(aliasName) === normalizeText(selectedIdentity.canonicalName)
    ) {
      onToast?.("主显示名不能删除，可以先修改主显示名");
      return;
    }
    updateIdentity(selectedIdentity.id, {
      aliases: selectedIdentity.aliases.filter(
        (alias) => normalizeText(alias.name) !== normalizeText(aliasName),
      ),
    });
  }

  function deleteIdentity() {
    if (!selectedIdentity) return;
    if (
      !window.confirm(
        `删除艺人身份「${selectedIdentity.canonicalName}」？唱片不会被删除，只会恢复按原署名分组。`,
      )
    ) {
      return;
    }
    onChange(
      (currentState) => updatedState(currentState, (identities) =>
        identities.filter((identity) => identity.id !== selectedIdentity.id),
      ),
    );
    onToast?.("已删除艺人映射，唱片原始署名保持不变");
  }

  return (
    <>
      <header>
        <div className="settings-title-with-back">
          <button
            type="button"
            className="icon-button"
            onClick={onBack}
            aria-label="返回设置"
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <div>
            <span className="eyebrow">设置 / 资料管理</span>
            <h2 id="settings-title">艺人管理</h2>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">关闭</span>
        </button>
      </header>

      <p className="artist-manager-intro">
        多种署名可指向同一个艺人身份。艺人页和搜索使用统一身份聚类，
        唱片详情仍展示导入时的原始署名。
      </p>

      <section className="artist-identity-audit">
        <div>
          {auditRunning ? (
            <SpinnerGap className="is-spinning" aria-hidden="true" />
          ) : duplicateMbidGroups.length ? (
            <WarningCircle weight="fill" aria-hidden="true" />
          ) : (
            <CheckCircle weight="fill" aria-hidden="true" />
          )}
          <span>
            <strong>身份核验</strong>
            <small>
              {auditRunning
                ? `正在用作品证据核对 ${auditProgress.done} / ${auditProgress.total} 位艺人`
                : auditSummary ||
                  (persistedAuditStats.checked
                    ? `已保存 ${persistedAuditStats.checked} 位核验结果：确认 ${persistedAuditStats.confirmed} 位，需判断 ${persistedAuditStats.review} 位`
                    : "仅在艺人名称与至少一张作品同时匹配时自动填写 MBID")}
            </small>
          </span>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={auditRunning}
          onClick={() => runMusicBrainzAudit(true)}
        >
          <ArrowsClockwise aria-hidden="true" />
          {auditRunning ? "核验中" : "重新核验全部"}
        </button>
        {auditRunning ? (
          <progress
            value={auditProgress.done}
            max={Math.max(auditProgress.total, 1)}
            aria-label="艺人身份核验进度"
          />
        ) : null}
        {duplicateMbidGroups.length ? (
          <div className="artist-mbid-duplicates" role="alert">
            <strong>发现重复 MusicBrainz ID，未自动合并</strong>
            {duplicateMbidGroups.map((group) => (
              <p key={group.mbid}>
                {group.identities
                  .map((identity) => identity.canonicalName)
                  .join("、")}
                <span>{group.mbid}</span>
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <div className="artist-manager-layout">
        <aside className="artist-identity-list">
          <form
            className="artist-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              addIdentity();
            }}
          >
            <input
              value={newArtistName}
              onChange={(event) => setNewArtistName(event.target.value)}
              placeholder="新建艺人身份"
              aria-label="新艺人的主显示名"
            />
            <button
              type="submit"
              className="icon-button"
              disabled={!newArtistName.trim()}
              aria-label="新建艺人"
            >
              <Plus aria-hidden="true" />
            </button>
          </form>
          <div className="artist-identity-scroll">
            {identityState.identities.map((identity) => {
              const group = groupById.get(identity.id);
              return (
                <button
                  type="button"
                  key={identity.id}
                  className={
                    selectedIdentity?.id === identity.id ? "is-active" : ""
                  }
                  onClick={() => setSelectedId(identity.id)}
                >
                  <span>
                    <strong>{identity.canonicalName}</strong>
                    <small>{identity.aliases.length} 个名字</small>
                  </span>
                  <em>{group?.releases.length ?? 0}</em>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="artist-identity-editor">
          {selectedIdentity ? (
            <>
              <div className="artist-editor-heading">
                <div>
                  <span className="eyebrow">统一身份</span>
                  <h3>{selectedIdentity.canonicalName}</h3>
                  <p>
                    {selectedGroup?.releases.length ?? 0} 张发行 ·{" "}
                    {selectedIdentity.aliases.length} 个名字
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-button artist-delete-button"
                  onClick={deleteIdentity}
                  aria-label="删除这个艺人映射"
                  title="删除映射"
                >
                  <Trash aria-hidden="true" />
                </button>
              </div>

              <div className="artist-fields">
                <label>
                  主显示名
                  <input
                    value={canonicalNameDraft}
                    onChange={(event) =>
                      setCanonicalNameDraft(event.target.value)
                    }
                    onBlur={commitCanonicalName}
                  />
                </label>
                <label>
                  MusicBrainz 艺人 ID（MBID）
                  <span className="field-with-action">
                    <input
                      value={selectedIdentity.musicBrainzMbid ?? ""}
                      onChange={(event) =>
                        updateIdentity(selectedIdentity.id, {
                          musicBrainzMbid: event.target.value.trim(),
                        })
                      }
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    />
                    {/^[0-9a-f-]{36}$/i.test(
                      selectedIdentity.musicBrainzMbid ?? "",
                    ) ? (
                      <a
                        href={`https://musicbrainz.org/artist/${selectedIdentity.musicBrainzMbid}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="在 MusicBrainz 查看"
                        title="在 MusicBrainz 查看"
                      >
                        <ArrowSquareOut aria-hidden="true" />
                      </a>
                    ) : null}
                  </span>
                </label>
                {selectedIdentity.musicBrainzStatus ? (
                  <div
                    className={`artist-mbid-status is-${selectedIdentity.musicBrainzStatus.toLocaleLowerCase()}`}
                  >
                    <strong>
                      {["MATCHED", "VALID"].includes(
                        selectedIdentity.musicBrainzStatus,
                      )
                        ? "已用作品证据确认"
                        : selectedIdentity.musicBrainzStatus === "AMBIGUOUS"
                          ? "存在同名候选，需手动判断"
                          : selectedIdentity.musicBrainzStatus ===
                              "NEEDS_REVIEW"
                            ? "现有 ID 与作品证据不一致"
                            : "没有足够证据，未写入 ID"}
                    </strong>
                    {selectedIdentity.musicBrainzCheckedAt ? (
                      <small>
                        最近核验{" "}
                        {new Date(
                          selectedIdentity.musicBrainzCheckedAt,
                        ).toLocaleString("zh-CN")}
                      </small>
                    ) : null}
                    {(selectedIdentity.musicBrainzCandidates ?? []).map(
                      (candidate) => (
                        <a
                          key={candidate.musicBrainzMbid}
                          href={`https://musicbrainz.org/artist/${candidate.musicBrainzMbid}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {candidate.name}
                          {candidate.disambiguation
                            ? ` · ${candidate.disambiguation}`
                            : ""}
                          <ArrowSquareOut aria-hidden="true" />
                        </a>
                      ),
                    )}
                  </div>
                ) : null}
              </div>

              <section className="artist-alias-section">
                <header>
                  <div>
                    <h4>名字与别名</h4>
                    <p>输入发行中出现过的完整署名，精确映射到此艺人。</p>
                  </div>
                </header>
                <form
                  className="artist-alias-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    assignAlias(newAlias);
                  }}
                >
                  <input
                    value={newAlias}
                    onChange={(event) => setNewAlias(event.target.value)}
                    placeholder="例如：Waa Wei"
                    list="unmapped-artist-credits"
                  />
                  <datalist id="unmapped-artist-credits">
                    {unmappedCredits.slice(0, 100).map((credit) => (
                      <option key={credit.name} value={credit.name} />
                    ))}
                  </datalist>
                  <button
                    type="submit"
                    className="secondary-button"
                    disabled={!newAlias.trim()}
                  >
                    加入
                  </button>
                </form>
                <div className="artist-alias-list">
                  {selectedIdentity.aliases.map((alias) => {
                    const rawCount =
                      rawCredits.find(
                        (credit) =>
                          normalizeText(credit.name) ===
                          normalizeText(alias.name),
                      )?.count ?? 0;
                    const isPrimary =
                      normalizeText(alias.name) ===
                      normalizeText(selectedIdentity.canonicalName);
                    return (
                      <div key={normalizeText(alias.name)}>
                        <span>
                          <strong>{alias.name}</strong>
                          <small>
                            {isPrimary ? "主显示名" : "别名"} ·{" "}
                            {rawCount
                              ? `${rawCount} 张发行使用`
                              : alias.source === "MUSICBRAINZ"
                                ? "来自 MusicBrainz"
                                : "搜索别名"}
                          </small>
                        </span>
                        {!isPrimary ? (
                          <button
                            type="button"
                            onClick={() => removeAlias(alias.name)}
                            aria-label={`移除别名 ${alias.name}`}
                          >
                            <X aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="unmapped-credit-section">
                <header>
                  <div>
                    <h4>待整理的原始署名</h4>
                    <p>点击“归入”即可把该名字映射到当前艺人。</p>
                  </div>
                  <strong>{unmappedCredits.length}</strong>
                </header>
                <input
                  className="unmapped-credit-search"
                  value={creditSearch}
                  onChange={(event) => setCreditSearch(event.target.value)}
                  placeholder="筛选原始署名"
                  aria-label="筛选待整理的原始署名"
                />
                <div className="unmapped-credit-list">
                  {filteredCredits.map((credit) => (
                    <div key={credit.name}>
                      <span>
                        <strong>{credit.name}</strong>
                        <small>{credit.count} 张发行</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => assignAlias(credit.name)}
                      >
                        归入
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="artist-manager-empty">
              <Database aria-hidden="true" />
              <h3>先建立一个艺人身份</h3>
              <p>建立后即可把不同署名归入同一个人物。</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
