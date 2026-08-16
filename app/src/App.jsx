import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  DownloadSimple,
  Funnel,
  GearSix,
  GridFour,
  GridNine,
  ListBullets,
  MagnifyingGlass,
  Plus,
  Rows,
  SquaresFour,
  UploadSimple,
  UsersThree,
  VinylRecord,
} from "@phosphor-icons/react";
import {
  BrowserRouter,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { getSeedReleases, seedReleases } from "./data/seed.js";
import {
  findExactNeoDbDuplicateGroups,
  findReleaseByReferenceUrl,
  getNextVisibleLimit,
  upsertConfirmedExternalLink,
  clearConfirmedExternalLink,
} from "./lib/music.js";
import {
  ArtistGroups,
  ReleaseGrid,
  ReleaseList,
  ReleaseShelf,
} from "./components/ReleaseViews.jsx";
import { ReleaseDetail } from "./components/ReleaseDetail.jsx";
import { AddReleaseDialog } from "./components/AddReleaseDialog.jsx";
import { ImportDialog } from "./components/ImportDialog.jsx";
import { NeoDbSyncDialog } from "./components/NeoDbSyncDialog.jsx";
import {
  NEODB_ACCESS_TOKEN_KEY,
  NEODB_OAUTH_CLIENT_KEY,
  NEODB_OAUTH_PENDING_KEY,
  NEODB_SYNC_STATE_KEY,
  dedupeEquivalentListeningEntries,
} from "./lib/neodbSync.js";
import { ContextualSearchResults } from "./components/ContextualSearchResults.jsx";
import { LibrarySearchField } from "./components/LibrarySearchField.jsx";
import { DuplicateManager } from "./components/DuplicateManager.jsx";
import { SettingsDialog } from "./components/SettingsDialog.jsx";
import {
  ActiveFilterChips,
  FilterDrawer,
} from "./components/FilterDrawer.jsx";
import {
  ARTIST_IDENTITY_BACKUP_STORAGE_KEY,
  ARTIST_IDENTITY_STORAGE_KEY,
  DEFAULT_ARTIST_IDENTITY_STATE,
  getReleaseArtistTargets,
  groupReleasesByArtistIdentity,
  loadArtistIdentityState,
  saveArtistIdentityState,
  sanitizeArtistIdentityState,
  sortArtistGroups,
} from "./lib/artists.js";
import {
  activeFilterCount,
  EMPTY_LIBRARY_FILTERS,
  LIBRARY_FILTER_STORAGE_KEY,
  loadLibraryFilters,
  saveLibraryFilters,
  sanitizeLibraryFilters,
} from "./lib/filters.js";
import {
  mergeArtistIdentityStates,
  mergeReleaseLibraries,
  mergeSelectedReleases,
  validateRecordshelfBackup,
} from "./lib/backupMerge.js";
import {
  DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY,
  LEGACY_FULL_LIBRARY_KEYS,
  LEGACY_USER_STATE_KEY,
  USER_STATE_KEY,
} from "./lib/sharedStorageKeys.js";
import { notifySharedLocalStateChanged } from "./lib/sharedLocalState.js";
import { persistReleaseOverlay } from "./lib/releaseMetadataPersist.js";
import { normalizeAlbumIntroduction } from "./lib/appleMusicEditorial.js";
import {
  getBaseRelease,
  loadInitialLibraryState,
  persistUserState,
} from "./lib/libraryUserState.js";
import {
  countReleaseTypes,
  getLibraryRouteState,
  getLibrarySearchResults,
} from "./lib/librarySearch.js";
import { isReadOnlyMode } from "./lib/readonlyMode.js";
import { getRemotePreviewMeta } from "./lib/remotePreview.js";

const PAGE_SIZE = 84;

const navItems = [
  { href: "/", label: "音乐库", Icon: VinylRecord },
  { href: "/artists", label: "艺人", Icon: UsersThree },
  { href: "/admin/add", label: "添加", Icon: Plus },
  { href: "/?focus=search", label: "搜索", Icon: MagnifyingGlass },
  { href: "/settings", label: "设置", Icon: GearSix },
];

function LibraryApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [initialLibraryState] = useState(loadInitialLibraryState);
  const [releases, setReleases] = useState(initialLibraryState.releases);
  const [artistIdentityState, setArtistIdentityState] = useState(
    loadArtistIdentityState,
  );
  const [releaseTypeOverrides, setReleaseTypeOverrides] = useState(
    initialLibraryState.userState.releaseTypeOverrides ?? {},
  );
  const [view, setView] = useState(
    new URLSearchParams(location.search).get("view") || "grid",
  );
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(loadLibraryFilters);
  const [listeningGuideStatuses, setListeningGuideStatuses] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const readOnly = isReadOnlyMode();
  const previewMeta = getRemotePreviewMeta();
  const [sort, setSort] = useState("listened_desc");
  const [artistSort, setArtistSort] = useState("average_desc");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [toast, setToast] = useState("");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [listeningReleaseId, setListeningReleaseId] = useState(null);
  const [optimisticDetailId, setOptimisticDetailId] = useState(null);
  const loadMoreSentinelRef = useRef(null);
  const libraryWorkspaceReturnRef = useRef(null);
  const skipInitialUserStatePersistRef = useRef(true);

  const refreshListeningGuideStatuses = useCallback(async () => {
    try {
      const response = await fetch("/api/listening-guides/statuses", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = await response.json();
      setListeningGuideStatuses(payload.statuses ?? {});
    } catch {
      // The filter remains usable with an empty local index while the service starts.
    }
  }, []);

  const {
    isArtistRoute,
    isAddRoute,
    isImportRoute,
    isSyncRoute,
    isSettingsRoute,
    isArtistSettingsRoute,
    isDuplicateRoute,
    selectedArtistId,
    isArtistIndex,
    detailId: routeDetailId,
    detailReturnTarget,
  } = getLibraryRouteState(location);
  const detailId = optimisticDetailId ?? routeDetailId;
  const selectedRelease = releases.find((release) => release.id === detailId);
  const selectedReleaseArtistTargets = useMemo(
    () =>
      selectedRelease
        ? getReleaseArtistTargets(
            selectedRelease,
            artistIdentityState,
          )
        : [],
    [artistIdentityState, selectedRelease],
  );
  const listeningRelease = releases.find(
    (release) => release.id === listeningReleaseId,
  );

  useEffect(() => {
    if (skipInitialUserStatePersistRef.current) {
      skipInitialUserStatePersistRef.current = false;
      return;
    }
    if (readOnly) return;
    if (persistUserState(releases, releaseTypeOverrides)) {
      notifySharedLocalStateChanged();
    }
  }, [readOnly, releases, releaseTypeOverrides]);

  useEffect(() => {
    saveArtistIdentityState(artistIdentityState);
  }, [artistIdentityState]);

  useEffect(() => {
    saveLibraryFilters(filters);
  }, [filters]);

  useEffect(() => {
    refreshListeningGuideStatuses();
    const handleGuideChange = (event) => {
      const releaseId = event.detail?.releaseId;
      if (!releaseId) {
        refreshListeningGuideStatuses();
        return;
      }
      setListeningGuideStatuses((current) => ({
        ...current,
        [releaseId]: event.detail?.status ?? "EMPTY",
      }));
    };
    window.addEventListener("recordshelf-listening-guide-changed", handleGuideChange);
    return () =>
      window.removeEventListener(
        "recordshelf-listening-guide-changed",
        handleGuideChange,
      );
  }, [refreshListeningGuideStatuses]);

  useEffect(() => {
    if (showFilters) refreshListeningGuideStatuses();
  }, [refreshListeningGuideStatuses, showFilters]);

  useEffect(() => {
    if (!readOnly) return;
    if (
      isAddRoute ||
      isImportRoute ||
      isSyncRoute ||
      isArtistSettingsRoute ||
      isDuplicateRoute
    ) {
      navigate(`/?view=${view}`, { replace: true });
    }
  }, [
    isAddRoute,
    isArtistSettingsRoute,
    isDuplicateRoute,
    isImportRoute,
    isSyncRoute,
    navigate,
    readOnly,
    view,
  ]);

  useEffect(() => {
    setReleases((current) => {
      let changed = false;
      const next = current.map((release) => {
        const listeningEntries = dedupeEquivalentListeningEntries(
          release.listeningEntries,
        );
        if (listeningEntries.length === release.listeningEntries.length) {
          return release;
        }
        changed = true;
        return { ...release, listeningEntries };
      });
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("focus") === "search") {
      window.setTimeout(
        () => document.querySelector("#library-search")?.focus(),
        0,
      );
    }
  }, [location.search]);

  useEffect(() => {
    setOptimisticDetailId(null);
  }, [routeDetailId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("view") === view) return;
    params.set("view", view);
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      replace: true,
      preventScrollReset: true,
    });
  }, [view, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (
      isArtistRoute &&
      !selectedArtistId &&
      ["wall", "shelf"].includes(view)
    ) {
      setView("grid");
    }
  }, [isArtistRoute, selectedArtistId, view]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const updateScrollTopVisibility = () => {
      setShowScrollTop(window.scrollY > Math.max(560, window.innerHeight * 0.8));
    };
    window.addEventListener("scroll", updateScrollTopVisibility, {
      passive: true,
    });
    updateScrollTopVisibility();
    return () =>
      window.removeEventListener("scroll", updateScrollTopVisibility);
  }, []);

  const searchResults = useMemo(
    () =>
      getLibrarySearchResults({
        releases,
        search,
        filters,
        artistIdentityState,
        listeningGuideStatuses,
        sort,
      }),
    [
      artistIdentityState,
      filters,
      listeningGuideStatuses,
      releases,
      search,
      sort,
    ],
  );
  const visibleReleases = searchResults.primary;
  const contextualSearchResults = searchResults.contextual;

  const counts = useMemo(() => countReleaseTypes(releases), [releases]);
  const displayedReleases = visibleReleases.slice(0, visibleLimit);
  const displayedContextualResults = contextualSearchResults.slice(
    0,
    visibleLimit,
  );
  const artistGroups = useMemo(
    () =>
      isArtistRoute
        ? groupReleasesByArtistIdentity(
            visibleReleases,
            artistIdentityState,
            search,
          )
        : [],
    [
      artistIdentityState,
      isArtistRoute,
      search,
      visibleReleases,
    ],
  );
  const sortedArtistGroups = useMemo(
    () => sortArtistGroups(artistGroups, artistSort),
    [artistGroups, artistSort],
  );
  const displayedArtistGroups = selectedArtistId
    ? artistGroups
    : sortedArtistGroups.slice(0, visibleLimit);
  const duplicateGroups = useMemo(
    () =>
      isSettingsRoute || isDuplicateRoute
        ? findExactNeoDbDuplicateGroups(releases)
        : [],
    [isDuplicateRoute, isSettingsRoute, releases],
  );
  const duplicateReleaseCount = useMemo(
    () =>
      new Set(
        duplicateGroups.flatMap((group) =>
          group.releases.map((release) => release.id),
        ),
      ).size,
    [duplicateGroups],
  );

  useEffect(() => {
    const workspace = libraryWorkspaceReturnRef.current;
    if (!workspace || workspace.pathname !== location.pathname) return undefined;

    setSearch(workspace.search);
    setFilters(workspace.filters);
    setSort(workspace.sort);
    setView(workspace.view);
    setVisibleLimit(workspace.visibleLimit);
    setShowFilters(workspace.showFilters);

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        window.scrollTo({ top: workspace.scrollY, behavior: "auto" });
        libraryWorkspaceReturnRef.current = null;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [location.pathname]);

  useEffect(() => {
    if (
      libraryWorkspaceReturnRef.current?.pathname === location.pathname
    ) {
      return;
    }
    setVisibleLimit(PAGE_SIZE);
  }, [
    search,
    filters,
    sort,
    artistSort,
    isArtistRoute,
    selectedArtistId,
    view,
  ]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (
      !sentinel ||
      ((isArtistRoute
        ? displayedArtistGroups.length >= artistGroups.length
        : displayedReleases.length >= visibleReleases.length) &&
        displayedContextualResults.length >= contextualSearchResults.length)
    ) {
      return undefined;
    }

    if (!("IntersectionObserver" in window)) {
      const loadOnScroll = () => {
        const distanceToBottom =
          document.documentElement.scrollHeight -
          window.scrollY -
          window.innerHeight;
        if (distanceToBottom < 600) {
          setVisibleLimit((current) =>
            getNextVisibleLimit(
              current,
              Math.max(
                isArtistRoute
                  ? artistGroups.length
                  : visibleReleases.length,
                contextualSearchResults.length,
              ),
              PAGE_SIZE,
            ),
          );
        }
      };
      window.addEventListener("scroll", loadOnScroll, { passive: true });
      loadOnScroll();
      return () => window.removeEventListener("scroll", loadOnScroll);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
          setVisibleLimit((current) =>
            getNextVisibleLimit(
              current,
              Math.max(
                isArtistRoute
                  ? artistGroups.length
                  : visibleReleases.length,
                contextualSearchResults.length,
              ),
              PAGE_SIZE,
            ),
          );
      },
      { rootMargin: "520px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    contextualSearchResults.length,
    displayedContextualResults.length,
    displayedArtistGroups.length,
    displayedReleases.length,
    isArtistRoute,
    artistGroups.length,
    visibleReleases.length,
  ]);

  function openRelease(id) {
    const from = isDuplicateRoute
      ? "duplicates"
      : isArtistRoute
        ? "artists"
        : "library";
    setOptimisticDetailId(id);
    navigate(
      `/releases/${encodeURIComponent(id)}?view=${view}&from=${from}`,
      { preventScrollReset: true },
    );
  }

  function selectArtist(artistId) {
    const params = new URLSearchParams(location.search);
    params.set("artist", artistId);
    params.set("view", view);
    navigate(`/artists?${params.toString()}`);
  }

  function clearSelectedArtist() {
    const params = new URLSearchParams(location.search);
    params.delete("artist");
    params.set("view", view);
    navigate(`/artists?${params.toString()}`);
  }

  const applyLibrarySearch = useCallback(
    (nextSearch) => {
      if (nextSearch === search) return;
      setSearch(nextSearch);
      if (isDuplicateRoute) {
        navigate(`/?view=${view}`);
      } else if (isArtistRoute && selectedArtistId) {
        const params = new URLSearchParams(location.search);
        params.delete("artist");
        navigate(`/artists?${params.toString()}`);
      }
    },
    [
      isArtistRoute,
      isDuplicateRoute,
      location.search,
      navigate,
      search,
      selectedArtistId,
      view,
    ],
  );

  const clearLibrarySearch = useCallback(() => {
    setSearch("");
  }, []);

  function openArtistFromDetail(artistId) {
    const from = new URLSearchParams(location.search).get("from");
    if (!from || from === "library") {
      libraryWorkspaceReturnRef.current = {
        pathname: location.pathname,
        url: `${location.pathname}${location.search}`,
        scrollY: window.scrollY,
        search,
        filters,
        sort,
        view,
        visibleLimit,
        showFilters,
      };
    } else {
      libraryWorkspaceReturnRef.current = null;
    }
    setSearch("");
    const params = new URLSearchParams();
    params.set("artist", artistId);
    params.set("view", view);
    navigate(`/artists?${params.toString()}`);
  }

  function saveRelease(release) {
    setReleases((current) => [release, ...current]);
    navigate(`/?view=${view}`);
    setToast(`已添加《${release.title}》`);
  }

  function saveListening(releaseId, entry) {
    setReleases((current) =>
      current.map((release) =>
        release.id === releaseId
          ? {
              ...release,
              listeningEntries: [...release.listeningEntries, entry],
            }
          : release,
      ),
    );
    setListeningReleaseId(null);
    setToast("已保存新的收听记录，过去的评分与评论仍然保留");
  }

  function updateReleaseType(releaseId, releaseType) {
    let updatedTitle = "";
    const baseRelease = getBaseRelease(releaseId);
    setReleases((current) =>
      current.map((release) => {
        if (release.id !== releaseId) return release;
        updatedTitle = release.title;
        return {
          ...release,
          releaseType,
          releaseTypeUserConfirmed: true,
          releaseTypeSource: "USER_CONFIRMED",
          releaseTypeMatchedFrom: [],
          releaseTypeEvidence: [],
          releaseTypeMatchedAt: new Date().toISOString(),
        };
      }),
    );
    if (baseRelease) {
      setReleaseTypeOverrides((current) => {
        const next = { ...current };
        if (releaseType === baseRelease.releaseType) {
          delete next[releaseId];
        } else {
          next[releaseId] = releaseType;
        }
        return next;
      });
    }
    setToast(
      `已将《${updatedTitle}》设为 ${
        releaseType === "OTHER" ? "未分类" : releaseType
      }`,
    );
  }

  function updateReleasePlatformLink(releaseId, provider, url) {
    const providerLabels = {
      NEODB: "NeoDB",
      APPLE_MUSIC: "Apple Music",
      SPOTIFY: "Spotify",
    };
    const currentRelease = releases.find(
      (release) => release.id === releaseId,
    );
    if (!currentRelease) return "未找到发行记录";
    const result = upsertConfirmedExternalLink(
      currentRelease,
      url,
      provider,
    );
    if (result.error) {
      setToast(result.error);
      return result.error;
    }
    setReleases((current) =>
      current.map((release) =>
        release.id === releaseId ? result.release : release,
      ),
    );
    setToast(
      `已为《${currentRelease.title}》保存 ${
        providerLabels[provider] ?? provider
      } 链接`,
    );
    return true;
  }

  function clearReleasePlatformLink(releaseId, provider) {
    const providerLabels = {
      NEODB: "NeoDB",
      APPLE_MUSIC: "Apple Music",
      SPOTIFY: "Spotify",
    };
    const currentRelease = releases.find(
      (release) => release.id === releaseId,
    );
    if (!currentRelease) return "未找到发行记录";
    const result = clearConfirmedExternalLink(currentRelease, provider);
    if (result.error) {
      setToast(result.error);
      return result.error;
    }
    setReleases((current) =>
      current.map((release) =>
        release.id === releaseId ? result.release : release,
      ),
    );
    setToast(
      `已清除《${currentRelease.title}》的 ${
        providerLabels[provider] ?? provider
      } 链接`,
    );
    return true;
  }

  function updateAlbumIntroduction(releaseId, rawText) {
    const text = normalizeAlbumIntroduction(rawText);
    let updatedTitle = "";
    setReleases((current) =>
      current.map((release) => {
        if (release.id !== releaseId) return release;
        updatedTitle = release.title;
        if (!text) {
          const next = { ...release };
          delete next.albumIntroduction;
          return next;
        }
        return { ...release, albumIntroduction: text };
      }),
    );
    persistReleaseOverlay(releaseId, {
      albumIntroduction: text || null,
    });
    setToast(
      text
        ? `已保存《${updatedTitle}》的专辑介绍`
        : `已清除《${updatedTitle}》的专辑介绍`,
    );
  }

  async function copyReleaseId(releaseId, releaseTitle) {
    try {
      await navigator.clipboard.writeText(releaseId);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = releaseId;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      if (!copied) {
        setToast("复制失败，请稍后再试");
        return false;
      }
    }
    setToast(`已复制《${releaseTitle}》的专辑 ID`);
    return true;
  }

  function applyCoverUpdates(updates = []) {
    const updatesById = new Map(
      updates
        .filter(
          (update) =>
            update?.id &&
            (String(update.coverUrl ?? "").startsWith("/private-covers/") ||
              /^https?:\/\//i.test(String(update.coverUrl ?? ""))),
        )
        .map((update) => [update.id, update]),
    );
    if (!updatesById.size) return;
    setReleases((current) =>
      current.map((release) => {
        const update = updatesById.get(release.id);
        if (!update) return release;
        return {
          ...release,
          coverUrl: update.coverUrl,
          coverRemoteUrl: update.coverRemoteUrl ?? release.coverRemoteUrl,
          coverSource: update.coverSource ?? release.coverSource,
          coverMatchedFrom:
            update.coverMatchedFrom ?? release.coverMatchedFrom,
          coverMatchedAt: update.coverMatchedAt ?? release.coverMatchedAt,
        };
      }),
    );
  }

  function applyMotionArtworkUpdates(updates = []) {
    const updatesById = new Map(
      updates
        .filter((update) => update?.id && update.motionArtwork?.checkedAt)
        .map((update) => [update.id, update.motionArtwork]),
    );
    if (!updatesById.size) return;
    setReleases((current) =>
      current.map((release) =>
        updatesById.has(release.id)
          ? { ...release, motionArtwork: updatesById.get(release.id) }
          : release,
      ),
    );
    for (const [releaseId, motionArtwork] of updatesById) {
      persistReleaseOverlay(releaseId, { motionArtwork });
    }
  }

  function applyExternalRatings(releaseId, externalRatings) {
    if (!releaseId || !externalRatings?.checkedAt) return;
    setReleases((current) =>
      current.map((release) =>
        release.id === releaseId
          ? { ...release, externalRatings }
        : release,
      ),
    );
  }

  const applyTracklist = useCallback((releaseId, tracklist) => {
    if (!releaseId || tracklist?.status !== "SUCCESS") return;
    setReleases((current) =>
      current.map((release) =>
        release.id === releaseId ? { ...release, tracklist } : release,
      ),
    );
    persistReleaseOverlay(releaseId, { tracklist });
  }, []);

  function findMergeCandidate(releaseId, inputUrl) {
    return findReleaseByReferenceUrl(
      releases,
      releaseId,
      inputUrl,
      window.location.origin,
    );
  }

  function mergeReleaseSelection({
    currentReleaseId,
    candidateReleaseId,
    keepReleaseId,
  }) {
    const currentRelease = releases.find(
      (release) => release.id === currentReleaseId,
    );
    const candidateRelease = releases.find(
      (release) => release.id === candidateReleaseId,
    );
    if (
      !currentRelease ||
      !candidateRelease ||
      ![currentReleaseId, candidateReleaseId].includes(keepReleaseId)
    ) {
      setToast("合并目标已经变化，请重新查找后再试");
      return;
    }
    const keptRelease =
      keepReleaseId === currentReleaseId ? currentRelease : candidateRelease;
    const removedRelease =
      keepReleaseId === currentReleaseId ? candidateRelease : currentRelease;
    const mergeResult = mergeSelectedReleases(
      keptRelease,
      removedRelease,
    );
    setReleases((library) =>
      library
        .filter((release) => release.id !== mergeResult.removedReleaseId)
        .map((release) =>
          release.id === mergeResult.keptReleaseId
            ? mergeResult.release
            : release,
        ),
    );
    setReleaseTypeOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([releaseId]) => releaseId !== mergeResult.removedReleaseId,
        ),
      ),
    );
    if (mergeResult.keptReleaseId !== currentReleaseId) {
      navigate(
        `/releases/${encodeURIComponent(mergeResult.keptReleaseId)}${
          location.search
        }`,
        { replace: true },
      );
    }
    setToast(
      `已保留《${mergeResult.release.title}》，合并 ${mergeResult.historyAdded} 条独有收听历史并删除另一条发行`,
    );
  }

  function resolveDuplicateGroup(group, keepReleaseId) {
    const removedReleaseIds = new Set(
      group.releases
        .filter((release) => release.id !== keepReleaseId)
        .map((release) => release.id),
    );
    setReleases((current) =>
      current.filter((release) => !removedReleaseIds.has(release.id)),
    );
    setReleaseTypeOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([releaseId]) => !removedReleaseIds.has(releaseId),
        ),
      ),
    );
    const keptRelease = group.releases.find(
      (release) => release.id === keepReleaseId,
    );
    setToast(
      `已保留《${keptRelease.title}》，删除 ${removedReleaseIds.size} 条重复记录`,
    );
  }

  function commitImport({ imported, appendEntries, fileName }) {
    setReleases((current) => {
      const withAppendedEntries = current.map((release) => {
        const additions = appendEntries
          .filter((item) => item.releaseId === release.id)
          .map((item) => item.entry);
        return additions.length
          ? {
              ...release,
              listeningEntries: [...release.listeningEntries, ...additions],
            }
          : release;
      });
      return [...imported, ...withAppendedEntries];
    });
    navigate(`/?view=${view}`);
    setToast(
      `已导入 ${imported.length + appendEntries.length} 条记录 · ${fileName}`,
    );
  }

  function serializedLibraryExport() {
    return JSON.stringify(
      {
        schemaVersion: "recordshelf-v1",
        exportedAt: new Date().toISOString(),
        releases,
        artistIdentityState,
      },
      null,
      2,
    );
  }

  function exportJson() {
    const payload = serializedLibraryExport();
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "recordshelf-export.json";
    link.click();
    URL.revokeObjectURL(url);
    setToast("完整 JSON 已导出");
  }

  function mergeJsonBackup(payload, fileName) {
    const backup = validateRecordshelfBackup(payload);
    const releaseMerge = mergeReleaseLibraries(
      releases,
      backup.releases,
    );
    const artistMerge = mergeArtistIdentityStates(
      artistIdentityState,
      backup.artistIdentityState,
    );
    setReleases(releaseMerge.releases);
    setArtistIdentityState(artistMerge.state);
    setToast(
      `已合并 ${fileName}：新增 ${releaseMerge.releasesAdded} 张发行、${releaseMerge.historyAdded} 条历史、${artistMerge.identitiesAdded} 位艺人；更新 ${releaseMerge.releasesUpdated} 张发行和 ${artistMerge.identitiesUpdated} 位艺人`,
    );
  }

  async function restoreFactorySettings() {
    const acknowledged = window.confirm(
      "恢复出厂设置会清除 Web 与 Mac 共用的手动添加、编辑、删除、重复项取舍、艺人映射、筛选条件、NeoDB 同步状态和本机 AI 模型连接，并恢复初始音乐库。\n\n是否继续？",
    );
    if (!acknowledged) return;
    const finallyConfirmed = window.confirm(
      "最后确认：恢复出厂设置后，本地修改无法撤销。建议先在设置中备份音乐库。\n\n确定恢复出厂设置？",
    );
    if (!finallyConfirmed) return;

    [
      USER_STATE_KEY,
      LEGACY_USER_STATE_KEY,
      ...LEGACY_FULL_LIBRARY_KEYS,
      ARTIST_IDENTITY_STORAGE_KEY,
      ARTIST_IDENTITY_BACKUP_STORAGE_KEY,
      LIBRARY_FILTER_STORAGE_KEY,
      NEODB_SYNC_STATE_KEY,
      NEODB_OAUTH_CLIENT_KEY,
      DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY,
    ].forEach((key) => window.localStorage.removeItem(key));
    notifySharedLocalStateChanged();
    [NEODB_ACCESS_TOKEN_KEY, NEODB_OAUTH_PENDING_KEY].forEach((key) =>
      window.sessionStorage.removeItem(key),
    );
    await fetch("/api/listening-guides/provider", { method: "DELETE" }).catch(
      () => {},
    );

    setReleases(getSeedReleases());
    setArtistIdentityState(
      sanitizeArtistIdentityState(DEFAULT_ARTIST_IDENTITY_STATE),
    );
    setReleaseTypeOverrides({});
    setFilters(sanitizeLibraryFilters(EMPTY_LIBRARY_FILTERS));
    setSearch("");
    setSort("listened_desc");
    setArtistSort("average_desc");
    setView("grid");
    setVisibleLimit(PAGE_SIZE);
    setShowFilters(false);
    setToast("已恢复出厂设置");
    navigate("/?view=grid");
  }

  const activeBasePath = isDuplicateRoute || detailReturnTarget === "duplicates"
    ? "/settings/duplicates"
    : isArtistRoute || detailReturnTarget === "artists"
      ? "/artists"
      : "/";
  function navItemIsActive(href) {
    if (href === "/artists") {
      return isArtistRoute || detailReturnTarget === "artists";
    }
    if (href === "/settings") {
      return (
        isSettingsRoute ||
        isSyncRoute ||
        isDuplicateRoute ||
        detailReturnTarget === "duplicates"
      );
    }
    if (href === "/") {
      return (
        location.pathname === "/" ||
        (location.pathname.startsWith("/releases/") &&
          !["artists", "duplicates"].includes(detailReturnTarget))
      );
    }
    return location.pathname === href;
  }

  function handleNavItemClick(event, href) {
    const workspace = libraryWorkspaceReturnRef.current;
    if (href !== "/" || !isArtistRoute || !workspace) return;
    event.preventDefault();
    navigate(workspace.url);
  }

  return (
    <div className="app-shell">
      <aside className="desktop-sidebar" aria-label="主导航">
        <Link className="brand-mark" to="/" aria-label="RecordShelf 首页">
          <img src="/recordshelf-logo.png" alt="" aria-hidden="true" />
        </Link>
        <nav>
          {(readOnly
            ? navItems.filter((item) => item.href !== "/admin/add")
            : navItems
          ).map(({ href, label, Icon }) => {
            const active = navItemIsActive(href);
            return (
              <Link
                key={label}
                to={href}
                className={active ? "is-active" : ""}
                onClick={(event) => handleNavItemClick(event, href)}
              >
                <Icon weight={active ? "fill" : "regular"} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <button
          type="button"
          className="sidebar-export"
          onClick={exportJson}
        >
          <DownloadSimple aria-hidden="true" />
          <span>导出</span>
        </button>
      </aside>

      <main className="library-main">
        <header className="library-header">
          <div>
            <p className="eyebrow">
              {readOnly ? "只读预览" : "你的听歌档案"}
            </p>
            <h1>RecordShelf</h1>
            <p>
              {releases.length} releases
              {readOnly && previewMeta.updatedAt
                ? ` · 更新于 ${new Date(previewMeta.updatedAt).toLocaleString("zh-CN")}`
                : ""}
            </p>
          </div>
          <div className="header-actions">
            <LibrarySearchField
              appliedQuery={search}
              onApply={applyLibrarySearch}
              onClear={clearLibrarySearch}
            />
            <button
              type="button"
              className={`icon-button filter-button${
                activeFilterCount(filters) ? " is-active" : ""
              }`}
              onClick={() => setShowFilters(true)}
              aria-label="打开筛选"
            >
              <Funnel aria-hidden="true" />
              {activeFilterCount(filters) ? (
                <span className="filter-count-badge" aria-hidden="true">
                  {activeFilterCount(filters)}
                </span>
              ) : null}
            </button>
            {readOnly ? null : (
              <Link className="primary-button desktop-add" to="/admin/add">
                <Plus aria-hidden="true" />
                添加唱片
              </Link>
            )}
          </div>
        </header>

        {!isDuplicateRoute ? (
          <div className="organize-bar">
            <div className="organize-tabs" aria-label="组织方式">
              <Link className={!isArtistRoute ? "is-active" : ""} to="/">
                全部发行
              </Link>
              <Link className={isArtistRoute ? "is-active" : ""} to="/artists">
                按艺人
              </Link>
            </div>
            {readOnly ? null : (
              <Link className="import-link" to="/admin/import">
                <UploadSimple aria-hidden="true" />
                导入 CSV
              </Link>
            )}
          </div>
        ) : null}

        {!isDuplicateRoute ? (
          <ActiveFilterChips
            filters={filters}
            releases={releases}
            artistIdentityState={artistIdentityState}
            onChange={setFilters}
            onOpen={() => setShowFilters(true)}
          />
        ) : null}

        {isDuplicateRoute ? (
          <DuplicateManager
            groups={duplicateGroups}
            onOpen={openRelease}
            onResolve={resolveDuplicateGroup}
            onBack={() => navigate(`/settings?view=${view}`)}
          />
        ) : (
          <>
        <section className="library-toolbar" aria-label="音乐库控件">
          <div className="type-tabs" aria-label="发行类型">
            {[
              ["ALL", "All"],
              ["LP", "LP"],
              ["EP", "EP"],
              ["SINGLE", "Singles"],
              ["OTHER", "未分类"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={
                  (value === "ALL" && filters.releaseTypes.length === 0) ||
                  (filters.releaseTypes.length === 1 &&
                    filters.releaseTypes[0] === value)
                    ? "is-active"
                    : ""
                }
                onClick={() =>
                  setFilters((current) => ({
                    ...current,
                    releaseTypes: value === "ALL" ? [] : [value],
                  }))
                }
              >
                {label} <span>{counts[value] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="toolbar-right">
            <span className="result-count">
              {isArtistIndex
                ? `显示 ${displayedArtistGroups.length} / ${artistGroups.length} 位艺人`
                : `显示 ${Math.min(
                    displayedReleases.length,
                    visibleReleases.length,
                  )} / ${visibleReleases.length} 张发行`}
            </span>
            <label className="sort-select">
              <span className="sr-only">排序</span>
              <select
                value={isArtistIndex ? artistSort : sort}
                onChange={(event) =>
                  isArtistIndex
                    ? setArtistSort(event.target.value)
                    : setSort(event.target.value)
                }
              >
                {isArtistIndex ? (
                  <>
                    <option value="average_desc">平均分（高→低）</option>
                    <option value="name_asc">艺人名称 A–Z</option>
                    <option value="name_desc">艺人名称 Z–A</option>
                  </>
                ) : (
                  <>
                    <option value="listened_desc">最近听过</option>
                    <option value="rating_desc">评分最高</option>
                    <option value="released_desc">发行日期（新→旧）</option>
                    <option value="released_asc">发行日期（旧→新）</option>
                    <option value="title_asc">标题 A–Z</option>
                  </>
                )}
              </select>
              <ArrowDown aria-hidden="true" />
            </label>
            <div className="view-switch" aria-label="视图">
              {(
                isArtistIndex
                  ? [
                      ["grid", GridFour, "宫格"],
                      ["list", ListBullets, "列表"],
                    ]
                  : [
                      ["grid", GridFour, "宫格"],
                      ["list", ListBullets, "列表"],
                      ["wall", GridNine, "唱片墙"],
                      ["shelf", Rows, "唱片架"],
                    ]
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  className={view === value ? "is-active" : ""}
                  onClick={() => setView(value)}
                  aria-label={label}
                  title={label}
                >
                  <Icon weight={view === value ? "fill" : "regular"} />
                </button>
              ))}
            </div>
          </div>
        </section>

        <section
          className={`library-content${view === "shelf" ? " is-shelf-view" : ""}`}
        >
          {search ? (
            <header className="primary-search-heading">
              <div>
                <span className="eyebrow">直接命中</span>
                <h2>{isArtistRoute ? "艺人" : "唱片与艺人"}</h2>
              </div>
              <span>
                {isArtistRoute
                  ? `${artistGroups.length} 位艺人`
                  : `${visibleReleases.length} 张唱片`}
              </span>
            </header>
          ) : null}
          {visibleReleases.length ? (
            isArtistRoute ? (
              <ArtistGroups
                groups={displayedArtistGroups}
                selectedArtistId={selectedArtistId}
                view={view}
                onSelectArtist={selectArtist}
                onClearArtist={clearSelectedArtist}
                onOpen={openRelease}
                onChangeType={readOnly ? undefined : updateReleaseType}
                onCopyReleaseId={copyReleaseId}
              />
            ) : view === "list" ? (
              <ReleaseList
                releases={displayedReleases}
                onOpen={openRelease}
                onCopyReleaseId={copyReleaseId}
              />
            ) : view === "shelf" ? (
              <ReleaseShelf
                releases={displayedReleases}
                onOpen={openRelease}
                onCopyReleaseId={copyReleaseId}
              />
            ) : (
              <ReleaseGrid
                releases={displayedReleases}
                onOpen={openRelease}
                onChangeType={readOnly ? undefined : updateReleaseType}
                onCopyReleaseId={copyReleaseId}
                wall={view === "wall"}
              />
            )
          ) : (
            <div
              className={
                contextualSearchResults.length
                  ? "direct-search-empty"
                  : "empty-state"
              }
            >
              <SquaresFour aria-hidden="true" />
              <h2>
                {contextualSearchResults.length
                  ? "没有标题或艺人直接命中"
                  : "没有找到唱片"}
              </h2>
              <p>
                {contextualSearchResults.length
                  ? "在下方的评论与其他文字中找到了相关内容。"
                  : "试试清除搜索或切换发行类型。"}
              </p>
              {!contextualSearchResults.length ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setSearch("");
                    setFilters(sanitizeLibraryFilters());
                  }}
                >
                  清除筛选
                </button>
              ) : null}
            </div>
          )}
        </section>
        {search ? (
          <ContextualSearchResults
            results={displayedContextualResults}
            query={search}
            onOpen={openRelease}
          />
        ) : null}
        {(isArtistRoute
          ? displayedArtistGroups.length < artistGroups.length
          : displayedReleases.length < visibleReleases.length) ||
        displayedContextualResults.length <
          contextualSearchResults.length ? (
          <div
            className="load-more-wrap"
            ref={loadMoreSentinelRef}
            role="status"
            aria-live="polite"
          >
            <span className="auto-load-status">
              <span className="auto-load-dot" aria-hidden="true" />
              继续向下滚动，自动载入剩余{" "}
              {(isArtistRoute
                ? artistGroups.length - displayedArtistGroups.length
                : visibleReleases.length - displayedReleases.length) +
                contextualSearchResults.length -
                displayedContextualResults.length}{" "}
              {isArtistRoute ? "位艺人" : "条结果"}
            </span>
          </div>
        ) : null}
          </>
        )}
      </main>

      <nav className="mobile-nav" aria-label="移动端导航">
        {(readOnly
          ? navItems.filter((item) => item.href !== "/admin/add")
          : navItems
        ).map(({ href, label, Icon }) => {
          const active = navItemIsActive(href);
          return (
            <Link
              key={label}
              to={href}
              className={active ? "is-active" : ""}
              onClick={(event) => handleNavItemClick(event, href)}
            >
              <Icon weight={active ? "fill" : "regular"} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      {showScrollTop ? (
        <button
          type="button"
          className={`scroll-top-button${toast ? " has-toast" : ""}`}
          aria-label="返回页面顶部"
          title="返回顶部"
          onClick={() =>
            window.scrollTo({
              top: 0,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth",
            })
          }
        >
          <ArrowUp weight="bold" aria-hidden="true" />
        </button>
      ) : null}

      <ReleaseDetail
        release={selectedRelease}
        artistTargets={selectedReleaseArtistTargets}
        onClose={() => {
          setOptimisticDetailId(null);
          navigate(`${activeBasePath}?view=${view}`, {
            preventScrollReset: true,
          });
        }}
        onAddListening={
          readOnly ? undefined : (releaseId) => setListeningReleaseId(releaseId)
        }
        onChangeType={readOnly ? undefined : updateReleaseType}
        onUpdatePlatformLink={readOnly ? undefined : updateReleasePlatformLink}
        onClearPlatformLink={readOnly ? undefined : clearReleasePlatformLink}
        onSaveAlbumIntroduction={readOnly ? undefined : updateAlbumIntroduction}
        onFindMergeCandidate={readOnly ? undefined : findMergeCandidate}
        onMergeRelease={readOnly ? undefined : mergeReleaseSelection}
        onOpenArtist={openArtistFromDetail}
        onApplyMotionArtworkUpdates={applyMotionArtworkUpdates}
        onApplyExternalRatings={readOnly ? undefined : applyExternalRatings}
        onApplyTracklist={readOnly ? undefined : applyTracklist}
        onApplyCoverUpdates={readOnly ? undefined : applyCoverUpdates}
        onToast={setToast}
      />
      {isAddRoute && !readOnly ? (
        <AddReleaseDialog
          onClose={() => navigate(`${activeBasePath}?view=${view}`)}
          onSaveRelease={saveRelease}
        />
      ) : null}
      {listeningRelease ? (
        <AddReleaseDialog
          mode="listening"
          release={listeningRelease}
          onClose={() => setListeningReleaseId(null)}
          onSaveListening={saveListening}
        />
      ) : null}
      {isImportRoute && !readOnly ? (
        <ImportDialog
          releases={releases}
          onClose={() => navigate(`${activeBasePath}?view=${view}`)}
          onCommit={commitImport}
        />
      ) : null}
      {isSyncRoute && !readOnly ? (
        <NeoDbSyncDialog
          releases={releases}
          identityReleases={seedReleases}
          onClose={() => navigate(`/settings?view=${view}`)}
          onApply={setReleases}
          onReviewDuplicates={() =>
            navigate(`/settings/duplicates?view=${view}`)
          }
          onToast={setToast}
        />
      ) : null}
      {isSettingsRoute ? (
        <SettingsDialog
          mode={isArtistSettingsRoute ? "artists" : "home"}
          releases={releases}
          identityState={artistIdentityState}
          onChangeIdentityState={setArtistIdentityState}
          onOpenArtistManager={() =>
            navigate(`/settings/artists?view=${view}`)
          }
          duplicateGroupCount={duplicateGroups.length}
          duplicateReleaseCount={duplicateReleaseCount}
          onOpenDuplicateManager={() =>
            navigate(`/settings/duplicates?view=${view}`)
          }
          onOpenSync={readOnly ? undefined : () => navigate(`/sync?view=${view}`)}
          onBack={() => navigate(`/settings?view=${view}`)}
          onClose={() => navigate(`/?view=${view}`)}
          onExport={exportJson}
          backupText={serializedLibraryExport()}
          onMergeBackup={readOnly ? undefined : mergeJsonBackup}
          onRestore={readOnly ? undefined : restoreFactorySettings}
          onToast={setToast}
          onApplyCoverUpdates={readOnly ? undefined : applyCoverUpdates}
          readOnly={readOnly}
        />
      ) : null}
      <FilterDrawer
        open={showFilters}
        releases={releases}
        filters={filters}
        artistIdentityState={artistIdentityState}
        listeningGuideStatuses={listeningGuideStatuses}
        onApply={(nextFilters) => {
          setFilters(nextFilters);
          setShowFilters(false);
          if (isDuplicateRoute) navigate(`/?view=${view}`);
        }}
        onClose={() => setShowFilters(false)}
      />
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <LibraryApp />
    </BrowserRouter>
  );
}
