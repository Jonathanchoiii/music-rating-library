export const DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY =
  "recordshelf-dismissed-artist-duplicates-v1";

export const SHARED_LOCAL_STORAGE_KEYS = Object.freeze([
  "recordshelf-user-state-v2",
  "recordshelf-user-state-v1",
  "recordshelf-mvp-releases-v5",
  "recordshelf-mvp-releases-v4",
  "recordshelf-mvp-releases-v3",
  "recordshelf-mvp-releases-v2",
  "recordshelf-mvp-releases-v1",
  "recordshelf-artist-identities-v1",
  "recordshelf-artist-identities-backups-v1",
  "recordshelf-library-filters-v1",
  "recordshelf-neodb-sync-v1",
  "recordshelf-neodb-oauth-client-v1",
  DISMISSED_ARTIST_DUPLICATES_STORAGE_KEY,
]);

export const SHARED_LOCAL_STORAGE_KEY_SET = new Set(
  SHARED_LOCAL_STORAGE_KEYS,
);
