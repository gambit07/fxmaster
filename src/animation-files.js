import { packageId } from "./constants.js";
import { getDialogColors } from "./utils.js";

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

async function findThumbFor(file) {
  const lastSlash = file.lastIndexOf("/");
  const dir = file.slice(0, lastSlash);
  const baseName =
    file
      .split("/")
      .pop()
      .replace(/_[0-9]+x[0-9]+\.webm$/i, "") + "_Thumb";

  try {
    const listing = await CONFIG.fxmaster.FilePickerNS.browse("data", dir);
    const candidates = Array.isArray(listing.files)
      ? listing.files.map((f) => decodeURIComponent(f.split("/").pop()))
      : [];
    const match = candidates.find((name) => name.startsWith(baseName) && name.toLowerCase().endsWith(".webp"));
    return match ? `${dir}/${match}` : null;
  } catch {
    return null;
  }
}

// Scan configured roots for .webm’s and thumbnails for jb2a to build our animations db

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
        anchor: { x: 0.5, y: 0.5 },
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

      if (fx.folder === "JB2A Patreon" || fx.folder === "JB2A Free" || fx.folder === "Baileywiki") {
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
    effectsMap.__emptyScan = true;
  }
  else ui.notifications.info(game.i18n.localize("FXMASTER.AnimationEffect.ScanComplete"));

  return effectsMap;
}
