/** Preserve derivative extension ordering in final GLSL ES 1.00 programs. */
export function prepareFilterShaderSources(vertex, fragment) {
  if (typeof vertex !== "string" || typeof fragment !== "string") return [vertex, fragment];
  if (!fragment.includes("#extension GL_OES_standard_derivatives")) return [vertex, fragment];
  if (/^\s*#version\s+300\b/.test(vertex) || /^\s*#version\s+300\b/.test(fragment)) return [vertex, fragment];

  const prepare = (source) => {
    const extensions = [];
    const body = source
      .replace(/^\s*#version\s+100\s*\n/, "")
      .replace(
        /#ifdef\s+GL_OES_standard_derivatives\s*\n\s*#extension\s+GL_OES_standard_derivatives\s*:\s*enable\s*\n\s*#endif/g,
        (block) => {
          extensions.push(block);
          return "";
        },
      );
    return ["#version 100", ...extensions, body.trimStart()].join("\n");
  };
  return [prepare(vertex), prepare(fragment)];
}
