/**
 * FXMaster Preset API
 * -------------------
 * Provides an integration API for other modules/macros to apply. Predefined preset effects by name.
 *
 * Presets are defined in ./api-effects.js
 *
 * Usage:
 * await FXMASTER.api.presets.play("sunshower", { topDown: false, direction: "north", belowTokens: false, belowTiles: false, belowForeground: false, darknessActivationMin: 0, darknessActivationMax: 1, soundFx: false, density: "high", speed: "low" });
 * await FXMASTER.api.presets.stop("blizzard"); await FXMASTER.api.presets.toggle("blizzard", { topDown: true});
 * await FXMASTER.api.presets.switch("sunshower", { topDown: true });
 * const allPresets = FXMASTER.api.presets.list();
 * const validPresets = FXMASTER.api.presets.listValid();
 * const activePresets = FXMASTER.api.presets.listActive();
 * const activeOnScene = FXMASTER.api.presets.listActive({ scene: "<sceneUuid>" });
 *
 * Behavior summary:
 * - `play` enables a preset and updates an already-active preset when new options are provided.
 * - `stop` disables a preset.
 * - `toggle` switches a preset on or off.
 * - `switch` disables active presets before enabling the requested preset.
 * - `list`, `listValid`, and `listActive` expose preset catalog and activity information.
 */

import { API_EFFECT_ID_PREFIX, API_EFFECT_UPDATE_OPTIONS_FLAG, packageId } from "./constants.js";
import { API_EFFECTS, API_EFFECT_NAMES } from "./api-effects.js";
import { addDeletionKey, ensureSingleSceneLevelSelection, normalizeDarknessActivationRange } from "./utils.js";
import { logger } from "./logger.js";
import { buildSceneEffectUid, promoteEffectStackUids } from "./common/effect-stack.js";

const FXMASTER_PLUS_ID = "fxmaster-plus";
const KEY_PREFIX = "apiPreset_";

const ACTIVE_KEY_RE = /^apiPreset_(.+)_(?:p|f)\d+$/;

/**
 * Accepted relative intensity values for preset speed and density overrides.
 *
 * @typedef {"very-low"|"low"|"medium"|"high"|"very-high"|number} PresetRelativeLevelValue
 */

/**
 * Accepted level selector values for preset-scoped scene level filtering.
 *
 * A value may be a native Level id, a Level name/label/title, or an array of those values. Unmatched selections fall back to all levels.
 *
 * @typedef {string|number|Array<string|number>} PresetLevelsValue
 */

/**
 * Options accepted by the public preset API methods.
 *
 * @typedef {object} PresetPlayOptions
 * @property {boolean} [topDown=false] Render the preset's top-down variant when available.
 * @property {string|number} [direction] Compass direction (`"n"`, `"ne"`, `"e"`, `"se"`, `"s"`, `"sw"`, `"w"`, `"nw"`, `"up"`, `"down"`, `"left"`, `"right"`) or a numeric degree value.
 * @property {string} [color] Hex tint override such as `#RRGGBB` or `#RGB`.
 * @property {PresetRelativeLevelValue} [speed] Relative speed preset (`"very-low"`, `"low"`, `"medium"`, `"high"`, `"very-high"`) or an explicit numeric multiplier.
 * @property {PresetRelativeLevelValue} [density] Relative density preset (`"very-low"`, `"low"`, `"medium"`, `"high"`, `"very-high"`) or an explicit numeric multiplier.
 * @property {boolean} [belowTokens] Apply the preset beneath tokens.
 * @property {boolean} [belowTiles=false] Apply the preset beneath tiles.
 * @property {boolean} [belowForeground=false] Apply the preset beneath foreground coverage.
 * @property {boolean} [darknessActivationEnabled=false] Enable or disable darkness gating explicitly.
 * @property {number} [darknessActivationMin] Minimum scene darkness level for the preset effect range. Supplying min/max without an explicit toggle enables darkness activation.
 * @property {number} [darknessActivationMax] Maximum scene darkness level for the preset effect range. Supplying min/max without an explicit toggle enables darkness activation.
 * @property {boolean} [soundFx] Enable preset-linked Sound FX when FXMaster+ is active.
 * @property {PresetLevelsValue} [levels] Scene Level id, Level name, or an array of ids/names used to restrict the preset to specific scene levels. Invalid selections fall back to all levels.
 * @property {Scene|string} [scene] Scene document or scene UUID to target.
 * @property {boolean} [silent=true] Suppress UI warnings for missing presets or invalid override values.
 */

/**
 * Resolve a Scene from a Scene document instance or a UUID string.
 *
 * Supported inputs:
 * - A Scene document instance.
 * - A UUID string (e.g. `"Scene.abc123"`).
 *
 * @param {any} sceneRef - A Scene document or UUID string.
 * @returns {any|null} The resolved Scene document, or `null`.
 */
function resolveScene(sceneRef) {
  if (!sceneRef) return null;

  if (sceneRef?.collectionName === "scenes") return sceneRef;

  if (typeof sceneRef !== "string") return null;
  const ref = sceneRef.trim();
  if (!ref) return null;

  const checkUuid = fromUuidSync(ref);
  if (checkUuid && checkUuid.collectionName === "scenes") return checkUuid;

  return null;
}

/**
 * Check whether a preset variant references only currently-registered FXMaster effect types.
 *
 * If CONFIG.fxmaster is not yet populated, this returns true (best-effort).
 *
 * @param {*} variant
 * @returns {boolean}
 */
function isVariantCompatible(variant) {
  const particleDB = CONFIG?.fxmaster?.particleEffects;
  const filterDB = CONFIG?.fxmaster?.filterEffects;

  if (!particleDB || !filterDB) return true;

  const ps = variant?.particles ?? [];
  const fs = variant?.filters ?? [];

  for (const p of ps) {
    const t = p?.type;
    if (t && !(t in particleDB)) return false;
  }
  for (const f of fs) {
    const t = f?.type;
    if (t && !(t in filterDB)) return false;
  }
  return true;
}

/**
 * @returns {boolean}
 */
export function hasFxmasterPlus() {
  try {
    const mod = game?.modules?.get?.(FXMASTER_PLUS_ID);
    return !!(mod && mod.active);
  } catch {
    return false;
  }
}

/**
 * @returns {boolean}
 */
export function hasFxmaster() {
  try {
    const mod = game?.modules?.get?.(packageId);
    return !!(mod && mod.active);
  } catch {
    return false;
  }
}

/**
 * Normalize a user-provided preset name for lookup and keying.
 * @param {string} name
 * @returns {string}
 */
export function normalizePresetName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Convert a compass direction string into FXMaster degrees. FXMaster particle direction is screen-space degrees where: 0   = east (→) 90  = south (↓) 180 = west (←) 270 = north (↑)
 *
 * @param {string|number|null|undefined} dir
 * @returns {number|null}
 */
export function parseDirectionDegrees(dir) {
  if (dir === null || dir === undefined) return null;

  if (typeof dir === "number" && Number.isFinite(dir)) {
    const d = ((dir % 360) + 360) % 360;
    return d;
  }

  const s = String(dir).trim().toLowerCase();
  if (!s) return null;

  const norm = s.replace(/[\s_-]+/g, "");

  const map = {
    e: 0,
    east: 0,
    se: 45,
    southeast: 45,
    s: 90,
    south: 90,
    sw: 135,
    southwest: 135,
    w: 180,
    west: 180,
    nw: 225,
    northwest: 225,
    n: 270,
    north: 270,
    ne: 315,
    northeast: 315,
    up: 270,
    down: 90,
    left: 180,
    right: 0,
  };

  if (norm in map) return map[norm];
  return null;
}

/**
 * Relative speed/density mapping.
 *
 * Preset values are considered medium (1.0).
 *
 * - very-low  => -100%
 * - low       => -50%
 * - medium    => baseline
 * - high      => +50%
 * - very-high => +100%
 */
const RELATIVE_LEVEL_SCALE = {
  "very-low": 0.0,
  low: 0.5,
  medium: 1.0,
  high: 1.5,
  "very-high": 2.0,
};

/**
 * Parse a relative level string into a multiplier.
 *
 * Supports: "very-low", "low", "medium", "high", "very-high" (case-insensitive; allows spaces/underscores).
 *
 * @param {string|number|null|undefined} level
 * @returns {{ multiplier: number, provided: boolean, valid: boolean, normalized?: string }}
 */
