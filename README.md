<h1 style="text-align: center;">Gambit's FXMaster</h1>
<p style="text-align: center;"><img src="https://img.shields.io/github/v/release/gambit07/fxmaster?style=for-the-badge" alt="GitHub release" /> <img src="https://img.shields.io/github/downloads/gambit07/fxmaster/total?style=for-the-badge" alt="GitHub all releases" /> <a href="https://discord.gg/YvxHrJ4tVu" target="_blank" rel="nofollow noopener"><img src="https://dcbadge.limes.pink/api/server/BA7SQKqMpa" alt="Discord" /></a></p>
<h2 style="text-align: center;">Supporting The Module</h2>
<p style="text-align: center;"><a href="https://ko-fi.com/gambit07" target="_blank" rel="nofollow noopener"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="ko-fi" /></a> <a href="https://www.patreon.com/GambitsLounge" target="_blank" rel="nofollow noopener"> <img src="https://img.shields.io/badge/Patreon-Gambits Lounge-F96854?style=for-the-badge&amp;logo=patreon" alt="Patreon Gambits Lounge" /> </a></p>
<hr/>
<p>Welcome to the official release of FXMaster V7! This is a massive overhaul of Filters which have essentially been re-built from the ground up. Scene Filters can now be masked by regions, and Filters can be played directly within Regions. To allow making filters look more realistic, there is a new Edge Fade % parameter that will gradually fade a given effect to the region borders. Beyond Filter exclusive functionality, regions have been given much more flexibility by allowing elevation restrictions for both Particles and Filters. This will be super helpful for users of the Levels module, and more generally the upcoming Foundry V14 core levels integration. Particles and Filters have also received another often requested feature, the ability to place tokens above or below a given effect. Finally, many Particles and Filters have seen tweaks and functionality enhancements in V7. One special callout is the Lightning Filter effect, which now has a Thunder aware mode to sync lightning flashes up with Thunder sounds.</p>

**<p>Any support via the <a href="https://www.patreon.com/GambitsLounge" target="_blank" rel="nofollow noopener">Patreon</a> or <a href="https://ko-fi.com/gambit07" target="_blank" rel="nofollow noopener">Ko-fi</a> is greatly appreciated! If you are a Patreon subscriber you will receive access to the FXMaster+ module. FXMaster+ can be accessed from Patreon, and it's where I will be adding new particle effects and filters moving forward. For the month of September, it will get you access to the 🟢 Ghosts, 🟡 Sunlight, 🟢 Magic Crystals, 🟡 Fireflies, 🌸 Sakura Bloom, 🌸 Sakura Blossoms — Particle Effects previewed below:</p>**

<video
  autoplay
  muted
  playsinline
  loop
  preload="auto"
  src="https://github.com/user-attachments/assets/d9e1c89b-0ce7-4c5c-a5f2-55c242e82397">
</video>

<details>
  <summary>Sunlight (click to expand)</summary>
  <video
    autoplay
    muted
    playsinline
    loop
    preload="auto"
    src="https://github.com/user-attachments/assets/4bb9492d-dc3b-4d2e-82ee-6950cd2792eb">
  </video>
</details>
  
<details>
  <summary>Magic Crystals (click to expand)</summary>

  <video
    autoplay
    muted
    playsinline
    loop
    preload="auto"
    src="https://github.com/user-attachments/assets/7e35693a-094b-43d0-9249-584216b1df16">
  </video>
</details>

<details>
  <summary>Fireflies (click to expand)</summary>

  <video
    autoplay
    muted
    playsinline
    loop
    preload="auto"
    src="https://github.com/user-attachments/assets/860557a5-602e-4e80-a241-af06db3b2c1f">
  </video>
</details>

<details>
  <summary>Sakura Bloom (click to expand)</summary>

  <video
    autoplay
    muted
    playsinline
    loop
    preload="auto"
    src="https://github.com/user-attachments/assets/dfc880e7-f148-4db1-b509-2ef2332ede7a">
  </video>
