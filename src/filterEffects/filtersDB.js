import { FXColorFilter } from "./filters/FXColorFilter.js";
import { FXUnderwaterFilter } from "./filters/FXUnderwaterFilter.js";
import { FXLightningFilter } from "./filters/FXLightningFilter.js";
import { FXPredatorFilter } from "./filters/FXPredatorFilter.js";
import { FXOldFilmFilter } from "./filters/FXOldFilmFilter.js";
import { FXBloomFilter } from "./filters/FXBloomFilter.js";
// import {FXFogFilter} from "./filters/FXFogFilter.js"

export const filtersDB = {
  bloom: FXBloomFilter,
  color: FXColorFilter,
  // fog: FXFogFilter
  lightning: FXLightningFilter,
  oldfilm: FXOldFilmFilter,
  predator: FXPredatorFilter,
  underwater: FXUnderwaterFilter,
};