function parseRelativeLevelMultiplier(level) {
  if (level === null || level === undefined) return { multiplier: 1, provided: false, valid: true };

  if (typeof level === "number" && Number.isFinite(level)) {
    return { multiplier: level, provided: true, valid: true, normalized: String(level) };
  }

  const s = String(level ?? "")
    .trim()
    .toLowerCase();
  if (!s) return { multiplier: 1, provided: true, valid: false };

  const norm = s.replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  const m = RELATIVE_LEVEL_SCALE?.[norm];
  if (typeof m === "number" && Number.isFinite(m))
    return { multiplier: m, provided: true, valid: true, normalized: norm };

  const squashed = norm.replace(/-/g, "");
  if (squashed === "verylow")
    return { multiplier: RELATIVE_LEVEL_SCALE["very-low"], provided: true, valid: true, normalized: "very-low" };
  if (squashed === "veryhigh")
    return { multiplier: RELATIVE_LEVEL_SCALE["very-high"], provided: true, valid: true, normalized: "very-high" };

  return { multiplier: 1, provided: true, valid: false, normalized: norm };
}

/**
 * Best-effort lookup of a parameter descriptor (min/max/step/decimals) for a given effect option.
 *
 * This lets the Preset API clamp and quantize values so they don't exceed UI ranges and don't produce floating-point artifacts (e.g. 1.499999999).
 *
 * @param {{kind?: "particles"|"filters", type?: string}} meta
 * @param {string} key
 * @returns {{min?:number, max?:number, step?:number, decimals?:number}|null}
 */
