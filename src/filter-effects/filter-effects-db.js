import { BloomFilter } from "./effects/bloom.js";
import { ColorFilter } from "./effects/color.js";
import { FogFilter } from "./effects/fog.js";
import { LightningFilter } from "./effects/lightning.js";
import { OldFilmFilter } from "./effects/old-film.js";
import { ScreenShakeFilter } from "./effects/screen-shake.js";
import { PredatorFilter } from "./effects/predator.js";
import { UnderwaterFilter } from "./effects/underwater.js";

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
