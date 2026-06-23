import { packageId } from "../constants.js";
import { legacyClockwiseDirectionToGeometric, normalizeDirectionDegrees } from "../utils.js";
import { collectionValues, hasOwn, isPlainObject } from "../utils/object.js";
import { logger } from "../logger.js";

export const DIRECTION_CONVENTION_MIGRATION_VERSION = 1;

const DIRECTION_OPTION_KEYS = Object.freeze([
  "direction",
  "glyphDirection",
  "flowDirection",
  "waveDirection",
  "vortexDirection",
]);

const PLUS_PACKAGE_ID = "fxmaster-plus";
const PLUS_MANUAL_PLACEMENT_FLAGS = Object.freeze(["fireParticlesManualPlacements", "ghostsManualPlacements"]);
const SUNLIGHT_EFFECT_TYPE = "sunlight";
const DOCUMENT_MIGRATION_FLAG = "directionConventionMigrationVersion";
const PASSIVE_MIGRATION_SETTING = "directionConventionPassiveMigrationVersion";

function isEffectRegionBehavior(source) {
  const type = String(source?.type ?? "");
  return type === `${packageId}.particleEffectsRegion` || type === `${packageId}.filterEffectsRegion`;
}

function legacyWaterDirectionToGeometric(value) {
  return normalizeDirectionDegrees(180 - normalizeDirectionDegrees(value));
}

function legacySunlightAngleToTravelDirection(value, parallel = true) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) return null;
  return normalizeDirectionDegrees(parallel ? 90 - angle : 180 - angle);
}

function isWaterDirection(effectType, key) {
  return effectType === "water" && ["direction", "flowDirection", "waveDirection", "vortexDirection"].includes(key);
}

function convertLegacyDirectionValue(value, effectType, key) {
  return isWaterDirection(effectType, key)
    ? legacyWaterDirectionToGeometric(value)
    : legacyClockwiseDirectionToGeometric(value);
}

function matchFlatParameterKey(key, parameterKeys) {
  if (parameterKeys.includes(key)) return { effectType: null, parameterKey: key };

  const matches = parameterKeys
    .filter((parameterKey) => key.endsWith(`_${parameterKey}`))
    .sort((a, b) => b.length - a.length);

  const parameterKey = matches[0];
  if (!parameterKey) return null;

  const effectType = key.slice(0, key.length - parameterKey.length - 1);
  return effectType ? { effectType, parameterKey } : null;
}

function migrateNumberValue(value, effectType, key) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { changed: false, value };
  return { changed: true, value: convertLegacyDirectionValue(numeric, effectType, key) };
}

function documentMigrationVersion(document) {
  return Number(document?.getFlag?.(packageId, DOCUMENT_MIGRATION_FLAG) ?? 0) || 0;
}

function sourceFlagMigrationVersion(source) {
  return Number(source?.flags?.[packageId]?.[DOCUMENT_MIGRATION_FLAG] ?? 0) || 0;
}

function migrateDirectionNumberInPlace(object, key, effectType = null, context = {}) {
  if (!isPlainObject(object) || !hasOwn(object, key)) return false;

  const parameterKey = context.parameterKey ?? key;
  const entry = object[key];
  const value = isPlainObject(entry) && hasOwn(entry, "value") ? entry.value : entry;
  const result = migrateNumberValue(value, effectType, parameterKey);
  if (!result.changed) return false;
  object[key] = result.value;
  return true;
}

function migrateSunlightAngleInPlace(options, effectType = null) {
  if (!isPlainObject(options) || effectType !== SUNLIGHT_EFFECT_TYPE || !hasOwn(options, "angle")) return false;
  const parallel = typeof options.parallel === "boolean" ? options.parallel : true;
  const entry = options.angle;
  const value = isPlainObject(entry) && hasOwn(entry, "value") ? entry.value : entry;
  const next = legacySunlightAngleToTravelDirection(value, parallel);
  if (!Number.isFinite(next)) return false;
  options.angle = next;
  return true;
}

function migrateManualPlacementsInPlace(value) {
  if (!Array.isArray(value)) return false;
  let changed = false;
  for (const placement of value) {
    if (migrateDirectionNumberInPlace(placement, "direction")) changed = true;
  }
  return changed;
}

