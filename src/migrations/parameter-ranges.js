import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { collectionValues, hasOwn, isPlainObject } from "../utils/object.js";

export const PARAMETER_RANGE_MIGRATION_VERSION = 1;

const DOCUMENT_MIGRATION_FLAG = "parameterRangeMigrationVersion";
const PASSIVE_MIGRATION_SETTING = "parameterRangePassiveMigrationVersion";

function regionBehaviorEffectKind(source) {
  const type = String(source?.type ?? "");
  if (type === `${packageId}.particleEffectsRegion`) return "particle";
  if (type === `${packageId}.filterEffectsRegion`) return "filter";
  return null;
}

function isEffectRegionBehavior(source) {
  return regionBehaviorEffectKind(source) !== null;
}

function effectDatabase(kind) {
  return kind === "particle" ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
}

function effectDefinition(kind, type) {
  if (!type) return null;
  const db = effectDatabase(kind);
  return db?.[type] ?? null;
}

function documentMigrationVersion(document) {
  return Number(document?.getFlag?.(packageId, DOCUMENT_MIGRATION_FLAG) ?? 0) || 0;
}

function sourceFlagMigrationVersion(source) {
  return Number(source?.flags?.[packageId]?.[DOCUMENT_MIGRATION_FLAG] ?? 0) || 0;
}

function markFlagsMigrated(flags) {
  flags[packageId] = { ...(isPlainObject(flags[packageId]) ? flags[packageId] : {}) };
  flags[packageId][DOCUMENT_MIGRATION_FLAG] = PARAMETER_RANGE_MIGRATION_VERSION;
}

function isDeletionKey(key) {
  return String(key ?? "").startsWith("-=") || String(key ?? "").startsWith("==");
}

function validEffectMapEntry(key, entry) {
  if (isDeletionKey(key)) return null;
  if (!isPlainObject(entry)) return null;
  const type = String(entry.type ?? "").trim();
  return type ? type : null;
}

function unknownEffectTypesInMap(kind, effectMap) {
  if (!isPlainObject(effectMap)) return [];
  const unknown = [];
  for (const [key, entry] of Object.entries(effectMap)) {
    const type = validEffectMapEntry(key, entry);
    if (!type) continue;
    if (!effectDefinition(kind, type)) unknown.push(`${kind}:${type}`);
  }
  return unknown;
}

function unknownEnabledFlatEffectTypes(kind, system) {
  if (!isPlainObject(system)) return [];
  const db = effectDatabase(kind) ?? {};
  const unknown = [];
  for (const [key, value] of Object.entries(system)) {
    if (!key.endsWith("_enabled") || value !== true) continue;
    const type = key.slice(0, -"_enabled".length);
    if (!type || type.startsWith("_")) continue;
    if (!db[type]) unknown.push(`${kind}:${type}`);
  }
  return unknown;
}

function assertNoUnknownEffects(scope, unknown) {
  const unique = [...new Set(unknown)].sort();
  if (!unique.length) return;
  throw new Error(`${scope} contains unknown FXMaster effect type(s): ${unique.join(", ")}`);
}

function passiveConfigToEffectMap(config) {
  if (!isPlainObject(config)) return {};
  return Object.fromEntries(Object.entries(config).map(([type, options]) => [type, { type, options }]));
}

function migrateOptionsInPlace(kind, type, options) {
  if (!isPlainObject(options)) return false;
  const definition = effectDefinition(kind, type);
  if (!definition) return false;

  const next = CONFIG.fxmaster?.normalizeEffectOptionsForStorageFromLegacy?.(definition, options) ?? options;
  const diffA = foundry.utils.diffObject(options, next);
  const diffB = foundry.utils.diffObject(next, options);
  const changed = !foundry.utils.isEmpty(diffA) || !foundry.utils.isEmpty(diffB);
  if (!changed) return false;

  for (const key of Object.keys(options)) delete options[key];
  Object.assign(options, next);
  return true;
}

