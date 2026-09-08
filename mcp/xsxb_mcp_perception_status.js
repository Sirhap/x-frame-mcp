"use strict";

const TARGETS = Object.freeze({
  subject: {
    hypothesis: "subject",
    label: /person|character|human|figure|warrior|hero|dog|animal|cat|bird|人物|角色|人形|狗/iu,
  },
  weapon: {
    hypothesis: "elongated_attachment",
    label: /sword|blade|weapon|spear|gun|axe|bow|staff|shield|剑|刀|武器/iu,
  },
  hand: { hypothesis: "contact_point", label: /hand|fist|palm|手|拳/iu },
  effect: { hypothesis: "transient_effect", label: /effect|trail|spark|flash|特效|拖影/iu },
  text: { hypothesis: "text_like", label: /text|letter|word|文字/iu },
});

/**
 * Reports each requested target independently. Missing candidates never prove absence.
 * Semantic confirmation requires a relevant grounded label; geometry alone cannot
 * establish a hand, weapon, effect, or readable text.
 * @param {string[]} targets Requested targets.
 * @param {object[]} candidates Code-grounded candidates with optional model labels.
 * @returns {object} Target-keyed evidence and resolution states.
 */
function perceptionTargetStatus(targets, candidates) {
  return Object.fromEntries(
    [...new Set(targets)].map((target) => {
      const spec = TARGETS[target];
      const semanticMatch = (candidate) =>
        Boolean(spec && candidate.semanticLabel && spec.label.test(candidate.semanticLabel));
      const matches = candidates.filter(
        (candidate) => candidate.hypothesis === spec?.hypothesis || semanticMatch(candidate),
      );
      const semantic = matches.some(semanticMatch) ? "confirmed" : "unknown";
      const grounded = matches.some(
        (candidate) => candidate.codeConfidence >= 0.8 && !candidate.ambiguities?.length,
      );
      const geometry = !matches.length ? "missing" : grounded ? "confirmed" : "candidate";
      const status = !matches.length
        ? "missing"
        : semantic === "confirmed"
          ? "semantic_confirmed"
          : target === "subject" && grounded
            ? "geometry_confirmed"
            : "candidate";
      return [
        target,
        {
          status,
          geometry,
          semantic,
          regionIds: matches.map((candidate) => candidate.regionId),
          ambiguities: [...new Set(matches.flatMap((candidate) => candidate.ambiguities || []))],
        },
      ];
    }),
  );
}

module.exports = { perceptionTargetStatus };
