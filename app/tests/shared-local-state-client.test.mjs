import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuthoritativeSharedStateWriter,
  reconcileSharedStateResponse,
} from "../src/lib/sharedLocalState.js";

test("only 4173 Web and the Mac shell may write shared state", () => {
  assert.equal(
    isAuthoritativeSharedStateWriter({
      hostname: "127.0.0.1",
      port: "4173",
      userAgent: "Mozilla/5.0",
    }),
    true,
  );
  assert.equal(
    isAuthoritativeSharedStateWriter({
      hostname: "localhost",
      port: "4173",
      userAgent: "Mozilla/5.0",
    }),
    true,
  );
  assert.equal(
    isAuthoritativeSharedStateWriter({
      hostname: "127.0.0.1",
      port: "5173",
      userAgent: "Mozilla/5.0",
    }),
    false,
  );
  assert.equal(
    isAuthoritativeSharedStateWriter({
      hostname: "127.0.0.1",
      port: "4187",
      userAgent: "Mozilla/5.0",
    }),
    false,
  );
  assert.equal(
    isAuthoritativeSharedStateWriter({
      hostname: "127.0.0.1",
      port: "4173",
      userAgent: "RecordShelf Electron/39.0",
    }),
    true,
  );
});

test("an older response never overwrites edits made while its request was in flight", () => {
  const userStateKey = "recordshelf-user-state-v2";
  const syncStateKey = "recordshelf-neodb-sync-v1";
  const previousUserState = JSON.stringify({
    userReleases: [],
  });
  const nextUserState = JSON.stringify({
    userReleases: [{ id: "release-new-from-neodb", title: "拆" }],
  });
  const nextSyncState = JSON.stringify({
    lastSyncedAt: "2026-07-28T16:23:18.772Z",
  });
  const requestStorage = {
    [userStateKey]: previousUserState,
    [syncStateKey]: nextSyncState,
  };
  const currentStorage = {
    [userStateKey]: nextUserState,
    [syncStateKey]: nextSyncState,
  };
  const authoritativeStorage = {
    [userStateKey]: previousUserState,
    [syncStateKey]: nextSyncState,
  };

  const result = reconcileSharedStateResponse(
    requestStorage,
    currentStorage,
    authoritativeStorage,
  );

  assert.equal(result.storage[userStateKey], nextUserState);
  assert.equal(result.storage[syncStateKey], nextSyncState);
  assert.equal(result.appliedRemoteChanges, false);
  assert.equal(result.hasPendingChanges, true);
});

test("the queued follow-up reaches a clean authoritative state", () => {
  const userStateKey = "recordshelf-user-state-v2";
  const syncStateKey = "recordshelf-neodb-sync-v1";
  const userState = JSON.stringify({
    userReleases: [{ id: "release-new-from-neodb", title: "拆" }],
  });
  const syncState = JSON.stringify({
    lastSyncedAt: "2026-07-28T16:23:18.772Z",
  });
  const storage = {
    [userStateKey]: userState,
    [syncStateKey]: syncState,
  };

  const result = reconcileSharedStateResponse(
    storage,
    storage,
    storage,
  );

  assert.deepEqual(result.storage, storage);
  assert.equal(result.appliedRemoteChanges, false);
  assert.equal(result.hasPendingChanges, false);
});
