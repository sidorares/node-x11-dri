'use strict';

// The two ES 3.0 texture types, side by side, doing the thing that
// distinguishes them.
//
//     node examples/texture-3d.js
//
// Writes texture-3d.png with three panels:
//
//   1. a 2D array texture — four independent images in one object, one per
//      quadrant. Layers do not filter into each other, so the boundaries are
//      hard no matter what the sampler is set to.
//   2. a 3D texture holding a 64x64x64 volume, ray-marched: the third axis
//      *is* filtered, which is what makes the smoke look continuous rather
//      than sliced.
//   3. the same volume sampled as flat slices, to show the texels the
//      filtering is interpolating between.
//
// Both are one texImage3D call with a different target. Immutable storage
// (texStorage3D) is used for the volume, which is the normal way to allocate
// a texture whose shape never changes.

const { offscreen, program, quad } = require('./offscreen');

const SIZE = 320;
const ctx = offscreen(SIZE * 3, SIZE, { glVersion: 3 });
const gl = ctx.gl;
const gpu = ctx.gpu;

console.log(`ES ${gpu.contextVersion} context, driver reports ${gpu.glVersion.string}`);
console.log('features:', gpu.features);
if (!gpu.features.texture3D || gpu.glVersion.major < 3) {
    console.error('this driver has no ES 3.0 3D/array textures');
    ctx.close();
    process.exit(1);
}
console.log(`MAX_3D_TEXTURE_SIZE ${gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)},` +
    ` MAX_ARRAY_TEXTURE_LAYERS ${gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)}`);

const VS = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

// ---- panel 1: a 2D array texture -------------------------------------------

// Four 64x64 images in one object. A material atlas works this way: one bind,
// one sampler, and the layer index picks the image — without the bleeding
// between neighbours that a packed 2D atlas suffers at its seams.
const LAYER = 64;
const layers = new Uint8Array(LAYER * LAYER * 4 * 4);
for (let l = 0; l < 4; l++) {
    for (let y = 0; y < LAYER; y++) {
        for (let x = 0; x < LAYER; x++) {
            const o = ((l * LAYER + y) * LAYER + x) * 4;
            const u = x / LAYER, v = y / LAYER;
            const checks = ((x >> 3) + (y >> 3)) % 2 === 0;
            const rings = Math.sin(Math.hypot(u - 0.5, v - 0.5) * 30) * 0.5 + 0.5;
            const pattern = [checks ? 1 : 0.25, rings, u, v * (checks ? 1 : 0.3)][l];
            const tint = [[1, 0.4, 0.35], [0.4, 0.85, 1], [1, 0.85, 0.35], [0.6, 1, 0.5]][l];
            layers[o] = 255 * pattern * tint[0];
            layers[o + 1] = 255 * pattern * tint[1];
            layers[o + 2] = 255 * pattern * tint[2];
            layers[o + 3] = 255;
        }
    }
}
const arrayTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTex);
gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, LAYER, LAYER, 4, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, layers);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const arrayProgram = program(gl, VS, `#version 300 es
precision mediump float;
precision mediump sampler2DArray;
uniform sampler2DArray uTex;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
    // quadrant -> layer. The layer index is not interpolated, so the four
    // quarters stay completely independent of one another.
    vec2 q = floor(vUv * 2.0);
    float layer = q.y * 2.0 + q.x;
    fragColor = texture(uTex, vec3(fract(vUv * 2.0), layer));
}`);

// ---- panels 2 and 3: a 3D texture ------------------------------------------

