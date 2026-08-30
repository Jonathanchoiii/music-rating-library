import { createHmac, timingSafeEqual } from "node:crypto";
import { AUTH_COOKIE, AUTH_COOKIE_PAYLOAD } from "./paths.mjs";

export function previewPassword() {
  return String(process.env.RECORDSHELF_PREVIEW_PASSWORD ?? "").trim();
}

export function expectedCookieValue(password = previewPassword()) {
  return createHmac("sha256", password)
    .update(AUTH_COOKIE_PAYLOAD)
    .digest("hex");
}

export function readCookie(req, name = AUTH_COOKIE) {
  const header = req?.headers?.cookie ?? req?.headers?.Cookie ?? "";
  const match = String(header)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

export function isPreviewAuthorized(req) {
  const password = previewPassword();
  if (!password) return false;
  const got = readCookie(req);
  const expected = expectedCookieValue(password);
  if (!got || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function loginCookieHeader(password = previewPassword()) {
  const value = expectedCookieValue(password);
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload));
}

export function unauthorized(res, error = "PREVIEW_LOGIN_REQUIRED") {
  sendJson(res, 401, { error });
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}