</details>

<hr/>

FXMaster is a module for [Foundry Virtual Tabletop] that provides various types of effects:

- _Particle Effects_, including weather (rain, clouds, fog, snow, etc.), animals (crows, bats, spiders, etc.), and a few
  others.
- _Filter Effects_, including color overlays, underwater, lightning, and more.
- _Animation Effects_, using video files provided by external sources.

This module also provides ways to easily configure these effects.

## Table of Contents

- [FXMaster](#fxmaster)
  - [Table of Contents](#table-of-contents)
  - [Installation Instructions](#installation-instructions)
  - [FAQ](#faq)
  - [Usage](#usage)
    - [Animation Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/hat-wizard-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/hat-wizard-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/hat-wizard-dark.svg" alt="Animation Effects Icon" height="20" width="20" style="vertical-align:middle;"></picture>](#animation-effects)
      - [Placing Animation Effects](#placing-animation-effects)
      - [Managing Animation Effects](#managing-animation-effects)
    - [Particle Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/cloud-rain-light.svg" media="(prefers-color-scheme: dark)"><source srcset="./media/font-awesome/cloud-rain-dark.svg" media="(prefers-color-scheme: light)"><img src="./media/font-awesome/cloud-rain-dark.svg" alt="Particle Effects Icon" height="20" width="20" style="display:inline-block; vertical-align:bottom;"></picture>](#particle-effects)
      - [Particle Effects via Region Behavior](#particle-effects-via-region-behavior)
      - [Masking Particle Effects](#masking-particle-effects)
      - [⚠ Warning Regarding Large Scenes](#-warning-regarding-large-scenes)
    - [Filter Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/filter-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/filter-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/filter-dark.svg" alt="Filter Effects Icon" height="20" width="20" style="vertical-align:middle;"></picture>](#filter-effects)
      - [Filter Effects via Region Behavior](#filter-effects-via-region-behavior)
      - [Masking Filter Effects](#masking-filter-effects)
    - [Save Particle and Filter Effects as a Macro&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/floppy-disk-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/floppy-disk-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/floppy-disk-dark.svg" alt="Save Particle and Filter Effects as a Macro Icon" height="20" width="20" style="vertical-align:middle;"></picture>](#save-particle-and-filter-effects-as-macro)
    - [Clear Particle and Filter Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/trash-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/trash-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/trash-dark.svg" alt="Clear Particle and Filter Effects Icon" height="20" width="20" style="vertical-align:middle;"></picture>](#clear-particle-and-filter-effects)
  - [Developer API](#developer-api)
    - [Filter Effects](#filter-effects)
      - [Available Filter Effects With Supported Options](#available-filter-effects-with-supported-options)
    - [Particle Effects](#particle-effects)
      - [Available Particle Effects With Supported Options](#available-particle-effects-with-supported-options)
      - [Particle Effect Options](#particle-effect-options)
  - [Contributing](#contributing)
  - [Acknowledgement](#acknowledgement)
  - [Licensing](#licensing)

## Installation Instructions

To install FXMaster, find FXMaster in the module browser, or paste the following URL into the Install Module dialog in
the Setup menu of Foundry Virtual Tabletop:

```
https://github.com/gambit07/fxmaster/releases/latest/download/module.json
```

## FAQ

- Q: I have put a animation effect onto a scene, and now I can't get rid of it. How do I remove it?

  A: Most likely, you created a permanently playing animation effect by dragging an animation effect onto the canvas, which
  is just a regular [Tile](https://foundryvtt.com/article/tiles/) and not managed by FXMaster. To remove it, go to the
  Tile Controls and remove the Tile there.

- Q: What is the difference between Particle Effects, Filter Effects, and Animation Effects?

  A: Particle Effects are global effects that display particles on the whole scene. Mostly they are weather effects, but
  they also include animals and some other effects.<br>
  Filter Effects are filters that adjust the whole scene in some way, e.g. by adjusting the color or distorting the
  scene to look like it's underwater.<br>
  Animation Effects are animations (video files) that can be played on your chosen location on the canvas.

- Q: Can I provide my own effects?

  A: You can provide your own Animation Effects via the Custom folder in the module's settings.
  It's not possible to provide your own Particle Effects or Filter Effects.

## Usage

The functionality of FXMaster can be accessed via _Effect Controls_ <picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/wand-magic-sparkles-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/wand-magic-sparkles-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/wand-magic-sparkles-dark.svg" alt="Effect Controls Icon" height="20" width="20" style="vertical-align:middle;"></picture> in scene controls. Each FXMaster app has its own tool inside scene controls.

### Animation Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/hat-wizard-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/hat-wizard-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/hat-wizard-dark.svg" alt="Animation Effects Icon" height="20" width="20" style="vertical-align:bottom;"></picture>

_Animation Effects_ are video files that can be previewed and/or placed on the canvas via clicking and dragging. FXMaster aggregates animations from popular animation module providers including: [JB2A], [Jinker's Animated Art], [Jack Kerouac's Animated Spell Effects], [Jack Kerouac's Animated Spell Effects Cartoon], [Boss Loot Animated Assets], and [Wild Magic Surge]. Along side the built in module support, you can also add your own Custom folder of animations from the modules settings.

On first world load after updating or installing FXMaster, the animation effects database will be built. You will see an active UI notification window while this process runs. It can take anywhere from 5 to 10 minutes depending on how many animations exist in your world. Once the process completes, you are ready to use the Animation Effects window. If you ever add or remove animations, either from a Custom folder or an Animation module, you can re-build the animations database at any time via the Settings menu option "Refresh Animations Database."

Clicking on this tool opens the _Animation Effects Management_ app:

![Animation Effects Management](./media/screenshots/animation-effects-management.webp)

In this app, you can filter based on specific animation providers and search for specific animations. Searching supports advanced queries using AND, OR, and NOT, e.g.: (eldritch OR arrow) AND NOT blast

You can preview each effect by hovering over the black box with your mouse.

#### Placing Animation Effects

In order to place an _Animation Effect_, simply drag it from the window to the canvas which will create a [Tile](https://foundryvtt.com/article/tiles/) on the canvas that includes your animation.

#### Managing Animation Effects

_Animation Effects_ details can be viewed by right clicking an animation icon in the window. Details included are the Author, File Name, File Path, and Sequencer Path. Additionally, you can adjust the Scale and Anchor of a placed tile within this menu. Finally, you can Favorite an animation within this window, which will create a Favorites tag in the main window dropdown. If you make a change, hit the "Save Changes" button to save the _Animation Effect_ and close the app.

![Animation Effect Update](./media/screenshots/update-animation-effect.webp)

### Particle Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/cloud-rain-light.svg" media="(prefers-color-scheme: dark)"><source srcset="./media/font-awesome/cloud-rain-dark.svg" media="(prefers-color-scheme: light)"><img src="./media/font-awesome/cloud-rain-dark.svg" alt="Particle Effects Icon" height="20" width="20" style="display:inline-block; vertical-align:bottom;"></picture>

_Particle Effects_ include weather effects like rain, fog, clouds, and snow, but also other global particle effects such as birds flying across the scene or spiders crawling around. 

There are two ways to implement _Particle Effects_: via the _Effect Controls_ menu for global _Particle Effects_, or via a [Region](https://foundryvtt.com/article/scene-regions/) using the _FXMaster: Particle Effects_ Region behavior.

#### Particle Effects via Effect Controls App

Clicking on the _Effect Controls_ tool opens the _Particle Effects Management_ app:

![Particle Effects Management](./media/screenshots/particle-effects-management.webp)

In this app, you can configure individual _Particle Effects_. They are sorted into different groups ("Weather", "Ambient", and "Animals").

You can activate individual _Particle Effects_ by clicking the corresponding toggle button.

By clicking on the name of a _Particle Effect_, you expand it, showing the options for that effect:

![Particle Effect Options](./media/screenshots/particle-effect-options.webp)

#### Particle Effects via Region Behavior

After adding a Region, open the Region config menu and navigate to the Behaviors tab. Add a new behavior and select the option 'FXMaster: Particle Effects': 

![Particle Effects Management](./media/screenshots/particle-effects-region-management.webp)

In this menu, you can configure individual _Particle Effects_ in the same way as in the main app, and add region elevation visibility handling. Selecting the checkbox next to a _Particle Effect_ will display a dropdown of its options. Saving the Region behavior will add the selected _Particle Effects_ to the region. For region elevation, use the Elevation Constraints dropdown.

None - No elevation restrictions are considered.
Tokens POV - Visibility will be restricted to a given tokens POV. For example, if the region elevation bottom is set to 10 feet, and region elevation top is set to 20 feet, the particle effect will be visible to the token while their elevation is between 10 and 20 feet. If the region elevation bottom is set to 10 feet, and region elevation top is infinite, the particle effect will be visible to the token while their elevation is 10 feet or above. If the region elevation bottom is infinite, and region elevation top is 20, the particle effect will be visible to the token while their elevation is 20 feet or below.
Specific Tokens POV - Same visibility as Tokens POV, but only allows that visibility based on Token UUID's entered. Any Token UUID not entered will not be able to see the particle effect. 

Always Visible for GM - Ignores Tokens POV for GM and makes the effect always visible.

In addition, you can subscribe the Particle Region behavior to the Token Enters and Token Exits events. These events can work in concert with the Elevation Constraints options, or on their own.

Token Enters: Effect becomes visible when a token enters the bounds of the region. This event can be paired with Token Exits to turn an effect on and off when a token moves in/out. Alternatively, you can only add the Token Enters event, in which case the effect will become visible once a token enters, and remain visible even if they exit.
Token Exits: Effect becomes not visible when a token exits the bounds of the region.

#### Masking Particle Effects

By default, _Particle Effects_ added via the app are displayed across the entire scene. However, it is possible to mask them from specific areas. This can be achieved within Regions by using the Region behavior "Suppress Weather" or "FXMaster: Suppress Scene Particles". "Suppress Weather" masks all Particle and Filter effects along with core Foundry effects, "FXMaster: Suppress Scene Particles" only masks FXMaster Particle Effects.

_Particle Effects_ are only displayed outside the region areas when masked. If a Hole shape is added to the region, scene particle effects will display in the hole area cutout.

#### ⚠ Warning Regarding Large Scenes

The _Particle Effects_ provided by FXMaster can have a pretty significant impact on performance, primarily due to the amount of customization FXMaster offers. 
Increasing density and particle size particularly in large scenes (around 10,000 px × 10,000 px and larger) can be very costly.
Be careful when enabling _Particle Effects_ in such scenes as it might make them crash. If that happens, launch the world in safe configuration
and delete the configured _Particle Effects_ for the scene by running the following as a script macro or in the
developer console (F12):

```js
canvas.scene.unsetFlag("fxmaster", "effects");
```

You can then safely reactivate your modules. When creating Particle Effects on large scenes like the above, try to limit density and size as much as possible for a more performant experience.

### Filter Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/filter-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/filter-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/filter-dark.svg" alt="Filter Effects Icon" height="20" width="20" style="vertical-align:middle;"></picture>

_Filter Effects_ include effects that change the underlying scene visuals in some way like altering the color, displaying an old film effect, or adding underwater displacement.
There are two ways to implement _Filter Effects_: via the _Effect Controls_ menu for global _Filter Effects_, or via a [Region](https://foundryvtt.com/article/scene-regions/) using the _FXMaster: Filter Effects_ Region behavior.

#### Filter Effects via Effect Controls App

Clicking on this tool opens the _Filter Effects Management_ app:

![Filter Effects Management](./media/screenshots/filter-effects-management.webp)

You can activate individual _Filter Effects_ by clicking the corresponding toggle button.

By clicking on the name of a _Filter Effect_, you expand it, showing the options for that effect:

![Filter Effect Options](./media/screenshots/filter-effect-options.webp)

The available options differ heavily between individual _Filter Effects_, so it doesn't make much sense to list them
here.

The options will be adjusted in real-time as you make changes to them.

#### Filter Effects via Region Behavior

After adding a Region, open the Region config menu and navigate to the Behaviors tab. Add a new behavior and select the option 'FXMaster: Filter Effects': 

![Particle Effects Management](./media/screenshots/filter-effects-region-management.webp)

In this menu, you can configure individual _Filter Effects_ in the same way as in the main app, and add region elevation visibility handling. Selecting the checkbox next to a _Filter Effect_ will display a dropdown of its options. Saving the Region behavior will add the selected _Filter Effects_ to the region. For region elevation, use the Elevation Constraints dropdown.

None - No elevation restrictions are considered.
Tokens POV - Visibility will be restricted to a given tokens POV. For example, if the region elevation bottom is set to 10 feet, and region elevation top is set to 20 feet, the filter effect will be visible to the token while their elevation is between 10 and 20 feet. If the region elevation bottom is set to 10 feet, and region elevation top is infinite, the filter effect will be visible to the token while their elevation is 10 feet or above. If the region elevation bottom is infinite, and region elevation top is 20, the filter effect will be visible to the token while their elevation is 20 feet or below.
Specific Tokens POV - Same visibility as Tokens POV, but only allows that visibility based on Token UUID's entered. Any Token UUID not entered will not be able to see the filter effect. 

Always Visible for GM - Ignores Tokens POV for GM and makes the effect always visible.

In addition, you can subscribe the Filter Region behavior to the Token Enters and Token Exits events. These events can work in concert with the Elevation Constraints options, or on their own.

Token Enters: Effect becomes visible when a token enters the bounds of the region. This event can be paired with Token Exits to turn an effect on and off when a token moves in/out. Alternatively, you can only add the Token Enters event, in which case the effect will become visible once a token enters, and remain visible even if they exit.
Token Exits: Effect becomes not visible when a token exits the bounds of the region.

#### Masking Filter Effects

By default, _Filter Effects_ added via the scene app are displayed across the entire scene. However, it is possible to mask them from specific areas. This can be achieved within Regions by using the Region behavior "Suppress Weather" or "FXMaster: Suppress Scene Filters". "Suppress Weather" masks all Particle and Filter effects along with core Foundry effects, "FXMaster: Suppress Scene Filters" only masks FXMaster Filter Effects.

_Filter Effects_ are only displayed outside the region areas when masked. If a Hole shape is added to the region, scene filter effects will display in the hole area cutout.

### Save Particle and Filter Effects as a Macro&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/floppy-disk-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/floppy-disk-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/floppy-disk-dark.svg" alt="Save Particle and Filter Effects as a Macro Icon" height="20" width="20" style="vertical-align:middle;"></picture>

This tool allows you to create a macro from the currently active _Particle Effects_ and _Filter Effects_. When clicking
this tool, a macro is created in the macro directory. It's not put onto the hotbar, so you need to drag it there
yourself if you want to.

When executed, the macro sets the _Particle Effects_ and _Filter Effects_ of the current scene to the state they were in
when the macro was created.

### Clear Particle and Filter Effects&nbsp;&nbsp;<picture style="display:inline-block; vertical-align:bottom;"><source srcset="./media/font-awesome/trash-light.svg" media="(prefers-color-scheme: dark)"> <source srcset="./media/font-awesome/trash-dark.svg" media="(prefers-color-scheme: light)"> <img src="./media/font-awesome/trash-dark.svg" alt="Clear Particle and Filter Effects Icon" height="20" width="20" style="vertical-align:middle;"></picture>

When clicked, this tool shows a confirmation dialog to delete all _Particle Effects_ and _Filter Effects_ from the
current scene.

## Developer API

FXMaster provides functionality to interact with _Filter Effects_ and _Particle Effects_ from other packages and macros.

### Filter Effects

- Adding or updating a named filter
  ```javascript
  FXMASTER.filters.addFilter("myfilterID", "color", {
    color: { value: "#ff00ff", apply: true },
    gamma: 1.0,
    contrast: 1.0,
    brightness: 1.0,
    saturation: 0.2,
  });
  ```
- Removing a named filter
  ```javascript
  FXMASTER.filters.removeFilter("myfilterID");
  ```
- Toggling a named filter on and off
  ```javascript
  FXMASTER.filters.switch("myfilterID", "color", {
    color: { value: "#ff00ff", apply: true },
    gamma: 1.0,
    contrast: 1.0,
    brightness: 1.0,
    saturation: 0.2,
  });
  ```
- Setting the list of active filters
  ```javascript
  FXMASTER.filters.setFilters([
    {
      type: "color",
      options: {
        /* ... */
      },
    },
    {
      type: "lightning",
      options: {
        /* ... */
      },
    },
  ]);
  ```

#### Available Filter Effects With Supported Options

| Type         | Options                                                  |
| ------------ | -------------------------------------------------------- |
| `lightning`  | `belowTokens`, `frequency`, `spark_duration`, `brightness`, `audioAware`, `audioBassThreshold`, `audioChannels`              |
| `underwater` | `belowTokens`, `speed`, `scale`                                         |
| `predator`   | `belowTokens`, `noise`, `period`, `lineWidth`                           |
| `color`      | `belowTokens`, `color`, `saturation`, `contrast`, `brightness`, `gamma` |
| `bloom`      | `belowTokens`, `blur`, `bloomScale`, `threshold`                        |
| `oldfilm`    | `belowTokens`, `sepia`, `noise`, `noiseSize`, `scratch`, `scratchDensity`                                         |

You can get a complete list by typing `CONFIG.fxmaster.filters` in your web console.

### Particle Effects

- Switching a named particle effect on and off:
  ```javascript
  Hooks.call("fxmaster.switchParticleEffect", {
    name: "myParticleEffectID",
    type: "rain",
    options: { density: 0.5 },
  });
  ```
- Setting the active paticle effects:
  ```javascript
  Hooks.call("fxmaster.updateParticleEffects", [
    {
      type: "rain",
      options: {
        /* ... */
      },
    },
    {
      type: "bubbles",
      options: {
        /* ... */
      },
    },
  ]);
  ```

#### Available Particle Effects With Supported Options

| Type           | `FXMaster+` | `scale` | `direction` | `speed` | `lifetime` | `density` | `alpha` | `tint` |         `animations`         |
| -------------- | :-----: | :-----: | :---------: | :-----: | :--------: | :-------: | :-----: | :----: | :--------------------------: |
| `snowstorm`    |        |    ✓    |      ✓      |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `bubbles`      |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `clouds`       |        |    ✓    |      ✓      |    ✓    |     ✓      |           |    ✓    |   ✓    |                              |
| `embers`       |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `rainsimple`   |        |    ✓    |      ✓      |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `stars`        |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `crows`        |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `bats`         |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `spiders`      |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `fog`          |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `raintop`      |        |    ✓    |      ✓      |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `birds`        |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    | ✓ (`glide`, `flap`, `mixed`) |
| `leaves`       |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `rain`         |        |    ✓    |      ✓      |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `snow`         |        |    ✓    |      ✓      |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `eagles`       |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |     ✓ (`glide`, `flap`)      |
| `rats`         |        |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `sakurabloom`  |    ✓    |    ✓    |      ✓      |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `sakurablossom`|    ✓    |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |
| `fireflies`    |    ✓    |    ✓    |             |    ✓    |     ✓      |     ✓     |    ✓    |   ✓    |                              |

#### Some Particle Effect Options

| Option       | Type                              | Description                                                                                                                         |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scale`      | `number`                          | A factor that scales the effect relative to its base size.                                                                          |
| `direction`  | `number`                          | The direction of the effect in degrees.                                                                                             |
| `speed`      | `number`                          | A factor that adjusts the speed of the effect relative to its base speed.                                                           |
| `lieftime`   | `number`                          | A factor that adjusts the lifetime of the individual particles.                                                                     |
| `density`    | `number`                          | The density of the effect. For most effects, it represents the number of particles per grid unit.                                   |
| `alpha`      | `number`                          | A factor between 0 and 1 that adjusts the opacity of the particles (this is called "Opacity" in Particle Effects Management).       |
| `tint`       | `{value: string, apply: boolean}` | Tint the effect with this color.                                                                                                    |
| `animations` | `string[]`                        | An array of animations from list of animations for the effect to use. If it is empty or not defined, the default animation is used. |

## Contributing

Code and content contributions are accepted. Please feel free to submit issues to the issue tracker or submit pull
requests for code changes.

## Acknowledgement

Many thanks to:

- [U~man] for the original work on this module.
- [ghost] for maintaining functionality on this module for the past few years.
- [theripper93] for contributing his ideas regarding handling particle effect masking elegantly.
- [Wasp] for providing the [Sequencer] module.
- [SecretFire] for exchanging ideas, providing help, and shaders for the filter effects. Donate
  [here](https://ko-fi.com/secretfire).

## Licensing

- The software component of FXMaster is licensed under [BSD 3-Clause].
- The Seagull sprites used in the Birds particle effect are from [whtdragon].
- The control and tool icons are from [Font Awesome], licensed under the [CC BY-4.0].
- The icons for particle effects are by Rexard and licensed under [Rexard Game Dev Assets EULA].
- The rat sprites used in the Rats particle effect by crymoonster are licensed under [CC BY-4.0].

[Foundry Virtual Tabletop]: https://foundryvtt.com/
[JB2A]: https://github.com/Jules-Bens-Aa/JB2A_DnD5e
[Jinker's Animated Art]: https://github.com/jinkergm/JAA
[Jack Kerouac's Animated Spell Effects]: https://github.com/jackkerouac/animated-spell-effects
[Jack Kerouac's Animated Spell Effects Cartoon]: https://github.com/jackkerouac/animated-spell-effects-cartoon
[Boss Loot Animated Assets]: https://github.com/boss-loot/boss-loot-assets-free
[Wild Magic Surge]: https://foundryvtt.com/packages/wild_magic_surge_animated_dungeon_lighting_one
[Sequencer]: https://github.com/fantasycalendar/FoundryVTT-Sequencer
[U~man]: https://github.com/mesfoliesludiques
[ghost]: https://github.com/ghost-fvtt
[theripper93]: https://github.com/theripper93
[Wasp]: https://github.com/fantasycalendar
[SecretFire]: https://github.com/Feu-Secret
[whtdragon]: https://forums.rpgmakerweb.com/index.php?threads/whtdragons-animals-and-running-horses-now-with-more-dragons.53552/
[Font Awesome]: https://fontawesome.com/
[BSD 3-Clause]: ./LICENSES/BSD-3-Clause.txt
[CC BY-NC-SA-4.0]: ./LICENSES/CC-BY-NC-SA-4.0.txt
[CC BY-4.0]: ./LICENSES/CC-BY-4.0.txt
[Rexard Game Dev Assets EULA]: ./LICENSES/LicenseRef-RexardGameDevAssetsEULA.txt
