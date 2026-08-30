import {
  loginCookieHeader,
  previewPassword,
  readJsonBody,
  sendJson,
} from "../../remote-preview/auth.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }
  const password = previewPassword();
  if (!password) {
    sendJson(res, 503, { error: "PREVIEW_PASSWORD_REQUIRED" });
    return;
  }
  const body = await readJsonBody(req);
  if (!body || body.password !== password) {
    sendJson(res, 401, { error: "PREVIEW_LOGIN_FAILED" });
    return;
  }
  sendJson(
    res,
    200,
    { ok: true },
    { "set-cookie": loginCookieHeader(password) },
  );
}
