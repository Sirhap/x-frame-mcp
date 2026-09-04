"use strict";

/**
 * Runtime validation for the JSON Schema subset the XSXB MCP tools declare.
 *
 * The catalog advertises `additionalProperties: false`, `required`, `enum` and
 * numeric bounds, but the dispatcher used to pass arguments straight through,
 * so a misspelled property was silently ignored and the tool quietly ran with
 * its defaults. This module closes that gap without narrowing what already
 * works: the handlers deliberately accept the stringified numbers and booleans
 * that agents send, so those keep passing. Only input that cannot be
 * interpreted at all is rejected.
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
 * Whether a value satisfies one declared property type, allowing the string and
 * numeric spellings the tool handlers already normalize.
 * @param {unknown} value Candidate value.
 * @param {string} expected Declared JSON Schema type.
 * @returns {boolean} Whether the value is usable as that type.
 */
function parseNumeric(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number(value);
  const trimmed = value.trim();
  const fraction = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator ? Number(fraction[1]) / denominator : NaN;
  }
  return trimmed ? Number(trimmed) : NaN;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "string") return actual === "string";
  if (expected === "array") return actual === "array";
  if (expected === "object") return actual === "object";
  if (expected === "boolean") {
    if (actual === "boolean") return true;
    if (actual === "number") return value === 0 || value === 1;
    return actual === "string" && BOOLEAN_WORDS.has(value.trim().toLowerCase());
  }
  if (expected === "number" || expected === "integer") {
    const numeric = parseNumeric(value);
    if (!Number.isFinite(numeric)) return false;
    return expected === "number" || Number.isInteger(numeric);
  }
  return true;
}

/**
 * Reads a declared numeric property as a number for bound checks.
 * @param {unknown} value Candidate value.
 * @returns {number} Parsed number, or NaN.
 */
function asNumber(value) {
  return parseNumeric(value);
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
 * Validates one tool call's arguments against its declared input schema.
 * @param {string} toolName Tool being called.
 * @param {object} schema Declared input schema.
 * @param {object} args Caller-supplied arguments.
 * @returns {object} The same arguments, once they are known to be usable.
 * @throws {Error} When an argument is missing, unknown, or unusable.
 */
function validateToolArguments(toolName, schema, args) {
  const properties = schema?.properties || {};
  const declared = Object.keys(properties);
  /**
   * Raises a validation failure naming the tool and the property at fault.
   * @param {string} message Problem description.
   * @returns {never}
   */
  const reject = (message) => {
    const error = new Error(`${toolName}: ${message}`);
    error.code = "xsxb_invalid_arguments";
    throw error;
  };

  for (const name of schema?.required || []) {
    const value = args?.[name];
    if (value === undefined || value === null || value === "") {
      reject(`missing required argument "${name}".`);
    }
  }

  for (const [name, value] of Object.entries(args || {})) {
    const property = properties[name];
    if (!property) {
      if (schema?.additionalProperties !== false) continue;
      const suggestion = closestName(name, declared);
      reject(
        `unknown argument "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} ` +
          `Accepted arguments: ${declared.length ? declared.join(", ") : "none"}.`,
      );
    }
    // An omitted optional argument arrives as undefined from spread call sites.
    if (value === undefined) continue;
    if (property.type && !matchesType(value, property.type)) {
      reject(`argument "${name}" must be ${property.type}, received ${typeOf(value)}.`);
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      reject(`argument "${name}" must be one of: ${property.enum.join(", ")}. Received "${value}".`);
    }
    if (property.type === "array" && property.items) {
      for (const [index, item] of value.entries()) {
        if (property.items.type && !matchesType(item, property.items.type)) {
          reject(`argument "${name}"[${index}] must be ${property.items.type}, received ${typeOf(item)}.`);
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          validateToolArguments(`${toolName}.${name}[${index}]`, property.items, item);
        }
      }
    }
    if (property.minimum !== undefined && asNumber(value) < property.minimum) {
      reject(`argument "${name}" must be at least ${property.minimum}. Received ${value}.`);
    }
    if (property.exclusiveMinimum !== undefined && asNumber(value) <= property.exclusiveMinimum) {
      reject(`argument "${name}" must be greater than ${property.exclusiveMinimum}. Received ${value}.`);
    }
    if (property.maximum !== undefined && asNumber(value) > property.maximum) {
      reject(`argument "${name}" must be at most ${property.maximum}. Received ${value}.`);
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (property.properties || property.additionalProperties === false)
    ) {
      validateToolArguments(`${toolName}.${name}`, property, value);
    }
  }
  return args;
}

module.exports = { validateToolArguments };