function migrateSceneEffectMapInPlace(kind, effectMap) {
  if (!isPlainObject(effectMap)) return false;
  let changed = false;
  for (const [key, entry] of Object.entries(effectMap)) {
    const type = validEffectMapEntry(key, entry);
    if (!type) continue;
    if (migrateOptionsInPlace(kind, type, entry.options)) changed = true;
  }
  return changed;
}

function migrateRegionBehaviorSystemInPlace(kind, system) {
  if (!isPlainObject(system)) return false;

  const db = effectDatabase(kind);
  if (!db) return false;

  let changed = false;
  for (const type of Object.keys(db)) {
    const prefix = `${type}_`;
    const options = {};
    const flatKeys = [];

    for (const key of Object.keys(system)) {
      if (!key.startsWith(prefix)) continue;
      const optionKey = key.slice(prefix.length);
      options[optionKey] = system[key];
      flatKeys.push([key, optionKey]);
    }

    if (!flatKeys.length) continue;
    const before = foundry.utils.deepClone(options);
    if (!migrateOptionsInPlace(kind, type, options)) continue;

    for (const [flatKey, optionKey] of flatKeys) {
      if (hasOwn(options, optionKey) && options[optionKey] !== before[optionKey]) {
        system[flatKey] = options[optionKey];
        changed = true;
      }
    }
  }

  return changed;
}

function migrateRegionBehaviorFlagsInPlace(kind, flags) {
  if (!isPlainObject(flags)) return false;
  const fxmasterFlags = flags[packageId];
  if (!isPlainObject(fxmasterFlags)) return false;

  const flagKey = kind === "particle" ? "particleEffects" : "filters";
  assertNoUnknownEffects(`Region behavior ${kind} flags`, unknownEffectTypesInMap(kind, fxmasterFlags[flagKey]));

  return migrateSceneEffectMapInPlace(kind, fxmasterFlags[flagKey]);
}

async function migratePassiveSettings() {
  if (
    (Number(game.settings.get(packageId, PASSIVE_MIGRATION_SETTING) ?? 0) || 0) >= PARAMETER_RANGE_MIGRATION_VERSION
  ) {
    return false;
  }

  let changed = false;

  const passiveParticles = foundry.utils.deepClone(game.settings.get(packageId, "passiveParticleConfig") ?? {});
  assertNoUnknownEffects(
    "Passive particle configuration",
    unknownEffectTypesInMap("particle", passiveConfigToEffectMap(passiveParticles)),
  );

  let particleChanged = false;
  for (const [type, options] of Object.entries(passiveParticles)) {
    if (migrateOptionsInPlace("particle", type, options)) particleChanged = true;
  }
  if (particleChanged) {
    await game.settings.set(packageId, "passiveParticleConfig", passiveParticles);
    changed = true;
  }

  const passiveFilters = foundry.utils.deepClone(game.settings.get(packageId, "passiveFilterConfig") ?? {});
  assertNoUnknownEffects(
    "Passive filter configuration",
    unknownEffectTypesInMap("filter", passiveConfigToEffectMap(passiveFilters)),
  );

  let filterChanged = false;
  for (const [type, options] of Object.entries(passiveFilters)) {
    if (migrateOptionsInPlace("filter", type, options)) filterChanged = true;
  }
  if (filterChanged) {
    await game.settings.set(packageId, "passiveFilterConfig", passiveFilters);
    changed = true;
  }

  await game.settings.set(packageId, PASSIVE_MIGRATION_SETTING, PARAMETER_RANGE_MIGRATION_VERSION);
  return changed;
}

