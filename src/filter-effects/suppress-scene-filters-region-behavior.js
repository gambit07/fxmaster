/**
 * Region behavior with no options: if present (and not disabled) in a Region,
 * that Region should suppress only scene level Filter Effects within its area.
 */
export class SuppressSceneFiltersBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FXMASTER.Regions.SuppressSceneFilters"];

  static defineSchema() {
    return {};
  }
}
