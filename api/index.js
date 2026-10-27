/* =========================================================
   VERCEL SERVERLESS ENTRY
   vercel.json rewrites /api/<path> to /api?path=<path>.

   The router (and firebase-admin with it) is loaded on first request, so a
   module that cannot load on this runtime returns a JSON diagnostic instead
   of crashing every request with FUNCTION_INVOCATION_FAILED.
========================================================= */

let router = null;

export default async function handler(req, res) {
  let handle;
  try {
    router ||= import("../server/router.js");
    ({ handle } = await router);
  } catch (error) {
    router = null;
    console.error("API startup failed:", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({
      error: "The API could not start on this server.",
      code: error?.code || "startup_failed",
      detail: String(error?.message || "").split("\n")[0].replace(/\/var\/task\//g, ""),
      runtime: { node: process.version, requireModule: process.features?.require_module ?? null }
    }));
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const path = url.searchParams.get("path");
  return handle(req, res, path ? `/${path.replace(/^\/+/, "")}` : undefined);
}