async function migrateScene(scene) {
  if (documentMigrationVersion(scene) >= PARAMETER_RANGE_MIGRATION_VERSION) return false;

  const update = {
    [`flags.${packageId}.${DOCUMENT_MIGRATION_FLAG}`]: PARAMETER_RANGE_MIGRATION_VERSION,
  };
  const effects = foundry.utils.deepClone(scene.getFlag(packageId, "effects") ?? {});
  const filters = foundry.utils.deepClone(scene.getFlag(packageId, "filters") ?? {});

  assertNoUnknownEffects("Scene particle effects", unknownEffectTypesInMap("particle", effects));
  assertNoUnknownEffects("Scene filter effects", unknownEffectTypesInMap("filter", filters));

  if (migrateSceneEffectMapInPlace("particle", effects)) update[`flags.${packageId}.effects`] = effects;
  if (migrateSceneEffectMapInPlace("filter", filters)) update[`flags.${packageId}.filters`] = filters;

  await scene.update(update, { diff: false, recursive: false });
  return Object.keys(update).length > 1;
}

async function migrateRegionBehavior(behavior) {
  const source = behavior.toObject?.() ?? {};
  if (!isEffectRegionBehavior(source)) return false;
  if (sourceFlagMigrationVersion(source) >= PARAMETER_RANGE_MIGRATION_VERSION) return false;

  const update = {};
  const system = foundry.utils.deepClone(source.system ?? {});
  const flags = foundry.utils.deepClone(source.flags ?? {});
  const kind = regionBehaviorEffectKind(source);

  assertNoUnknownEffects(`Region behavior ${kind} system`, unknownEnabledFlatEffectTypes(kind, system));

  const systemChanged = migrateRegionBehaviorSystemInPlace(kind, system);
  const flagsChanged = migrateRegionBehaviorFlagsInPlace(kind, flags);

  if (systemChanged) update.system = system;
  markFlagsMigrated(flags);
  update.flags = flags;

  await behavior.update(update, { diff: false, recursive: false });
  return systemChanged || flagsChanged;
}

async function migrateRegion(region) {
  let changed = false;
  let failed = false;
  for (const behavior of collectionValues(region?.behaviors)) {
    try {
      if (await migrateRegionBehavior(behavior)) changed = true;
    } catch (error) {
      failed = true;
      logger.warn("FXMaster parameter range migration failed for a Region behavior.", error);
    }
  }
  return { changed, failed };
}

export async function migrateParameterRangeData() {
  if (!game.user?.isGM) return;

  const currentVersion = Number(game.settings.get(packageId, "parameterRangeMigrationVersion") ?? 0);
  if (currentVersion >= PARAMETER_RANGE_MIGRATION_VERSION) return;

  let sceneCount = 0;
  let regionCount = 0;
  let failureCount = 0;
  let passiveChanged = false;

  try {
    passiveChanged = await migratePassiveSettings();
  } catch (error) {
    failureCount += 1;
    logger.warn("FXMaster parameter range migration failed for passive configuration.", error);
  }

  for (const scene of collectionValues(game.scenes)) {
    try {
      if (await migrateScene(scene)) sceneCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.warn("FXMaster parameter range migration failed for a Scene.", error);
    }

    for (const region of collectionValues(scene.regions)) {
      try {
        const result = await migrateRegion(region);
        if (result.changed) regionCount += 1;
        if (result.failed) failureCount += 1;
      } catch (error) {
        failureCount += 1;
        logger.warn("FXMaster parameter range migration failed for a Region.", error);
      }
    }
  }

  if (failureCount === 0) {
    await game.settings.set(packageId, "parameterRangeMigrationVersion", PARAMETER_RANGE_MIGRATION_VERSION);
  } else {
    logger.warn(
      `FXMaster parameter range migration completed with ${failureCount} failure(s). The migration will retry on the next reload.`,
    );
  }

  if (sceneCount || regionCount || passiveChanged) {
    logger.info(
      `Migrated FXMaster normalized parameter ranges on ${sceneCount} Scene(s), ${regionCount} Region(s), and ${
        passiveChanged ? 1 : 0
      } passive configuration set(s).`,
    );
  }
}
