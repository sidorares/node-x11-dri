'use strict';

// What an ES 3.0 context buys, in the two places it shows up most.
//
//     node examples/es3-shaders.js
//
// Writes es3-shaders.png. Nothing here compiles or runs on ES 2.0:
//
//   - the geometry comes from gl_VertexID, so there is no vertex buffer and
//     no attribute at all — the fullscreen triangle is three vertices the
//     shader invents from their own index
//   - the fragment shader loops to a bound that comes from a uniform. GLSL
//     ES 1.00 requires loop bounds the compiler can constant-fold, which is
//     why escape-time fractals were awkward to write for it
//   - `in`/`out` instead of attribute/varying, and a declared output rather
//     than gl_FragColor
//
// The context asks for ES 3.0 and falls back, so this reports what it got
// before deciding whether it can run.

const { offscreen, program } = require('./offscreen');

const SIZE = 512;
const ctx = offscreen(SIZE, SIZE, { glVersion: 'auto' });
const gl = ctx.gl;
const gpu = ctx.gpu;

console.log(`asked EGL for ES ${gpu.contextVersion}, driver reports ${gpu.glVersion.string}`);
if (gpu.glVersion.major < 3) {
    console.error('this driver has no ES 3.0 — nothing below would compile');
    ctx.close();
    process.exit(1);
}
console.log('GLSL:', gl.getString(gl.SHADING_LANGUAGE_VERSION));

// `#version 300 es` has to be the very first characters of the source, so
// these strings start flush against the quote.
const p = program(gl, `#version 300 es
out vec2 vPos;
void main() {
    // One triangle big enough to cover the viewport, from the vertex index
    // alone: (-1,-1), (3,-1), (-1,3). No buffer, no attribute, no upload.
    vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
    vPos = p;
    gl_Position = vec4(p, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
uniform int uIterations;      // a loop bound ES 1.00 could not have taken
uniform vec2 uCentre;
uniform float uScale;
in vec2 vPos;
out vec4 fragColor;

void main() {
    vec2 c = uCentre + vPos * uScale;
    vec2 z = vec2(0.0);
    int taken = 0;
    for (int i = 0; i < uIterations; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 4.0) break;
        taken = i;
    }
    if (taken >= uIterations - 1) {
        fragColor = vec4(0.02, 0.02, 0.05, 1.0);   // inside the set
        return;
    }
    // Smooth the integer escape count into a continuous one, so the bands
    // become a gradient, then run it through a cosine palette.
    float m = float(taken) + 1.0 - log2(max(log2(length(z)), 1.0));
    float t = sqrt(m) * 0.11;
    vec3 col = 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
    fragColor = vec4(col, 1.0);
}`);
gl.useProgram(p);

gl.uniform1i(gl.getUniformLocation(p, 'uIterations'), 400);
gl.uniform2f(gl.getUniformLocation(p, 'uCentre'), -0.6, 0.0);
gl.uniform1f(gl.getUniformLocation(p, 'uScale'), 1.35);

gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 3);   // three vertices, no buffer bound

const err = gl.getError();
if (err !== gl.NO_ERROR) {
    console.error(`draw failed: GL error 0x${err.toString(16)}`);
    ctx.close();
    process.exit(1);
}

console.log('drew 3 vertices from gl_VertexID, 400 iterations per fragment');
ctx.save('es3-shaders.png');
ctx.close();
