module.exports = {
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },

  env: {
    browser: true,
    es2021: true,
    jquery: true,
  },

  extends: ["eslint:recommended", "@typhonjs-fvtt/eslint-config-foundry.js/0.8.0", "plugin:prettier/recommended"],

  plugins: [],

  globals: {
    PIXI: "readonly",
  },

  rules: {
    // Specify any specific ESLint rules.
  },

  overrides: [
    {
      files: ["./*.js", "./tools/**/*"],
      env: {
        node: true,
        browser: false,
      },
    },
  ],
};
