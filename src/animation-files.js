import { packageId } from "./constants.js";
import { getDialogColors } from "./utils.js";

const _dirListCache = new Map();

async function gatherWebms(dir, seen = new Set()) {
  if (seen.has(dir)) return [];
  seen.add(dir);
  let result;
  try {
    result = await CONFIG.fxmaster.FilePickerNS.browse(
      typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge ? "forge-bazaar" : "data",
      dir,
    );
  } catch {
    return [];
  }
  const files = Array.isArray(result.files) ? result.files : [];
  const folders = Array.isArray(result.dirs) ? result.dirs : Array.isArray(result.folders) ? result.folders : [];
  let webms = files.filter((f) => f.toLowerCase().endsWith(".webm"));

  for (const sub of folders) {
    const next = typeof sub === "string" ? sub : sub.path;
    webms = webms.concat(await gatherWebms(next, seen));
  }
  return webms;
}

// Browse-backed thumbnail resolver that returns an existing file or null.
export async function findThumbFor(file) {
  if (!file) return null;

  // Normalize Windows backslashes and split
  const f = String(file).replace(/\\/g, "/");
  const lastSlash = f.lastIndexOf("/");
  if (lastSlash < 0) return null;

  const dir = f.slice(0, lastSlash);
  const nameRaw = decodeURIComponent(f.slice(lastSlash + 1));

  const isWebm = /\.webm$/i.test(nameRaw);

  // stem: drop .webm only
  const stem = isWebm ? nameRaw.replace(/\.webm$/i, "") : nameRaw;

  // JB2A: also drop trailing _###x### (e.g., _512x512)
  const stemNoDims = stem.replace(/_[0-9]+x[0-9]+$/i, "");
  const jb2aBase1 = `${stemNoDims}_Thumb`;

  const eqi = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const SRC = (typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge) ? "forge-bazaar" : "data";

  async function list(d) {
    if (_dirListCache.has(d)) return _dirListCache.get(d);
    try {
      const listing = await CONFIG.fxmaster.FilePickerNS.browse(SRC, d);
      const names = Array.isArray(listing.files)
        ? listing.files.map((p) => decodeURIComponent(String(p).split("/").pop() || ""))
        : [];
      _dirListCache.set(d, names);
      return names;
    } catch {
      return null;
    }
  }

  // --- Eskie: modules/eskie-effects[-free]/assets/... -> /thumbnails/ + <stemNoDims>.png
  if (/(?:^|\/)modules\/eskie-effects(?:-free)?\/assets\//i.test(f)) {
    const thumbDir = dir.replace(/\/assets\//i, "/thumbnails/");
    const names = await list(thumbDir);
    if (names === null) return null;

    const hit = names.find((n) => eqi(n, `${stemNoDims}.png`));
    return hit ? `${thumbDir}/${hit}` : null;
  }

  // --- JB2A (Patreon/Free/Extras patterns): try base, then fallback
  if (/(?:^|\/)modules\/(?:jb2a(?:[_-].+)?|JB2A_DnD5e|jb2a-extras)\//i.test(f)) {
    const names = await list(dir);
    if (names === null) return null;

    const webps = names.filter((n) => /\.webp$/i.test(n));
    const base1 = jb2aBase1.toLowerCase();

    let hit = webps.find((n) => n.toLowerCase().startsWith(base1));
    if (hit) return `${dir}/${hit}`;

    const stemDropOne = stemNoDims.replace(/_[^_]+$/i, "");
    if (stemDropOne && stemDropOne !== stemNoDims) {
      const base2 = `${stemDropOne}_Thumb`.toLowerCase();
      hit = webps.find((n) => n.toLowerCase().startsWith(base2));
      if (hit) return `${dir}/${hit}`;
    }
  }

  // --- Baileywiki: same folder, same basename, .webp
  if (/(?:^|\/)modules\/baileywiki[^/]*\//i.test(f)) {
    const names = await list(dir);
    if (names === null) return null;

    const hit = names.find((n) => eqi(n, `${stem}.webp`));
    return hit ? `${dir}/${hit}` : null;
  }

  // --- Generic fallback: same folder, same basename, .webp
  {
    const names = await list(dir);
    if (names === null) return null;

    const hit = names.find((n) => eqi(n, `${stem}.webp`));
    return hit ? `${dir}/${hit}` : null;
  }
}

// Scan configured roots for .webm’s and thumbnails to build animations db

export async function registerAnimations({ initialScan = false } = {}) {
  if (!game.user.isGM) return;

  const { baseColor, highlightColor } = getDialogColors();

  let notifId = ui.notifications.info(game.i18n.localize("FXMASTER.AnimationEffect.ScanStart"), { permanent: true });
  if (game?.release?.generation >= 13) notifId = notifId.id;
  const notifEl = document.querySelector(`.notification[data-id="${notifId}"]`);

  const explicitRoots = [
    { path: "modules/jb2a_patreon", label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.JB2APatreon") },
    { path: "modules/JB2A_DnD5e", label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.JB2AFree") },
    { path: "modules/jb2a-extras", label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.JB2AExtras") },
    { path: "modules/jaamod", label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.JinkersAnimatedArt") },
    { path: "modules/eskie-effects-free", label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.EskieEffectsFree", "Eskie Effects Free") },
    { path: "modules/eskie-effects", label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.EskieEffects", "Eskie Effects") },
    {
      path: "modules/animated-spell-effects",
      label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.AnimatedSpellEffects"),
    },
    {
      path: "modules/animated-spell-effects-cartoon",
      label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.AnimatedSpellEffectsCartoon"),
    },
    {
      path: "modules/boss-loot-assets-premium",
      label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.BossLootAssetsPremium"),
    },
    {
      path: "modules/boss-loot-adventures-premium",
      label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.BossLootAdventuresPremium"),
    },
    {
      path: "modules/boss-loot-assets-free",
      label: game.i18n.localize("FXMASTER.AnimationEffect.ModuleLabel.BossLootAssetsFree"),
    },
  ];

  // Find Wild Magic Surge and Baileywiki, buncha module directories sooo I'll do some searching
  const dynamicRoots = [];
  const mods = await CONFIG.fxmaster.FilePickerNS.browse("data", "modules");
  const dirs = Array.isArray(mods.dirs) ? mods.dirs : Array.isArray(mods.folders) ? mods.folders : [];

  for (const d of dirs) {
    const name = typeof d === "string" ? d : d.path || d;
    if (/wild.*magic.*surge/i.test(name)) {
      dynamicRoots.push({ path: name, label: "Wild Magic Surge" });
    }

    if (/baileywiki/i.test(name)) {
      dynamicRoots.push({ path: name, label: "Baileywiki" });
    }
  }

  // Check users custom animations folder if present
  const customDir = game.settings.get(packageId, "customEffectsDirectory")?.trim();
  if (customDir) explicitRoots.push({ path: customDir, label: "Custom" });

  const roots = [
    ...explicitRoots,
    ...dynamicRoots.filter((r) => !explicitRoots.some((e) => e.path === r.path))
  ];

  const discovered = [];
  const sequencerActive = game.modules.get("sequencer")?.active;

  for (let i = 0; i < roots.length; i++) {
    const { path, label } = roots[i];
    const files = await gatherWebms(path);

    for (const file of files) {
      const fx = {
        label: file
          .split("/")
          .pop()
          .replace(/\.webm$/i, ""),
        folder: label,
        file,
        scale: { x: 1, y: 1 },
        angle: 0,
        speed: 0,
        animationDelay: { start: 0, end: 0 },
        ease: "Linear",
        preset: false,
        author: label,
        type: "SpecialEffect",
        sequencerPath: sequencerActive ? Sequencer?.Database?.inverseFlattenedEntries.get(file) : null,
      };

      discovered.push(fx);
    }

    if (notifEl) {
      const pct = Math.round(((i + 1) / roots.length) * 100);
      notifEl.style.borderColor = highlightColor;
      notifEl.style.background = `linear-gradient(90deg, ${highlightColor} ${pct}%, ${baseColor} ${pct}%)`;
      notifEl.innerText = game.i18n.format("FXMASTER.AnimationEffect.ScanModules", {
        current: i + 1,
        total: roots.length,
      });
    }
  }

  if(!initialScan) {
    let thumbNotifId = ui.notifications.info(game.i18n.localize("FXMASTER.AnimationEffect.ScanningThumbnails"), {
      permanent: true,
    });
    if (game?.release?.generation >= 13) thumbNotifId = thumbNotifId.id;
    const thumbNotifEl = document.querySelector(`.notification[data-id="${thumbNotifId}"]`);

    for (let i = 0; i < discovered.length; i++) {
      const fx = discovered[i];

      if (/(?:^|\/)modules\/(?:jb2a(?:[_-].+)?|JB2A_DnD5e|jb2a-extras|eskie-effects(?:-free)?)\//i.test(fx.file)) {
        const thumb = await findThumbFor(fx.file);
        if (thumb) fx.thumb = thumb;
      }

      if (thumbNotifEl) {
        const pct = Math.round(((i + 1) / discovered.length) * 100);
        thumbNotifEl.style.borderColor = highlightColor;
        thumbNotifEl.style.background = `linear-gradient(90deg, ${highlightColor} ${pct}%, ${baseColor} ${pct}%)`;
        thumbNotifEl.innerText = game.i18n.format("FXMASTER.AnimationEffect.ScanningThumbnailsProgress", {
          current: i + 1,
          total: discovered.length,
        });
      }
    }

    ui.notifications.clear(thumbNotifId);
  }

  const effectsMap = {};
  for (const fx of discovered) {
    const key = fx.folder.toLowerCase().replace(/ /g, "");
    (effectsMap[key] ??= { label: fx.folder, effects: [] }).effects.push(fx);
  }
  for (const k of Object.keys(effectsMap)) {
    effectsMap[k].effects.sort((a, b) => a.label.localeCompare(b.label));
  }

  if (notifEl) ui.notifications.clear(notifId);

  const isEmpty = Object.keys(effectsMap).length === 0;
  if(isEmpty) {
    ui.notifications.warn(game.i18n.localize("FXMASTER.AnimationEffect.ScanCompleteEmpty"));
  }
  else ui.notifications.info(game.i18n.localize("FXMASTER.AnimationEffect.ScanComplete"));

  return effectsMap;
}
