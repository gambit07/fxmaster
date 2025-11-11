import { SpiderParticleEffect } from "./effects/spiders.js";
import { StarsParticleEffect } from "./effects/stars.js";
import { StarsParticleEffect } from "./effects/fish.js";
import { AutumnLeavesParticleEffect } from "./effects/leaves.js";
import { BatsParticleEffect } from "./effects/bats.js";
import { BirdsParticleEffect } from "./effects/birds.js";
import { BubblesParticleEffect } from "./effects/bubbles.js";
import { CloudsParticleEffect } from "./effects/clouds.js";
import { CrowsParticleEffect } from "./effects/crows.js";
import { EaglesParticleEffect } from "./effects/eagles.js";
import { EmbersParticleEffect } from "./effects/embers.js";
import { FogParticleEffect } from "./effects/fog.js";
import { RainParticleEffect } from "./effects/rain.js";
import { RainTopParticleEffect } from "./effects/rain-top.js";
import { RatsParticleEffect } from "./effects/rats.js";
import { SnowParticleEffect } from "./effects/snow.js";
import { SnowstormParticleEffect } from "./effects/snowstorm.js";

/** @typedef {Record<string, typeof import("./effects/effect.js").FXMasterParticleEffect>} ParticleEffects */

/** @type {ParticleEffects} */
export const particleEffects = {
  bats: BatsParticleEffect,
  birds: BirdsParticleEffect,
  crows: CrowsParticleEffect,
  eagles: EaglesParticleEffect,
  rats: RatsParticleEffect,
  spiders: SpiderParticleEffect,
  fishs: FishsParticleEffect,

  bubbles: BubblesParticleEffect,
  embers: EmbersParticleEffect,
  stars: StarsParticleEffect,

  autumnleaves: AutumnLeavesParticleEffect,
  clouds: CloudsParticleEffect,
  fog: FogParticleEffect,
  rain: RainParticleEffect,
  raintop: RainTopParticleEffect,
  snow: SnowParticleEffect,
  snowstorm: SnowstormParticleEffect,
};
