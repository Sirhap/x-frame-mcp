"use strict";

/**
 * Runtime validation for the JSON Schema subset the XSXB MCP tools declare.
 *
 * The catalog advertises `additionalProperties: false`, `required`, `enum` and
 * numeric bounds, but the dispatcher used to pass arguments straight through,
 * so a misspelled property was silently ignored and the tool quietly ran with
 * its defaults. This module closes that gap without narrowing what already
 * works: the handlers deliberately accept the stringified numbers and booleans
 * that agents send, so those keep passing and are normalized before dispatch.
 * Invalid structural values are rejected instead of coerced into indexes or flags.
 */

const BOOLEAN_WORDS = new Set(["true", "false", "yes", "no", "1", "0"]);

/**
 * Reads a value's JSON Schema type name.
 * @param {unknown} value Candidate value.
 * @returns {string} Schema type name.
 */
function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Parses only numbers and numeric strings, including simple fractions.
 * @param {unknown} value Raw argument.
 * @returns {number} Parsed number or NaN for an invalid representation.
 */
function parseNumeric(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const trimmed = value.trim();
  const fraction = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator ? Number(fraction[1]) / denominator : NaN;
  }
  return trimmed ? Number(trimmed) : NaN;
}

/**
 * Normalizes a scalar only after its representation is known to be valid.
 * @param {unknown} value Raw argument.
 * @param {string} expected Declared type.
 * @returns {{valid:boolean,value:unknown}} Validation and canonical value.
 */
function normalizeScalar(value, expected) {
  const actual = typeOf(value);
  if (expected === "boolean") {
    if (actual === "boolean") return { valid: true, value };
    if (actual === "number") return { valid: value === 0 || value === 1, value: value === 1 };
    const word = actual === "string" ? value.trim().toLowerCase() : "";
    return { valid: BOOLEAN_WORDS.has(word), value: ["true", "yes", "1"].includes(word) };
  }
  if (expected === "number" || expected === "integer") {
    const numeric = parseNumeric(value);
    return {
      valid: Number.isFinite(numeric) && (expected === "number" || Number.isInteger(numeric)),
      value: numeric,
    };
  }
  return { valid: !expected || actual === expected, value };
}

/**
 * Finds the declared property name closest to an unknown one, so a typo points
 * at its intended target instead of just failing.
 * @param {string} unknown Rejected property name.
 * @param {string[]} candidates Declared property names.
 * @returns {string} Closest name, or an empty string when nothing is close.
 */
function closestName(unknown, candidates) {
  let best = "";
  let bestScore = 0;
  for (const candidate of candidates) {
    const shorter = unknown.length < candidate.length ? unknown : candidate;
    const longer = unknown.length < candidate.length ? candidate : unknown;
    if (!longer.startsWith(shorter.slice(0, Math.min(3, shorter.length)))) continue;
    let shared = 0;
    while (shared < shorter.length && shorter[shared] === longer[shared]) shared += 1;
    const score = shared / longer.length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.6 ? best : "";
}

/**
 * Validates and normalizes a declared value, including nested objects and arrays.
 * Defaults remain the handler's responsibility; omitted fields stay omitted.
 * @param {string} toolName Tool and nested object context.
 * @param {object} schema Declared schema subset.
 * @param {unknown} input Caller value, never mutated.
 * @param {string} label Argument name used in errors.
 * @returns {unknown} Canonical value.
 */
function normalizeValue(toolName, schema, input, label) {
  /** Raises a machine-readable argument error before any tool side effect. */
  const reject = (message) => {
    const error = new Error(`${toolName}: ${message}`);
    error.code = "xsxb_invalid_arguments";
    throw error;
  };
  const normalized = normalizeScalar(input, schema.type);
  if (!normalized.valid) {
    reject(`argument "${label}" must be ${schema.type}, received ${typeOf(input)}.`);
  }
  const value = normalized.value;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    reject(`argument "${label}" must be one of: ${schema.enum.join(", ")}. Received "${input}".`);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    reject(`argument "${label}" must be at least ${schema.minimum}. Received ${input}.`);
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    reject(`argument "${label}" must be greater than ${schema.exclusiveMinimum}. Received ${input}.`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    reject(`argument "${label}" must be at most ${schema.maximum}. Received ${input}.`);
  }
  if (Array.isArray(value) && schema.items) {
    return value.map((item, index) => normalizeValue(toolName, schema.items, item, `${label}[${index}]`));
  }
  if (typeOf(value) !== "object") return value;
  const properties = schema.properties || {};
  const declared = Object.keys(properties);
  for (const name of schema.required || []) {
    if (value[name] === undefined || value[name] === null || value[name] === "") {
      reject(`missing required argument "${name}" in ${label}.`);
    }
  }
  const entries = Object.entries(value).map(([name, entry]) => {
    const property = Object.hasOwn(properties, name) ? properties[name] : null;
    if (!property && schema.additionalProperties === false) {
      const suggestion = closestName(name, declared);
      reject(
        `unknown argument "${name}" in ${label}.${suggestion ? ` Did you mean "${suggestion}"?` : ""} ` +
          `Accepted arguments: ${declared.length ? declared.join(", ") : "none"}.`,
      );
    }
    if (entry === undefined || !property) return [name, entry];
    return [
      name,
      normalizeValue(toolName, property, entry, label === "arguments" ? name : `${label}.${name}`),
    ];
  });
  return Object.fromEntries(entries);
}

/**
 * Validates arguments and returns a normalized copy for public and internal calls.
 * @param {string} toolName Tool being called.
 * @param {object} schema Declared input schema.
 * @param {unknown} args Caller-supplied arguments.
 * @returns {object} Normalized arguments without changing caller-owned objects.
 * @throws {Error} When an argument is missing, unknown, or unusable.
 */
function validateToolArguments(toolName, schema, args) {
  return normalizeValue(toolName, schema, args, "arguments");
}

module.exports = { validateToolArguments };
