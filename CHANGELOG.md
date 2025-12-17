# Changelog

## [v7.2.0] - 2025-12-17
- Welcome to FXMaster V7.2! This release focused on performance and consistency improvements for Particle Effects, accomplished in a couple of ways:
  - First, all particle effects have had a pass on their density parameter with more normalized density ranges they can generate Particle effects within. This should prevent issues where you could apply an effect with maximum density on a huge scene and crash it (tested on scenes up to about 16000x12000). Density will now normalize to the number of cells present on a scene. I've tested each of these individually to try to find a good balance between performance and density, happy to hear any feedback (preferably on my Gambit's Lounge Discord) as these can be adjusted further in the future. 
  - Second, I've added in support for Foundrys built-in Performance Mode client setting. FXMaster will now adjust density based on that setting, where percentage is the fraction of total particles set in the manager that will be emitted, Maximum = 100%, High = 75%, Medium = 50%, Low = 25%. This should be a big help for players and GM's on lower end hardware such as laptops, and keep GM's from having to globally reduce particle density in order to not kill their lowest end hardware.
- Added new Elevation Constraints option to 'FXMaster: Suppress Scene Particles' and 'FXMaster: Suppress Scene Filters' behaviors. This functions in the same way as the region behaviors for adding a particle or filter, and will allow suppression based on the parameters set.
- Backend cleanup for Filter and Particle Effects, resolved a number of issues with masking consistency including Dynamic Token Borders not being masked appropriately when belowTokens = true
- Switched Particle and Filter management apps to use default foundry color picker for Tint parameter, only difference is a hex code text input is present for easy copy/paste
- Upodated Particle and Filter management apps to allow using the mouse scroll wheel to increase/decrease parameter values while a range slider is selected. This should be a good middle ground between preventing accidentally changing a parameter and allowing the flexibility of the mousewheel.
- Fog Filter Effect: Updated defaults to work better visually for a standard Fog, renamed Density label to Opacity as that is functionally what the setting does.
- Underwater Filter Effect: Resolved shader crashing in certain scenarios
- Added new localizations for December's FXMaster+ release, Ice! Also added new localizations for FXMaster+'s holiday surprise :]

## [v7.1.4] - 2025-11-26
- Resolved additional Clouds Shadow option shader crash in certain scenarios
- Resolved filters not respecting scene bounds when Performance mode was set to High or lower
- Added missing gating for masks in 0 mask scenarios
- Improved design of slider toggle and improved it's style being overridden in certain systems
- Tweaked the Rain Particle Effect to get better performance via more normalized density

## [v7.1.3] - 2025-11-26
- Resolved additional Clouds Shadow option shader crash in certain scenarios
- Resolved filters not respecting scene bounds when Performance mode was set to High or lower
- Added missing gating for masks in 0 mask scenarios
- Improved design of slider toggle and improved it's style being overridden in certain systems
- Tweaked the Rain Particle Effect to get better performance via more normalized density.

## [v7.1.3] - 2025-11-26
- Resolved additional Clouds Shadow option shader crash in certain scenarios
- Resolved filters not respecting scene bounds when Performance mode was set to High or lower
- Added missing gating for masks in 0 mask scenarios
- Improved design of slider toggle and improved it's style being overridden in certain systems
- Tweaked the Rain Particle Effect to get better performance via more normalized density

## [v7.1.2] - 2025-11-23
- Resolved Clouds Shadow option shader crash in certain scenarios
- Some tweaks to the update release chat card
- Updated pt-br localizations, thanks Kharmans!
- Updated pl localizations, thanks Lioheart!

## [v7.1.1] - 2025-11-22
- Resolved Animation Effects bug that prevented the window from opening if animations db was built but no animations were present
- Resolved missing gate for the belowTokens option on Particle Effects that caused a significant performance drop when a large number of tokens are on the canvas, even with belowTokens off. Additionally, improved performance of the belowTokens option when on for Particle Effects especially in many tokens on scene scenarios.
- Resolved scene Particle Effects not always correctly re-sizing to viewport in certain zoom scenarios
- Resolved a few localization key mismatches
- Resolved a namespace issue for V12 when opening the particle effects window
- Added localization keys for FXMaster+ new Sandstorm and Duststorm effects, and new Rainbow mode for Magic Crystals
- Updated pt-br localizations, thanks Kharmans!

## [v7.1.0] - 2025-11-16
This 7.1 release covers many bugfixes for 7.0, some performance improvements, and visual enhancements for the Particle, Filter, and Animation Effect windows
- Particle & Filter Effects:
  - Updated Particle and Filter boolean inputs to use a visual toggle instead of a checkbox for better style and visibility
  - Added tooltips for all parameters with some brief details on what each means. Tooltips can be turned off in FXMaster settings.
  - Resolved hole areas that extended outside a regions bounds causing effects to crash
  - Resolved hole areas that extended outside a regions bounds not masking filter or particle effects properly
  - Resolved console error regarding window position that could appear if switching between scenes quickly with a Particle or Filter window open
  - Resolved ellipses created using the ALT hotkey for a perfect circle not being accounted for in general region handling due to a type mismatch
  - Resolved belowTokens mask cutout not working correctly when a token was not controlled and under an occluded tile
  - Improve Below Tokens option when using Dynamic Token Rings. Further improvement needed but should give better coverage now.
- Particle Effects:
  - Added new Shadow Only option to the Clouds particle effect. This works when the new V7 Shadow option is on, and will cause only the shadows of clouds to display on the canvas.
  - Improved performance of Clouds new Shadow effect, and fixed shadow effect jitter when windows display scale > 100%
  - Modified belowTokens option for Particle Effects. Stashing effects in different layers turned out to be pretty brittle, so Particles now use the same Filters approach which cuts a mask for a given token. Byproduct of this approach is the belowTokens true option now also maintains effects that play above darkness, above darkness.
  - Increased performance of Particle Effects generally by pooling render texture requests
  - Resolved foundry native overhead occlusion filters for FXMaster particle effects not working
