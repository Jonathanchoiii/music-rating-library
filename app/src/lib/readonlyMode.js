import { isAuthoritativeSharedStateWriter } from "./sharedLocalState.js";

export function envReadOnlyFlag() {
  try {
    return import.meta.env?.VITE_RECORDSHELF_READONLY === "1";
  } catch {
    return false;
  }
}

export function isReadOnlyModeFromLocation({
  hostname,
  port,
  userAgent,
  search = "",
} = {}) {
  const params = new URLSearchParams(
    String(search).startsWith("?") ? String(search).slice(1) : search,
  );
  if (params.get("readonly") === "1") return true;
  if (envReadOnlyFlag()) return true;
  return !isAuthoritativeSharedStateWriter({
    hostname,
    port,
    userAgent,
  });
}

export function isReadOnlyMode() {
  if (typeof window === "undefined") return false;
  return isReadOnlyModeFromLocation({
    hostname: window.location.hostname,
    port: window.location.port,
    userAgent: navigator.userAgent,
    search: window.location.search,
  });
}
