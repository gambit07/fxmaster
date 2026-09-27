
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform mat3 filterMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

varying vec2 vTextureCoord;
varying vec2 vFilterCoord;

/**
 * main
 * ----
 * 2D vertex shader for FXMaster's filter pipeline.
 * - Derives `vTextureCoord` in the input (scene) texture UV space.
 * - Computes screen-space position from `aVertexPosition` and `outputFrame`.
 * - Builds a world-anchored `vFilterCoord` via `filterMatrix` for effects that need it.
 * - Projects to clip space using `projectionMatrix`.
 */
void main(void) {
  vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);

  vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;

  vFilterCoord = (filterMatrix * vec3(position, 1.0)).xy;

  gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}