- Filter Effects:
  - Resolved multiple polygon shapes on a single region with an Edge Fade % defined not working properly. Note: Rectangle and Ellipse type region shapes do not support Edge Fade % when creating multiple shapes on a single region.
  - Resolved Thunder Aware mode for the Lightning Filter displaying as usable for V12 users. This option was made possible via a new V13 api and so unfortunately is not supported in V12.
  - Resolved Fog Filter Effect not correctly applying Tint options
  - Resolved ghosting of token and region masks while panning/zooming, which was especially visible for the color filter when Below Tokens was on.
- Animation Effects:
  - Moved the Refresh Animations Database option from the settings menu into the Animation Effects window, and added a toggle for whether to include thumbnail processing
  - Massively improved thumbnail processing time when Refresh Animations Database runs with that option set
  - Improved thumbnail processing for JB2A to better match various string patterns they use
  - Added an Image Popout for Animation Effects when left clicking
  - Added Animation Effects support for new modules Eskie Effects and Eskie Effects Free, module includes thumbnails which are also processed alongside JB2A's
  - Removed Anchor parameter config when modifying animations. This option doesn't make sense when you can place the cursor exactly where you want the animation to be, so removing saves a bit of data on the db object
- Added Czech language support. Thanks Lethrendis!

## [v7.1.0] - 2025-11-16
This 7.1 release covers many bugfixes for 7.0, some performance improvements, and visual enhancements for the Particle, Filter, and Animation Effect windows
- Particle & Filter Effects:
  - Updated Particle and Filter boolean inputs to use a visual toggle instead of a checkbox for better style and visibility
  - Added tooltips for all parameters with some brief details on what each means. Tooltips can be turned off in FXMaster settings.
  - Resolved hole areas that extended outside a regions bounds causing effects to crash
  - Resolved hole areas that extended outside a regions bounds not masking filter or particle effects properly
  - Resolved console error regarding window position that could appear if switching between scenes quickly with a Particle or Filter window open
  - Resolved ellipses created using the ALT hotkey for a perfect circle not being accounted for in general region handling due to a type mismatch
  - Resolved belowTokens mask cutout not working correctly when a token was not controlled and under an occluded tile
  - Improve Below Tokens option when using Dynamic Token Rings. Further improvement needed but should give better coverage now.
- Particle Effects:
  - Added new Shadow Only option to the Clouds particle effect. This works when the new V7 Shadow option is on, and will cause only the shadows of clouds to display on the canvas.
  - Improved performance of Clouds new Shadow effect, and fixed shadow effect jitter when windows display scale > 100%
  - Modified belowTokens option for Particle Effects. Stashing effects in different layers turned out to be pretty brittle, so Particles now use the same Filters approach which cuts a mask for a given token. Byproduct of this approach is the belowTokens true option now also maintains effects that play above darkness, above darkness.
  - Increased performance of Particle Effects generally by pooling render texture requests
  - Resolved foundry native overhead occlusion filters for FXMaster particle effects not working
- Filter Effects:
  - Resolved multiple polygon shapes on a single region with an Edge Fade % defined not working properly. Note: Rectangle and Ellipse type region shapes do not support Edge Fade % when creating multiple shapes on a single region.
  - Resolved Thunder Aware mode for the Lightning Filter displaying as usable for V12 users. This option was made possible via a new V13 api and so unfortunately is not supported in V12.
  - Resolved Fog Filter Effect not correctly applying Tint options
  - Resolved ghosting of token and region masks while panning/zooming, which was especially visible for the color filter when Below Tokens was on.
- Animation Effects:
  - Moved the Refresh Animations Database option from the settings menu into the Animation Effects window, and added a toggle for whether to include thumbnail processing
  - Massively improved thumbnail processing time when Refresh Animations Database runs with that option set
  - Improved thumbnail processing for JB2A to better match various string patterns they use
  - Added an Image Popout for Animation Effects when left clicking
  - Added Animation Effects support for new modules Eskie Effects and Eskie Effects Free, module includes thumbnails which are also processed alongside JB2A's
  - Removed Anchor parameter config when modifying animations. This option doesn't make sense when you can place the cursor exactly where you want the animation to be, so removing saves a bit of data on the db object
- Added Czech language support. Thanks Lethrendis!

## [v7.0.3] - 2025-11-02
- Bugfixes:
  - Small fix for V12, forgot to add a namespace migration

## [v7.0.2] - 2025-11-02
- Bugfixes:
  - Below Tokens: Resolved Particle Effects appearing under tiles when Below Tokens was true
  - Above Darkness: Fix for above darkness effects (Embers, Stars, Fireflies, etc) displaying particles over Fog of War
  - Fixed Particle Effect Groups not assigned the correct localization
  - Fixed Particle Effects in Regions not grouping effect parameters correctly when un-checked

## [v7.0.1] - 2025-10-27
- Updates: Updated pt-br translations, thanks Kharmans!
- Bugfixes:
  - Regions 'Specific Tokens POV' option not working
  - A few small fixes for Token Enter and Exit events. I discovered these still need additional work so expect a future release with some better handling for these events.

## [v7.0.0] - 2025-10-27
Welcome to Gambit's FXMaster V7! DO NOT update to this version right before a session, it contains BREAKING CHANGES.
- BREAKING: Drawing based masks have been fully removed, along with the Invert Particle Effect Mask controls button. The reason for this is simple, drawings were never meant to support a masking system. Regions are able to do everything drawings could do and more. Now on to the fun changes!
- Filter Effects:
  - Gigantic overhaul, re-written from the ground up with custom shaders
  - Effects can now be placed on a region with the new 'FXMaster: Filter Effects' region behavior
  - Effects are now constrained to the bounds of a scene instead of the entire canvas
  - Effects can now be suppressed, either globally via Suppress Weather, or with a new 'FXMaster: Suppress Scene Filters' Region Behavior
  - Region Effects now have a Edge Fade % parameter, which softens the edges of a Region for more realistic visualizations
  - Added a Thunder Aware audio mode for the Lightning effect. Increased max period for lightning effect to allow longer durations between lightning flashes
