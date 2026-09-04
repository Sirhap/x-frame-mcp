"use strict";

const RECEIPT_SCHEMA_VERSION = 2;
const EFFECTS = Object.freeze(["confirmed", "partial", "unverifiable", "suspected_noop", "refused"]);
const ROUTES = Object.freeze([
  "domain_read",
  "domain_mutation",
  "code_perception",
  "geometry",
  "local_florence",
  "external_process",
]);
const VERIFICATION_STATUSES = Object.freeze(["satisfied", "unsatisfied", "unknown"]);

/**
 * Shared closed output schema advertised by every XSXB MCP tool.
 * Tool-specific business data stays under `data` so clients can reliably parse
 * the lifecycle fields without guessing which handler produced the receipt.
 * @returns {object} JSON Schema object.
 */
function receiptEnvelopeSchema() {
  return {
    type: "object",
    required: [
      "schemaVersion",
      "tool",
      "ok",
      "data",
      "observation",
      "execution",
      "verification",
      "escalation",
    ],
    properties: {
      schemaVersion: { type: "integer", const: RECEIPT_SCHEMA_VERSION },
      tool: { type: "string" },
      ok: { type: "boolean" },
      data: { type: ["object", "array", "string", "number", "boolean", "null"] },
      observation: {
        type: ["object", "null"],
        properties: {
          snapshotId: { type: "string" },
          scope: { type: "object" },
          sourceHashes: { type: "object" },
          view: { type: ["object", "null"] },
          createdAt: { type: "string" },
        },
        required: ["snapshotId", "scope", "sourceHashes", "createdAt"],
        additionalProperties: false,
      },
      execution: {
        type: ["object", "null"],
        properties: {
          effect: { type: "string", enum: [...EFFECTS] },
          route: { type: "string", enum: [...ROUTES] },
          artifacts: { type: "array", items: { type: "object" } },
        },
        required: ["effect", "route", "artifacts"],
        additionalProperties: false,
      },
      verification: {
        type: ["object", "null"],
        properties: {
          status: { type: "string", enum: [...VERIFICATION_STATUSES] },
          checks: { type: "array" },
          evidence: { type: "array" },
        },
        required: ["status", "checks", "evidence"],
        additionalProperties: false,
      },
      escalation: {
        type: ["object", "null"],
        properties: {
          target: {
            type: "string",
            enum: ["agent_visual", "local_florence", "user", "domain_algorithm", "external_dependency"],
          },
          reason: {
            type: "string",
            enum: [
              "model_unavailable",
              "model_failed",
              "code_ambiguity",
              "effect_unconfirmed",
              "stale_observation",
              "permission_required",
              "unsupported",
            ],
          },
        },
        required: ["target", "reason"],
        additionalProperties: false,
      },
      error: {
        type: ["object", "null"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          details: { type: ["object", "null"] },
        },
        required: ["code", "message", "details"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

/**
 * Maps an existing handler verification status into the v2 contract.
 * @param {unknown} status Existing verification status.
 * @returns {"satisfied"|"unsatisfied"|"unknown"}
 */
function verificationStatus(status) {
  if (status === "confirmed") return "satisfied";
  if (status === "suspected_noop") return "unsatisfied";
  return "unknown";
}

/**
 * Maps an existing handler verification status into an execution fact.
 * @param {unknown} status Existing verification status.
 * @returns {string}
 */
function executionEffect(status) {
  if (status === "suspected_noop") return "suspected_noop";
  if (status === "unverified" || status === "unverifiable") return "unverifiable";
  return "confirmed";
}

/**
 * Builds the standard successful MCP result.
 * @param {string} tool Tool name.
 * @param {unknown} data Raw business result.
 * @param {{readOnly?:boolean,route?:string,observation?:object|null,execution?:object|null,verification?:object|null,escalation?:object|null}} [options]
 * @returns {object} Versioned receipt.
 */
function successReceipt(tool, data, options = {}) {
  const raw = data && typeof data === "object" ? data : {};
  const rawVerify = raw.verify && typeof raw.verify === "object" ? raw.verify : null;
  const previewOnly = raw.dryRun === true || raw.applied === false || raw.deleted === false;
  const execution = options.readOnly
    ? null
    : options.execution || {
        effect: previewOnly ? "unverifiable" : executionEffect(rawVerify?.status),
        route: ROUTES.includes(options.route) ? options.route : "domain_mutation",
        artifacts: [],
      };
  const verification =
    options.verification ||
    (rawVerify
      ? {
          status: verificationStatus(rawVerify.status),
          checks: Array.isArray(rawVerify.checks) ? rawVerify.checks : [],
          evidence: [],
        }
      : previewOnly
        ? { status: "unknown", checks: ["preview_only"], evidence: [] }
        : null);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    tool,
    ok: true,
    data: data === undefined ? null : data,
    observation: options.observation || null,
    execution,
    verification,
    escalation: options.escalation || null,
  };
}

/**
 * Builds the standard failed MCP result.
 * @param {string} tool Tool name.
 * @param {Error|unknown} error Failure.
 * @returns {object} Versioned error receipt.
 */
function errorReceipt(tool, error) {
  const failure = error instanceof Error ? error : new Error(String(error || "Unknown MCP error."));
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    tool,
    ok: false,
    data: null,
    observation: null,
    execution: { effect: "refused", route: "domain_mutation", artifacts: [] },
    verification: null,
    escalation: null,
    error: {
      code: String(failure.code || "xsxb_tool_error"),
      message: failure.message,
      details: failure.details && typeof failure.details === "object" ? failure.details : null,
    },
  };
}

/**
 * Produces a short human diagnostic without duplicating structuredContent.
 * @param {object} receipt V2 receipt.
 * @returns {string} Compact text content.
 */
function receiptSummary(receipt) {
  if (!receipt?.ok) return `${receipt?.tool || "xsxb"}: ${receipt?.error?.code || "error"}`;
  const effect = receipt.execution?.effect;
  const parts = [`${receipt.tool}: ${effect || "ok"}`];
  const snapshotId = receipt.observation?.snapshotId;
  if (typeof snapshotId === "string" && snapshotId.startsWith("obs_v1_")) parts.push(snapshotId);
  const data = receipt.data && typeof receipt.data === "object" ? receipt.data : null;
  const artifactPath = data?.preview?.path || data?.outputPath || receipt.execution?.artifacts?.[0]?.path;
  if (typeof artifactPath === "string" && artifactPath) {
    const base = artifactPath.replace(/\\/g, "/").split("/").pop();
    if (base) parts.push(base);
  }
  return parts.join(" ");
}

module.exports = {
  EFFECTS,
  RECEIPT_SCHEMA_VERSION,
  ROUTES,
  VERIFICATION_STATUSES,
  errorReceipt,
  receiptEnvelopeSchema,
  receiptSummary,
  successReceipt,
};
