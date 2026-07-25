/**
 * Foundry Query transport for live and persisted particle-background
 * disturbances.
 *
 * Live queries keep connected viewers visually in step. A second query sends
 * the same compact movement segments to the active GM, which appends them to a
 * bounded Scene flag so late joiners and reloads can reconstruct the field.
 */

import { packageId } from "../../constants.js";
import { logger } from "../../logger.js";
import { particleBackgroundNow } from "./background-state.js";

export const PARTICLE_BACKGROUND_DISTURBANCE_QUERY = `${packageId}.particleBackgroundDisturbance`;
export const PARTICLE_BACKGROUND_DISTURBANCE_QUERY_VERSION = 1;
export const PARTICLE_BACKGROUND_PERSIST_QUERY = `${packageId}.persistParticleBackgroundDisturbance`;
export const PARTICLE_BACKGROUND_PERSIST_QUERY_VERSION = 1;
export const PARTICLE_BACKGROUND_QUERY_TIMEOUT_MS = 2500;
export const PARTICLE_BACKGROUND_PERSIST_QUERY_TIMEOUT_MS = 5000;
export const PARTICLE_BACKGROUND_MOVEMENT_HISTORY_FLAG = "particleBackgroundMovement";
export const PARTICLE_BACKGROUND_MOVEMENT_HISTORY_VERSION = 1;
export const PARTICLE_BACKGROUND_MOVEMENT_HISTORY_MAX_EVENTS = 4096;

const PERSIST_WRITE_DEBOUNCE_MS = 500;
const PERSIST_MAX_INBOUND_SEGMENTS = 96;
const PERSIST_MAX_CLOCK_AGE_MS = 60 * 1000;
const PERSIST_MAX_FUTURE_SKEW_MS = 5000;

let queryRegistered = false;
const persistenceQueues = new Map();
const historyReadCache = new WeakMap();

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function collectionValues(collection) {
  if (!collection) return [];
  try {
    if (Array.isArray(collection.contents)) return collection.contents;
  } catch (_err) {}
  try {
    if (typeof collection.values === "function") return Array.from(collection.values());
  } catch (_err) {}
  try {
    if (typeof collection[Symbol.iterator] === "function") return Array.from(collection);
  } catch (_err) {}
  return Array.isArray(collection) ? collection : [];
}

function userViewsScene(user, sceneId) {
  const expected = String(sceneId ?? "").trim();
  if (!expected) return false;
  const viewed = String(user?.viewedScene ?? user?._viewedScene ?? "").trim();
  return viewed === expected;
}

function getUserById(userId) {
  const id = String(userId ?? "").trim();
  if (!id) return null;
  try {
    const direct = globalThis.game?.users?.get?.(id) ?? null;
    if (direct) return direct;
  } catch (_err) {}
  return collectionValues(globalThis.game?.users).find((user) => String(user?.id ?? "") === id) ?? null;
}

function getSceneById(sceneId) {
  const id = String(sceneId ?? "").trim();
  if (!id) return null;
  try {
    const direct = globalThis.game?.scenes?.get?.(id) ?? null;
    if (direct) return direct;
  } catch (_err) {}
  return collectionValues(globalThis.game?.scenes).find((scene) => String(scene?.id ?? "") === id) ?? null;
}

function getTokenDocument(scene, tokenId) {
  const id = String(tokenId ?? "").trim();
  if (!scene || !id) return null;
  try {
    const direct = scene.tokens?.get?.(id) ?? null;
    if (direct) return direct;
  } catch (_err) {}
  try {
    const embedded = scene.getEmbeddedDocument?.("Token", id) ?? null;
    if (embedded) return embedded;
  } catch (_err) {}
  return collectionValues(scene.tokens).find((token) => String(token?.id ?? "") === id) ?? null;
}