- Particle Effects:
  - Effects can now be suppressed either globally via Suppress Weather, or with a new 'FXMaster: Suppress Scene Particles' Region Behavior
  - Increased max available density for rats particle effect
  - Modified fade-in and fade-out time for particle effects to a 5 second default, down from 20 seconds
  - Updated Particle Masking and Particle Emissions to better work with modules that create weird regions, ie Terrain Mapper
  - Updated Particle Effects Window to better handle resizes in combination with effect expansion
  - Updated Cloud Effect with new Shadow options
  - Updated Stars and Embers effects to play above the lighting layer, allowing them to be visible in darkness
  - Updated Rain effect to include a Splash parameter. Removed the separate Rain No Splash effect
  - Updated Rain Top Down effect to include a Splash parameter.
- Particle & Filter Effects:
  - Suppression via Suppress Weather, FXMaster: Suppress Scene Filters, or FXMaster: Suppress Scene Particles only effect Scene level filters and particles, meaning a region specific Filter or Particle effect can be overlayed on top of a Suppression behavior region.
  - Effects can now be placed above or below a token
    - New Scene and Region Below Tokens option per Particle and Filter Effect. When off, particles display above tokens. When on, particles display below tokens.
  - Effects now respect elevation when used on a region
    - New region behavior option Elevation Constraints. None - Region is always visible. Tokens POV - Region is restricted to any controlled tokens pov at a given elevation. Specific Tokens POV - Set of controlled tokens that are valid to see an effect at a given elevation.
  - Updated effects to pull currently active parameters for a scene instead of always using passive defaults when relevant
  - Updated effects to change to active scenes parameter options when a scene is changed instead of maintaining parameter options from the original scene, when relevant
  - Updated effects to display parameter output values in real time when using the arrow keys to make adjustments
- Added animation effect support for Baileywiki modules assets
- Updated localization file layouts, many new keys added but structure was ported and translation was ported/added where possible across all existing files. 
- Many more small bugfixes and tweaks

## [v6.0.11] - 2025-08-29
- Added a few new localization keys for the monthly FXMaster+ release
- Made a few tweaks to functionality to support the newest FXMaster+ particle effect, Magic Crystals

## [v6.0.9] - 2025-07-21
- Resolved FXMaster+ effects not showing up in region config
- Enabled proper masking for the firefly effect
- Updated pt-br and pl translations, thanks Kharmans and Lioheart!

## [v6.0.8] - 2025-07-19
- Updated regions Suppress Weather functionality to allow scene level particle effects to play in areas marked as a hole within a Suppress Weather region
- Added a few localization keys for July's new FXMaster+ effects
- Updated pt-br and pl translations, thanks Kharmans and Lioheart!

## [v6.0.7] - 2025-07-16
- Updated Clear Particle and Filter Effects button dialog to dialogV2. Now clears Particle and Filter Sidebar controls buttons highlighting immediately.
- Resolve issue with region masking on one scene applying across multiple scenes even if no region was present on other scenes
- Updated the onUpdateParticleEffects api to allow the particle effects app window buttons to end effects when relevant
- Added additional logging to animation effects to give clearer direction if no animation files are found
- Additional localization keys added

## [v6.0.6] - 2025-07-09
- Resolve issue with region initialization being done too late causing an issue where tokens were unable to move
- Resolve issue with the 'Suppress Weather' region behavior not working for ellipse and polygon region types
- Couple small bugfixes for css button color assignment

## [v6.0.5] - 2025-07-08
- Resolve doubling up of the initial Animation Module scan when switching scenes
- Removed thumbnail scan on first Animation Module scan. The process can take quite a while, especially on hosted services, so it will only be run when done manually through the Module settings page.

## [v6.0.4] - 2025-07-07
- Resolve Particle Effects window not auto-adjusting size based on dropdown expansion
- Removed !important css tags that were unnecessary
- Added updated pt-BR and pl translations from Kharmans and Lioheart. Thanks!
- Resolved update chat message displaying on every refresh in V12
- Resolve Suppress Weather masking not applying consistently

## [v6.0.3] - 2025-07-06
- Resolve module.zip not including the parent fxmaster folder
- Remove test css line left in effecting all buttons
- Add UI notification error if attempting to open the Animation Effects window without the Animations DB being properly built

## [v6.0.0] - 2025-07-06
FXMaster Version 6! Big visual and functional overhaul. V12 & V13 compatible. Removed all previously deprecated code. To reduce module size - removed individual animation assets hosted within the module and converted all module image assets to webp from png. Added and updated a number of localization keys. Changed module name to Gambit's FXMaster to align with my other modules, identifiers remains unchanged. Overview of the updates below, although I'm sure there will be some stuff I missed!
- Filter Effects
  - Re-wrote the menu for application v2!
  - Toggles can now be enabled and disabled individually. Toggle parameters will be updated in real time when making a change, and parameters will remember the last set value. 
  - Window position will be saved based off last placement.
- Particle Effects
  - Re-wrote the menu for application v2!
  - Toggles can now be enabled and disabled individually.
  - Toggle parameters will be updated in real time when making a change, and parameters will remember the last set value.
  - Window position will be saved based off last placement, along with window width.
  - App updated for a 3 column layout. This can be adjusted by re-sizing the app window, single column width is still supported.
  - NEW: Region support! You can now add particle effects to a region with the 'FXMaster: Particle Effects' region behavior.
  - NEW: Regions now support masking scene level particle effects, which can be applied with the 'Suppress Weather' region behavior. This respects FXMasters invert particle effect mask scene tool as well.
