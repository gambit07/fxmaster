/**
 * Region behavior with no options: if present (and not disabled) in a Region,
 * that Region should suppress SCENE-LEVEL Particle Effects within its area.
 * (Filter Effects remain unaffected.)
 */
export class SuppressSceneParticlesBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FXMASTER.Regions.SuppressSceneParticles"];

  static defineSchema() {
    return {};
  }
}
