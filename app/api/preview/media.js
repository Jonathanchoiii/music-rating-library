import { serveMedia } from "../../remote-preview/http.mjs";

export default async function handler(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.statusCode = 405;
    res.end();
    return;
  }
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `https://${host}`);
  await serveMedia(req, res, url);
}
