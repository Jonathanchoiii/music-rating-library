export const USER_STATE_KEY = "recordshelf-user-state-v2";
export const LEGACY_USER_STATE_KEY = "recordshelf-user-state-v1";
export const LEGACY_FULL_LIBRARY_KEYS = Object.freeze([
  "recordshelf-mvp-releases-v5",
  "recordshelf-mvp-releases-v4",
  "recordshelf-mvp-releases-v3",
  "recordshelf-mvp-releases-v2",
  "recordshelf-mvp-releases-v1",
]);
export const ARTIST_IDENTITY_STORAGE_KEY =
  "recordshelf-artist-identities-v1";
export const ARTIST_IDENTITY_BACKUP_STORAGE_KEY =
  "recordshelf-artist-identities-backups-v1";
export const LIBRARY_FILTER_STORAGE_KEY = "recordshelf-library-filters-v1";
export const NEODB_SYNC_STATE_KEY = "recordshelf-neodb-sync-v1";
export const NEODB_OAUTH_CLIENT_KEY = "recordshelf-neodb-oauth-client-v1";
export const DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY =
  "recordshelf-dismissed-artist-duplicates-v1";
export const ARTIST_PROFILE_STORAGE_KEY = "recordshelf-artist-profiles-v1";

export const SHARED_LOCAL_STORAGE_KEYS = Object.freeze([
  USER_STATE_KEY,
  LEGACY_USER_STATE_KEY,
  ...LEGACY_FULL_LIBRARY_KEYS,
  ARTIST_IDENTITY_STORAGE_KEY,
  ARTIST_IDENTITY_BACKUP_STORAGE_KEY,
  LIBRARY_FILTER_STORAGE_KEY,
  NEODB_SYNC_STATE_KEY,
  NEODB_OAUTH_CLIENT_KEY,
  DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY,
  ARTIST_PROFILE_STORAGE_KEY,
]);

export const SHARED_LOCAL_STORAGE_KEY_SET = new Set(
  SHARED_LOCAL_STORAGE_KEYS,
);
