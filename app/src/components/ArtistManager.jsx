import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  ArrowsClockwise,
  CheckCircle,
  Copy,
  Database,
  LinkSimple,
  Plus,
  SpinnerGap,
  Trash,
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
  mergeArtistIdentities,
  mergePossibleDuplicateArtists,
  removeResolvedDuplicateArtistCandidates,
  searchArtistCreditAssignments,
} from "../lib/artists.js";
import { normalizeText } from "../lib/music.js";
import { DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY } from "../lib/sharedStorageKeys.js";
import { notifySharedLocalStateChanged } from "../lib/sharedLocalState.js";

function updatedState(state, updater) {
  return {
    ...state,
    identities: updater(state.identities ?? []),
  };
}

function loadDismissedArtistDuplicateKeys() {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(
        DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY,
      ) ?? "[]",
    );
    return new Set(
      Array.isArray(saved)
        ? saved.filter((key) => typeof key === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveDismissedArtistDuplicateKeys(keys) {
  window.localStorage.setItem(
    DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY,
    JSON.stringify([...keys].sort()),
  );
  notifySharedLocalStateChanged();
}


export function ArtistManager({
  releases,
  identityState,
  onChange,
  onMergeProfiles,
  onBack,
  onClose,
  onToast,
}) {
  const [selectedId, setSelectedId] = useState(
    identityState.identities[0]?.id ?? "",
  );
  const [mobilePane, setMobilePane] = useState("list");
  const [newArtistName, setNewArtistName] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [creditSearch, setCreditSearch] = useState("");
  const [canonicalNameDraft, setCanonicalNameDraft] = useState("");
  const [scriptReady, setScriptReady] = useState(false);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditProgress, setAuditProgress] = useState({ done: 0, total: 0 });
  const [auditSummary, setAuditSummary] = useState("");
  const [duplicateScanRunning, setDuplicateScanRunning] = useState(false);
  const [duplicateScanCompleted, setDuplicateScanCompleted] = useState(false);
  const [duplicateCandidates, setDuplicateCandidates] = useState([]);
  const [duplicateSelections, setDuplicateSelections] = useState({});
  const [dismissedDuplicateKeys, setDismissedDuplicateKeys] = useState(
    loadDismissedArtistDuplicateKeys,
  );
  const duplicateListRef = useRef(null);
  const duplicateScrollRestoreRef = useRef(null);
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
  const creditSearchResults = useMemo(
    () =>
      searchArtistCreditAssignments(
        releases,
        identityState,
        creditSearch,
        selectedIdentity?.id ?? "",
        24,
      ),
    [creditSearch, identityState, releases, selectedIdentity?.id],
  );
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

  useLayoutEffect(() => {
    const pending = duplicateScrollRestoreRef.current;
    const list = duplicateListRef.current;
    if (!pending || !list) return;

    if (pending.nextKey) {
      const nextCandidate = [
        ...list.querySelectorAll("[data-duplicate-candidate]"),
      ].find(
        (element) =>
          element.dataset.duplicateCandidate === pending.nextKey,
      );
      if (nextCandidate) {
        const currentOffset =
          nextCandidate.getBoundingClientRect().top -
          list.getBoundingClientRect().top;
        list.scrollTop += currentOffset - pending.anchorOffset;
      } else {
        list.scrollTop = pending.scrollTop;
      }
    } else {
      list.scrollTop = pending.scrollTop;
    }
    duplicateScrollRestoreRef.current = null;
  }, [duplicateCandidates]);

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

  async function runDuplicateArtistScan() {
    if (duplicateScanRunning) return;
    setDuplicateScanRunning(true);
    setDuplicateScanCompleted(false);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const { findPossibleDuplicateArtistGroups } = await import(
        "../lib/artistChinese.js"
      );
      const candidates = findPossibleDuplicateArtistGroups(
        releases,
        identityState,
      ).filter((candidate) => !dismissedDuplicateKeys.has(candidate.key));
      duplicateScrollRestoreRef.current = {
        nextKey: "",
        anchorOffset: 0,
        scrollTop: 0,
      };
      setDuplicateCandidates(candidates);
      setDuplicateSelections({});
      setDuplicateScanCompleted(true);
      onToast?.(
        candidates.length
          ? `发现 ${candidates.length} 组疑似重复艺人，等待你确认`
          : "没有发现新的疑似重复艺人",
      );
    } catch {
      onToast?.("重复艺人扫描暂时无法完成");
    } finally {
      setDuplicateScanRunning(false);
    }
  }

  function dismissDuplicateCandidate(candidateKey) {
    setDismissedDuplicateKeys((current) => {
      const next = new Set(current);
      next.add(candidateKey);
      saveDismissedArtistDuplicateKeys(next);
      return next;
    });
    removeDuplicateCandidatesFromCurrentBatch(
      (candidate) => candidate.key === candidateKey,
      candidateKey,
    );
  }

  function removeDuplicateCandidatesFromCurrentBatch(
    shouldRemove,
    anchorKey,
  ) {
    const nextCandidates = duplicateCandidates.filter(
      (candidate) => !shouldRemove(candidate),
    );
    const anchorIndex = duplicateCandidates.findIndex(
      (candidate) => candidate.key === anchorKey,
    );
    const nextCandidate =
      nextCandidates[
        Math.min(
          Math.max(anchorIndex, 0),
          Math.max(nextCandidates.length - 1, 0),
        )
      ];
    const list = duplicateListRef.current;
    const anchor = list
      ? [...list.querySelectorAll("[data-duplicate-candidate]")].find(
          (element) =>
            element.dataset.duplicateCandidate === anchorKey,
        )
      : null;
    duplicateScrollRestoreRef.current = {
      nextKey: nextCandidate?.key ?? "",
      anchorOffset:
        anchor && list
          ? anchor.getBoundingClientRect().top -
            list.getBoundingClientRect().top
          : 0,
      scrollTop: list?.scrollTop ?? 0,
    };
    setDuplicateCandidates(nextCandidates);
    const remainingKeys = new Set(
      nextCandidates.map((candidate) => candidate.key),
    );
    setDuplicateSelections((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) =>
          remainingKeys.has(key),
        ),
      ),
    );
  }

  function preserveMergedArtistProfiles(
    identityIds,
    selectedIdentityId,
    extraNames = [],
  ) {
    if (!onMergeProfiles) return;
    const wantedIds = new Set(identityIds.filter(Boolean));
    const identityNames = identityState.identities
      .filter((identity) => wantedIds.has(identity.id))
      .flatMap((identity) => [
        identity.canonicalName,
        ...identity.aliases.map((alias) => alias.name),
      ]);
    onMergeProfiles(
      [...wantedIds],
      selectedIdentityId,
      [...new Set([...identityNames, ...extraNames].filter(Boolean))],
    );
  }

  function mergeDuplicateCandidate(candidate) {
    const selectedMemberId = duplicateSelections[candidate.key];
    const selectedMember = candidate.members.find(
      (member) => member.id === selectedMemberId,
    );
    if (!selectedMember) {
      onToast?.("请先选择关联后使用的主艺人名称");
      return;
    }
    if (candidate.hasMbidConflict) {
      onToast?.("这组候选的 MusicBrainz ID 不同，请先人工核对");
      return;
    }
    try {
      const nextState = mergePossibleDuplicateArtists(
        identityState,
        candidate,
        selectedMemberId,
      );
      onChange(nextState);
      preserveMergedArtistProfiles(
        candidate.members
          .flatMap((member) => [member.id, member.identityId])
          .filter(Boolean),
        selectedMemberId,
        candidate.members.flatMap(
          (member) => member.names ?? [member.canonicalName],
        ),
      );
      const remainingCandidates =
        removeResolvedDuplicateArtistCandidates(
          duplicateCandidates,
          candidate,
        );
      const remainingKeys = new Set(
        remainingCandidates.map((item) => item.key),
      );
      removeDuplicateCandidatesFromCurrentBatch(
        (item) => !remainingKeys.has(item.key),
        candidate.key,
      );
      onToast?.(
        `已关联为「${selectedMember.canonicalName}」，可继续处理当前扫描列表`,
      );
    } catch (error) {
      onToast?.(error.message || "暂时无法关联这组艺人");
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
      if (existing) {
        setSelectedId(existing.id);
        setMobilePane("detail");
      }
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
    setMobilePane("detail");
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
    const variants = await artistNameVariants(name);
    const conflicts = findArtistNameConflicts(
      identityState,
      variants,
      selectedIdentity.id,
    );
    const exactOwners = conflicts.filter((conflict) =>
      conflict.matches.some((match) =>
        ["PRIMARY", "ALIAS"].includes(match.source),
      ),
    );
    if (exactOwners.length === 1) {
      const existingIdentity = exactOwners[0].identity;
      if (
        window.confirm(
          `“${name}”目前属于艺人「${existingIdentity.canonicalName}」。\n\n如果两者是同一艺人，点击“确定”会将其关联到「${selectedIdentity.canonicalName}」；唱片、评论、评分和收听记录都不会被删除。\n\n如果只是同名但不同艺人，请点击“取消”。`,
        )
        ) {
        try {
          const nextState = mergeArtistIdentities(
            identityState,
            [selectedIdentity.id, existingIdentity.id],
            selectedIdentity.id,
          );
          onChange(nextState);
          preserveMergedArtistProfiles(
            [selectedIdentity.id, existingIdentity.id],
            selectedIdentity.id,
          );
          setNewAlias("");
          onToast?.(
            `已把「${existingIdentity.canonicalName}」关联到「${selectedIdentity.canonicalName}」`,
          );
        } catch (error) {
          onToast?.(error.message || "暂时无法关联这两个艺人");
        }
      } else {
        onToast?.("已取消关联，原有艺人映射保持不变");
      }
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

  function mergeMappedCredit(result) {
    if (
      !selectedIdentity ||
      !result?.identityId ||
      result.identityId === selectedIdentity.id
    ) {
      return;
    }
    const existingIdentity = identityState.identities.find(
      (identity) => identity.id === result.identityId,
    );
    if (!existingIdentity) {
      onToast?.("这个艺人身份已经变化，请重新搜索");
      return;
    }
    if (
      !window.confirm(
        `署名“${result.name}”目前属于艺人「${existingIdentity.canonicalName}」。\n\n确认两者是同一个艺人，并合并到「${selectedIdentity.canonicalName}」？\n\n主显示名、全部别名、唱片、评分、评论和收听记录都会保留。`,
      )
    ) {
      onToast?.("已取消合并，原有艺人资料保持不变");
      return;
    }
    try {
      const nextState = mergeArtistIdentities(
        identityState,
        [selectedIdentity.id, existingIdentity.id],
        selectedIdentity.id,
      );
      onChange(nextState);
      preserveMergedArtistProfiles(
        [selectedIdentity.id, existingIdentity.id],
        selectedIdentity.id,
      );
      onToast?.(
        `已把「${existingIdentity.canonicalName}」合并到「${selectedIdentity.canonicalName}」`,
      );
    } catch (error) {
      onToast?.(error.message || "暂时无法合并这两个艺人");
    }
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
    setMobilePane("list");
    onToast?.("已删除艺人映射，唱片原始署名保持不变");
  }

  return (
    <>
      <header>
        <div className="settings-title-with-back">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              if (
                mobilePane === "detail" &&
                window.matchMedia("(max-width: 760px)").matches
              ) {
                setMobilePane("list");
                return;
              }
              onBack();
            }}
            aria-label="返回上一级"
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

      <div
        className={`artist-manager-overview${
          mobilePane === "detail" ? " is-mobile-hidden" : ""
        }`}
      >
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

        <section className="artist-duplicate-scan">
        <header>
          <div>
            <span className="artist-duplicate-scan-icon">
              <Copy weight="fill" aria-hidden="true" />
            </span>
            <span>
              <strong>重复艺人扫描</strong>
              <small>
                按完整同名、简繁体、多语言原始署名、外部 ID 与共同作品证据生成候选
              </small>
            </span>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={duplicateScanRunning}
            onClick={runDuplicateArtistScan}
          >
            {duplicateScanRunning ? (
              <SpinnerGap className="is-spinning" aria-hidden="true" />
            ) : (
              <ArrowsClockwise aria-hidden="true" />
            )}
            {duplicateScanRunning
              ? "扫描中"
              : duplicateScanCompleted
                ? "重新扫描"
                : "开始扫描"}
          </button>
        </header>

        {duplicateScanCompleted && !duplicateCandidates.length ? (
          <p className="artist-duplicate-scan-empty">
            当前没有待判断的相似艺人。已确认“不是同一艺人”的候选会被记住，
            不会在下次扫描时重复出现。
          </p>
        ) : null}

        {duplicateCandidates.length ? (
          <div
            className="artist-duplicate-candidates"
            ref={duplicateListRef}
          >
            <p>
              发现 {duplicateCandidates.length} 组候选。跨语言原始署名只作为
              人工核对提示，不会自动合并；没有身份或作品依据的普通字符片段已被排除。
            </p>
            {duplicateCandidates.map((candidate) => (
              <article
                key={candidate.key}
                data-duplicate-candidate={candidate.key}
              >
                <header>
                  <div className="artist-duplicate-evidence">
                    {candidate.evidence.map((evidence) => (
                      <span key={evidence.type}>{evidence.label}</span>
                    ))}
                    {candidate.hasMbidConflict ? (
                      <strong>MusicBrainz ID 冲突，不能快速合并</strong>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissDuplicateCandidate(candidate.key)}
                  >
                    不是同一艺人
                  </button>
                </header>

                <fieldset>
                  <legend>选择关联后的主显示名</legend>
                  {candidate.members.map((member) => {
                    const selected =
                      duplicateSelections[candidate.key] === member.id;
                    const otherNames = member.names
                      .filter(
                        (name) =>
                          normalizeText(name) !==
                          normalizeText(member.canonicalName),
                      )
                      .slice(0, 3);
                    return (
                      <label
                        key={member.id}
                        className={selected ? "is-selected" : ""}
                      >
                        <input
                          type="radio"
                          name={`duplicate-keeper-${candidate.key}`}
                          checked={selected}
                          onChange={() =>
                            setDuplicateSelections((current) => ({
                              ...current,
                              [candidate.key]: member.id,
                            }))
                          }
                        />
                        <span>
                          <strong>{member.canonicalName}</strong>
                          <small>
                            {member.releaseCount} 张发行 ·{" "}
                            {member.mapped ? "已建立身份" : "原始署名"}
                          </small>
                          {otherNames.length ? (
                            <small>已有名字：{otherNames.join("、")}</small>
                          ) : null}
                          {member.musicBrainzMbid ? (
                            <small>MBID：{member.musicBrainzMbid}</small>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>

                <footer>
                  <span>
                    只合并艺人身份；唱片、评论和收听记录不会被删除。
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      !duplicateSelections[candidate.key] ||
                      candidate.hasMbidConflict
                    }
                    onClick={() => mergeDuplicateCandidate(candidate)}
                  >
                    <LinkSimple aria-hidden="true" />
                    关联并合并同类项
                  </button>
                </footer>
              </article>
            ))}
          </div>
        ) : null}
        </section>
      </div>

      <div className={`artist-manager-layout is-mobile-${mobilePane}`}>
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
                  onClick={() => {
                    setSelectedId(identity.id);
                    setMobilePane("detail");
                  }}
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
                    <h4>查找相同艺人</h4>
                    <p>
                      搜索其他署名或艺人；确认是同一人后，合并到
                      「{selectedIdentity.canonicalName}」。
                    </p>
                  </div>
                  <strong>{unmappedCredits.length} 个未归类署名</strong>
                </header>
                <input
                  className="unmapped-credit-search"
                  value={creditSearch}
                  onChange={(event) => setCreditSearch(event.target.value)}
                  placeholder="输入另一个艺人名称"
                  aria-label="搜索原始署名与已归类署名"
                />
                <div className="unmapped-credit-list">
                  {creditSearchResults.map((credit) => (
                    <div key={credit.key}>
                      <span>
                        <strong>{credit.name}</strong>
                        <small>
                          {credit.count ? `${credit.count} 张发行 · ` : ""}
                          {credit.kind === "UNMAPPED"
                            ? "未归类署名"
                            : credit.kind === "CURRENT"
                              ? "当前艺人的主名或别名"
                              : `另一个艺人身份 · 主名称「${credit.ownerName}」`}
                        </small>
                      </span>
                      {credit.kind === "CURRENT" ? (
                        <em>当前艺人</em>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            credit.kind === "MAPPED"
                              ? mergeMappedCredit(credit)
                              : assignAlias(credit.name)
                          }
                        >
                          {credit.kind === "MAPPED"
                            ? "合并到当前艺人"
                            : "归入当前艺人"}
                        </button>
                      )}
                    </div>
                  ))}
                  {!creditSearchResults.length ? (
                    <p className="unmapped-credit-empty">
                      没有找到匹配的署名
                    </p>
                  ) : null}
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
