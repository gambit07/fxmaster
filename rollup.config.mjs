import copy from "@guanghechen/rollup-plugin-copy";
import styles from "rollup-plugin-styler";
import { string } from "rollup-plugin-string";
import terser from "@rollup/plugin-terser";

import { distDirectory, packageId, sourceDirectory } from "./tools/const.mjs";

const staticFiles = ["assets", "CHANGELOG.md", "lang", "libs", "LICENSE.md", "module.json", "README.md", "templates"];
const isProduction = process.env.NODE_ENV === "production";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: { [`${packageId}`]: `${sourceDirectory}/${packageId}.js` },
  output: {
    dir: distDirectory,
    format: "es",
    sourcemap: true,
    assetFileNames: "[name].[ext]",
    inlineDynamicImports: true,
  },
  plugins: [
    styles({
      mode: ["extract", `css/${packageId}.css`],
      url: false,
      sourceMap: true,
      minimize: isProduction,
    }),
    string({
      include: [`${sourceDirectory}/**/*.frag`, `${sourceDirectory}/**/*.vert`],
    }),
    copy({
      verbose: true,
      targets: [{ src: staticFiles, dest: distDirectory }],
    }),
    isProduction && terser({ ecma: 2020, keep_fnames: true }),
  ],
};

export default config;
