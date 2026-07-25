import { normalizeDirectionDegrees } from "../utils.js";

const DIRECTION_SOURCE_PRIORITY = Object.freeze({
  wind: 30,
  duststorm: 20,
});

const sources = new Map();

function optionValue(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value === undefined ? fallback : value;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sourcePriority(type, fallback = 0) {
  return DIRECTION_SOURCE_PRIORITY[String(type ?? "")] ?? fallback;
}

function sourceLabel(entry) {
  const label = String(entry?.label ?? entry?.type ?? "");
  if (!label) return "";
  try {
    return String(game?.i18n?.localize?.(label) ?? label);
  } catch (_err) {
    return label;
  }
}

function activeSceneContext() {
  const sceneId = globalThis.canvas?.scene?.id ?? null;
  return sceneId ? { scope: "scene", sceneId } : null;
}

function entryContext(entry) {
  const explicit = entry?.context ?? null;
  if (explicit && typeof explicit === "object") return explicit;
  const instance = entry?.instance ?? null;
  const runtime =
    instance?.__fxmRuntimeContext ?? instance?.__fxmParticleContext ?? instance?.options?.__fxmParticleContext ?? null;
  return runtime && typeof runtime === "object" ? runtime : activeSceneContext();
}

function optionsContext(options = null) {
  if (options && typeof options === "object") {
    const runtime = options.__fxmRuntimeContext ?? options.__fxmParticleContext ?? null;
    if (runtime && typeof runtime === "object") return runtime;
  }
  return activeSceneContext();
}

function sameContext(sourceContext, requestedContext) {
  if (!requestedContext || typeof requestedContext !== "object") return true;
  const src = sourceContext && typeof sourceContext === "object" ? sourceContext : activeSceneContext();
  const reqScene = requestedContext.sceneId ?? activeSceneContext()?.sceneId ?? null;
  const srcScene = src?.sceneId ?? activeSceneContext()?.sceneId ?? null;
  if (reqScene && srcScene && reqScene !== srcScene) return false;

  const reqScope = String(requestedContext.scope ?? "scene");
  const srcScope = String(src?.scope ?? "scene");
  if (reqScope === "region") {
    if (srcScope !== "region") return false;
    const reqRegion = requestedContext.regionId ?? null;
    const srcRegion = src?.regionId ?? null;
    if (reqRegion && srcRegion && reqRegion !== srcRegion) return false;
    return true;
  }

  if (reqScope === "scene") return srcScope === "scene";
  return true;
}

function readSourceDirection(entry) {
  if (!entry) return null;
  const instance = entry.instance;
  if (!instance || instance.destroyed) return null;

  let value = null;
  try {
    if (typeof entry.getDirection === "function") value = entry.getDirection(instance);
    else if (Number.isFinite(Number(instance.effectiveDirection))) value = instance.effectiveDirection;
    else value = instance.direction;
  } catch (_err) {
    value = null;
  }

  const numeric = finiteNumber(value);
  return numeric === null ? null : normalizeDirectionDegrees(numeric, 0);
}

export function synchronizedDirectionAvailable() {
  try {
    return globalThis.game?.modules?.get?.("fxmaster-plus")?.active === true;
  } catch (_err) {
    return false;
  }
}

export function synchronizedDirectionOptionEnabled(options = {}) {
  if (!synchronizedDirectionAvailable()) return false;
  const raw = optionValue(options?.synchronizedDirection, false);
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || ["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
  }
  if (typeof raw === "number") return raw > 0;
  return raw === true;
}

export function shortestDirectionDeltaDegrees(from, to) {
  const a = normalizeDirectionDegrees(from, 0);
  const b = normalizeDirectionDegrees(to, 0);
  let delta = (b - a) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

export function lerpDirectionDegrees(from, to, t) {
  const amount = Math.max(0, Math.min(1, Number(t) || 0));
  return normalizeDirectionDegrees(
    normalizeDirectionDegrees(from, 0) + shortestDirectionDeltaDegrees(from, to) * amount,
    0,
  );
}

export function smoothDirectionBlend(t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  return x * x * (3 - 2 * x);
}

export class SynchronizedDirectionRuntime {
  static registerSource(instance, data = {}) {
    if (!instance) return null;
    const type = String(data.type ?? instance.constructor?.label ?? "direction");
    const entry = {
      instance,
      type,
      label: data.label ?? type,
      priority: Number.isFinite(Number(data.priority)) ? Number(data.priority) : sourcePriority(type, 0),
      getDirection: typeof data.getDirection === "function" ? data.getDirection : null,
      context: data.context && typeof data.context === "object" ? { ...data.context } : null,
      registeredAt: globalThis.performance?.now?.() ?? Date.now(),
    };
    sources.set(instance, entry);
    globalThis.Hooks?.callAll?.("fxmasterSynchronizedDirectionSourceChanged", this.activeSource);
    return entry;
  }

  static unregisterSource(instance) {
    if (!instance) return;
    const deleted = sources.delete(instance);
    if (deleted) globalThis.Hooks?.callAll?.("fxmasterSynchronizedDirectionSourceChanged", this.activeSource);
  }

  static get activeSource() {
    return this.getActiveSource();
  }

  static getActiveSource(context = null) {
    const requestedContext = context && typeof context === "object" ? context : null;
    let best = null;
    for (const entry of sources.values()) {
      if (!sameContext(entryContext(entry), requestedContext)) continue;
      const direction = readSourceDirection(entry);
      if (direction === null) continue;
      const candidate = { ...entry, context: entryContext(entry), direction };
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.priority > best.priority) {
        best = candidate;
        continue;
      }
      if (candidate.priority === best.priority && candidate.registeredAt > best.registeredAt) best = candidate;
    }
    return best;
  }

  static getDirection(fallback = 0, context = null) {
    const source = this.getActiveSource(context);
    if (!source) return normalizeDirectionDegrees(fallback, 0);
    return source.direction;
  }

  static resolveDirection(options = {}, fallback = 0, context = null) {
    if (!synchronizedDirectionOptionEnabled(options)) return normalizeDirectionDegrees(fallback, 0);
    const requestedContext = context && typeof context === "object" ? context : optionsContext(options);
    return this.getDirection(fallback, requestedContext);
  }

  static hasSource(context = null) {
    return !!this.getActiveSource(context);
  }

  static getSourceLabel(fallback = "", context = null) {
    const source = this.getActiveSource(context);
    return source ? sourceLabel(source) : fallback;
  }
}
