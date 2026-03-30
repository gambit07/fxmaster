/**
 * FXMaster: Color Utilities
 *
 * CSS variable resolution and color format conversion.
 */

/**
 * Resolve a CSS variable (typically a Foundry theme color variable) to its computed color value.
 *
 * @param {string} varName
 * @returns {string} The computed color string (usually an rgb(...) string).
 */

export function getCssVarValue(varName) {
  const el = document.createElement("div");
  el.style.color = `var(${varName})`;
  el.style.display = "none";
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.body.removeChild(el);
  return computed;
}

/**
 * Convert an rgb() string to rgba() with custom alpha.
 * @param {string} rgbString
 * @param {number} alpha
 * @returns {string}
 */
export function addAlphaToRgb(rgbString, alpha) {
  /* Legacy: rgb(R, G, B) */
  const legacy = rgbString.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (legacy) return `rgba(${legacy[1]}, ${legacy[2]}, ${legacy[3]}, ${alpha})`;

  /* Modern CSS Color Level 4: rgb(R G B) or rgb(R G B / A) */
  const modern = rgbString.match(/^rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*[\d.]+%?)?\)$/);
  if (modern) return `rgba(${modern[1]}, ${modern[2]}, ${modern[3]}, ${alpha})`;

  return rgbString;
}

/**
 * Get base and highlight colors used in FXMaster's UI, derived from Foundry theme CSS variables.
 *
 * @returns {{ baseColor: string, highlightColor: string }}
 */
export function getDialogColors() {
  const rgbColor = getCssVarValue("--color-warm-2");
  const rgbColorHighlight = getCssVarValue("--color-warm-3");
  const baseColor = addAlphaToRgb(rgbColor, 1);
  const highlightColor = addAlphaToRgb(rgbColorHighlight, 1);
  return { baseColor, highlightColor };
}
