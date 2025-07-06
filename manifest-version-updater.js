const stringifyPackage = require("stringify-package");

const repository = "gambit07/fxmaster";
const githubURL = "https://github.com";
const githubRawURL = "https://raw.githubusercontent.com";

module.exports.readVersion = function (contents) {
  return JSON.parse(contents).version;
};

module.exports.writeVersion = function (contents, version) {
  const json = JSON.parse(contents);
  json.license = `${githubRawURL}/${repository}/v${version}/LICENSE.md`;
  json.readme = `${githubRawURL}/${repository}/v${version}/README.md`;
  json.changelog = `${githubRawURL}/${repository}/v${version}/CHANGELOG.md`;
  json.version = version;
  json.download = `${githubURL}/${repository}/releases/download/v${version}/module.zip`;
  return stringifyPackage(json, 4);
};
