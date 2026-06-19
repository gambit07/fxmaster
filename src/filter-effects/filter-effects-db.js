import { BloomFilter } from "./filters/bloom.js";
import { ColorFilter } from "./filters/color.js";
import { FogFilter } from "./filters/fog.js";
import { LightningFilter } from "./filters/lightning.js";
import { OldFilmFilter } from "./filters/old-film.js";
import { ScreenShakeFilter } from "./filters/screen-shake.js";
import { PredatorFilter } from "./filters/predator.js";
import { UnderwaterFilter } from "./filters/underwater.js";

/** @typedef {Record<string, PIXI.Filter} FilterEffects */

/** @type {FilterEffects} */
export const filterEffects = {
  bloom: BloomFilter,
  color: ColorFilter,
  fog: FogFilter,
  lightning: LightningFilter,
  oldfilm: OldFilmFilter,
  predator: PredatorFilter,
  screenShake: ScreenShakeFilter,
  underwater: UnderwaterFilter,
};