function migrateOptionsInPlace(options, effectType = null) {
  if (!isPlainObject(options)) return false;
  let changed = false;
  for (const key of DIRECTION_OPTION_KEYS) {
    if (migrateDirectionNumberInPlace(options, key, effectType)) changed = true;
  }
  if (migrateManualPlacementsInPlace(options.manualPlacements)) changed = true;
  if (migrateManualPlacementsInPlace(options.placements)) changed = true;
  if (migrateSunlightAngleInPlace(options, effectType)) changed = true;
  return changed;
}

function migrateSceneEffectMapInPlace(effectMap) {
  if (!isPlainObject(effectMap)) return false;
  let changed = false;
  for (const [type, entry] of Object.entries(effectMap)) {
    if (migrateOptionsInPlace(entry?.options, entry?.type ?? type)) changed = true;
  }
  return changed;
}

function migrateSunlightFlatAngleInPlace(system, key, effectType = null) {
  if (!isPlainObject(system) || effectType !== SUNLIGHT_EFFECT_TYPE || !hasOwn(system, key)) return false;
  const parallelKey = `${effectType}_parallel`;
  const parallel = typeof system[parallelKey] === "boolean" ? system[parallelKey] : true;
  const entry = system[key];
  const value = isPlainObject(entry) && hasOwn(entry, "value") ? entry.value : entry;
  const next = legacySunlightAngleToTravelDirection(value, parallel);
  if (!Number.isFinite(next)) return false;
  system[key] = next;
  return true;
}

function migrateRegionBehaviorSystemInPlace(system) {
  if (!isPlainObject(system)) return false;
  let changed = false;
  for (const key of Object.keys(system)) {
    const directionMatch = matchFlatParameterKey(key, DIRECTION_OPTION_KEYS);
    if (directionMatch) {
      if (
        migrateDirectionNumberInPlace(system, key, directionMatch.effectType, {
          parameterKey: directionMatch.parameterKey,
        })
      ) {
        changed = true;
      }
    }

    const sunlightMatch = matchFlatParameterKey(key, ["angle"]);
    if (sunlightMatch) {
      if (migrateSunlightFlatAngleInPlace(system, key, sunlightMatch.effectType)) changed = true;
    }
  }
  return changed;
}

function migrateRegionBehaviorFlagsInPlace(fxmasterFlags) {
  if (!isPlainObject(fxmasterFlags)) return [];
  const changed = [];
  if (migrateSceneEffectMapInPlace(fxmasterFlags.particleEffects)) changed.push("particleEffects");
  if (migrateSceneEffectMapInPlace(fxmasterFlags.filters)) changed.push("filters");
  return changed;
}

function buildFlatFlagUpdate(moduleId, key, value) {
  return { [`flags.${moduleId}.${key}`]: value };
}

async function migrateScene(scene) {
  if (documentMigrationVersion(scene) >= DIRECTION_CONVENTION_MIGRATION_VERSION) return false;

  const update = {
    [`flags.${packageId}.${DOCUMENT_MIGRATION_FLAG}`]: DIRECTION_CONVENTION_MIGRATION_VERSION,
  };
  const effects = foundry.utils.deepClone(scene.getFlag(packageId, "effects") ?? {});
  const filters = foundry.utils.deepClone(scene.getFlag(packageId, "filters") ?? {});

  if (migrateSceneEffectMapInPlace(effects)) update[`flags.${packageId}.effects`] = effects;
  if (migrateSceneEffectMapInPlace(filters)) update[`flags.${packageId}.filters`] = filters;

  for (const flag of PLUS_MANUAL_PLACEMENT_FLAGS) {
    const placements = foundry.utils.deepClone(scene.getFlag(PLUS_PACKAGE_ID, flag));
    if (migrateManualPlacementsInPlace(placements))
      Object.assign(update, buildFlatFlagUpdate(PLUS_PACKAGE_ID, flag, placements));
  }

  await scene.update(update, { diff: false });
  return Object.keys(update).length > 1;
}

