/* =========================================================
   INPUT VALIDATION
   Each helper returns a clean value or records an error in `errors`.
========================================================= */

import { badRequest } from "./http.js";
import { rupeesToPaise, isPaise } from "../shared/pricing.js";

export class Validator {
  constructor(input) {
    this.input = input && typeof input === "object" ? input : {};
    this.errors = {};
  }

  fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return undefined;
  }

  has(field) {
    return Object.prototype.hasOwnProperty.call(this.input, field);
  }

  string(field, { required = false, max = 500, min = 0, pattern, label = field, transform } = {}) {
    const raw = this.input[field];
    let value = raw === null || raw === undefined ? "" : String(raw).trim();
    if (transform) value = transform(value);
    if (!value) {
      if (required) return this.fail(field, `${label} is required.`);
      return "";
    }
    if (value.length > max) return this.fail(field, `${label} must be ${max} characters or fewer.`);
    if (value.length < min) return this.fail(field, `${label} must be at least ${min} characters.`);
    if (pattern && !pattern.test(value)) return this.fail(field, `${label} is not valid.`);
    return value;
  }

  int(field, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER, label = field, nullable = false } = {}) {
    const raw = this.input[field];
    if (raw === null || raw === undefined || raw === "") {
      if (required) return this.fail(field, `${label} is required.`);
      return nullable ? null : undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value)) return this.fail(field, `${label} must be a whole number.`);
    if (value < min) return this.fail(field, `${label} must be at least ${min}.`);
    if (value > max) return this.fail(field, `${label} must be at most ${max}.`);
    return value;
  }

  // Accepts paise integers (`fieldPaise`) or rupee strings (`field`).
  money(field, { required = false, label = field, max = 1_000_000_000 } = {}) {
    const raw = this.input[field];
    if (raw === null || raw === undefined || raw === "") {
      if (required) return this.fail(field, `${label} is required.`);
      return null;
    }
    const value = typeof raw === "number" ? raw : rupeesToPaise(raw);
    if (!isPaise(value)) return this.fail(field, `${label} must be a valid amount in paise.`);
    if (value > max) return this.fail(field, `${label} is too large.`);
    return value;
  }

  number(field, { required = false, min = -Infinity, max = Infinity, label = field, allowed } = {}) {
    const raw = this.input[field];
    if (raw === null || raw === undefined || raw === "") {
      if (required) return this.fail(field, `${label} is required.`);
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) return this.fail(field, `${label} must be a number.`);
    if (value < min || value > max) return this.fail(field, `${label} must be between ${min} and ${max}.`);
    if (allowed && !allowed.includes(value)) return this.fail(field, `${label} must be one of ${allowed.join(", ")}.`);
    return value;
  }

  oneOf(field, options, { required = false, label = field, fallback } = {}) {
    const raw = this.input[field];
    if (raw === null || raw === undefined || raw === "") {
      if (required) return this.fail(field, `${label} is required.`);
      return fallback;
    }
    if (!options.includes(raw)) return this.fail(field, `${label} is not a valid option.`);
    return raw;
  }

  bool(field, fallback = false) {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") return fallback;
    return raw === true || raw === "true" || raw === 1 || raw === "1";
  }

  assert() {
    if (Object.keys(this.errors).length) {
      throw badRequest("Please correct the highlighted fields.", { fields: this.errors });
    }
  }
}
