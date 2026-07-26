import { useEffect, useMemo, useRef, useState } from "react";
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
  MusicNotes,
  Plus,
  SquaresFour,
  UploadSimple,
  UsersThree,
  VinylRecord,
  X,
} from "@phosphor-icons/react";
import {
  BrowserRouter,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { seedReleases } from "./data/seed.js";
import {
  getCurrentRating,
  findExactNeoDbDuplicateGroups,
  compareReleaseDates,
  getReleaseContextMatches,
  getLatestListenedAt,
  getNextVisibleLimit,
  findReleaseByReferenceUrl,
  normalizeText,
  reconcileCanonicalCoverOverride,
  reconcileCanonicalExternalLinkOverride,
  reconcileCanonicalTitleOverride,
  releaseMatchesPrimarySearch,
} from "./lib/music.js";
import {
  ArtistGroups,
  ReleaseGrid,
  ReleaseList,
} from "./components/ReleaseViews.jsx";
import { ReleaseDetail } from "./components/ReleaseDetail.jsx";
import { AddReleaseDialog } from "./components/AddReleaseDialog.jsx";
import { ImportDialog } from "./components/ImportDialog.jsx";
import { NeoDbSyncDialog } from "./components/NeoDbSyncDialog.jsx";
import {
  dedupeEquivalentListeningEntries,
  getReleaseMetadataFields,
} from "./lib/neodbSync.js";
import { ContextualSearchResults } from "./components/ContextualSearchResults.jsx";
import { DuplicateManager } from "./components/DuplicateManager.jsx";
import { SettingsDialog } from "./components/SettingsDialog.jsx";
import {
  ActiveFilterChips,
  FilterDrawer,
} from "./components/FilterDrawer.jsx";
import {
  getReleaseArtistTargets,
  groupReleasesByArtistIdentity,
  loadArtistIdentityState,
  releaseMatchesMappedArtistQuery,
  saveArtistIdentityState,
  sortArtistGroups,
} from "./lib/artists.js";
import {
  activeFilterCount,
  loadLibraryFilters,
  releaseMatchesLibraryFilters,
  saveLibraryFilters,
  sanitizeLibraryFilters,
} from "./lib/filters.js";
import {
  mergeArtistIdentityStates,
  mergeReleaseLibraries,
  mergeSelectedReleases,
  validateRecordshelfBackup,
} from "./lib/backupMerge.js";

const USER_STATE_KEY = "recordshelf-user-state-v2";
const LEGACY_USER_STATE_KEY = "recordshelf-user-state-v1";
const LEGACY_FULL_LIBRARY_KEYS = [
  "recordshelf-mvp-releases-v5",
  "recordshelf-mvp-releases-v4",
  "recordshelf-mvp-releases-v3",
  "recordshelf-mvp-releases-v2",
  "recordshelf-mvp-releases-v1",
];
const PAGE_SIZE = 84;
const BASE_RELEASE_BY_ID = new Map(
  seedReleases.map((release) => [release.id, release]),
);
const BASE_ENTRY_IDS_BY_RELEASE = new Map(
  seedReleases.map((release) => [
    release.id,
    new Set(release.listeningEntries.map((entry) => entry.id)),
  ]),
);
const RELEASE_METADATA_FIELDS = getReleaseMetadataFields();

const navItems = [
  { href: "/", label: "音乐库", Icon: VinylRecord },
  { href: "/artists", label: "艺人", Icon: UsersThree },
  { href: "/admin/add", label: "添加", Icon: Plus },
  { href: "/?focus=search", label: "搜索", Icon: MagnifyingGlass },
  { href: "/settings", label: "设置", Icon: GearSix },
];

function deriveUserState(releases, releaseTypeOverrides = {}) {
  const listeningEntryAdditions = {};
  const listeningEntryRemovals = {};
  const releaseMetadataOverrides = {};
  const userReleases = [];
  const currentReleaseIds = new Set(releases.map((release) => release.id));
  const removedReleaseIds = seedReleases
    .filter((release) => !currentReleaseIds.has(release.id))
    .map((release) => release.id);

  for (const release of releases) {
    const baseRelease = BASE_RELEASE_BY_ID.get(release.id);
    if (!baseRelease) {
      userReleases.push(release);
      continue;
    }
    const baseEntryIds = BASE_ENTRY_IDS_BY_RELEASE.get(release.id);
    const additions = release.listeningEntries.filter(
      (entry) => !baseEntryIds.has(entry.id),
    );
    if (additions.length) {
      listeningEntryAdditions[release.id] = additions;
    }
    const currentEntryIds = new Set(
      release.listeningEntries.map((entry) => entry.id),
    );
    const removals = baseRelease.listeningEntries
      .filter((entry) => !currentEntryIds.has(entry.id))
      .map((entry) => entry.id);
    if (removals.length) {
      listeningEntryRemovals[release.id] = removals;
    }
    const metadataPatch = Object.fromEntries(
      RELEASE_METADATA_FIELDS.filter(
        (field) =>
          JSON.stringify(release[field]) !==
          JSON.stringify(baseRelease[field]),
      ).map((field) => [field, release[field]]),
    );
    if (Object.keys(metadataPatch).length) {
      releaseMetadataOverrides[release.id] = metadataPatch;
    }
  }

  return {
    releaseTypeOverrides,
    listeningEntryAdditions,
    listeningEntryRemovals,
    releaseMetadataOverrides,
    removedReleaseIds,
    userReleases,
  };
}

function applyUserState(userState = {}) {
  const releaseTypeOverrides = userState.releaseTypeOverrides ?? {};
  const listeningEntryAdditions = userState.listeningEntryAdditions ?? {};
  const listeningEntryRemovals = userState.listeningEntryRemovals ?? {};
  const releaseMetadataOverrides = userState.releaseMetadataOverrides ?? {};
  const removedReleaseIds = new Set(userState.removedReleaseIds ?? []);
  const baseReleases = seedReleases
    .filter((release) => !removedReleaseIds.has(release.id))
    .map((release) => {
      const removedEntryIds = new Set(
        listeningEntryRemovals[release.id] ?? [],
      );
      const metadataOverride = reconcileCanonicalTitleOverride(
        release,
        reconcileCanonicalCoverOverride(
          release,
          reconcileCanonicalExternalLinkOverride(
            release,
            releaseMetadataOverrides[release.id] ?? {},
          ),
        ),
      );
      return {
        ...release,
        ...metadataOverride,
        releaseType:
          releaseTypeOverrides[release.id] ??
          metadataOverride.releaseType ??
          release.releaseType,
        releaseTypeUserConfirmed:
          metadataOverride.releaseTypeUserConfirmed ??
          (Object.hasOwn(releaseTypeOverrides, release.id)
            ? true
            : release.releaseTypeUserConfirmed ?? false),
        listeningEntries: [
          ...dedupeEquivalentListeningEntries([
            ...release.listeningEntries.filter(
              (entry) => !removedEntryIds.has(entry.id),
            ),
            ...(listeningEntryAdditions[release.id] ?? []),
          ]),
        ],
      };
    });
  return [...(userState.userReleases ?? []), ...baseReleases];
}

function keepExplicitLegacyTypeOverrides(overrides = {}) {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([releaseId, releaseType]) =>
        BASE_RELEASE_BY_ID.has(releaseId) && releaseType !== "OTHER",
    ),
  );
}

