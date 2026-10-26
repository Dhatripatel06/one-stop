/* =========================================================
   API CLIENT (customer site)
========================================================= */

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(0, "You appear to be offline. Check your connection and try again.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, data.error || "Something went wrong. Please try again.", data.details);
  }
  return data;
}

let catalogPromise = null;

export function getCatalog() {
  catalogPromise ||= api("/catalog").catch(error => {
    catalogPromise = null;
    throw error;
  });
  return catalogPromise;
}
