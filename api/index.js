/* =========================================================
   VERCEL SERVERLESS ENTRY
   vercel.json rewrites /api/<path> to /api?path=<path>.
========================================================= */

import { handle } from "../server/router.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.searchParams.get("path");
  return handle(req, res, path ? `/${path.replace(/^\/+/, "")}` : undefined);
}