function loadInitialLibraryState() {
  try {
    const savedUserState = window.localStorage.getItem(USER_STATE_KEY);
    if (savedUserState) {
      const userState = JSON.parse(savedUserState);
      return { releases: applyUserState(userState), userState };
    }

    const legacyUserStateValue =
      window.localStorage.getItem(LEGACY_USER_STATE_KEY);
    if (legacyUserStateValue) {
      const legacyUserState = JSON.parse(legacyUserStateValue);
      const userState = {
        ...legacyUserState,
        releaseTypeOverrides: keepExplicitLegacyTypeOverrides(
          legacyUserState.releaseTypeOverrides,
        ),
      };
      window.localStorage.setItem(USER_STATE_KEY, JSON.stringify(userState));
      window.localStorage.removeItem(LEGACY_USER_STATE_KEY);
      return { releases: applyUserState(userState), userState };
    }

    for (const legacyKey of LEGACY_FULL_LIBRARY_KEYS) {
      const legacyValue = window.localStorage.getItem(legacyKey);
      if (!legacyValue) continue;
      const legacyReleases = JSON.parse(legacyValue);
      const legacyTypeOverrides = Object.fromEntries(
        legacyReleases
          .filter((release) => {
            const baseRelease = BASE_RELEASE_BY_ID.get(release.id);
            return (
              baseRelease &&
              release.releaseType !== "OTHER" &&
              release.releaseType !== baseRelease.releaseType
            );
          })
          .map((release) => [release.id, release.releaseType]),
      );
      const migratedState = deriveUserState(
        legacyReleases,
        legacyTypeOverrides,
      );
      window.localStorage.setItem(
        USER_STATE_KEY,
        JSON.stringify(migratedState),
      );
      LEGACY_FULL_LIBRARY_KEYS.forEach((key) =>
        window.localStorage.removeItem(key),
      );
      return {
        releases: applyUserState(migratedState),
        userState: migratedState,
      };
    }
    const userState = deriveUserState(seedReleases);
    return { releases: applyUserState(userState), userState };
  } catch {
    const userState = deriveUserState(seedReleases);
    return { releases: applyUserState(userState), userState };
  }
}

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
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState("listened_desc");
  const [artistSort, setArtistSort] = useState("average_desc");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [toast, setToast] = useState("");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [listeningReleaseId, setListeningReleaseId] = useState(null);
  const loadMoreSentinelRef = useRef(null);
  const libraryWorkspaceReturnRef = useRef(null);

  const isArtistRoute = location.pathname === "/artists";
  const isAddRoute = location.pathname === "/admin/add";
  const isImportRoute = location.pathname === "/admin/import";
  const isSyncRoute = location.pathname === "/sync";
  const isSettingsRoute =
    location.pathname === "/settings" ||
    location.pathname === "/settings/artists";
  const isArtistSettingsRoute =
    location.pathname === "/settings/artists";
  const isDuplicateRoute =
    location.pathname === "/settings/duplicates" ||
    location.pathname === "/duplicates";
  const selectedArtistId =
    new URLSearchParams(location.search).get("artist") ?? "";
  const isArtistIndex = isArtistRoute && !selectedArtistId;
  const detailId = location.pathname.startsWith("/releases/")
    ? decodeURIComponent(location.pathname.split("/").pop())
    : null;
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
    const serializedState = JSON.stringify(
      deriveUserState(releases, releaseTypeOverrides),
    );
    try {
      window.localStorage.setItem(USER_STATE_KEY, serializedState);
    } catch (error) {
      try {
        LEGACY_FULL_LIBRARY_KEYS.forEach((key) =>
          window.localStorage.removeItem(key),
        );
        window.localStorage.removeItem(LEGACY_USER_STATE_KEY);
        window.localStorage.setItem(USER_STATE_KEY, serializedState);
      } catch (retryError) {
        console.warn("用户变更暂时无法写入本地存储", retryError ?? error);
      }
    }
  }, [releases, releaseTypeOverrides]);

  useEffect(() => {
    saveArtistIdentityState(artistIdentityState);
  }, [artistIdentityState]);

  useEffect(() => {
    saveLibraryFilters(filters);
  }, [filters]);

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
    const params = new URLSearchParams(location.search);
    params.set("view", view);
    const next = `${location.pathname}?${params.toString()}`;
    window.history.replaceState({}, "", next);
  }, [view, location.pathname, location.search]);

  useEffect(() => {
    if (isArtistRoute && !selectedArtistId && view === "wall") {
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

  const searchResults = useMemo(() => {
    const query = normalizeText(search);
    const filtered = releases.filter((release) =>
      releaseMatchesLibraryFilters(
        release,
        filters,
        artistIdentityState,
      ),
    );
    const sortReleases = (releaseA, releaseB) => {
      if (sort === "rating_desc") {
        return (
          (getCurrentRating(releaseB.listeningEntries) ?? -1) -
          (getCurrentRating(releaseA.listeningEntries) ?? -1)
        );
      }
      if (sort === "title_asc") {
        return releaseA.title.localeCompare(releaseB.title, "zh-CN");
      }
      if (sort === "released_desc") {
        return compareReleaseDates(releaseA, releaseB, "desc");
      }
      if (sort === "released_asc") {
        return compareReleaseDates(releaseA, releaseB, "asc");
      }
      return (
        Date.parse(getLatestListenedAt(releaseB.listeningEntries) ?? 0) -
        Date.parse(getLatestListenedAt(releaseA.listeningEntries) ?? 0)
      );
    };
    if (!query) {
      return {
        primary: [...filtered].sort(sortReleases),
        contextual: [],
      };
    }

    const primary = filtered
      .filter(
        (release) =>
          releaseMatchesPrimarySearch(release, query) ||
          releaseMatchesMappedArtistQuery(
            release,
            query,
            artistIdentityState,
          ),
      )
      .sort(sortReleases);
    const primaryIds = new Set(primary.map((release) => release.id));
    const contextual = filtered
      .filter((release) => !primaryIds.has(release.id))
      .map((release) => ({
        release,
        matches: getReleaseContextMatches(release, query),
      }))
      .filter((result) => result.matches.length)
      .sort((resultA, resultB) =>
        sortReleases(resultA.release, resultB.release),
      );
    return { primary, contextual };
  }, [artistIdentityState, filters, releases, search, sort]);
  const visibleReleases = searchResults.primary;
  const contextualSearchResults = searchResults.contextual;

  const counts = useMemo(
    () =>
      releases.reduce(
        (result, release) => {
          result.ALL += 1;
          result[release.releaseType] = (result[release.releaseType] ?? 0) + 1;
          return result;
        },
        { ALL: 0, LP: 0, EP: 0, SINGLE: 0 },
      ),
    [releases],
  );
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
    () => findExactNeoDbDuplicateGroups(releases),
    [releases],
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
    navigate(
      `/releases/${encodeURIComponent(id)}?view=${view}&from=${from}`,
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
    const baseRelease = BASE_RELEASE_BY_ID.get(releaseId);
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

  const detailReturnTarget = new URLSearchParams(location.search).get("from");
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
          <MusicNotes weight="fill" />
        </Link>
        <nav>
          {navItems.map(({ href, label, Icon }) => {
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
            <p className="eyebrow">你的听歌档案</p>
            <h1>RecordShelf</h1>
            <p>{releases.length} releases</p>
          </div>
          <div className="header-actions">
            <label className="search-field">
              <MagnifyingGlass aria-hidden="true" />
              <span className="sr-only">搜索发行、艺人、流派或评论</span>
              <input
                id="library-search"
                type="search"
                value={search}
                placeholder="搜索唱片、艺人或评论"
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (isDuplicateRoute) {
                    navigate(`/?view=${view}`);
                  } else if (isArtistRoute && selectedArtistId) {
                    const params = new URLSearchParams(location.search);
                    params.delete("artist");
                    navigate(`/artists?${params.toString()}`);
                  }
                }}
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="清除搜索"
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </label>
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
            <Link className="primary-button desktop-add" to="/admin/add">
              <Plus aria-hidden="true" />
              添加唱片
            </Link>
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
            <Link className="import-link" to="/admin/import">
              <UploadSimple aria-hidden="true" />
              导入 CSV
            </Link>
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

        <section className="library-content">
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
                onChangeType={updateReleaseType}
              />
            ) : view === "list" ? (
              <ReleaseList releases={displayedReleases} onOpen={openRelease} />
            ) : (
              <ReleaseGrid
                releases={displayedReleases}
                onOpen={openRelease}
                onChangeType={updateReleaseType}
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
        {navItems.map(({ href, label, Icon }) => {
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
        onClose={() => navigate(`${activeBasePath}?view=${view}`)}
        onAddListening={(releaseId) => setListeningReleaseId(releaseId)}
        onChangeType={updateReleaseType}
        onFindMergeCandidate={findMergeCandidate}
        onMergeRelease={mergeReleaseSelection}
        onOpenArtist={openArtistFromDetail}
      />
      {isAddRoute ? (
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
      {isImportRoute ? (
        <ImportDialog
          releases={releases}
          onClose={() => navigate(`${activeBasePath}?view=${view}`)}
          onCommit={commitImport}
        />
      ) : null}
      {isSyncRoute ? (
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
          onOpenSync={() => navigate(`/sync?view=${view}`)}
          onBack={() => navigate(`/settings?view=${view}`)}
          onClose={() => navigate(`/?view=${view}`)}
          onExport={exportJson}
          backupText={serializedLibraryExport()}
          onMergeBackup={mergeJsonBackup}
          onRestore={() => {
            if (window.confirm("恢复演示数据？当前本地修改会被覆盖。")) {
              setReleases(seedReleases);
              setToast("已恢复演示数据");
              navigate("/");
            }
          }}
          onToast={setToast}
        />
      ) : null}
      <FilterDrawer
        open={showFilters}
        releases={releases}
        filters={filters}
        artistIdentityState={artistIdentityState}
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
