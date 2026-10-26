/* =========================================================
   ADMIN API CLIENT — sends the Firebase ID token with every call.
========================================================= */

let currentUser = null;
let onUnauthorized = () => {};

export function setUser(user) {
  currentUser = user;
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = "GET", body, raw = false } = {}) {
  if (!currentUser) throw new ApiError(401, "Sign in to continue.");
  const token = await currentUser.getIdToken();
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, "Network error. Check your internet connection and try again.");
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthorized();
    throw new ApiError(response.status, data.error || `Request failed (${response.status}).`, data.details);
  }
  return raw ? response : response.json();
}

export const api = {
  get: path => request(path),
  post: (path, body = {}) => request(path, { method: "POST", body }),
  patch: (path, body = {}) => request(path, { method: "PATCH", body }),
  put: (path, body = {}) => request(path, { method: "PUT", body }),
  del: path => request(path, { method: "DELETE" }),
  async blob(path) {
    const response = await request(path, { raw: true });
    return response.blob();
  }
};