// A 64-cubed volume holding a gyroid shell — a surface that genuinely varies
// along all three axes, so both the ray-march and the slices have structure
// to show, and the filtering has something continuous to interpolate.
const N = 64;
const volume = new Uint8Array(N * N * N);
const F = Math.PI * 4; // two periods across the cube
for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = x / N, v = y / N, w = z / N;
            const g = Math.sin(F * u) * Math.cos(F * v) +
                      Math.sin(F * v) * Math.cos(F * w) +
                      Math.sin(F * w) * Math.cos(F * u);
            // a shell around the zero surface, faded to nothing at the walls
            const shell = Math.max(0, 1 - Math.abs(g) / 0.9) ** 2;
            const r = Math.hypot(u - 0.5, v - 0.5, w - 0.5);
            const ball = Math.max(0, Math.min(1, (0.46 - r) / 0.12));
            volume[(z * N + y) * N + x] = Math.min(255, shell * ball * 255);
        }
    }
}
const volumeTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_3D, volumeTex);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
if (gpu.features.textureStorage) {
    // Allocate once, in a sized format, then fill: the shape of this texture
    // is never going to change.
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, N, N, N);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, N, N, N, gl.RED, gl.UNSIGNED_BYTE, volume);
} else {
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, volume);
}
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
    gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);

const volumeProgram = program(gl, VS, `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVolume;
uniform int uMode;              // 0: ray-march, 1: flat slices
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
    if (uMode == 1) {
        // A 4x4 grid of slices, each a single depth. This is the data the
        // panel to the left is interpolating between.
        vec2 cell = floor(vUv * 4.0);
        vec2 inner = fract(vUv * 4.0);
        float slice = (cell.y * 4.0 + cell.x) / 16.0 + 0.03;
        float d = texture(uVolume, vec3(inner, slice)).r;
        // a hairline between cells, so sixteen separate images read as
        // sixteen separate images
        float edge = min(min(inner.x, inner.y), min(1.0 - inner.x, 1.0 - inner.y));
        vec3 c = vec3(0.25, 0.55, 1.0) * d * 1.6 + 0.04;
        fragColor = vec4(edge < 0.012 ? vec3(0.16) : c, 1.0);
        return;
    }
    // Straight through the cube, front to back, accumulating.
    vec3 ro = vec3(vUv, 0.0);
    vec3 rd = vec3((vUv - 0.5) * 0.35, 1.0);
    vec3 acc = vec3(0.0);
    float alpha = 0.0;
    for (int i = 0; i < 96; i++) {
        vec3 p = ro + rd * (float(i) / 96.0);
        // Trilinear filtering across all three axes is the whole point: the
        // 64 samples along the way land between texels almost every time.
        float d = texture(uVolume, p).r;
        float a = d * 0.06 * (1.0 - alpha);
        acc += mix(vec3(1.0, 0.45, 0.2), vec3(0.4, 0.8, 1.0), p.z) * a * 2.2;
        alpha += a;
        if (alpha > 0.98) break;
    }
    fragColor = vec4(acc + 0.04, 1.0);
}`);

// ---- draw ------------------------------------------------------------------

gl.clearColor(0.02, 0.02, 0.04, 1);
gl.clear(gl.COLOR_BUFFER_BIT);

gl.useProgram(arrayProgram);
quad(gl, arrayProgram, 'position');
gl.uniform1i(gl.getUniformLocation(arrayProgram, 'uTex'), 0);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTex);
gl.viewport(0, 0, SIZE, SIZE);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

gl.useProgram(volumeProgram);
quad(gl, volumeProgram, 'position');
gl.uniform1i(gl.getUniformLocation(volumeProgram, 'uVolume'), 0);
const uMode = gl.getUniformLocation(volumeProgram, 'uMode');
gl.bindTexture(gl.TEXTURE_3D, volumeTex);
for (const [x, mode] of [[SIZE, 0], [SIZE * 2, 1]]) {
    gl.viewport(x, 0, SIZE, SIZE);
    gl.uniform1i(uMode, mode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

const err = gl.getError();
if (err !== gl.NO_ERROR) {
    console.error(`GL error 0x${err.toString(16)}`);
    ctx.close();
    process.exit(1);
}

console.log(`array: 4 layers of ${LAYER}x${LAYER}; volume: ${N}^3 = ` +
    `${(volume.length / 1024).toFixed(0)} KiB of R8`);
ctx.save('texture-3d.png');
console.log('panels: 2D array (4 layers) | 3D volume ray-marched | its slices');
ctx.close();
