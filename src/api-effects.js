export const API_EFFECTS = {
  "acid-rain": {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#00ff55",
              },
              topDown: false,
              splash: false,
              scale: 2,
              direction: 90,
              speed: 1.8,
              lifetime: 2.5,
              density: 1.5,
              alpha: 1,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#009e03",
              },
              scale: 1,
              speed: 3,
              lifetime: 1,
              density: 0.1,
              alpha: 0.1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#00ff55",
              },
              topDown: true,
              splash: false,
              scale: 2.5,
              direction: 90,
              speed: 1.8,
              lifetime: 2.5,
              density: 5,
              alpha: 1,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#009e03",
              },
              scale: 1,
              speed: 3,
              lifetime: 1,
              density: 0.1,
              alpha: 0.1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "aether-haze": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "magiccrystals",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#d1befe",
              },
              rainbow: false,
              orbit: false,
              orbitDistance: 0.5,
              scale: 0.4,
              speed: 1,
              lifetime: 2,
              density: 0.1,
              alpha: 0.3,
              spin: 0.1,
              glow: 0.75,
              bloom: 0.5,
            },
          },
        ],
        filters: [
          {
            type: "fog",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#5b14ff",
              },
              dimensions: 0.6,
              speed: 0.5,
              density: 0.2,
            },
          },
          {
            type: "underwater",
            options: {
              belowTokens: false,
              speed: 15,
              scale: 32,
            },
          },
        ],
      },
    },
  },
  "arcane-winds": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "sandstorm",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#00d5ff",
              },
              scale: 0.65,
              direction: 0,
              speed: 0.8,
              lifetime: 4,
              density: 0.6,
              alpha: 1,
              wobble: 1,
              wobbleFrequency: 2,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#432afe",
              },
              dimensions: 1.2,
              speed: 0.1,
              density: 0.25,
              direction: 0,
              streakiness: 1,
              opacity: 1,
            },
          },
          {
            type: "bloom",
            options: {
              belowTokens: false,
              blur: 10,
              bloomScale: 0.5,
              threshold: 0.5,
            },
          },
        ],
      },
    },
  },
  ashfall: {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "embers",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              topDown: false,
              scale: 2.5,
              speed: 1,
              lifetime: 4.1,
              density: 1.2,
              alpha: 0.4,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#000000",
              },
              dimensions: 1.2,
              speed: 0.1,
              density: 0.5,
              direction: 0,
              streakiness: 0.15,
              opacity: 1,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "embers",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              topDown: true,
              scale: 5,
              speed: 5,
              lifetime: 4.1,
              density: 1.4,
              alpha: 1,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#000000",
              },
              dimensions: 1.2,
              speed: 0.1,
              density: 0.5,
              direction: 270,
              streakiness: 0.15,
              opacity: 1,
            },
          },
        ],
      },
    },
  },
  "autumn-leaves": {
    free: {
      normal: {
        particles: [
          {
            type: "autumnleaves",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: false,
              scale: 1,
              speed: 1.5,
              lifetime: 2.8,
              density: 0.2,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "autumnleaves",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: true,
              scale: 1,
              speed: 4,
              lifetime: 3,
              density: 0.6,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "twilight-sun": {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "sunlight",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              parallel: false,
              color: {
                apply: true,
                value: "#000000",
              },
              angle: -127,
              gain: 1,
              lacunarity: 1,
              beam_length: 8000,
              alpha: 1,
              speed: 2,
            },
          },
        ],
      },
    },
  },
  "black-sun": {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "sunlight",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              parallel: false,
              color: {
                apply: true,
                value: "#ff0000",
              },
              angle: -90,
              gain: 1,
              lacunarity: 1,
              beam_length: 8000,
              alpha: 1,
              speed: 2,
            },
          },
          {
            type: "color",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#6A5A8E",
              },
              saturation: 1,
              contrast: 1.1,
              brightness: 1,
              gamma: 0.8,
            },
          },
        ],
      },
    },
  },
  blizzard: {
    free: {
      normal: {
        particles: [
          {
            type: "snowstorm",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: false,
              rotationStrength: 4,
              scale: 1,
              direction: 0,
              speed: 7.5,
              lifetime: 0.8,
              density: 1,
              alpha: 0.5,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "snowstorm",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: true,
              rotationStrength: 4,
              scale: 1.5,
              direction: 0,
              speed: 5,
              lifetime: 0.5,
              density: 1,
              alpha: 0.7,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {
      normal: {
        particles: [
          {
            type: "snowstorm",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: false,
              rotationStrength: 4,
              scale: 1,
              direction: 0,
              speed: 7.5,
              lifetime: 0.8,
              density: 1,
              alpha: 0.5,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#ffffff",
              },
              dimensions: 1.2,
              speed: 0.6,
              density: 0.25,
              direction: 0,
              streakiness: 1,
              opacity: 0.5,
              topDown: false,
              soundFxEnabled: true,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "snowstorm",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: true,
              rotationStrength: 4,
              scale: 1.5,
              direction: 0,
              speed: 5,
              lifetime: 0.5,
              density: 1,
              alpha: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#ffffff",
              },
              dimensions: 1.2,
              speed: 0.6,
              density: 0.25,
              direction: 0,
              streakiness: 1,
              opacity: 0.5,
            },
          },
        ],
      },
    },
  },
  "blood-rain": {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#ff0000",
              },
              topDown: false,
              splash: true,
              scale: 3,
              direction: 90,
              speed: 1.8,
              lifetime: 2.5,
              density: 2.5,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#ff0000",
              },
              topDown: true,
              splash: false,
              scale: 4,
              direction: 90,
              speed: 1.8,
              lifetime: 2.5,
              density: 5,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  cloudy: {
    free: {
      normal: {
        particles: [
          {
            type: "clouds",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#000000",
              },
              scale: 2.5,
              direction: 0,
              speed: 1.5,
              lifetime: 1,
              density: 0.02,
              alpha: 0.8,
              dropShadow: true,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 300,
              shadowBlur: 5.5,
              shadowOpacity: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "divine-light": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "embers",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#ffea00",
              },
              topDown: false,
              scale: 3.4,
              speed: 1,
              lifetime: 4.1,
              density: 0.2,
              alpha: 0.5,
            },
          },
          {
            type: "stars",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#ffea00",
              },
              scale: 1.4,
              speed: 1,
              lifetime: 1,
              density: 1,
              alpha: 0.6,
            },
          },
        ],
        filters: [
          {
            type: "sunlight",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              parallel: true,
              color: {
                apply: true,
                value: "#ffea00",
              },
              angle: 0,
              gain: 0.2,
              lacunarity: 3,
              beam_length: 0,
              alpha: 1,
              speed: 1.1,
            },
          },
        ],
      },
    },
  },
  drizzle: {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#fbff00",
              },
              topDown: false,
              splash: false,
              scale: 1.5,
              direction: 75,
              speed: 0.4,
              lifetime: 3,
              density: 0.2,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#fbff00",
              },
              topDown: true,
              splash: true,
              scale: 1.5,
              direction: 75,
              speed: 0.4,
              lifetime: 3,
              density: 1,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "dust-devil": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "sandstorm",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#feee8b",
              },
              scale: 1,
              direction: 270,
              speed: 7.2,
              lifetime: 2.6,
              density: 2,
              alpha: 1,
              wobble: 1,
              wobbleFrequency: 2,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: true,
              soundFxEnabled: true,
              color: {
                apply: true,
                value: "#b38b5a",
              },
              dimensions: 5,
              speed: 0.6,
              density: 0.55,
              direction: 265,
              streakiness: 0.15,
              opacity: 0.6,
            },
          },
        ],
      },
    },
  },
  fog: {
    free: {
      normal: {
        particles: [],
        filters: [
          {
            type: "fog",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#424242",
              },
              dimensions: 0.4,
              speed: 0.4,
              density: 0.35,
            },
          },
        ],
      },
    },
    plus: {},
  },
  gravewind: {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "ghosts",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#00382d",
              },
              scale: 1,
              speed: 3,
              lifetime: 4,
              density: 0.002,
              alpha: 0.5,
              glow: 0.6,
              wobble: 0.7,
              displacement: 0.6,
              blur: 0.35,
              variants: ["creepy"],
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#00382d",
              },
              dimensions: 5,
              speed: 0.3,
              density: 0.45,
              direction: 0,
              streakiness: 1,
              opacity: 0.65,
            },
          },
        ],
      },
    },
  },
  hail: {
    free: {
      normal: {
        particles: [
          {
            type: "hail",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#FFFFFF",
              },
              topDown: false,
              scale: 0.5,
              direction: 55,
              speed: 2.1,
              lifetime: 1,
              density: 0.6,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "hail",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#FFFFFF",
              },
              topDown: true,
              scale: 0.6,
              direction: 55,
              speed: 1.6,
              lifetime: 1.6,
              density: 1,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "heat-wave": {
    free: {
      normal: {
        particles: [],
        filters: [
          {
            type: "fog",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#feb434",
              },
              dimensions: 0,
              speed: 0.4,
              density: 0.15,
            },
          },
          {
            type: "bloom",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              blur: 5,
              bloomScale: 0.5,
              threshold: 0,
            },
          },
        ],
      },
    },
    plus: {},
  },
  hurricane: {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#545454",
              },
              topDown: false,
              splash: false,
              scale: 4,
              direction: 75,
              speed: 2.5,
              lifetime: 2.5,
              density: 3.5,
              alpha: 1,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 1.5,
              speed: 5,
              lifetime: 1,
              density: 0.12,
              alpha: 0.4,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 1.5,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#545454",
              },
              topDown: true,
              splash: false,
              scale: 4.5,
              direction: 75,
              speed: 2.5,
              lifetime: 2.5,
              density: 3.5,
              alpha: 1,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 1.5,
              speed: 5,
              lifetime: 1,
              density: 0.12,
              alpha: 0.4,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 1.5,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
            },
          },
        ],
      },
    },
    plus: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#545454",
              },
              topDown: false,
              splash: true,
              scale: 3,
              direction: 75,
              speed: 2.5,
              lifetime: 2.5,
              density: 5,
              alpha: 1,
              soundFxEnabled: false,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 1.5,
              speed: 5,
              lifetime: 1,
              density: 0.12,
              alpha: 0.3,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 2.5,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
              topDown: false,
              soundFxEnabled: false,
            },
          },
          {
            type: "lightningbolts",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: false,
                value: "#00aeff",
              },
              mode: ["horizontal"],
              directionalMovement: true,
              direction: 75,
              syncFlash: true,
              topDownBoltsVariable: true,
              thickness: 1.8,
              topDownScale: 6,
              topDownBolts: 10,
              branches: 15,
              length: 1.5,
              speed: 0.95,
              jitter: 0.2,
              brightness: 4,
              opacity: 0.2,
              glow: 1,
              frequency: 5000,
              spark_duration: 705,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.85,
            },
          },
          {
            type: "duststorm",
            options: {
              belowTokens: true,
              soundFxEnabled: true,
              color: {
                apply: true,
                value: "#000000",
              },
              dimensions: 0,
              speed: 0.6,
              density: 0.55,
              direction: 75,
              streakiness: 0.15,
              opacity: 1,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#545454",
              },
              topDown: true,
              splash: false,
              scale: 3.5,
              direction: 75,
              speed: 3,
              lifetime: 2,
              density: 5,
              alpha: 1,
              soundFxEnabled: false,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 1.5,
              speed: 5,
              lifetime: 1,
              density: 0.12,
              alpha: 0.3,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 1.5,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
              topDown: false,
              soundFxEnabled: false,
            },
          },
          {
            type: "duststorm",
            options: {
              belowTokens: true,
              soundFxEnabled: true,
              color: {
                apply: true,
                value: "#000000",
              },
              dimensions: 0,
              speed: 0.6,
              density: 0.55,
              direction: 75,
              streakiness: 0.15,
              opacity: 1,
            },
          },
          {
            type: "lightningbolts",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: false,
                value: "#00aeff",
              },
              mode: ["topDown"],
              directionalMovement: false,
              direction: 0,
              syncFlash: true,
              topDownBoltsVariable: true,
              thickness: 1,
              topDownScale: 10,
              topDownBolts: 5,
              branches: 15,
              length: 2.5,
              speed: 0.99,
              jitter: 0.3,
              brightness: 4,
              opacity: 1,
              glow: 1,
              frequency: 5000,
              spark_duration: 705,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.85,
            },
          },
        ],
      },
    },
  },
  "ice-storm": {
    free: {
      normal: {
        particles: [
          {
            type: "hail",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#ffffff",
              },
              topDown: false,
              scale: 0.3,
              direction: 55,
              speed: 2.5,
              lifetime: 3,
              density: 1.05,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "hail",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#ffffff",
              },
              topDown: true,
              scale: 0.3,
              direction: 55,
              speed: 1.5,
              lifetime: 1.5,
              density: 1.05,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "ley-surge": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "magiccrystals",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              rainbow: true,
              orbit: false,
              orbitDistance: 1,
              scale: 0.1,
              speed: 4.3,
              lifetime: 5,
              density: 5,
              alpha: 1,
              spin: 1,
              glow: 1,
              bloom: 0,
            },
          },
        ],
        filters: [
          {
            type: "glitch",
            options: {
              belowTokens: false,
              sliceEnable: true,
              crosshatch: true,
              slices: 3,
              scrollSpeed: 0,
              refreshRate: 0,
              offset: 5,
              direction: 135,
              sliceJaggedness: 0.52,
              sliceShardAngle: 1,
              redX: -42,
              redY: -42,
              greenX: -34,
              greenY: -34,
              blueX: -34,
              blueY: -34,
              glyphEnable: false,
              glyphColor: {
                apply: true,
                value: "#0fff77",
              },
              glyphIntensity: 2,
              glyphCell: 76,
              glyphSpeed: 1,
              glyphDirection: 0,
              glyphDensity: 0.28,
              glyphSlicePct: 1,
              glyphFlickerSpeed: 0,
              soundFxEnabled: false,
            },
          },
        ],
      },
    },
  },
  "luminous-sky": {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#1fc7ff",
              },
              dimensions: 5,
              speed: 0.2,
              density: 0.45,
              direction: 270,
              streakiness: 1,
              opacity: 0.25,
            },
          },
          {
            type: "fog",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#6842ff",
              },
              dimensions: 0.6,
              speed: 1.4,
              density: 0.15,
            },
          },
        ],
      },
    },
  },
  "meteor-shower": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "sandstorm",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#4f4f4f",
              },
              scale: 1,
              direction: 0,
              speed: 7,
              lifetime: 2.6,
              density: 0.6,
              alpha: 1,
              wobble: 1,
              wobbleFrequency: 0.35,
            },
          },
        ],
        filters: [],
      },
    },
  },
  mist: {
    free: {
      normal: {
        particles: [],
        filters: [
          {
            type: "fog",
            options: {
              belowTokens: false,
              color: {
                apply: true,
                value: "#ffffff",
              },
              dimensions: 0.3,
              speed: 0.3,
              density: 0.1,
            },
          },
        ],
      },
    },
    plus: {},
  },
  monsoon: {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#858585",
              },
              topDown: false,
              splash: true,
              scale: 3.5,
              direction: 55,
              speed: 0.8,
              lifetime: 2.5,
              density: 2,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#858585",
              },
              topDown: false,
              splash: true,
              scale: 3.5,
              direction: 55,
              speed: 0.8,
              lifetime: 2.5,
              density: 2,
              alpha: 1,
            },
          },
        ],
        filters: [
          {
            type: "sunlight",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              parallel: true,
              color: {
                apply: true,
                value: "#fff2a8",
              },
              angle: -38,
              gain: 0.2,
              lacunarity: 2.5,
              beam_length: 4580,
              alpha: 1,
              speed: 0.1,
            },
          },
        ],
      },
    },
  },
  nullfront: {
    free: {
      normal: {
        particles: [
          {
            type: "clouds",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#ff0000",
              },
              scale: 5,
              direction: 0,
              speed: 5,
              lifetime: 1,
              density: 0.066,
              alpha: 0.5,
              dropShadow: true,
              shadowOnly: true,
              shadowRotation: 315,
              shadowDistance: 300,
              shadowBlur: 5.5,
              shadowOpacity: 1,
            },
          },
          {
            type: "stars",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#ff00d0",
              },
              scale: 1,
              speed: 1,
              lifetime: 1,
              density: 1,
              alpha: 0.6,
            },
          },
          {
            type: "bubbles",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#ff00d0",
              },
              topDown: false,
              scale: 0.3,
              speed: 5,
              lifetime: 1.8,
              density: 0.5,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  overcast: {
    free: {
      normal: {
        particles: [
          {
            type: "clouds",
            options: {
              belowTokens: false,
              tint: {
                apply: true,
                value: "#616161",
              },
              scale: 2.5,
              direction: 0,
              speed: 0.7,
              lifetime: 1,
              density: 0.2,
              alpha: 0.2,
              dropShadow: false,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 300,
              shadowBlur: 5.5,
              shadowOpacity: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "partly-cloudy": {
    free: {
      normal: {
        particles: [
          {
            type: "clouds",
            options: {
              belowTokens: false,
              tint: {
                apply: false,
                value: "#b0b0b0",
              },
              scale: 1,
              direction: 0,
              speed: 1.5,
              lifetime: 1,
              density: 0.015,
              alpha: 0.8,
              dropShadow: true,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 150,
              shadowBlur: 0.5,
              shadowOpacity: 0.5,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "permafrost-surge": {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "ice",
            options: {
              belowTokens: true,
              soundFxEnabled: false,
              iceTint: {
                apply: true,
                value: "#4dafff",
              },
              strength: 1,
              iceScale: 2.4,
              depth: 0.3,
              frostStrength: 1,
              veinStrength: 0.3,
              waterTint: {
                apply: true,
                value: "#000000",
              },
              waterStrength: 1,
              waterSpeed: 0.4,
              sheenTint: {
                apply: true,
                value: "#d1d1d1",
              },
              sheenStrength: 0.8,
              reflectionStrength: 1,
              reflectionDistance: 85,
              reflectionBlur: 0.3,
              reflectionFresnel: 6,
            },
          },
        ],
      },
    },
  },
  "plague-miasma": {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "ice",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              iceTint: {
                apply: true,
                value: "#34fe8c",
              },
              strength: 0.6,
              iceScale: 2.4,
              depth: 0.3,
              frostStrength: 1,
              veinStrength: 0,
              waterTint: {
                apply: true,
                value: "#000000",
              },
              waterStrength: 1,
              waterSpeed: 0.8,
              sheenTint: {
                apply: true,
                value: "#d1d1d1",
              },
              sheenStrength: 0,
              reflectionStrength: 0,
              reflectionDistance: 0,
              reflectionBlur: 0,
              reflectionFresnel: 1,
            },
          },
        ],
      },
    },
  },
  rain: {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#545454",
              },
              topDown: false,
              splash: true,
              scale: 1.5,
              direction: 75,
              speed: 1.5,
              lifetime: 2.5,
              density: 1.5,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#545454",
              },
              topDown: true,
              splash: false,
              scale: 2,
              direction: 75,
              speed: 1.5,
              lifetime: 2.5,
              density: 1.8,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "rolling-fog": {
    free: {
      normal: {
        particles: [],
        filters: [
          {
            type: "fog",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: false,
                value: "#feb434",
              },
              dimensions: 0.7,
              speed: 4,
              density: 0.3,
            },
          },
        ],
      },
    },
    plus: {},
  },
  "sakura-bloom": {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "sakurabloom",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: false,
              rotationStrength: 0,
              scale: 0.2,
              direction: 90,
              speed: 0.5,
              lifetime: 1,
              density: 1,
              alpha: 1,
            },
          },
        ],
        filters: [
          {
            type: "color",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#ffc2f4",
              },
              saturation: 1,
              contrast: 1,
              brightness: 1,
              gamma: 1.4,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "sakurabloom",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ffffff",
              },
              topDown: true,
              rotationStrength: 0.5,
              scale: 0.2,
              direction: 90,
              speed: 0.5,
              lifetime: 0.4,
              density: 1,
              alpha: 1,
            },
          },
        ],
        filters: [
          {
            type: "color",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#ffc2f4",
              },
              saturation: 1,
              contrast: 1,
              brightness: 1,
              gamma: 1.4,
            },
          },
        ],
      },
    },
  },
  sandstorm: {
    free: {},
    plus: {
      normal: {
        particles: [
          {
            type: "sandstorm",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#9fb7fe",
              },
              scale: 0.85,
              direction: 0,
              speed: 4.8,
              lifetime: 4,
              density: 4.5,
              alpha: 1,
              wobble: 0,
              wobbleFrequency: 0,
            },
          },
        ],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#b38b5a",
              },
              dimensions: 5,
              speed: 0.5,
              density: 0.45,
              direction: 0,
              streakiness: 1,
              opacity: 0.6,
            },
          },
        ],
      },
    },
  },
  sleet: {
    free: {
      normal: {
        particles: [
          {
            type: "hail",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#757575",
              },
              topDown: false,
              scale: 0.3,
              direction: 55,
              speed: 3,
              lifetime: 1.6,
              density: 1.05,
              alpha: 1,
            },
          },
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: false,
              scale: 1.8,
              direction: 55,
              speed: 1.9,
              lifetime: 2.5,
              density: 2,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  snow: {
    free: {
      normal: {
        particles: [
          {
            type: "snow",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ff0000",
              },
              topDown: false,
              scale: 0.5,
              direction: 90,
              speed: 1.4,
              lifetime: 0.6,
              density: 5,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
      topDown: {
        particles: [
          {
            type: "snow",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ff0000",
              },
              topDown: true,
              scale: 0.5,
              direction: 0,
              speed: 1.4,
              lifetime: 0.6,
              density: 5,
              alpha: 1,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  "spore-cloud": {
    free: {
      normal: {
        particles: [
          {
            type: "fog",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#00ff9d",
              },
              scale: 2.5,
              speed: 3,
              lifetime: 5,
              density: 0.07,
              alpha: 0.2,
            },
          },
          {
            type: "embers",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#41a300",
              },
              topDown: false,
              scale: 4,
              speed: 1,
              lifetime: 4.1,
              density: 0.2,
              alpha: 0.5,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  sunshower: {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: false,
              scale: 0.7,
              direction: 75,
              speed: 0.7,
              lifetime: 2.5,
              density: 1,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 0.7,
              direction: 0,
              speed: 1,
              lifetime: 1,
              density: 0.047,
              alpha: 0.8,
              dropShadow: true,
              shadowOnly: true,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "color",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#fff2a8",
              },
              saturation: 1,
              contrast: 1,
              brightness: 1,
              gamma: 1,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: true,
              splash: false,
              scale: 1,
              direction: 75,
              speed: 0.7,
              lifetime: 2.5,
              density: 1.2,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 0.7,
              direction: 0,
              speed: 1,
              lifetime: 1,
              density: 0.047,
              alpha: 0.8,
              dropShadow: true,
              shadowOnly: true,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "color",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#fff2a8",
              },
              saturation: 1,
              contrast: 1,
              brightness: 1,
              gamma: 1,
            },
          },
        ],
      },
    },
    plus: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: false,
              scale: 0.7,
              direction: 75,
              speed: 0.7,
              lifetime: 2.5,
              density: 1,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 0.7,
              direction: 0,
              speed: 1,
              lifetime: 1,
              density: 0.047,
              alpha: 0.8,
              dropShadow: true,
              shadowOnly: true,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "sunlight",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              parallel: true,
              color: {
                apply: true,
                value: "#fff2a8",
              },
              angle: -18,
              gain: 1,
              lacunarity: 0.5,
              beam_length: 0,
              alpha: 0.3,
              speed: 1.5,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: true,
              splash: false,
              scale: 1,
              direction: 75,
              speed: 0.7,
              lifetime: 2.5,
              density: 1.2,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 0.7,
              direction: 0,
              speed: 1,
              lifetime: 1,
              density: 0.047,
              alpha: 0.8,
              dropShadow: true,
              shadowOnly: true,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "sunlight",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              parallel: true,
              color: {
                apply: true,
                value: "#fff2a8",
              },
              angle: -18,
              gain: 1,
              lacunarity: 0.5,
              beam_length: 0,
              alpha: 0.3,
              speed: 1.5,
            },
          },
        ],
      },
    },
  },
  thunderstorm: {
    free: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: true,
              scale: 1.6,
              direction: 75,
              speed: 1.9,
              lifetime: 2.5,
              density: 4,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#828282",
              },
              scale: 5,
              direction: 75,
              speed: 4,
              lifetime: 1,
              density: 0.047,
              alpha: 0.2,
              dropShadow: false,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 1.6,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: false,
              scale: 1.8,
              direction: 75,
              speed: 1.9,
              lifetime: 2.5,
              density: 4,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#828282",
              },
              scale: 5,
              direction: 75,
              speed: 4,
              lifetime: 1,
              density: 0.047,
              alpha: 0.2,
              dropShadow: false,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 1.5,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
            },
          },
        ],
      },
    },
    plus: {
      normal: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: true,
              scale: 1.6,
              direction: 75,
              speed: 1.9,
              lifetime: 2.5,
              density: 4,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#828282",
              },
              scale: 5,
              direction: 75,
              speed: 4,
              lifetime: 1,
              density: 0.047,
              alpha: 0.2,
              dropShadow: false,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 2,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
              topDown: false,
            },
          },
          {
            type: "lightningbolts",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: false,
                value: "#00aeff",
              },
              mode: ["horizontal"],
              directionalMovement: false,
              direction: 0,
              syncFlash: true,
              topDownBoltsVariable: true,
              thickness: 2,
              topDownScale: 10,
              topDownBolts: 5,
              branches: 15,
              length: 2,
              speed: 1,
              jitter: 0.3,
              brightness: 4,
              opacity: 1,
              glow: 1,
              frequency: 5000,
              spark_duration: 705,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.85,
            },
          },
        ],
      },
      topDown: {
        particles: [
          {
            type: "rain",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#80a6ff",
              },
              topDown: false,
              splash: false,
              scale: 1.8,
              direction: 75,
              speed: 1.9,
              lifetime: 2.5,
              density: 4,
              alpha: 1,
            },
          },
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#828282",
              },
              scale: 5,
              direction: 75,
              speed: 4,
              lifetime: 1,
              density: 0.047,
              alpha: 0.2,
              dropShadow: false,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 0.7,
            },
          },
        ],
        filters: [
          {
            type: "lightning",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              frequency: 5000,
              spark_duration: 500,
              brightness: 2,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.75,
              topDown: false,
            },
          },
          {
            type: "lightningbolts",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: false,
                value: "#00aeff",
              },
              mode: ["topDown"],
              directionalMovement: false,
              direction: 0,
              syncFlash: true,
              topDownBoltsVariable: true,
              thickness: 2,
              topDownScale: 10,
              topDownBolts: 5,
              branches: 15,
              length: 2,
              speed: 1,
              jitter: 0.3,
              brightness: 4,
              opacity: 1,
              glow: 1,
              frequency: 5000,
              spark_duration: 705,
              audioAware: false,
              audioChannels: ["environment"],
              audioBassThreshold: 0.85,
            },
          },
        ],
      },
    },
  },
  tornado: {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#6b6b6b",
              },
              dimensions: 4,
              speed: 5,
              density: 1,
              direction: 0,
              streakiness: 0,
              opacity: 0.3,
            },
          },
        ],
      },
    },
  },
  veilfall: {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "glitch",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              sliceEnable: true,
              crosshatch: false,
              slices: 3,
              scrollSpeed: 0.1,
              refreshRate: 0,
              offset: 75,
              direction: 180,
              sliceJaggedness: 0.5,
              sliceShardAngle: 0,
              redX: -50,
              redY: -50,
              greenX: -50,
              greenY: -50,
              blueX: -50,
              blueY: -50,
              glyphEnable: true,
              glyphColor: {
                apply: true,
                value: "#6A5A8E",
              },
              glyphIntensity: 1,
              glyphCell: 27,
              glyphSpeed: 9.7,
              glyphDirection: 0,
              glyphDensity: 0.28,
              glyphSlicePct: 1,
              glyphFlickerSpeed: 0.359,
              topDown: false,
            },
          },
          {
            type: "color",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#887da1",
              },
              saturation: 1,
              contrast: 1,
              brightness: 1,
              gamma: 1,
            },
          },
        ],
      },
    },
  },
  "wildfire-smoke": {
    free: {
      normal: {
        particles: [
          {
            type: "clouds",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: true,
                value: "#000000",
              },
              scale: 5,
              direction: 0,
              speed: 5,
              lifetime: 0.5,
              density: 0.2,
              alpha: 0.2,
              dropShadow: false,
              shadowOnly: false,
              shadowRotation: 315,
              shadowDistance: 0,
              shadowBlur: 2.5,
              shadowOpacity: 1,
            },
          },
          {
            type: "embers",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              tint: {
                apply: false,
                value: "#ff7300",
              },
              topDown: false,
              scale: 1,
              speed: 1,
              lifetime: 4.1,
              density: 0.2,
              alpha: 0.5,
            },
          },
        ],
        filters: [],
      },
    },
    plus: {},
  },
  windy: {
    free: {},
    plus: {
      normal: {
        particles: [],
        filters: [
          {
            type: "duststorm",
            options: {
              belowTokens: false,
              soundFxEnabled: false,
              color: {
                apply: true,
                value: "#4f4f4f",
              },
              dimensions: 0,
              speed: 0.5,
              density: 1,
              direction: 0,
              streakiness: 1,
              opacity: 0.5,
            },
          },
        ],
      },
    },
  },
};

export const API_EFFECT_NAMES = Object.freeze(Object.keys(API_EFFECTS));
