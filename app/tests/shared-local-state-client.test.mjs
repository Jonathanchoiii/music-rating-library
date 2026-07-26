import assert from "node:assert/strict";
import test from "node:test";
import { isAuthoritativeSharedStateWriter } from "../src/lib/sharedLocalState.js";

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