- Animation Effects (Previously Special Effects)
  - Complete overhaul. The goal of this re-work was to remove seldom used features and focus on giving this window an identity. In my mind that was a tool that allows flexible previewing and searching of animations.
  - FXMaster no longer supports features that overlapped with Sequencer, Sequencer is just better (much better) at those things. Placing animations via drag-drop as a tile is still supported, and the scale and anchor parameters can still be set on each animation.
  - App now displays animations in a grid. The window can be re-sized to change animation sizes for large previews on hover.
  - Animation details can be viewed and include file name, file path, and sequencer db path where relevant.
  - NEW: Added search functionality with more advanced query support via AND, OR, and NOT. As an example, this will allow searching for any animation with eldritch in the name but not blast - ex: eldritch AND NOT blast
  - NEW: Added support for all major animation modules. Animations db will be built on first load after update based off modules present. The Animations db can be re-built at any time through the FXMaster settings page if animation modules are added, updated, or removed.
  - NEW: Added support for custom animation folders. This can be specified in the FXMaster settings page.
  - NEW: Added the ability to favorite animations, these will be accessible as a dropdown filter tag along with the major animation authors and custom folder

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [5.0.1](https://github.com/ghost-fvtt/fxmaster/compare/v5.0.0...v5.0.1) (2025-05-21)


### Bug Fixes

* include additional logic to prevent erroneous ui warning on token drop to canvas ([086ad9d](https://github.com/ghost-fvtt/fxmaster/commit/086ad9d907a5fd44f4440cbcf55cbff201f0c419))

## [5.0.0](https://github.com/ghost-fvtt/fxmaster/compare/v4.1.1...v5.0.0) (2025-05-21)


### ⚠ BREAKING CHANGES

* v13 compatible release
* v13 compatible release
* v13 Compatability
* V13 Compatability. Check the Github readme for more info
* V13 Compatability. Visit the github for more info

### Features

* more v13 things ([77bb702](https://github.com/ghost-fvtt/fxmaster/commit/77bb70202e71cde06ea202b093868df4fdc48890))
* official v13 release ([b0d7ef3](https://github.com/ghost-fvtt/fxmaster/commit/b0d7ef31e134b473046d96aa66f4010141f23007))
* v13 Compatability ([ba3b0d1](https://github.com/ghost-fvtt/fxmaster/commit/ba3b0d1c851566f8dd5eb00a6a4015e1775009df))
* V13 Compatability. Check the Github readme for more info ([7603a99](https://github.com/ghost-fvtt/fxmaster/commit/7603a99301bf391355c8b7e73f54a3291c4a8c41))
* V13 Compatability. Visit the github for more info ([56edae9](https://github.com/ghost-fvtt/fxmaster/commit/56edae9268cc775ed8e5008406b62591fc1956f6))
* v13 compatible release ([3421abb](https://github.com/ghost-fvtt/fxmaster/commit/3421abb87316596ed23b7ad45c5d2278e5b2ec64))
* v13 compatible release ([4a58b9d](https://github.com/ghost-fvtt/fxmaster/commit/4a58b9d9e60f42cbe650563b70701103ebc2fbf1))

### [4.1.1](https://github.com/ghost-fvtt/fxmaster/compare/v4.1.0...v4.1.1) (2025-05-18)

## [4.1.0](https://github.com/ghost-fvtt/fxmaster/compare/v4.0.2...v4.1.0) (2024-09-08)


### Features

* add support for v12 ([8e2f175](https://github.com/ghost-fvtt/fxmaster/commit/8e2f175bfe925e35ea6defb4ecae0be82f372b86))


### Bug Fixes

* add missing awaits ([ec1f2d2](https://github.com/ghost-fvtt/fxmaster/commit/ec1f2d2bdd08244d27f14a98995eb116e2f1051b)), closes [#761](https://github.com/ghost-fvtt/fxmaster/issues/761)

### [4.0.2](https://github.com/ghost-fvtt/fxmaster/compare/v4.0.1...v4.0.2) (2023-06-15)


### Bug Fixes

* make the weather mask work properly for polygon drawings ([38d8f58](https://github.com/ghost-fvtt/fxmaster/commit/38d8f58c68eded53a55d39f4e1a5da5523c54de8)), closes [#521](https://github.com/ghost-fvtt/fxmaster/issues/521)

### [4.0.1](https://github.com/ghost-fvtt/fxmaster/compare/v4.0.0...v4.0.1) (2023-05-28)


### Bug Fixes

* add migration for scene weather configuration ([3df17a3](https://github.com/ghost-fvtt/fxmaster/commit/3df17a30f7132d2b24ecce77d1a9a8b9cf92db3a))

## [4.0.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.6.0...v4.0.0) (2023-05-28)


### ⚠ BREAKING CHANGES

* Dropped support for v10

### Features

* add support for v11 ([aec47f0](https://github.com/ghost-fvtt/fxmaster/commit/aec47f08b834ea89913a0505761ccda8dc2f2db9))

## [3.6.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.5.2...v3.6.0) (2023-03-22)


### Features

* add German localization ([97012c8](https://github.com/ghost-fvtt/fxmaster/commit/97012c8a61a08ec07309d2924a9752bbbb9fd89d))
* add opacity option to particle effects ([afa74ce](https://github.com/ghost-fvtt/fxmaster/commit/afa74ce9e0581cadf201127497d1b9bde5c98072)), closes [#305](https://github.com/ghost-fvtt/fxmaster/issues/305)


### Bug Fixes

* don't rerender Special Effects Management on every world setting change ([5a2984e](https://github.com/ghost-fvtt/fxmaster/commit/5a2984e7dffeba9c5326483ce1aeca5a11fa6b72)), closes [#438](https://github.com/ghost-fvtt/fxmaster/issues/438)

### [3.5.2](https://github.com/ghost-fvtt/fxmaster/compare/v3.5.1...v3.5.2) (2022-12-17)


### Bug Fixes

* address issue that that snow particle effect wasn’t configurable ([bfb05d8](https://github.com/ghost-fvtt/fxmaster/commit/bfb05d80dd8923cc1dbc77c706584214974de8b7))

### [3.5.1](https://github.com/ghost-fvtt/fxmaster/compare/v3.5.0...v3.5.1) (2022-11-12)


### Bug Fixes

* fix issue with old scene mask not being cleared on scene change ([cd875dc](https://github.com/ghost-fvtt/fxmaster/commit/cd875dc008af5aa8611c9a7e0595bfd79453b293))
* remove bottom border on special effect folders ([9f7f2e8](https://github.com/ghost-fvtt/fxmaster/commit/9f7f2e85aaa32295fe21d7c9ac8e7edadd9e528b))

## [3.5.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.4.0...v3.5.0) (2022-09-01)


### Features

* add fog filter (experimental, might change at any time, use at your own risk) ([336eea5](https://github.com/ghost-fvtt/fxmaster/commit/336eea514808dcab290247310c9da767ead2a9a7)), closes [#67](https://github.com/ghost-fvtt/fxmaster/issues/67)

## [3.4.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.3.0...v3.4.0) (2022-08-17)


### Features

* add compatibility with v10.278 ([358f37a](https://github.com/ghost-fvtt/fxmaster/commit/358f37ac041b61190e57fc605f03ce3294c131c9))

## [3.3.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.2.0...v3.3.0) (2022-08-14)


### Features

* prewarm particle effects when loading a scene ([22930c4](https://github.com/ghost-fvtt/fxmaster/commit/22930c4cb4ced78a104a23ea64e16b3d388e3426))


### Bug Fixes

* address an issue where particle effects were not properly vanishing when they were disabled ([9fef0b5](https://github.com/ghost-fvtt/fxmaster/commit/9fef0b556d0f732de2a29dd4ec1e78d0caf978ab))

## [3.2.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.1.5...v3.2.0) (2022-07-29)


### Features

* make filters apply to lighting ([5c3eab0](https://github.com/ghost-fvtt/fxmaster/commit/5c3eab06c262a62a88753ae526fbfdb6b5877cb5))

### [3.1.5](https://github.com/ghost-fvtt/fxmaster/compare/v3.1.4...v3.1.5) (2022-07-25)


### Bug Fixes

* improve updating filters and their animations ([6b5f4d6](https://github.com/ghost-fvtt/fxmaster/commit/6b5f4d66184f9e9c58c97d53554650b7d530ffde)), closes [#176](https://github.com/ghost-fvtt/fxmaster/issues/176)

### [3.1.4](https://github.com/ghost-fvtt/fxmaster/compare/v3.1.3...v3.1.4) (2022-07-24)


### Bug Fixes

* address deprecation warning about `CONFIG.fxmaster.specials` ([4f480f2](https://github.com/ghost-fvtt/fxmaster/commit/4f480f28af07e26ff409cec5e025b038a90a4813))
* properly handle switching multiple effects with the `fxmaster.switchParticleEffect` hook ([36c42df](https://github.com/ghost-fvtt/fxmaster/commit/36c42df2f2ed15ddf5c84aa383217d187feefd8e)), closes [#320](https://github.com/ghost-fvtt/fxmaster/issues/320)

### [3.1.3](https://github.com/ghost-fvtt/fxmaster/compare/v3.1.2...v3.1.3) (2022-07-22)


### Bug Fixes

* make the filter area the whole screen ([40309d8](https://github.com/ghost-fvtt/fxmaster/commit/40309d8378e9f86bcbf9fd03e29b66eb220fe8f3))
* translate filter effect name when saving a filter as a macro ([6ba8205](https://github.com/ghost-fvtt/fxmaster/commit/6ba820569f261f922684089d50961046b0431e18))

### [3.1.2](https://github.com/ghost-fvtt/fxmaster/compare/v3.1.1...v3.1.2) (2022-07-22)

### [3.1.1](https://github.com/ghost-fvtt/fxmaster/compare/v3.1.0...v3.1.1) (2022-07-22)


### Bug Fixes

* update for v10.274 ([8693c3b](https://github.com/ghost-fvtt/fxmaster/commit/8693c3ba95f705787766690b1ca736d6a6ec4fe3))

## [3.1.0](https://github.com/ghost-fvtt/fxmaster/compare/v3.0.0...v3.1.0) (2022-07-17)


### Features

* **lang:** update brazilian portuguese translation ([9f500dc](https://github.com/ghost-fvtt/fxmaster/commit/9f500dca283c5f2ccd2fd26b1ef31d39c8e7ef54))

## [3.0.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.7.0...v3.0.0) (2022-07-17)


### ⚠ BREAKING CHANGES

* * Support for v9 has been dropped
* Weather effects have been renamed to particle effects:
  * The hooks `fxmaster.updateWeather`, `fxmaster.switchWeather` have been
    replaced by `fxmaster.updateParticleEffects` and
	`fxmaster.switchParticleEffect`. Compatibility shims exist but will be
	removed in v4.
  * Properties of `canvas.fxmaster` have been renamed (`weather` =>
    `particleEffectsContainer`, `weatherEffects` => `particleEffects`,
	`drawWeather` => `drawParticleEffects`)
  * `CONFIG.fxmaster.weather` is deprecated and has been replaced by
    `CONFIG.fxmaster.particleEffects`. A compatibility shim still exists
	but it will be removed in v4.
* The hook `fxmaster.drawWeather` has been removed
* Many assets have been moved. For the most important things (e.g. macro
  icons), there are migration, but not for everything.
* The possibility to apply filters only to specific canvas layers has been
  removed (unfortunately necessary due to changes in foundry core).
* The implementation of the masking functionality has changed completely,
  which very likely breaks compatibility with modules such as
  Weather Blocker and Perfect Vision, which have been patching that
  functionality.
* The `updateMask` hook has been removed.

### Features

* add support for Foundry Virtual Tabletop v10 ([d8c48a4](https://github.com/ghost-fvtt/fxmaster/commit/d8c48a435ff42c73d9e5036b1c73cd4ba93f4766))


### Bug Fixes

* address a small issue in world migration 3 and improve french translation ([38ff166](https://github.com/ghost-fvtt/fxmaster/commit/38ff1665adf70f2f17ea7fe65b2cbdd5d3dc0b59))

## [2.7.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.6.0...v2.7.0) (2022-04-25)


### Features

* make the save button for the weather and filter managments disabled until a change is made ([8292b61](https://github.com/ghost-fvtt/fxmaster/commit/8292b6130b52b47844bb492238267aea7e21faea))

## [2.6.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.5.0...v2.6.0) (2022-04-23)


### Features

* group weather effects (animals, other, weather) and sort weather and filter effects ([a67c26c](https://github.com/ghost-fvtt/fxmaster/commit/a67c26c9268c72f929b5a017dc89d525ac8f7d3a))

## [2.5.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.4.0...v2.5.0) (2022-04-23)


### Features

* add line width parameter for predator filter ([621ccc7](https://github.com/ghost-fvtt/fxmaster/commit/621ccc7a2a54d2ad76fa99fb015386911b86e49d))


### Bug Fixes

* fix the old fil and predator filter vanishing over time ([3abd496](https://github.com/ghost-fvtt/fxmaster/commit/3abd4963799a6dd75961116c30ada64a01a8dac2))

## [2.4.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.3.3...v2.4.0) (2022-03-24)


### Features

* add rats weather effect ([7a0a68e](https://github.com/ghost-fvtt/fxmaster/commit/7a0a68e08fcdbcb216c8dad91ddbb967111efcd5))

### [2.3.3](https://github.com/ghost-fvtt/fxmaster/compare/v2.3.2...v2.3.3) (2022-03-08)


### Bug Fixes

* remove non-existent lang from module.json ([723c5e7](https://github.com/ghost-fvtt/fxmaster/commit/723c5e7702dedbda83c033907ba62124456aa432))

### [2.3.2](https://github.com/ghost-fvtt/fxmaster/compare/v2.3.1...v2.3.2) (2022-02-22)


### Bug Fixes

* load special effect files lazily ([5d29064](https://github.com/ghost-fvtt/fxmaster/commit/5d2906483d40a218fef78b9449923decf2e8a6af)), closes [#209](https://github.com/ghost-fvtt/fxmaster/issues/209)

### [2.3.1](https://github.com/ghost-fvtt/fxmaster/compare/v2.3.0...v2.3.1) (2022-02-08)

## [2.3.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.2.4...v2.3.0) (2022-02-08)


### Features

* save filter effects to macro ([208b547](https://github.com/ghost-fvtt/fxmaster/commit/208b54791d2d1d3175fe23b933b678defe4b5fcb))

### [2.2.4](https://github.com/ghost-fvtt/fxmaster/compare/v2.2.3...v2.2.4) (2022-02-01)

### [2.2.3](https://github.com/ghost-fvtt/fxmaster/compare/v2.2.2...v2.2.3) (2022-01-31)

### [2.2.2](https://github.com/ghost-fvtt/fxmaster/compare/v2.2.1...v2.2.2) (2022-01-17)


### Bug Fixes

* make multiple filters of the same type work correctly together—for real this time ([a46b56b](https://github.com/ghost-fvtt/fxmaster/commit/a46b56b8ed652e1fe4e9bf991a5c035aa0d3dfe2)), closes [#167](https://github.com/ghost-fvtt/fxmaster/issues/167)

### [2.2.1](https://github.com/ghost-fvtt/fxmaster/compare/v2.2.0...v2.2.1) (2022-01-16)


### Bug Fixes

* address conflict between SpecialsLayer and overhead tiles + walls ([faf7ac8](https://github.com/ghost-fvtt/fxmaster/commit/faf7ac8c043da47732270eaa7ce44e7aac944eb1)), closes [#173](https://github.com/ghost-fvtt/fxmaster/issues/173)
* correctly animate multiple filters of the same type ([#175](https://github.com/ghost-fvtt/fxmaster/issues/175)) ([ff5fdd8](https://github.com/ghost-fvtt/fxmaster/commit/ff5fdd861bb0064696cda9635f56c8876009e896)), closes [#167](https://github.com/ghost-fvtt/fxmaster/issues/167)
* use suitable values in example macros ([#174](https://github.com/ghost-fvtt/fxmaster/issues/174)) ([25c836a](https://github.com/ghost-fvtt/fxmaster/commit/25c836ad88d23a6a92381946e494075e0c1b4387))

## [2.2.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.1.2...v2.2.0) (2022-01-09)


### Features

* add additional selectable animations for the bird weather effect ([9cb8bd2](https://github.com/ghost-fvtt/fxmaster/commit/9cb8bd2cef8a580e13865f3ce898a8c1d8644667)), closes [#65](https://github.com/ghost-fvtt/fxmaster/issues/65)
* add density option for clouds ([da139c5](https://github.com/ghost-fvtt/fxmaster/commit/da139c50f84b908146e69c63fd00448073214b33)), closes [#121](https://github.com/ghost-fvtt/fxmaster/issues/121)
* add eagles weather effect ([2f7f0ca](https://github.com/ghost-fvtt/fxmaster/commit/2f7f0ca71de69d272fbd4526e1392eebb4202f15))
* add the ability to adjust the lifetime of particles in weather effects ([edc7972](https://github.com/ghost-fvtt/fxmaster/commit/edc7972f384bed048fd1ba6728c47126cb6dd4b7))
* adjust weather effects according to scene offset ([0dbd3fe](https://github.com/ghost-fvtt/fxmaster/commit/0dbd3fe33b508dc2fccc9b970c89cf90bb7163ef)), closes [#146](https://github.com/ghost-fvtt/fxmaster/issues/146)
* improve the Topdown Rain weather effect ([f8eb819](https://github.com/ghost-fvtt/fxmaster/commit/f8eb8199b61f0505b93cf923db45c7daf8b5264a))
* make make handling of weather and filter effects more robust against unknown types ([3ebee9d](https://github.com/ghost-fvtt/fxmaster/commit/3ebee9d1c7547ffbb092cbbd31f60545ce23cfd9))
* scale life time inversely proportional with speed ([6974d31](https://github.com/ghost-fvtt/fxmaster/commit/6974d31a66422b6c2d58a7520e5293b693903d49))


### Bug Fixes

* adjust frequency of snow and snowstorm weather effects to avoid lull ([147ca32](https://github.com/ghost-fvtt/fxmaster/commit/147ca321ff9b69d1d246607bdb23c093469c735c)), closes [#122](https://github.com/ghost-fvtt/fxmaster/issues/122)
* use the correct default value for direction in the weather config ([9c60715](https://github.com/ghost-fvtt/fxmaster/commit/9c6071559d0c44f1109a00cf7a38ba04d6446ede))

### [2.1.2](https://github.com/ghost-fvtt/fxmaster/compare/v2.1.1...v2.1.2) (2022-01-05)


### Bug Fixes

* avoid recursion problem when deferring drawing the weather layer ([bc00024](https://github.com/ghost-fvtt/fxmaster/commit/bc00024cfafea2369b95af0b42acd8b870173c2d))
* make lighting correctly affect weather and specials ([#153](https://github.com/ghost-fvtt/fxmaster/issues/153)) ([cfe28cf](https://github.com/ghost-fvtt/fxmaster/commit/cfe28cf3270d006d3e269ff56481fca7fe765cfe)), closes [#149](https://github.com/ghost-fvtt/fxmaster/issues/149)

### [2.1.1](https://github.com/ghost-fvtt/fxmaster/compare/v2.1.0...v2.1.1) (2022-01-04)


### Bug Fixes

* if migrations need to be performed, defer drawing of weather to when they are done ([e43221d](https://github.com/ghost-fvtt/fxmaster/commit/e43221daf3993876ea01665bbec053efad3e1916)), closes [#144](https://github.com/ghost-fvtt/fxmaster/issues/144)
* make weather scene mask work when sceneRect is not contained in rect ([7a6685f](https://github.com/ghost-fvtt/fxmaster/commit/7a6685f4fae23437832b913514bb3754f5db7160))

## [2.1.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.0.2...v2.1.0) (2021-12-28)


### Features

* make it possible to wait for effects to be stopped ([c7a1b9b](https://github.com/ghost-fvtt/fxmaster/commit/c7a1b9b93adb72b3678bfa47e77d6f7f72fd9395))


### Bug Fixes

* add guards against there not being a canvas.scene ([bc866bf](https://github.com/ghost-fvtt/fxmaster/commit/bc866bf405c8f9cdbedaab2797504d9c3d4ee672))
* make enable and disableAll settings work properly again ([45040a5](https://github.com/ghost-fvtt/fxmaster/commit/45040a51cd6761752bed6757acabc1e6a659a3d0)), closes [#139](https://github.com/ghost-fvtt/fxmaster/issues/139)

### [2.0.2](https://github.com/ghost-fvtt/fxmaster/compare/v2.0.1...v2.0.2) (2021-12-26)


### Bug Fixes

* make compatible with Weather Blocker ([fe61e34](https://github.com/ghost-fvtt/fxmaster/commit/fe61e349f4678353ec99f28746ec32f4a1995d84))

### [2.0.1](https://github.com/ghost-fvtt/fxmaster/compare/v2.0.0...v2.0.1) (2021-12-25)


### Bug Fixes

* don't redraw weather if the weather mask is inverted ([d6899cc](https://github.com/ghost-fvtt/fxmaster/commit/d6899cc43af90195ba5fe2dea61fc379575a15dc))
* make drawings mask work when drawing are outside of the scene ([cfe0a81](https://github.com/ghost-fvtt/fxmaster/commit/cfe0a816f0d8608de08056c3857996da60963b2f))
* make filter addition / removal play nice with non-fxmaster filters ([aa41c67](https://github.com/ghost-fvtt/fxmaster/commit/aa41c67addcd79211d049c9a76b6c4245e08f6e3))
* make using special effects by clicking (not dragging) the canvas work ([6fbccea](https://github.com/ghost-fvtt/fxmaster/commit/6fbcceaf95b1dcb49afe93f1bf813153a1fc9cee)), closes [#129](https://github.com/ghost-fvtt/fxmaster/issues/129)

## [2.0.0](https://github.com/ghost-fvtt/fxmaster/compare/v2.0.0-rc2...v2.0.0) (2021-12-20)

## [2.0.0-rc2](https://github.com/ghost-fvtt/fxmaster/compare/v2.0.0-rc1...v2.0.0-rc2) (2021-12-19)


### Bug Fixes

* add backwards compatibility for `canvas.fxmaster._createInvertMask` ([d9bba42](https://github.com/ghost-fvtt/fxmaster/commit/d9bba42e4fc5ae367ddf8e20917c31eeb777d0b2))
* add backwards compatibility for `FXMASTER.filters.apply_to` ([82007b9](https://github.com/ghost-fvtt/fxmaster/commit/82007b95af7434a9113941bc6e82edfdc27f9448))
* destroy old mask when updating the mask to prevent memory leak ([05fa8a1](https://github.com/ghost-fvtt/fxmaster/commit/05fa8a1e3a0dc1600193d52231ee500f94af9589))
* round scale, speed, and density during migration to prevent long decimal numbers being shown ([09b5a90](https://github.com/ghost-fvtt/fxmaster/commit/09b5a902bda04617cfd2c25abf921700e20842ed)), closes [#114](https://github.com/ghost-fvtt/fxmaster/issues/114)

## [2.0.0-rc1](https://github.com/ghost-fvtt/fxmaster/compare/v1.2.1...v2.0.0-rc1) (2021-12-17)


### ⚠ BREAKING CHANGES

* remove `canvas.fxmaster.playVideo`, use
`canvas.specials.playVideo` instead.
* In foundry V9, it's not possible anymore to manipulate
the permissions in `CONST`. For that reason, it was necessary to switch
to using a setting instead. Unfortunately, it is not easily possible to
to migrate from the old way to the new way, so users will have to adapt
their settings to match what they had configured previously.
* A lot of things have been moved around. In particular, the es modules
  * module/controls.js
  * filterEffects/FilterManager.js
  * filterEffects/filtersDB.js
  * specialEffects/specialsDB.js
  * specialEffects/SpecialsLayer.js
  * weatherEffects/weatherDB.js
  * weatherEffects/WeatherLayer.js

  do not exist anymore. Asset files also have been moved.

### Features

* **i18n:** update pt-BR localization ([#106](https://github.com/ghost-fvtt/fxmaster/issues/106)) ([2555f84](https://github.com/ghost-fvtt/fxmaster/commit/2555f84eda0fef114951d8573f0bbaacad9d6835))
* localize titles for layer toggle checkboxes in the filter config ([8873f0e](https://github.com/ghost-fvtt/fxmaster/commit/8873f0e514b09d400e56efc6c9ec4a2f792963ff)), closes [#112](https://github.com/ghost-fvtt/fxmaster/issues/112)
* make all weather effects available in the scene config ([6b1aa56](https://github.com/ghost-fvtt/fxmaster/commit/6b1aa56c839720cf74933284e3b65e45ba78c0ec))
* make compatible with foundry V9 ([e2320a5](https://github.com/ghost-fvtt/fxmaster/commit/e2320a5f17752060500d765d0cd2c3b65ea71b61))
* remove the donation button from the settings ([6298330](https://github.com/ghost-fvtt/fxmaster/commit/6298330ebdefe589f7db280e79816f5a0b884a4c))
* remove WeatherLayer#playVideo ([399b4dd](https://github.com/ghost-fvtt/fxmaster/commit/399b4dd4bdcdc9867977ce7191d174956d437c55))
* rework weather options ([#110](https://github.com/ghost-fvtt/fxmaster/issues/110)) ([5eb0d07](https://github.com/ghost-fvtt/fxmaster/commit/5eb0d07975fce14a60514ec27a0247c05f04da95))
* switch to common package layout ([3f99379](https://github.com/ghost-fvtt/fxmaster/commit/3f993799ca6cb784843ff18ffc21c9aed74767a7))


### Bug Fixes

* fix a bug where weather effects were not removed correctly ([079a610](https://github.com/ghost-fvtt/fxmaster/commit/079a61001c9089ec8d624c1972f0f2f8e6aa30ca))
* fix broken filter macro in compendium ([096c0a5](https://github.com/ghost-fvtt/fxmaster/commit/096c0a55ca366ceac4f8cbcb84ccf8d576ad4571))
* fix problem with filters not being displayed if the filteredLayers have not been set yet ([983d9d8](https://github.com/ghost-fvtt/fxmaster/commit/983d9d820e38f9d6dc1021b077fa87a0b7f79624)), closes [#97](https://github.com/ghost-fvtt/fxmaster/issues/97)
* make non inverted masks work in V9 ([8b251ce](https://github.com/ghost-fvtt/fxmaster/commit/8b251ce00a5708cca6145737c112fbc46816803d))

## [1.2.1] - 2021-07-08
### Changed
- Reworked sliders to be easier to work with
- Fixed spider assets names

## [1.2.0] - 2021-07-03
# Added
- **Breaking:** Reworked weather effects configuration
- Added spider swarm weather effect
- Spanish update
- Inverted weather mask toggle
- set Timeout after stopping effect to force delete if particles are staying too long
- Filters can be applied to a subset of layers
- Added casting modes to Special effects config panel
- Added canvas.fxmaster.playVideo migration warning

## [1.1.4] - 2021-06-23
### Changed
- Hotfix

## [1.1.3] - 2021-06-23
### Changed
- Hotfix

## [1.1.2] - 2021-06-23
- Version update

## [1.1.1] - 2021-06-22
### Added
- Filters configuration panel
- Special effects can be dragged to the macro bar
- Added a drawFacing method
- Special effects can be dropped on the SpecialsLayer to create Tiles
### Changed
- BREAKING MACROS: layers have been split between weather and specials, playVideo method is now integrated in canvas.specials

## [1.1.0] - 2021-06-16
### Added
- Weather masking can be toggled on drawings (see drawing HUD icons)
- Lightning filter
- drawWeather and updateMask Hooks
### Changed
- FXMaster no longer overrides custom layers from other modules

## [1.0.9] - 2021-06-02
### Added
- Custom special effects can be sorted in folders
- Preset special effects can be cloned and overriden for editing
- Special effects are sorted in ascii order in their folder
### Changed
- No longer overrides tokens, background and foreground pixi filters to enhance compatibility
## Removed

## [1.0.8] - 2021-05-30
### Added
- Special effects now have their own permission
### Changed
- FXMasterLayer now extends CanvasLayer (previously PlaceablesLayer), it may correct a few bugs
## Removed

## [1.0.7] - 2021-05-29
### Added
### Changed
- Various fixes for Foundry 0.8.x
## Removed

## [1.0.6] - 2021-05-23
### Added
### Changed
- Fixed Weather UI not updating weather
- PlayVideo and DrawSpecialToward now returns a promise
### Removed

## [1.0.5] - 2021-05-21
### Added
- Donation link
### Changed
- Compatibility with 0.8.4
- Weather effects now end softly on scene update
### Removed

## [1.0.4] - 2021-05-21
### Added
### Changed
- Added legacy link for v0.7.9 compatibility
### Removed

## [1.0.3] - 2021-01-26
### Added
### Changed
- Accepted merge requests for translations
### Removed

## [1.0.2] - 2021-01-08
### Added
- Animation settings in the specials creation dialog
### Changed
- Fixed speed not taken into account without the animationDelay set up
### Removed

## [1.0.1] - 2021-01-06
### Added
- Animation easing
### Changed
- Fixed readme examples
- Show special effects to players
- Special effects can be added with a module
### Removed

## [1.0.0] - 2020-11-29
### Added
- Blood splatter special effect
- Added tooltip on specials labels
- Specials playback rate can be specified in macros only
### Changed
- Specials list is now taken from the CONFIG.fxmaster.specials array so modules can add to it
- Specials now deletes if the video encounters an error
- Fixed socket name for specials
- Specials config dialog is resizable
### Removed

## [0.9.9] - 2020-11-26
### Added
- Added Birds weather effect
- Added speed parameter for moving special effects
### Changed
- Removed a couple of console logs
- Improved the snowstorm effect
### Removed

## [0.9.8] - 2020-11-19
### Added
- Added default values for special effects parameters
### Changed
- Fixed scale not set on special effect edition
### Removed

## [0.9.7] - 2020-11-18
### Added
### Changed
- Fixed weather effect configuration
- Fixed crossOrigin 
### Removed

## [0.9.6] - 2020-11-18
### Added
- Custom special effects can be edited
- Fireball special effect
### Changed
- Fixed weather effects and filter updates 
### Removed