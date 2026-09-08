"use strict";

/**
 * Conservative warm exposed-skin mask, not a skin identity classifier.
 * Gloves, non-warm fantasy skin and occluded hands deliberately abstain.
 * @param {number} red Red channel.
 * @param {number} green Green channel.
 * @param {number} blue Blue channel.
 * @returns {boolean} Whether this pixel supports an exposed-limb proposal.
 */
function exposedSkinPixel(red, green, blue) {
  return (
    red > 45 &&
    green > 22 &&
    blue > 12 &&
    red > green * 1.12 &&
    green > blue * 1.06 &&
    red - blue > 18 &&
    red - green < 135
  );
}

/**
 * Finds compact, exposed distal regions inside a connected standing subject.
 * Ratios only reject implausible regions; coordinates come from observed pixels.
 * Deliberately limited to separated, lowered fists: not a general pose estimator.
 * @param {object} frame Segmented RGBA image.
 * @param {object} subject Foreground subject component.
 * @param {Int32Array} labels Original foreground component labels.
 * @param {Function} components Eight-connected component analyser.
 * @returns {object[]} Unconfirmed contact candidates backed by local pixels.
 */
function connectedHandCandidates(frame, subject, labels, components) {
  const mask = new Uint8ClampedArray(frame.data.length);
  for (let y = subject.minY; y <= subject.maxY; y += 1) {
    for (let x = subject.minX; x <= subject.maxX; x += 1) {
      const index = y * frame.width + x;
      const offset = index * 4;
      if (
        labels[index] === subject.label &&
        frame.data[offset + 3] > 16 &&
        exposedSkinPixel(frame.data[offset], frame.data[offset + 1], frame.data[offset + 2])
      ) {
        mask.set(frame.data.subarray(offset, offset + 4), offset);
      }
    }
  }
  const width = subject.maxX - subject.minX + 1;
  const height = subject.maxY - subject.minY + 1;
  const regions = components(mask, frame.width, frame.height).components.filter((region) => {
    const x = (region.centerX - subject.minX) / width;
    const y = (region.centerY - subject.minY) / height;
    return (
      !region.noise &&
      region.count >= Math.max(4, subject.count * 0.003) &&
      region.count <= subject.count * 0.09 &&
      region.width <= width * 0.25 &&
      region.height <= height * 0.17 &&
      region.fillRatio >= 0.3 &&
      region.aspectRatio <= 2 &&
      (x < 0.3 || x > 0.7) &&
      y > 0.5 &&
      y < 0.85
    );
  });
  // One strongest patch per screen side avoids fragment-derived duplicate palms.
  return [false, true].flatMap((right) => {
    const region = regions
      .filter((item) => item.centerX > subject.centerX === right)
      .sort((a, b) => b.count - a.count)[0];
    return region
      ? [
          {
            hypothesis: "contact_point",
            component: region,
            codeConfidence: Number(Math.min(0.69, 0.5 + region.fillRatio * 0.19).toFixed(3)),
            evidence: ["connected_subject_local_color", "compact_distal_region"],
            ambiguities: ["contact_geometry_does_not_prove_hand", "exposed_lowered_hand_heuristic"],
            provenance: ["code_perception", "local_pixel_components"],
          },
        ]
      : [];
  });
}

module.exports = { connectedHandCandidates, exposedSkinPixel };
