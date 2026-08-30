import { serveSnapshot } from "../../remote-preview/http.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }
  await serveSnapshot(req, res);
}