function getRegisteredParamDescriptor(meta, key) {
  try {
    const kind = meta?.kind;
    const type = meta?.type;
    if (!kind || !type) return null;

    const db = kind === "particles" ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
    const cls = db?.[type];
    const params = cls?.parameters;
    const desc = params?.[key];

    if (!desc || typeof desc !== "object") return null;

    /** Only expose numeric range-style metadata. */
    const min = Number(desc.min);
    const max = Number(desc.max);
    const step = Number(desc.step);
    const decimals = Number(desc.decimals);

    return {
      ...(Number.isFinite(min) ? { min } : {}),
      ...(Number.isFinite(max) ? { max } : {}),
      ...(Number.isFinite(step) && step > 0 ? { step } : {}),
      ...(Number.isFinite(decimals) && decimals >= 0 ? { decimals } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Infer decimal precision from a step size.
 * @param {number} step
 * @returns {number}
 */
function decimalsFromStep(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);
  const m = /e-(\d+)$/i.exec(s);
  if (m) return Number.parseInt(m[1], 10) || 0;
  const i = s.indexOf(".");
  return i >= 0 ? s.length - i - 1 : 0;
}

/**
 * Clamp and quantize a numeric value to a param descriptor.
 *
 * Quantization snaps to the nearest `step`, aligned to `min` (when present).
 *
 * @param {number} value
 * @param {{min?:number, max?:number, step?:number, decimals?:number}|null} desc
 * @returns {number}
 */
function clampAndQuantize(value, desc) {
  let v = Number(value);
  if (!Number.isFinite(v)) return value;

  const min = Number.isFinite(desc?.min) ? desc.min : null;
  const max = Number.isFinite(desc?.max) ? desc.max : null;
  const step = Number.isFinite(desc?.step) && desc.step > 0 ? desc.step : null;

  if (min !== null) v = Math.max(min, v);
  if (max !== null) v = Math.min(max, v);

  if (step !== null) {
    const base = min !== null ? min : 0;
    const n = Math.round((v - base) / step);
    v = base + n * step;

    if (min !== null) v = Math.max(min, v);
    if (max !== null) v = Math.min(max, v);
  }

  const decimals = Number.isFinite(desc?.decimals) ? desc.decimals : step !== null ? decimalsFromStep(step) : 6;
  if (Number.isFinite(decimals) && decimals >= 0) v = Number(v.toFixed(decimals));

  return v;
}

/**
 * Convenience: clamp/quantize a value for a specific effect parameter.
 *
 * @param {{kind?: "particles"|"filters", type?: string}} meta
 * @param {string} key
 * @param {number} value
 * @returns {number}
 */
function clampAndQuantizeForEffect(meta, key, value) {
  const desc = getRegisteredParamDescriptor(meta, key);
  if (!desc) {
    const v = Number(value);
    return Number.isFinite(v) ? Number(v.toFixed(6)) : value;
  }
  return clampAndQuantize(value, desc);
}
/**
 * Parse a user-provided hex color string.
 *
 * Supports:
 * - "#RRGGBB" / "#RGB"
 * - "RRGGBB" / "RGB"
 * - "0xRRGGBB" / "0xRGB"
 *
 * 8-digit values (e.g. "#RRGGBBAA") are accepted but the alpha channel is ignored.
 *
 * @param {string|null|undefined} color
 * @returns {{ provided: boolean, valid: boolean, hex: string|null }}
 */
function parseHexColor(color) {
  if (color === null || color === undefined) return { provided: false, valid: true, hex: null };

  const raw = String(color ?? "").trim();
  if (!raw) return { provided: true, valid: false, hex: null };

  let s = raw.toLowerCase();
  if (s.startsWith("0x")) s = s.slice(2);
  if (s.startsWith("#")) s = s.slice(1);

  if (!/^[0-9a-f]+$/i.test(s)) return { provided: true, valid: false, hex: null };

  if (s.length === 3) {
    s = s
      .split("")
      .map((c) => `${c}${c}`)
      .join("");
  } else if (s.length === 8) {
    s = s.slice(0, 6);
  }

  if (s.length !== 6) return { provided: true, valid: false, hex: null };
  return { provided: true, valid: true, hex: `#${s}` };
}

/**
 * Normalize degrees into the range [-180, 180], mapping 180 => -180.
 *
 * @param {number} deg
 * @returns {number}
 */
function normalizeAngle180(deg) {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  if (d === 180) d = -180;
  return d;
}

/**
 * Convert API direction (FXMaster degrees: 0=east, 90=south, 180=west, 270=north) into the FXMaster+ Sunlight filter's angle parameter.
 *
 * Sunlight: Angle is effectively an emission point, and the mapping differs depending on whether the filter is in parallel mode.
 *
 * Mappings:
 * - parallel (sunshower): -180=north, -90=east, 0=south, 90=west
 * - non-parallel (black-sun/twilight-sun): -180=east, -90=south, 0=west, 90=north
 *
 * @param {number} directionDeg
 * @param {boolean} parallel
 * @returns {number}
 */
function sunlightAngleFromDirection(directionDeg, parallel) {
  const d = Number(directionDeg);
  if (!Number.isFinite(d)) return 0;
  return parallel ? normalizeAngle180(d - 90) : normalizeAngle180(d - 180);
}

/**
 * @typedef {object} PresetVariant
 * @property {Array<{type:string, options?:object}>} [particles]
 * @property {Array<{type:string, options?:object}>} [filters]
 */

/**
 * Resolve the preset variant for a given name and options.
 *
 * @param {string} name
 * @param {{topDown?: boolean}} [opts]
 * @returns {{presetName: string, tier: "plus"|"free", variant: PresetVariant}|null}
 */
export function resolvePresetVariant(name, { topDown = false } = {}) {
  const presetName = normalizePresetName(name);
  const preset = API_EFFECTS?.[presetName] ?? null;
  if (!preset) return null;

  const plusActive = hasFxmasterPlus();
  const freeActive = hasFxmaster();

  const hasPlusTier = preset.plus && Object.keys(preset.plus).length > 0;
  const hasFreeTier = preset.free && Object.keys(preset.free).length > 0;

  const want = topDown ? "topDown" : "normal";
  const fallback = topDown ? "normal" : "topDown";

  /** @type {Array<{tier:"plus"|"free", variant: PresetVariant}>} */
  const candidates = [];

  if (plusActive && hasPlusTier) {
    const pt = preset.plus ?? {};
    const v = pt?.[want] ?? pt?.[fallback] ?? null;
    if (v) candidates.push({ tier: "plus", variant: v });
  }

  if (freeActive && hasFreeTier) {
    const ft = preset.free ?? {};
    const v = ft?.[want] ?? ft?.[fallback] ?? null;
    if (v) candidates.push({ tier: "free", variant: v });
  }

  if (!candidates.length) return null;

  const chosen = candidates.find((c) => isVariantCompatible(c.variant)) ?? candidates[0];
  return { presetName, tier: chosen.tier, variant: chosen.variant };
}

/**
 * Deep clone helper
 * @template T
 * @param {T} v
 * @returns {T}
 */
function deepClone(v) {
  if (foundry?.utils?.deepClone) return foundry.utils.deepClone(v);
  return JSON.parse(JSON.stringify(v));
}

/**
 * Accepted generic API effect entry shape used by saved FXMaster macros.
 *
 * @typedef {object} ApiEffectPlayEntry
 * @property {"particle"|"filter"} kind Effect kind.
 * @property {string} [id] Explicit API-managed effect id.
 * @property {string} [effectId] Alternate explicit API-managed effect id.
 * @property {string} type FXMaster effect type.
 * @property {object} [options] Effect options.
 */

const MACRO_API_KEY_PREFIX = API_EFFECT_ID_PREFIX;
const API_EFFECT_TOGGLE_GROUPS_FLAG = "_apiEffectToggleGroups";
const API_EFFECT_TOGGLE_KEY_PREFIX = "apiToggle_";

/**
 * Normalize a generic API effect kind.
 *
 * @param {unknown} kind
 * @returns {"particle"|"filter"|null}
 */
function normalizeApiEffectKind(kind) {
  const k = String(kind ?? "")
    .trim()
    .toLowerCase();
  if (k === "particle" || k === "particles") return "particle";
  if (k === "filter" || k === "filters") return "filter";
  return null;
}

/**
 * Stable JSON-ish serialization used to derive repeatable toggle keys from effect payloads.
 *
 * @param {*} value
 * @returns {string}
 */
function stableApiEffectStringify(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableApiEffectStringify(v)).join(",")}]`;

  const type = typeof value;
  if (type === "number" || type === "boolean" || type === "string") return JSON.stringify(value);
  if (type === "undefined" || type === "function" || type === "symbol") return "null";

  const keys = Object.keys(value).filter((key) => {
    const v = value[key];
    return typeof v !== "undefined" && typeof v !== "function" && typeof v !== "symbol";
  });
  keys.sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableApiEffectStringify(value[key])}`).join(",")}}`;
}

/**
 * Return a compact deterministic hash suitable for a scene flag path segment.
 *
 * @param {string} value
 * @returns {string}
 */
function hashApiEffectToggleValue(value) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const high = (h2 >>> 0).toString(36).padStart(7, "0");
  const low = (h1 >>> 0).toString(36).padStart(7, "0");
  return `${high}${low}`;
}

/**
 * Resolve a repeatable toggle key for an API effect group.
 *
 * @param {Array<{kind:"particle"|"filter", info: object}>} entries
 * @param {string|null|undefined} explicitKey
 * @returns {string}
 */
function createApiEffectToggleKey(entries, explicitKey = null) {
  const explicit = String(explicitKey ?? "").trim();
  if (explicit) return `${API_EFFECT_TOGGLE_KEY_PREFIX}custom_${hashApiEffectToggleValue(explicit)}`;

  const payload = (entries ?? []).map(({ kind, info }) => ({ kind, info }));
  return `${API_EFFECT_TOGGLE_KEY_PREFIX}${hashApiEffectToggleValue(stableApiEffectStringify(payload))}`;
}

/**
 * Convert normalized API effect entries back to the public effect payload shape.
 *
 * @param {Array<{kind:"particle"|"filter", info: object, requestedId?: string|null}>} entries
 * @returns {Array<object>}
 */
function denormalizeApiEffectEntries(entries = []) {
  return entries.map(({ kind, info, requestedId }) => ({
    kind,
    ...(requestedId ? { id: requestedId } : {}),
    ...deepClone(info ?? {}),
  }));
}

/**
 * Return active particle/filter ids from a stored toggle group, ignoring stale ids.
 *
 * @param {Scene} scene
 * @param {{particles?: Array<string>, filters?: Array<string>}|null|undefined} group
 * @returns {{particles: string[], filters: string[]}}
 */
function getActiveApiEffectToggleGroupIds(scene, group) {
  const curParticles = scene?.getFlag?.(packageId, "effects") ?? {};
  const curFilters = scene?.getFlag?.(packageId, "filters") ?? {};

  const particles = arrayifyApiEffectStopInput(group?.particles)
    .map((id) => String(id ?? "").trim())
    .filter((id) => id && id in curParticles);
  const filters = arrayifyApiEffectStopInput(group?.filters)
    .map((id) => String(id ?? "").trim())
    .filter((id) => id && id in curFilters);

  return { particles, filters };
}

/**
 * Return whether the scene flag key belongs to the public API/macro effect namespace.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isApiManagedEffectId(id) {
  return typeof id === "string" && id.startsWith(MACRO_API_KEY_PREFIX);
}

/**
 * Normalize an explicit API-managed effect id request for a specific effect kind.
 *
 * @param {"particle"|"filter"} kind
 * @param {unknown} id
 * @returns {string|null}
 */
function normalizeRequestedApiEffectId(kind, id) {
  const requestedId = String(id ?? "").trim();
  if (!requestedId || !isApiManagedEffectId(requestedId)) return null;

  const suffix = kind === "particle" ? "_p" : "_f";
  return requestedId.endsWith(suffix) ? requestedId : null;
}

/**
 * Build a comparable signature for exact API-effect payload matching.
 *
 * @param {"particle"|"filter"} kind
 * @param {object} info
 * @returns {string}
 */
function getApiEffectPayloadSignature(kind, info) {
  return stableApiEffectStringify({ kind, info });
}

/**
 * Find one exact active API-created particle/filter set matching the requested normalized toggle entries.
 *
 * Exact payload matching allows `.toggle` to disable rows created earlier by `.play` while leaving core and manually-managed scene rows untouched.
 *
 * @param {Array<{kind:"particle"|"filter", info: object}>} entries
 * @param {object} curParticles
 * @param {object} curFilters
 * @returns {{fullMatch: boolean, particles: string[], filters: string[]}}
 */
function collectMatchingApiEffectIds(entries, curParticles, curFilters) {
  const buckets = { particle: new Map(), filter: new Map() };
  const addCandidate = (kind, id, info) => {
    if (!isApiManagedEffectId(id) || !isValidEffectInfo(info)) return;
    const sig = getApiEffectPayloadSignature(kind, info);
    const bucket = buckets[kind];
    const list = bucket.get(sig) ?? [];
    list.push(id);
    bucket.set(sig, list);
  };

  for (const [id, info] of Object.entries(curParticles ?? {})) addCandidate("particle", id, info);
  for (const [id, info] of Object.entries(curFilters ?? {})) addCandidate("filter", id, info);

  const matched = { particles: [], filters: [] };
  for (const { kind, info } of entries) {
    const sig = getApiEffectPayloadSignature(kind, info);
    const list = buckets[kind].get(sig);
    if (!list?.length) return { fullMatch: false, particles: [], filters: [] };
    const id = list.shift();
    if (kind === "particle") matched.particles.push(id);
    else matched.filters.push(id);
  }

  return { fullMatch: true, ...matched };
}

/**
 * Return a generic API effect id that is unique within its scene flag bucket.
 *
 * @param {"particle"|"filter"} kind
 * @param {Set<string>} used
 * @returns {string}
 */
function createGenericApiEffectId(kind, used) {
  const suffix = kind === "particle" ? "p" : "f";
  for (let i = 0; i < 100; i++) {
    const id = `${MACRO_API_KEY_PREFIX}${foundry.utils.randomID()}_${suffix}`;
    if (used.has(id)) continue;
    used.add(id);
    return id;
  }

  const fallback = `${MACRO_API_KEY_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${suffix}`;
  used.add(fallback);
  return fallback;
}

/**
 * Return a small changing token used to force per-update API effect render options through scene update data.
 *
 * @returns {string}
 */
function createApiEffectsUpdateNonce() {
  try {
    return foundry?.utils?.randomID?.() ?? Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
  } catch (_err) {
    return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
  }
}

/**
 * Add nested scene flag updates using dot paths so particle/filter row additions and deletion operators can be committed alongside transient render options in one Scene update.
 *
 * @param {object} target
 * @param {string} flagName
 * @param {object} flagUpdate
 * @returns {boolean} Whether any entries were added.
 */
function addSceneFlagBucketUpdates(target, flagName, flagUpdate) {
  const entries = Object.entries(flagUpdate ?? {});
  for (const [key, value] of entries) target["flags." + packageId + "." + flagName + "." + key] = value;
  return entries.length > 0;
}

/**
 * Commit API-effect particle/filter flag changes, optionally attaching a one-shot no-fade instruction consumed by updateScene hooks on every client.
 *
 * @param {Scene} scene
 * @param {{particleUpdate?: object, filterUpdate?: object, stack?: Array<{uid:string}>|null, toggleGroupUpdate?: object, skipFading?: boolean}} [opts]
 * @returns {Promise<boolean>} True when a scene update was committed.
 */
async function commitApiEffectsSceneUpdate(
  scene,
  { particleUpdate = {}, filterUpdate = {}, stack = null, toggleGroupUpdate = {}, skipFading = false } = {},
) {
  if (!scene) return false;

  const updateData = {};
  const particlesChanged = addSceneFlagBucketUpdates(updateData, "effects", particleUpdate);
  const filtersChanged = addSceneFlagBucketUpdates(updateData, "filters", filterUpdate);

  if (Array.isArray(stack)) updateData["flags." + packageId + ".stack"] = stack;

  addSceneFlagBucketUpdates(updateData, API_EFFECT_TOGGLE_GROUPS_FLAG, toggleGroupUpdate);

  if (particlesChanged || filtersChanged) {
    updateData["flags." + packageId + "." + API_EFFECT_UPDATE_OPTIONS_FLAG] = {
      skipFading: skipFading === true,
      nonce: createApiEffectsUpdateNonce(),
    };
  }

  if (!Object.keys(updateData).length) return false;
  await scene.update(updateData);
  return true;
}

/**
 * Normalize a generic API effect entry into a scene flag payload.
 *
 * @param {object} entry
 * @param {Scene|null|undefined} scene
 * @returns {{kind:"particle"|"filter", info: object, requestedId: string|null}|null}
 */
function normalizeGenericApiEffectEntry(entry, scene) {
  if (!entry || typeof entry !== "object") return null;

  const kind = normalizeApiEffectKind(entry.kind);
  if (!kind) return null;

  const raw = entry.info && typeof entry.info === "object" ? entry.info : entry;
  const requestedId = normalizeRequestedApiEffectId(kind, entry.id ?? entry.effectId ?? raw?.id ?? raw?.effectId);
  const info = raw && typeof raw === "object" ? deepClone(raw) : {};
  delete info.kind;
  delete info.info;
  delete info.uid;
  delete info.id;
  delete info.effectId;
  delete info.skipFading;
  delete info.toggleKey;
  delete info.apiToggleKey;

  const type = String(info.type ?? "").trim();
  if (!type) return null;

  info.type = type;
  info.options = ensureSingleSceneLevelSelection(
    info.options && typeof info.options === "object" ? { ...info.options } : {},
    scene,
  );

  return { kind, info, requestedId };
}

/**
 * Normalize arbitrary effect definition input to an array while treating a single object as one requested effect.
 *
 * @param {*} value
 * @returns {Array<*>}
 */
function arrayifyApiEffectEntryInput(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Build the ordered generic API effect entry list from either an explicit ordered `effects` array or separate particle/filter arrays.
 *
 * @param {{effects?: object|Array<object>, particles?: object|Array<object>, filters?: object|Array<object>}} args
 * @returns {Array<object>}
 */
function getGenericApiEffectEntries(args = {}) {
  if (args?.effects !== null && args?.effects !== undefined) return arrayifyApiEffectEntryInput(args.effects);

  const entries = [];
  for (const p of arrayifyApiEffectEntryInput(args?.particles))
    entries.push({ kind: "particle", ...(p && typeof p === "object" ? p : {}) });
  for (const f of arrayifyApiEffectEntryInput(args?.filters))
    entries.push({ kind: "filter", ...(f && typeof f === "object" ? f : {}) });
  return entries;
}

/**
 * Add arbitrary particle/filter effects through the API-effects scene path.
 *
 * By default, this creates fresh non-core effect ids so identical payloads can be played multiple times. Explicit API-managed ids are preserved when provided, allowing saved macros to reference stable stop ids. Added entries appear in the API Effects management window and do not toggle or replace the built-in scene-manager rows. When an ordered `effects` array is supplied, its order is treated as the requested FX stack order from top to bottom and is preserved when the newly-created API rows are promoted into the scene stack.
 *
 * @param {{effects?: ApiEffectPlayEntry[], particles?: object[], filters?: object[], scene?: Scene|string, skipFading?: boolean, apiToggleKey?: string|null}} [args]
 * @returns {Promise<{particles: string[], filters: string[]}|false>} Created ids by kind, or false when no scene is available.
 */
export async function playApiEffects({
  effects = null,
  particles = [],
  filters = [],
  scene = null,
  skipFading = false,
  apiToggleKey = null,
} = {}) {
  const sc = scene ? resolveScene(scene) : canvas?.scene;
  if (!sc) return false;

  const entries = getGenericApiEffectEntries({ effects, particles, filters })
    .map((entry) => normalizeGenericApiEffectEntry(entry, sc))
    .filter(Boolean);

  if (!entries.length) return { particles: [], filters: [] };

  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  const usedParticleIds = new Set(Object.keys(curParticles));
  const usedFilterIds = new Set(Object.keys(curFilters));
  const assignedParticleIds = new Set();
  const assignedFilterIds = new Set();
  const particleUpdate = {};
  const filterUpdate = {};
  const promotedUids = [];
  const created = { particles: [], filters: [] };

  const assignRequestedOrGeneratedId = (kind, requestedId) => {
    const usedIds = kind === "particle" ? usedParticleIds : usedFilterIds;
    const assignedIds = kind === "particle" ? assignedParticleIds : assignedFilterIds;
    const normalizedRequestedId = normalizeRequestedApiEffectId(kind, requestedId);

    if (normalizedRequestedId && !assignedIds.has(normalizedRequestedId)) {
      assignedIds.add(normalizedRequestedId);
      usedIds.add(normalizedRequestedId);
      return normalizedRequestedId;
    }

    const generatedId = createGenericApiEffectId(kind, usedIds);
    assignedIds.add(generatedId);
    return generatedId;
  };

  for (const { kind, info, requestedId } of entries) {
    if (kind === "particle") {
      const id = assignRequestedOrGeneratedId(kind, requestedId);
      particleUpdate[id] = info;
      promotedUids.push(buildSceneEffectUid("particle", id));
      created.particles.push(id);
      continue;
    }

    const id = assignRequestedOrGeneratedId(kind, requestedId);
    filterUpdate[id] = info;
    promotedUids.push(buildSceneEffectUid("filter", id));
    created.filters.push(id);
  }

  const toggleGroupUpdate = apiToggleKey ? { [apiToggleKey]: created } : {};
  await commitApiEffectsSceneUpdate(sc, { particleUpdate, filterUpdate, toggleGroupUpdate, skipFading });

  await promoteEffectStackUids(promotedUids, sc);

  return created;
}

/**
 * Normalize arbitrary input to an array while treating a single string/object as one requested id/row.
 *
 * @param {*} value
 * @returns {Array<*>}
 */
function arrayifyApiEffectStopInput(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse a scene effect stack UID such as "scene:particle:apiMacro_abc_p".
 *
 * @param {string} uid
 * @returns {{kind:"particle"|"filter", id:string}|null}
 */
function parseSceneApiEffectUid(uid) {
  if (typeof uid !== "string") return null;
  const parts = uid.split(":");
  if (parts[0] !== "scene" || parts.length < 3) return null;
  const kind = normalizeApiEffectKind(parts[1]);
  if (!kind) return null;
  const id = parts.slice(2).join(":").trim();
  return id ? { kind, id } : null;
}

/**
 * Extract an API-effect id/kind from a stop request item.
 *
 * @param {*} item
 * @param {"particle"|"filter"|null} [forcedKind]
 * @returns {{kind:"particle"|"filter"|null, id:string}|null}
 */
function normalizeApiEffectStopItem(item, forcedKind = null) {
  if (item === null || item === undefined) return null;

  if (typeof item === "string") {
    const parsed = parseSceneApiEffectUid(item);
    if (parsed) return { kind: forcedKind ?? parsed.kind, id: parsed.id };
    const id = item.trim();
    return id ? { kind: forcedKind, id } : null;
  }

  if (typeof item !== "object") return null;

  const uid = typeof item.uid === "string" ? parseSceneApiEffectUid(item.uid) : null;
  if (uid) return { kind: forcedKind ?? uid.kind, id: uid.id };

  const kind = forcedKind ?? normalizeApiEffectKind(item.kind);
  const id = String(item.id ?? item.effectId ?? item.key ?? "").trim();
  return id ? { kind, id } : null;
}

/**
 * Collect particle/filter ids from a stop request.
 *
 * @param {object|string|Array<*>} args
 * @returns {{particleIds:Set<string>, filterIds:Set<string>, unknownIds:Set<string>}}
 */
function collectApiEffectStopIds(args = {}) {
  const particleIds = new Set();
  const filterIds = new Set();
  const unknownIds = new Set();

  const add = (item, forcedKind = null) => {
    const normalized = normalizeApiEffectStopItem(item, forcedKind);
    if (!normalized) return;
    if (normalized.kind === "particle") particleIds.add(normalized.id);
    else if (normalized.kind === "filter") filterIds.add(normalized.id);
    else unknownIds.add(normalized.id);
  };

  const source = typeof args === "string" || Array.isArray(args) ? { effects: args } : args ?? {};
  for (const item of arrayifyApiEffectStopInput(source.particles)) add(item, "particle");
  for (const item of arrayifyApiEffectStopInput(source.filters)) add(item, "filter");
  for (const item of arrayifyApiEffectStopInput(source.effects)) add(item, null);
  for (const item of arrayifyApiEffectStopInput(source.ids)) add(item, null);

  if (!particleIds.size && !filterIds.size && !unknownIds.size) {
    const single = normalizeApiEffectStopItem(source, null);
    if (single?.kind === "particle") particleIds.add(single.id);
    else if (single?.kind === "filter") filterIds.add(single.id);
    else if (single?.id) unknownIds.add(single.id);
  }

  return { particleIds, filterIds, unknownIds };
}

/**
 * Build arguments for scoped convenience stop helpers.
 *
 * @param {"particles"|"filters"} property
 * @param {*} value
 * @param {object} [opts]
 * @returns {object}
 */
function buildScopedApiEffectStopArgs(property, value = [], opts = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const hasEnvelope = ["particles", "filters", "effects", "ids", "scene", "skipFading", "toggleGroupUpdate"].some(
      (key) => key in value,
    );
    if (hasEnvelope) {
      return {
        scene: opts.scene ?? value.scene,
        skipFading: opts.skipFading ?? value.skipFading,
        toggleGroupUpdate: opts.toggleGroupUpdate ?? value.toggleGroupUpdate,
        [property]: value[property] ?? value.effects ?? value.ids ?? [],
      };
    }
  }

  return { ...(opts ?? {}), [property]: value };
}

/**
 * Remove arbitrary API-created particle/filter effects through the API-effects scene path.
 *
 * The expected input is the object returned by `FXMASTER.api.effects.play`, an object containing `particles` and/or `filters` id arrays, or the same effect payload definitions used for `play`/`toggle`.
 *
 * @param {object|string|Array<*>} [args]
 * @param {{scene?: Scene|string, skipFading?: boolean, toggleGroupUpdate?: object}} [opts]
 * @returns {Promise<{particles: string[], filters: string[]}|false>} Removed ids by kind, or false when no scene is available.
 */
export async function stopApiEffects(args = {}, opts = {}) {
  const source = typeof args === "string" || Array.isArray(args) ? { effects: args } : args ?? {};
  const scene = opts.scene ?? source.scene ?? null;
  const skipFading = opts.skipFading ?? source.skipFading ?? false;
  const toggleGroupUpdate = opts.toggleGroupUpdate ?? source.toggleGroupUpdate ?? {};
  const sc = scene ? resolveScene(scene) : canvas?.scene;
  if (!sc) return false;

  const { particleIds, filterIds, unknownIds } = collectApiEffectStopIds(source);
  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  if (!particleIds.size && !filterIds.size && !unknownIds.size) {
    const entries = getGenericApiEffectEntries(source)
      .map((entry) => normalizeGenericApiEffectEntry(entry, sc))
      .filter(Boolean);

    if (!entries.length) {
      await commitApiEffectsSceneUpdate(sc, { toggleGroupUpdate });
      return { particles: [], filters: [] };
    }

    const matchingIds = collectMatchingApiEffectIds(entries, curParticles, curFilters);
    if (matchingIds.fullMatch) {
      for (const id of matchingIds.particles) particleIds.add(id);
      for (const id of matchingIds.filters) filterIds.add(id);
    } else {
      await commitApiEffectsSceneUpdate(sc, { toggleGroupUpdate });
      return { particles: [], filters: [] };
    }
  }
  const particleUpdate = {};
  const filterUpdate = {};
  const removed = { particles: [], filters: [] };
  const removedParticleIds = new Set();
  const removedFilterIds = new Set();

  const deleteParticle = (id) => {
    if (!id || !(id in curParticles) || removedParticleIds.has(id)) return;
    addDeletionKey(particleUpdate, id);
    removedParticleIds.add(id);
    removed.particles.push(id);
  };
  const deleteFilter = (id) => {
    if (!id || !(id in curFilters) || removedFilterIds.has(id)) return;
    addDeletionKey(filterUpdate, id);
    removedFilterIds.add(id);
    removed.filters.push(id);
  };

  for (const id of particleIds) deleteParticle(id);
  for (const id of filterIds) deleteFilter(id);
  for (const id of unknownIds) {
    deleteParticle(id);
    deleteFilter(id);
  }

  const removedUids = [
    ...removed.particles.map((id) => buildSceneEffectUid("particle", id)),
    ...removed.filters.map((id) => buildSceneEffectUid("filter", id)),
  ];

  let nextStack = null;
  if (removedUids.length) {
    const removeSet = new Set(removedUids);
    const currentStack = sc.getFlag?.(packageId, "stack");
    if (Array.isArray(currentStack)) {
      const filtered = currentStack.filter((entry) => !removeSet.has(entry?.uid));
      if (filtered.length !== currentStack.length) nextStack = filtered;
    }
  }

  await commitApiEffectsSceneUpdate(sc, {
    particleUpdate,
    filterUpdate,
    stack: nextStack,
    toggleGroupUpdate,
    skipFading,
  });
  return removed;
}

/**
 * Toggle an arbitrary API-created particle/filter effect group on or off.
 *
 * The first call creates a fresh API-effect group. Later calls with the same effect payload, or the same explicit `toggleKey`, remove the ids created for that group.
 *
 * @param {{effects?: ApiEffectPlayEntry[], particles?: object[], filters?: object[], scene?: Scene|string, skipFading?: boolean, toggleKey?: string, key?: string, id?: string, name?: string}} [args]
 * @param {{scene?: Scene|string, skipFading?: boolean, toggleKey?: string, key?: string, id?: string, name?: string}} [opts]
 * @returns {Promise<{active: boolean, action: "play"|"stop", particles: string[], filters: string[]}|false>} Toggle result, or false when no scene is available.
 */
export async function toggleApiEffects(args = {}, opts = {}) {
  const source = typeof args === "string" || Array.isArray(args) ? { effects: args } : args ?? {};
  const scene = opts.scene ?? source.scene ?? null;
  const skipFading = opts.skipFading ?? source.skipFading ?? false;
  const explicitToggleKey =
    opts.toggleKey ??
    opts.key ??
    opts.id ??
    opts.name ??
    source.toggleKey ??
    source.key ??
    source.id ??
    source.name ??
    null;
  const sc = scene ? resolveScene(scene) : canvas?.scene;
  if (!sc) return false;

  const entries = getGenericApiEffectEntries(source)
    .map((entry) => normalizeGenericApiEffectEntry(entry, sc))
    .filter(Boolean);

  if (!entries.length) return { active: false, action: "stop", particles: [], filters: [] };

  const toggleKey = createApiEffectToggleKey(entries, explicitToggleKey);
  const groups = sc.getFlag?.(packageId, API_EFFECT_TOGGLE_GROUPS_FLAG) ?? {};
  const activeIds = getActiveApiEffectToggleGroupIds(sc, groups?.[toggleKey]);

  if (activeIds.particles.length || activeIds.filters.length) {
    const toggleGroupUpdate = {};
    addDeletionKey(toggleGroupUpdate, toggleKey);
    const stopped = await stopApiEffects(
      { particles: activeIds.particles, filters: activeIds.filters, scene: sc, skipFading },
      { toggleGroupUpdate },
    );
    return { active: false, action: "stop", particles: stopped?.particles ?? [], filters: stopped?.filters ?? [] };
  }

  const matchingIds = collectMatchingApiEffectIds(
    entries,
    sc.getFlag?.(packageId, "effects") ?? {},
    sc.getFlag?.(packageId, "filters") ?? {},
  );
  if (matchingIds.fullMatch) {
    const toggleGroupUpdate = {};
    addDeletionKey(toggleGroupUpdate, toggleKey);
    const stopped = await stopApiEffects(
      { particles: matchingIds.particles, filters: matchingIds.filters, scene: sc, skipFading },
      { toggleGroupUpdate },
    );
    return { active: false, action: "stop", particles: stopped?.particles ?? [], filters: stopped?.filters ?? [] };
  }

  const played = await playApiEffects({
    effects: denormalizeApiEffectEntries(entries),
    scene: sc,
    skipFading,
    apiToggleKey: toggleKey,
  });

  return { active: true, action: "play", particles: played?.particles ?? [], filters: played?.filters ?? [] };
}

/**
 * Convenience helper for removing API-created particle effects by id.
 *
 * @param {*} [particles]
 * @param {{scene?: Scene|string, skipFading?: boolean}} [opts]
 * @returns {Promise<{particles: string[], filters: string[]}|false>}
 */
export async function stopApiParticleEffects(particles = [], opts = {}) {
  return stopApiEffects(buildScopedApiEffectStopArgs("particles", particles, opts));
}

/**
 * Convenience helper for removing API-created filter effects by id.
 *
 * @param {*} [filters]
 * @param {{scene?: Scene|string, skipFading?: boolean}} [opts]
 * @returns {Promise<{particles: string[], filters: string[]}|false>}
 */
export async function stopApiFilterEffects(filters = [], opts = {}) {
  return stopApiEffects(buildScopedApiEffectStopArgs("filters", filters, opts));
}

/**
 * Build arguments for scoped convenience toggle helpers.
 *
 * @param {"particles"|"filters"} property
 * @param {*} value
 * @param {object} [opts]
 * @returns {object}
 */
function buildScopedApiEffectToggleArgs(property, value = [], opts = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const hasEnvelope = [
      "particles",
      "filters",
      "effects",
      "ids",
      "scene",
      "skipFading",
      "toggleKey",
      "key",
      "id",
      "name",
    ].some((key) => key in value);
    if (hasEnvelope) {
      return {
        scene: opts.scene ?? value.scene,
        skipFading: opts.skipFading ?? value.skipFading,
        toggleKey: opts.toggleKey ?? value.toggleKey,
        key: opts.key ?? value.key,
        id: opts.id ?? value.id,
        name: opts.name ?? value.name,
        [property]: value[property] ?? value.effects ?? value.ids ?? [],
      };
    }
  }

  return { ...(opts ?? {}), [property]: value };
}

/**
 * Convenience helper for toggling API-created particle effects.
 *
 * @param {*} [particles]
 * @param {{scene?: Scene|string, skipFading?: boolean, toggleKey?: string, key?: string, id?: string, name?: string}} [opts]
 * @returns {Promise<{active: boolean, action: "play"|"stop", particles: string[], filters: string[]}|false>}
 */
export async function toggleApiParticleEffects(particles = [], opts = {}) {
  return toggleApiEffects(buildScopedApiEffectToggleArgs("particles", particles, opts));
}

/**
 * Convenience helper for toggling API-created filter effects.
 *
 * @param {*} [filters]
 * @param {{scene?: Scene|string, skipFading?: boolean, toggleKey?: string, key?: string, id?: string, name?: string}} [opts]
 * @returns {Promise<{active: boolean, action: "play"|"stop", particles: string[], filters: string[]}|false>}
 */
export async function toggleApiFilterEffects(filters = [], opts = {}) {
  return toggleApiEffects(buildScopedApiEffectToggleArgs("filters", filters, opts));
}

/**
 * Normalize the scene Level collection into an array.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<any>}
 */
function getSceneLevels(scene) {
  const levels = [];
  const seen = new Set();

  const push = (level) => {
    if (!level) return;
    const id = String(level?.id ?? level?._id ?? "").trim();
    const looksLikeLevel =
      !!id || "elevation" in Object(level) || "isView" in Object(level) || "isVisible" in Object(level);
    if (!looksLikeLevel) return;
    const key = id || level;
    if (seen.has(key)) return;
    seen.add(key);
    levels.push(level);
  };

  const pushAll = (value) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(push);
    if (typeof value?.toArray === "function") return value.toArray().forEach(push);
    if (typeof value?.values === "function") return Array.from(value.values()).forEach(push);
    try {
      return Array.from(value).forEach(push);
    } catch (_err) {
      push(value);
    }
  };

  pushAll(scene?.levels?.contents ?? scene?.levels ?? null);

  try {
    pushAll(scene?.getEmbeddedCollection?.("Level"));
  } catch (_err) {
    /** Ignore Foundry accessors that are unavailable in older versions. */
  }

  try {
    push(scene?.initialLevel);
  } catch (_err) {
    /** Ignore Foundry accessors that are unavailable in older versions. */
  }

  try {
    push(scene?.firstLevel);
  } catch (_err) {
    /** Ignore Foundry accessors that are unavailable in older versions. */
  }

  try {
    if (!scene?.id || canvas?.scene?.id === scene.id) push(canvas?.level);
  } catch (_err) {
    /** Ignore canvas level access when the canvas is not ready. */
  }

  try {
    pushAll(scene?.availableLevels);
  } catch (_err) {
    /** Available levels are a useful V14 fallback, but may depend on user/canvas state. */
  }

  return levels;
}

function getSceneLevelIds(scene) {
  return Array.from(
    new Set(
      getSceneLevels(scene)
        .map((level) => String(level?.id ?? level?._id ?? "").trim())
        .filter(Boolean),
    ),
  );
}

/**
 * Normalize a user-provided Level matcher for preset API comparisons.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function normalizePresetLevelMatcher(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Return whether a user-provided preset Level selector matches a native Level document.
 *
 * @param {any} level
 * @param {string} matcher
 * @returns {boolean}
 */
function presetLevelMatches(level, matcher) {
  if (!matcher) return false;

  const candidates = [level?.id, level?.name, level?.label, level?._source?.name, level?._source?.label, level?.title];

  return candidates.some((candidate) => normalizePresetLevelMatcher(candidate) === matcher);
}

/**
 * Resolve a preset API level selector into native scene Level ids.
 *
 * Empty selections, single-level selections, and selections that cover every scene level collapse to [] because [] is FXMaster's "all levels" scope. That keeps one-level V14 scenes on the same compositor path as unscoped scene effects.
 *
 * @param {PresetLevelsValue|null|undefined} value
 * @param {Scene|null|undefined} scene
 * @returns {string[]}
 */
function resolvePresetLevelSelection(value, scene) {
  if (value == null || value === "") return [];

  const levels = getSceneLevels(scene);
  const sceneLevelIds = getSceneLevelIds(scene);
  if (!levels.length || sceneLevelIds.length <= 1) return [];

  const requested = (Array.isArray(value) ? value : [value])
    .map((entry) => normalizePresetLevelMatcher(entry))
    .filter(Boolean);
  if (!requested.length) return [];

  const resolved = [];
  const seen = new Set();

  for (const matcher of requested) {
    const match = levels.find((level) => presetLevelMatches(level, matcher));
    const levelId = String(match?.id ?? match?._id ?? "").trim();
    if (!levelId || seen.has(levelId)) continue;
    seen.add(levelId);
    resolved.push(levelId);
  }

  return resolved.length && resolved.length < sceneLevelIds.length ? resolved : [];
}

/**
 * Apply top-level overrides to a particle or filter options object.
 *
 * @param {object} options
 * @param {{ topDown?: boolean, belowTokens?: boolean, belowTiles?: boolean, belowForeground?: boolean, darknessActivationEnabled?: boolean, darknessActivationMin?: number, darknessActivationMax?: number, directionDeg?: number|null, soundFx?: boolean, speedScale?: number, densityScale?: number, levels?: PresetLevelsValue, }} overrides
 * @param {{ plusActive: boolean, scene?: Scene|null }} ctx
 * @param {{kind?: "particles"|"filters", type?: string}} meta
 * @returns {object}
 */
function applyOptionOverrides(options = {}, overrides = {}, { plusActive, scene = null } = {}, meta = {}) {
  const out = options && typeof options === "object" ? options : {};

  if (typeof overrides.topDown === "boolean") out.topDown = overrides.topDown;
  if (typeof overrides.belowTokens === "boolean") out.belowTokens = overrides.belowTokens;
  if (typeof overrides.belowTiles === "boolean") out.belowTiles = overrides.belowTiles;
  if (typeof overrides.belowForeground === "boolean") out.belowForeground = overrides.belowForeground;

  const resolvedLevels = resolvePresetLevelSelection(overrides.levels, scene);
  if (resolvedLevels.length) out.levels = resolvedLevels;
  else delete out.levels;

  const hasExplicitDarknessActivationEnabled = typeof overrides.darknessActivationEnabled === "boolean";
  const hasDarknessActivationMin = Number.isFinite(overrides.darknessActivationMin);
  const hasDarknessActivationMax = Number.isFinite(overrides.darknessActivationMax);
  if (hasExplicitDarknessActivationEnabled) {
    out.darknessActivationEnabled = overrides.darknessActivationEnabled;
  }
  if (hasDarknessActivationMin || hasDarknessActivationMax) {
    const currentRange = normalizeDarknessActivationRange(out.darknessActivationRange);
    out.darknessActivationRange = normalizeDarknessActivationRange({
      min: hasDarknessActivationMin ? overrides.darknessActivationMin : currentRange.min,
      max: hasDarknessActivationMax ? overrides.darknessActivationMax : currentRange.max,
    });
    if (!hasExplicitDarknessActivationEnabled) out.darknessActivationEnabled = true;
  }

  if (typeof overrides.soundFx === "boolean") {
    out.soundFxEnabled = plusActive ? overrides.soundFx : false;
  } else if (!plusActive && "soundFxEnabled" in out) {
    out.soundFxEnabled = false;
  }

  if (typeof overrides.speedScale === "number" && Number.isFinite(overrides.speedScale) && overrides.speedScale !== 1) {
    if (typeof out.speed === "number" && Number.isFinite(out.speed)) {
      out.speed = clampAndQuantizeForEffect(meta, "speed", out.speed * overrides.speedScale);
    }
  }
  if (
    typeof overrides.densityScale === "number" &&
    Number.isFinite(overrides.densityScale) &&
    overrides.densityScale !== 1
  ) {
    if (typeof out.density === "number" && Number.isFinite(out.density)) {
      out.density = clampAndQuantizeForEffect(meta, "density", out.density * overrides.densityScale);
    }
  }

  if (typeof overrides.colorHex === "string" && overrides.colorHex) {
    const hex = overrides.colorHex;

    if (meta.kind === "particles") {
      out.tint = {
        ...(out.tint && typeof out.tint === "object" ? out.tint : {}),
        apply: true,
        value: hex,
      };

      if ("rainbow" in out) out.rainbow = false;
    }

    if (meta.kind === "filters") {
      const setColorObj = (k) => {
        const v = out?.[k];
        if (v && typeof v === "object" && "apply" in v && "value" in v) {
          out[k] = { ...(v ?? {}), apply: true, value: hex };
          return true;
        }
        if (typeof v === "string") {
          out[k] = { apply: true, value: hex };
          return true;
        }
        return false;
      };

      if ("color" in out) setColorObj("color");
      if ("tint" in out) setColorObj("tint");

      for (const [k, v] of Object.entries(out ?? {})) {
        const lk = String(k).toLowerCase();
        const looksColorish = lk.includes("tint") || lk.includes("color");
        if (!looksColorish) continue;
        if (k === "color" || k === "tint") continue;
        if (v && typeof v === "object" && "apply" in v && "value" in v && typeof v.value === "string") {
          out[k] = { ...(v ?? {}), apply: true, value: hex };
        }
      }
    }
  }

  if (typeof overrides.directionDeg === "number" && Number.isFinite(overrides.directionDeg)) {
    const dir = overrides.directionDeg;

    /** Route direction overrides through sunlight angle conversion. */
    if (meta.kind === "filters" && meta.type === "sunlight") {
      const parallel = typeof out.parallel === "boolean" ? out.parallel : true;
      out.angle = sunlightAngleFromDirection(dir, parallel);
      return out;
    }
    /** Apply direction overrides to both glitch direction channels. */
    if (meta.kind === "filters" && meta.type === "glitch") {
      out.direction = dir;
      out.glyphDirection = dir;
      return out;
    }

    /** Apply the default direction override. */
    out.direction = dir;
  }

  return out;
}

/**
 * Build stable scene-flag keys for a preset.
 * @param {string} presetName normalized preset name
 * @returns {{ particlePrefix: string, filterPrefix: string }}
 */
function keyPrefixesForPreset(presetName) {
  const safe = normalizePresetName(presetName).replace(/[^a-z0-9_-]/g, "-");
  return {
    particlePrefix: `${KEY_PREFIX}${safe}_p`,
    filterPrefix: `${KEY_PREFIX}${safe}_f`,
  };
}

/**
 * Determine if a stored scene flag entry looks like a valid FXMaster effect info object.
 * @param {*} info
 * @returns {boolean}
 */
function isValidEffectInfo(info) {
  return !!(info && typeof info === "object" && typeof info.type === "string" && info.type.trim());
}

/**
 * Remove all scene FX created by this preset API for the given preset name.
 *
 * @param {string} name
 * @param {{ scene?: any }} [opts]
 * @returns {Promise<boolean>}
 */
export async function stopPreset(name, { scene = null } = {}) {
  const presetName = normalizePresetName(name);
  const sc = scene ? resolveScene(scene) : canvas?.scene;
  if (!sc) return false;

  const { particlePrefix, filterPrefix } = keyPrefixesForPreset(presetName);

  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  const particleUpdate = {};
  const filterUpdate = {};

  for (const k of Object.keys(curParticles)) {
    if (
      k.startsWith(particlePrefix) ||
      ((k.startsWith("-=") || k.startsWith("==")) && k.slice(2).startsWith(particlePrefix))
    ) {
      addDeletionKey(particleUpdate, k);
    }
  }
  for (const k of Object.keys(curFilters)) {
    if (
      k.startsWith(filterPrefix) ||
      ((k.startsWith("-=") || k.startsWith("==")) && k.slice(2).startsWith(filterPrefix))
    ) {
      addDeletionKey(filterUpdate, k);
    }
  }

  const promises = [];
  if (Object.keys(particleUpdate).length) promises.push(sc.setFlag(packageId, "effects", particleUpdate));
  if (Object.keys(filterUpdate).length) promises.push(sc.setFlag(packageId, "filters", filterUpdate));

  if (!promises.length) return true;
  await Promise.all(promises);
  return true;
}

/**
 * Play (apply) a preset by name onto the current scene.
 *
 * This only manages keys created by this preset API (`apiPreset_*`) and will not modify core FXMaster `core_*` scene effects.
 *
 * @param {string} name
 * @param {PresetPlayOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function playPreset(
  name,
  {
    topDown = false,
    direction = undefined,
    color = undefined,
    speed = undefined,
    density = undefined,
    belowTokens = undefined,
    belowTiles = false,
    belowForeground = false,
    darknessActivationEnabled = undefined,
    darknessActivationMin = undefined,
    darknessActivationMax = undefined,
    soundFx = undefined,
    levels = undefined,
    scene = null,
    silent = true,
  } = {},
) {
  const sc = scene ? resolveScene(scene) : canvas?.scene;
  if (!sc) return false;

  const resolved = resolvePresetVariant(name, { topDown });
  if (!resolved) {
    const msg = game.i18n.format("FXMASTER.API.PresetNotFound", { name });
    logger.warn(msg);
    if (!silent) ui?.notifications?.warn?.(msg);
    return false;
  }

  const plusActive = hasFxmasterPlus();

  const particles = deepClone(resolved.variant?.particles ?? []);
  const filters = deepClone(resolved.variant?.filters ?? []);

  const directionDeg = parseDirectionDegrees(direction);

  const colorInfo = parseHexColor(color);
  if (colorInfo.provided && !colorInfo.valid) {
    const msg = game.i18n.format("FXMASTER.API.InvalidColor", { color });
    logger.warn(msg);
    if (!silent) ui?.notifications?.warn?.(msg);
  }

  const speedScaleInfo = parseRelativeLevelMultiplier(speed);
  const densityScaleInfo = parseRelativeLevelMultiplier(density);

  if (speedScaleInfo.provided && !speedScaleInfo.valid) {
    const msg = game.i18n.format("FXMASTER.API.InvalidSpeedLevel", { speed });
    logger.warn(msg);
    if (!silent) ui?.notifications?.warn?.(msg);
  }
  if (densityScaleInfo.provided && !densityScaleInfo.valid) {
    const msg = game.i18n.format("FXMASTER.API.InvalidDensityLevel", { density });
    logger.warn(msg);
    if (!silent) ui?.notifications?.warn?.(msg);
  }

  const overrides = {
    topDown,
    belowTokens,
    belowTiles,
    belowForeground,
    darknessActivationEnabled,
    darknessActivationMin,
    darknessActivationMax,
    directionDeg,
    soundFx,
    levels,
    speedScale: speedScaleInfo.multiplier,
    densityScale: densityScaleInfo.multiplier,
    colorHex: colorInfo.hex,
  };
  for (const p of particles) {
    if (!p || typeof p !== "object") continue;
    p.options = applyOptionOverrides(
      p.options ?? {},
      overrides,
      { plusActive, scene: sc },
      { kind: "particles", type: p.type },
    );
  }
  for (const f of filters) {
    if (!f || typeof f !== "object") continue;
    f.options = applyOptionOverrides(
      f.options ?? {},
      overrides,
      { plusActive, scene: sc },
      { kind: "filters", type: f.type },
    );
  }

  const presetName = resolved.presetName;
  const { particlePrefix, filterPrefix } = keyPrefixesForPreset(presetName);

  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  const particleUpdate = {};
  const filterUpdate = {};

  const nextParticleKeys = new Set(particles.map((_, i) => `${particlePrefix}${i}`));
  const nextFilterKeys = new Set(filters.map((_, i) => `${filterPrefix}${i}`));

  for (const k of Object.keys(curParticles)) {
    if ((k.startsWith("-=") || k.startsWith("==")) && k.slice(2).startsWith(particlePrefix)) {
      addDeletionKey(particleUpdate, k);
      continue;
    }

    if (!k.startsWith(particlePrefix)) continue;

    if (!nextParticleKeys.has(k) || !isValidEffectInfo(curParticles[k])) addDeletionKey(particleUpdate, k);
  }
  for (const k of Object.keys(curFilters)) {
    if ((k.startsWith("-=") || k.startsWith("==")) && k.slice(2).startsWith(filterPrefix)) {
      addDeletionKey(filterUpdate, k);
      continue;
    }

    if (!k.startsWith(filterPrefix)) continue;
    if (!nextFilterKeys.has(k) || !isValidEffectInfo(curFilters[k])) addDeletionKey(filterUpdate, k);
  }

  for (let i = 0; i < particles.length; i++) {
    const key = `${particlePrefix}${i}`;
    particleUpdate[key] = particles[i];
  }
  for (let i = 0; i < filters.length; i++) {
    const key = `${filterPrefix}${i}`;
    filterUpdate[key] = filters[i];
  }

  const promises = [];
  if (Object.keys(particleUpdate).length) promises.push(sc.setFlag(packageId, "effects", particleUpdate));
  if (Object.keys(filterUpdate).length) promises.push(sc.setFlag(packageId, "filters", filterUpdate));

  await Promise.all(promises);

  const promotedUids = [
    ...particles.map((_, i) => buildSceneEffectUid("particle", `${particlePrefix}${i}`)),
    ...filters.map((_, i) => buildSceneEffectUid("filter", `${filterPrefix}${i}`)),
  ];
  await promoteEffectStackUids(promotedUids, sc);

  if (resolved.tier === "plus" && !plusActive) {
    const msg = game.i18n.format("FXMASTER.API.PlusPresetInactive", { name: presetName });
    logger.warn(msg);
    if (!silent) ui?.notifications?.warn?.(msg);
  }

  return true;
}

/**
 * Toggle a preset by name.
 *
 * - If the preset is currently active (any API-managed keys exist), stop it.
 * - Otherwise, play it.
 *
 * @param {string} name
 * @param {PresetPlayOptions} [opts]
 * @returns {Promise<boolean>} new enabled state (true=enabled, false=disabled)
 */
export async function togglePreset(name, opts = {}) {
  const sc = opts.scene ? resolveScene(opts.scene) : canvas?.scene;
  if (!sc) return false;

  const presetName = normalizePresetName(name);
  const { particlePrefix, filterPrefix } = keyPrefixesForPreset(presetName);

  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  const hasParticles = Object.keys(curParticles).some((k) => k.startsWith(particlePrefix));
  const hasFilters = Object.keys(curFilters).some((k) => k.startsWith(filterPrefix));
  const enabled = hasParticles || hasFilters;

  if (enabled) {
    await stopPreset(name, { scene: sc });
    return false;
  }

  await playPreset(name, { ...opts, scene: sc });
  return true;
}

/**
 * List all known preset names.
 * @returns {string[]}
 */
export function listPresets() {
  return [...(API_EFFECT_NAMES ?? [])];
}

/**
 * Return the preset names currently active on a scene (created by this preset API).
 *
 * @param {{ scene?: any }} [opts]
 * @returns {string[]} active preset names (normalized)
 */
export function listActivePresets({ scene = null } = {}) {
  const sc = scene ? resolveScene(scene) : canvas?.scene;
  if (!sc) return [];

  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  const names = new Set();

  const collect = (obj) => {
    for (const rawKey of Object.keys(obj ?? {})) {
      const key = rawKey.startsWith("-=") || rawKey.startsWith("==") ? rawKey.slice(2) : rawKey;
      const m = ACTIVE_KEY_RE.exec(key);
      if (m?.[1]) names.add(m[1]);
    }
  };

  collect(curParticles);
  collect(curFilters);

  return [...names].sort();
}

/**
 * List preset names that are currently valid for this world.
 *
 * A preset is considered "valid" if it can be resolved for the current module tier (free/plus) AND all referenced effect types are registered in CONFIG.fxmaster.
 *
 * By default this checks both normal and top-down variants; a preset is included if either is valid.
 *
 * @param {{ topDown?: boolean|null }} [opts]
 * @returns {string[]}
 */
export function listValidPresets({ topDown = null } = {}) {
  const names = new Set();
  const all = API_EFFECT_NAMES ?? Object.keys(API_EFFECTS ?? {});

  const isValidFor = (name, td) => {
    const resolved = resolvePresetVariant(name, { topDown: !!td });
    return !!(resolved && isVariantCompatible(resolved.variant));
  };

  for (const n of all) {
    const presetName = normalizePresetName(n);
    if (topDown === null) {
      if (isValidFor(presetName, false) || isValidFor(presetName, true)) names.add(presetName);
    } else {
      if (isValidFor(presetName, !!topDown)) names.add(presetName);
    }
  }

  return [...names].sort();
}

/**
 * Stop any active presets (created by this preset API) and then play the given preset.
 *
 * @param {string} name
 * @param {PresetPlayOptions} [opts] Same options as {@link playPreset}. If name is falsy, this only stops active presets.
 * @returns {Promise<boolean>}
 */
export async function switchPreset(name, opts = {}) {
  const sc = opts.scene ? resolveScene(opts.scene) : canvas?.scene;
  if (!sc) return false;

  const silent = opts?.silent !== false;

  if (name) {
    const topDown = !!opts.topDown;
    const resolved = resolvePresetVariant(name, { topDown });
    if (!resolved) {
      const msg = game.i18n.format("FXMASTER.API.PresetNotFound", { name });
      logger.warn(msg);
      if (!silent) ui?.notifications?.warn?.(msg);
      return false;
    }
  }

  const curParticles = sc.getFlag?.(packageId, "effects") ?? {};
  const curFilters = sc.getFlag?.(packageId, "filters") ?? {};

  const particleUpdate = {};
  const filterUpdate = {};

  for (const rawKey of Object.keys(curParticles)) {
    const key = rawKey.startsWith("-=") || rawKey.startsWith("==") ? rawKey.slice(2) : rawKey;
    if (ACTIVE_KEY_RE.test(key)) addDeletionKey(particleUpdate, rawKey);
  }
  for (const rawKey of Object.keys(curFilters)) {
    const key = rawKey.startsWith("-=") || rawKey.startsWith("==") ? rawKey.slice(2) : rawKey;
    if (ACTIVE_KEY_RE.test(key)) addDeletionKey(filterUpdate, rawKey);
  }

  const promises = [];
  if (Object.keys(particleUpdate).length) promises.push(sc.setFlag(packageId, "effects", particleUpdate));
  if (Object.keys(filterUpdate).length) promises.push(sc.setFlag(packageId, "filters", filterUpdate));
  if (promises.length) await Promise.all(promises);

  if (!name) return true;

  return await playPreset(name, { ...opts, scene: sc });
}

/**
 * Register this API onto the fxmaster module and global FXMASTER object. Call during init.
 */
export function registerPresetApi() {
  try {
    const mod = game?.modules?.get?.(packageId);
    if (!mod) return;

    mod.api ||= {};
    mod.api.presets ||= {};
    mod.api.effects ||= {};

    Object.assign(mod.api.presets, {
      play: playPreset,
      stop: stopPreset,
      toggle: togglePreset,
      switch: switchPreset,
      list: listPresets,
      listActive: listActivePresets,
      listValid: listValidPresets,
      hasFxmasterPlus,
      hasFxmaster,
    });

    mod.api.effects.particles ||= {};
    mod.api.effects.filters ||= {};

    Object.assign(mod.api.effects, {
      play: playApiEffects,
      stop: stopApiEffects,
      toggle: toggleApiEffects,
    });

    Object.assign(mod.api.effects.particles, {
      stop: stopApiParticleEffects,
      toggle: toggleApiParticleEffects,
    });

    Object.assign(mod.api.effects.filters, {
      stop: stopApiFilterEffects,
      toggle: toggleApiFilterEffects,
    });

    try {
      globalThis.FXMASTER ||= {};
      globalThis.FXMASTER.api ||= {};
      globalThis.FXMASTER.api.presets = mod.api.presets;
      globalThis.FXMASTER.api.effects = mod.api.effects;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  } catch (err) {
    logger.error("Failed to register preset API", err);
  }
}
