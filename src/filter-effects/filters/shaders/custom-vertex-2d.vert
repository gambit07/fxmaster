// SPDX-FileCopyrightText: 2022 Johannes Loher
// SPDX-FileCopyrightText: 2025 Gambit
// SPDX-License-Identifier: BSD-3-Clause

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
  // vTextureCoord in the input (scene) texture UV space
  vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);

  // Position in screen space for this pass (device px in Pixi’s filter pipeline)
  vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;

  // World-anchored coord used by some effects (e.g., fog), via filterMatrix
  vFilterCoord = (filterMatrix * vec3(position, 1.0)).xy;

  // Final clip-space position
  gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}