function userCanUpdateToken(user, tokenDocument) {
  if (!user || !tokenDocument) return false;
  try {
    const result = tokenDocument.canUserModify?.(user, "update");
    if (typeof result === "boolean") return result;
  } catch (_err) {}
  try {
    const owner = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return !!tokenDocument.testUserPermission?.(user, owner);
  } catch (_err) {
    return !!user.isGM;
  }
}

function normalizePoint(value) {
  const x = Number(value?.x ?? value?.[0]);
  const y = Number(value?.y ?? value?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function normalizeLevelIds(value) {
  const input = Array.isArray(value) ? value : value instanceof Set ? Array.from(value) : [];
  const result = [];
  const seen = new Set();
  for (const entry of input) {
    const id = String(entry ?? "")
      .trim()
      .slice(0, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= 32) break;
  }
  result.sort();
  return result;
}

function roundCompactNumber(value) {
  return Math.round(finiteNumber(value, 0) * 1000) / 1000;
}

/**
 * Normalize an in-memory or compact persisted disturbance event.
 *
 * @param {object|Array|null|undefined} raw
 * @returns {object|null}
 */
export function normalizeParticleBackgroundMovementEvent(raw) {
  const compact = Array.isArray(raw);
  const eventId = String(compact ? raw[0] : raw?.eventId ?? "")
    .trim()
    .slice(0, 192);
  const tokenId = String(compact ? raw[1] : raw?.tokenId ?? "")
    .trim()
    .slice(0, 128);
  const from = compact ? normalizePoint([raw[2], raw[3]]) : normalizePoint(raw?.from);
  const to = compact ? normalizePoint([raw[4], raw[5]]) : normalizePoint(raw?.to);
  const tokenWidth = Number(compact ? raw[6] : raw?.tokenWidth);
  const tokenHeight = Number(compact ? raw[7] : raw?.tokenHeight);
  const occurredAt = Number(compact ? raw[8] : raw?.occurredAt);
  const seedValue = Number(compact ? raw[9] : raw?.seed);
  const levelIds = normalizeLevelIds(compact ? raw[10] : raw?.levelIds);
  const tokenElevation = finiteNumber(compact ? raw[11] : raw?.tokenElevation, 0);

  if (!eventId || !tokenId || !from || !to) return null;
  if (![tokenWidth, tokenHeight, occurredAt].every(Number.isFinite)) return null;
  if (!(tokenWidth > 0) || !(tokenHeight > 0) || !(occurredAt > 0)) return null;

  return {
    eventId,
    tokenId,
    from,
    to,
    tokenWidth,
    tokenHeight,
    tokenElevation,
    occurredAt,
    seed: Number.isFinite(seedValue) ? Math.trunc(seedValue) >>> 0 : 0,
    levelIds,
  };
}

function compactMovementEvent(event) {
  const normalized = normalizeParticleBackgroundMovementEvent(event);
  if (!normalized) return null;
  return [
    normalized.eventId,
    normalized.tokenId,
    roundCompactNumber(normalized.from.x),
    roundCompactNumber(normalized.from.y),
    roundCompactNumber(normalized.to.x),
    roundCompactNumber(normalized.to.y),
    roundCompactNumber(normalized.tokenWidth),
    roundCompactNumber(normalized.tokenHeight),
    Math.round(normalized.occurredAt),
    normalized.seed >>> 0,
    normalized.levelIds,
    roundCompactNumber(normalized.tokenElevation),
  ];
}

function normalizeHistoryRoot(raw) {
  const events = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw?.events) ? raw.events : []) {
    const event = normalizeParticleBackgroundMovementEvent(entry);
    if (!event || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    events.push(event);
  }
  events.sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
  if (events.length > PARTICLE_BACKGROUND_MOVEMENT_HISTORY_MAX_EVENTS) {
    events.splice(0, events.length - PARTICLE_BACKGROUND_MOVEMENT_HISTORY_MAX_EVENTS);
  }
  return {
    version: Number(raw?.version ?? raw?.v) || PARTICLE_BACKGROUND_MOVEMENT_HISTORY_VERSION,
    revision: Math.max(0, Math.trunc(Number(raw?.revision ?? raw?.r) || 0)),
    updatedAt: Math.max(0, Number(raw?.updatedAt) || 0),
    events,
  };
}

/**
 * Read and normalize the Scene's persisted movement history.
 *
 * @param {Scene|null|undefined} scene
 * @returns {{version:number,revision:number,updatedAt:number,events:object[],source:any}}
 */
export function readParticleBackgroundMovementHistory(scene) {
  let raw = null;
  try {
    raw = scene?.getFlag?.(packageId, PARTICLE_BACKGROUND_MOVEMENT_HISTORY_FLAG) ?? null;
  } catch (_err) {
    raw = null;
  }
  if (scene && (typeof scene === "object" || typeof scene === "function")) {
    const cached = historyReadCache.get(scene) ?? null;
    const rawRevision = Math.max(0, Math.trunc(Number(raw?.revision ?? raw?.r) || 0));
    if (cached && cached.source === raw && cached.revision === rawRevision) return cached;
  }
  const normalized = normalizeHistoryRoot(raw);
  const result = { ...normalized, source: raw };
  if (scene && (typeof scene === "object" || typeof scene === "function")) historyReadCache.set(scene, result);
  return result;
}

function activeGMUser() {
  try {
    const direct = globalThis.game?.users?.activeGM ?? null;
    if (direct?.active && direct?.isGM) return direct;
  } catch (_err) {}
  const active = collectionValues(globalThis.game?.users)
    .filter((user) => user?.active && user?.isGM)
    .sort((a, b) => {
      const activeOrder = Number(!!b?.isActiveGM) - Number(!!a?.isActiveGM);
      return activeOrder || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    });
  return active.find((user) => user?.isActiveGM) ?? active[0] ?? null;
}

function localUserIsActiveGM() {
  const user = globalThis.game?.user ?? null;
  if (!user?.isGM || !user?.active) return false;
  if (typeof user.isActiveGM === "boolean") return user.isActiveGM;
  return String(activeGMUser()?.id ?? "") === String(user.id ?? "");
}

function validatePersistencePayload(queryData = {}) {
  if (Number(queryData?.version) !== PARTICLE_BACKGROUND_PERSIST_QUERY_VERSION) {
    return { accepted: [], reason: "unsupported-version" };
  }

  const sceneId = String(queryData?.sceneId ?? "").trim();
  const senderUserId = String(queryData?.senderUserId ?? "").trim();
  const scene = getSceneById(sceneId);
  const sender = getUserById(senderUserId);
  if (!scene || !sender?.active) return { accepted: [], reason: "invalid-scene-or-user" };

  const now = particleBackgroundNow();
  const grid = Math.max(1, Number(scene?.grid?.size ?? scene?.dimensions?.size ?? 100) || 100);
  const rawSegments = Array.isArray(queryData?.segments)
    ? queryData.segments.slice(0, PERSIST_MAX_INBOUND_SEGMENTS)
    : [];
  const accepted = [];

  for (const raw of rawSegments) {
    const event = normalizeParticleBackgroundMovementEvent(raw);
    if (!event) continue;
    const tokenDocument = getTokenDocument(scene, event.tokenId);
    if (!tokenDocument || !userCanUpdateToken(sender, tokenDocument)) continue;

    const age = now - event.occurredAt;
    if (age > PERSIST_MAX_CLOCK_AGE_MS || age < -PERSIST_MAX_FUTURE_SKEW_MS) continue;

    const distance = Math.hypot(event.to.x - event.from.x, event.to.y - event.from.y);
    const width = clamp(event.tokenWidth, grid * 0.1, grid * 20, grid);
    const height = clamp(event.tokenHeight, grid * 0.1, grid * 20, grid);
    const teleportThreshold = Math.max(grid * 8, Math.max(width, height) * 8);
    if (!(distance > Math.max(0.25, grid * 0.005)) || distance > teleportThreshold) continue;

    accepted.push({
      ...event,
      tokenWidth: width,
      tokenHeight: height,
      occurredAt: clamp(event.occurredAt, now - PERSIST_MAX_CLOCK_AGE_MS, now + PERSIST_MAX_FUTURE_SKEW_MS, now),
    });
  }

  return { accepted, scene, sender };
}

function schedulePersistenceFlush(sceneId, queue) {
  if (queue.timer !== null || queue.flushing) return;
  queue.timer =
    globalThis.setTimeout?.(() => {
      queue.timer = null;
      void flushPersistenceQueue(sceneId, queue);
    }, PERSIST_WRITE_DEBOUNCE_MS) ?? null;
  if (queue.timer === null) void flushPersistenceQueue(sceneId, queue);
}

async function flushPersistenceQueue(sceneId, queue) {
  if (!queue || queue.flushing || !queue.pending.size) return;
  if (!localUserIsActiveGM()) {
    queue.pending.clear();
    persistenceQueues.delete(sceneId);
    return;
  }

  const scene = getSceneById(sceneId);
  if (!scene || typeof scene.setFlag !== "function") {
    queue.pending.clear();
    persistenceQueues.delete(sceneId);
    return;
  }

  queue.flushing = true;
  const batch = Array.from(queue.pending.values());
  queue.pending.clear();

  try {
    const existing = readParticleBackgroundMovementHistory(scene);
    const merged = new Map(existing.events.map((event) => [event.eventId, event]));
    for (const event of batch) merged.set(event.eventId, event);
    const events = Array.from(merged.values()).sort(
      (a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId),
    );
    if (events.length > PARTICLE_BACKGROUND_MOVEMENT_HISTORY_MAX_EVENTS) {
      events.splice(0, events.length - PARTICLE_BACKGROUND_MOVEMENT_HISTORY_MAX_EVENTS);
    }

    const compact = events.map(compactMovementEvent).filter(Boolean);
    await scene.setFlag(packageId, PARTICLE_BACKGROUND_MOVEMENT_HISTORY_FLAG, {
      version: PARTICLE_BACKGROUND_MOVEMENT_HISTORY_VERSION,
      revision: existing.revision + 1,
      updatedAt: particleBackgroundNow(),
      events: compact,
    });
  } catch (err) {
    for (const event of batch) queue.pending.set(event.eventId, event);
    logger.debug("FXMaster: persisted particle-background movement write failed", err);
  } finally {
    queue.flushing = false;
    if (queue.pending.size) schedulePersistenceFlush(sceneId, queue);
    else if (queue.timer === null) persistenceQueues.delete(sceneId);
  }
}

function enqueuePersistedMovement(sceneId, events) {
  const id = String(sceneId ?? "").trim();
  if (!id || !Array.isArray(events) || !events.length) return 0;
  let queue = persistenceQueues.get(id) ?? null;
  if (!queue) {
    queue = { pending: new Map(), timer: null, flushing: false };
    persistenceQueues.set(id, queue);
  }
  for (const event of events) queue.pending.set(event.eventId, event);
  schedulePersistenceFlush(id, queue);
  return events.length;
}

async function receivePersistenceQuery(queryData = {}) {
  if (!localUserIsActiveGM()) return { accepted: 0, reason: "not-active-gm" };
  const validated = validatePersistencePayload(queryData);
  if (!validated.accepted.length) return { accepted: 0, reason: validated.reason ?? "no-valid-segments" };
  return {
    accepted: enqueuePersistedMovement(String(validated.scene?.id ?? queryData?.sceneId ?? ""), validated.accepted),
  };
}

/** Register module-prefixed query handlers during Foundry's init phase. */
export function registerParticleBackgroundQueries() {
  const config = globalThis.CONFIG;
  if (!config) {
    queryRegistered = false;
    return false;
  }

  config.queries ??= {};
  config.queries[PARTICLE_BACKGROUND_DISTURBANCE_QUERY] = async (queryData = {}) => {
    if (Number(queryData?.version) !== PARTICLE_BACKGROUND_DISTURBANCE_QUERY_VERSION) {
      return { accepted: 0, reason: "unsupported-version" };
    }
    try {
      const layer = globalThis.canvas?.particleeffects ?? null;
      if (!layer || typeof layer.receiveParticleBackgroundDisturbanceQuery !== "function") {
        return { accepted: 0, reason: "layer-unavailable" };
      }
      return (await layer.receiveParticleBackgroundDisturbanceQuery(queryData)) ?? { accepted: 0 };
    } catch (err) {
      logger.debug("FXMaster: particle-background query handler failed", err);
      return { accepted: 0, reason: "handler-failed" };
    }
  };

  config.queries[PARTICLE_BACKGROUND_PERSIST_QUERY] = async (queryData = {}) => {
    try {
      return await receivePersistenceQuery(queryData);
    } catch (err) {
      logger.debug("FXMaster: particle-background persistence query handler failed", err);
      return { accepted: 0, reason: "handler-failed" };
    }
  };

  queryRegistered = true;
  return true;
}

export function particleBackgroundQueriesAvailable() {
  return (
    queryRegistered &&
    typeof globalThis.CONFIG?.queries?.[PARTICLE_BACKGROUND_DISTURBANCE_QUERY] === "function" &&
    typeof globalThis.game?.user?.query === "function"
  );
}

export function particleBackgroundPersistenceAvailable() {
  if (!queryRegistered) return false;
  if (localUserIsActiveGM()) return true;
  const gm = activeGMUser();
  return !!gm?.active && typeof gm.query === "function";
}

export function getParticleBackgroundQueryParticipants(sceneId, { includeSelf = true } = {}) {
  const localUserId = String(globalThis.game?.user?.id ?? "");
  return collectionValues(globalThis.game?.users).filter((user) => {
    if (!user || (!includeSelf && String(user.id ?? "") === localUserId)) return false;
    if (!user.active || typeof user.query !== "function") return false;
    return userViewsScene(user, sceneId);
  });
}

export function getParticleBackgroundQueryRecipients(sceneId) {
  return getParticleBackgroundQueryParticipants(sceneId, { includeSelf: false });
}

export function queryParticleBackgroundDisturbances(user, payload) {
  if (!particleBackgroundQueriesAvailable() || typeof user?.query !== "function") {
    return Promise.resolve({ accepted: 0, reason: "query-unavailable" });
  }
  return user.query(PARTICLE_BACKGROUND_DISTURBANCE_QUERY, payload, {
    timeout: PARTICLE_BACKGROUND_QUERY_TIMEOUT_MS,
  });
}

export function persistParticleBackgroundDisturbances(payload) {
  if (!queryRegistered) return Promise.resolve({ accepted: 0, reason: "query-unavailable" });
  if (localUserIsActiveGM()) return Promise.resolve(receivePersistenceQuery(payload));

  const gm = activeGMUser();
  if (!gm?.active || typeof gm.query !== "function") {
    return Promise.resolve({ accepted: 0, reason: "active-gm-unavailable" });
  }
  return gm.query(PARTICLE_BACKGROUND_PERSIST_QUERY, payload, {
    timeout: PARTICLE_BACKGROUND_PERSIST_QUERY_TIMEOUT_MS,
  });
}

export const particleBackgroundQueryInternals = Object.freeze({
  collectionValues,
  userViewsScene,
  normalizeLevelIds,
  compactMovementEvent,
  normalizeHistoryRoot,
  validatePersistencePayload,
  activeGMUser,
  localUserIsActiveGM,
  enqueuePersistedMovement,
  flushPersistenceQueue,
});
