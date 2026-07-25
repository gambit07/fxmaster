import { ScatterBackgroundSurface } from "./scatter-background-surface.js";
import { RainBackgroundSurface } from "./rain-background-surface.js";
import { SandBackgroundSurface } from "./sand-background-surface.js";
import { SnowBackgroundSurface, SnowstormBackgroundSurface } from "./snow-background-surface.js";

/**
 * Create a background surface for an effect descriptor.
 *
 * @param {object|null|undefined} descriptor
 * @param {object} config
 * @returns {SnowBackgroundSurface|SnowstormBackgroundSurface|SandBackgroundSurface|RainBackgroundSurface|ScatterBackgroundSurface|null}
 */
export function createParticleBackgroundSurface(descriptor, config = {}) {
  const type = String(descriptor?.type ?? "");
  if (type === "snow") return new SnowBackgroundSurface(config);
  if (type === "snowstorm") return new SnowstormBackgroundSurface(config);
  if (type === "sand") return new SandBackgroundSurface(config);
  if (type === "rain") return new RainBackgroundSurface(config);
  if (type === "scatter") return new ScatterBackgroundSurface({ ...config, descriptor });
  return null;
}