async function migrateRegionBehavior(behavior) {
  const source = behavior.toObject?.() ?? {};
  if (!isEffectRegionBehavior(source)) return false;
  if (sourceFlagMigrationVersion(source) >= DIRECTION_CONVENTION_MIGRATION_VERSION) return false;

  const update = {};
  const system = foundry.utils.deepClone(source.system ?? {});
  const fxmasterFlags = foundry.utils.deepClone(source.flags?.[packageId] ?? {});

  const systemChanged = migrateRegionBehaviorSystemInPlace(system);
  const changedFlagKeys = migrateRegionBehaviorFlagsInPlace(fxmasterFlags);
  if (systemChanged) update.system = system;
  for (const key of changedFlagKeys) update[`flags.${packageId}.${key}`] = fxmasterFlags[key];
  update[`flags.${packageId}.${DOCUMENT_MIGRATION_FLAG}`] = DIRECTION_CONVENTION_MIGRATION_VERSION;

  await behavior.update(update, { diff: false });
  return systemChanged || changedFlagKeys.length > 0;
}

async function migrateRegion(region) {
  let changed = false;
  let failed = false;
  for (const behavior of collectionValues(region?.behaviors)) {
    try {
      if (await migrateRegionBehavior(behavior)) changed = true;
    } catch (error) {
      failed = true;
      logger.warn("FXMaster direction migration failed for a Region behavior.", error);
    }
  }
  return { changed, failed };
}

async function migratePassiveSettings() {
  if (
    (Number(game.settings.get(packageId, PASSIVE_MIGRATION_SETTING) ?? 0) || 0) >=
    DIRECTION_CONVENTION_MIGRATION_VERSION
  ) {
    return false;
  }

  let changed = false;

  const passiveParticles = foundry.utils.deepClone(game.settings.get(packageId, "passiveParticleConfig") ?? {});
  let particleChanged = false;
  for (const [type, options] of Object.entries(passiveParticles)) {
    if (migrateOptionsInPlace(options, type)) particleChanged = true;
  }
  if (particleChanged) {
    await game.settings.set(packageId, "passiveParticleConfig", passiveParticles);
    changed = true;
  }

  const passiveFilters = foundry.utils.deepClone(game.settings.get(packageId, "passiveFilterConfig") ?? {});
  let filterChanged = false;
  for (const [type, options] of Object.entries(passiveFilters)) {
    if (migrateOptionsInPlace(options, type)) filterChanged = true;
  }
  if (filterChanged) {
    await game.settings.set(packageId, "passiveFilterConfig", passiveFilters);
    changed = true;
  }

  await game.settings.set(packageId, PASSIVE_MIGRATION_SETTING, DIRECTION_CONVENTION_MIGRATION_VERSION);
  return changed;
}

export async function migrateDirectionConventionData() {
  if (!game.user?.isGM) return;

  const currentVersion = Number(game.settings.get(packageId, "directionConventionMigrationVersion") ?? 0);
  if (currentVersion >= DIRECTION_CONVENTION_MIGRATION_VERSION) return;

  let sceneCount = 0;
  let regionCount = 0;
  let failureCount = 0;
  let passiveChanged = false;

  try {
    passiveChanged = await migratePassiveSettings();
  } catch (error) {
    failureCount += 1;
    logger.warn("FXMaster direction migration failed for passive configuration.", error);
  }

  for (const scene of collectionValues(game.scenes)) {
    try {
      if (await migrateScene(scene)) sceneCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.warn("FXMaster direction migration failed for a Scene.", error);
    }

    for (const region of collectionValues(scene.regions)) {
      try {
        const result = await migrateRegion(region);
        if (result.changed) regionCount += 1;
        if (result.failed) failureCount += 1;
      } catch (error) {
        failureCount += 1;
        logger.warn("FXMaster direction migration failed for a Region.", error);
      }
    }
  }

  if (failureCount === 0) {
    await game.settings.set(packageId, "directionConventionMigrationVersion", DIRECTION_CONVENTION_MIGRATION_VERSION);
  } else {
    logger.warn(
      `FXMaster direction migration completed with ${failureCount} failure(s). The migration will retry on the next reload.`,
    );
  }

  if (sceneCount || regionCount || passiveChanged) {
    logger.info(
      `Migrated FXMaster direction and sunlight angles on ${sceneCount} Scene(s), ${regionCount} Region(s), and ${
        passiveChanged ? 1 : 0
      } passive configuration set(s).`,
    );
  }
}
