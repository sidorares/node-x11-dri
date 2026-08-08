'use strict';

// Two thousand quads in one draw call, using a vertex array object to hold
// the setup.
//
//     node examples/instancing.js
//
// Writes instancing.png. The geometry is four vertices, uploaded once.
// Everything that differs per quad — position, size, rotation, colour — is
// an attribute marked with vertexAttribDivisor(loc, 1), which tells GL to
// advance it once per instance instead of once per vertex. Without it this
// is 2000 draw calls and 2000 uniform updates.
//
// Both features are optional: core in ES 3.0, extensions before it, and
// possibly neither. gpu.features is the thing to branch on.

const { offscreen, program } = require('./offscreen');

const COUNT = 2000;
const SIZE = 512;
const ctx = offscreen(SIZE, SIZE);
const gl = ctx.gl;
const gpu = ctx.gpu;

console.log('features:', gpu.features);
const missing = ['vertexArrayObject', 'instancedArrays'].filter(f => !gpu.features[f]);
if (missing.length) {
    console.error(`this driver has no ${missing.join(' and no ')}`);
    console.error('GL version:', gl.getString(gl.VERSION));
    ctx.close();
    process.exit(1);
}

const p = program(gl, `
attribute vec2 aCorner;      // per vertex: the unit quad
attribute vec2 aCentre;      // per instance from here down
attribute vec2 aScale;
attribute float aAngle;
attribute vec3 aColor;
varying vec3 vColor;
varying vec2 vLocal;
void main() {
    vColor = aColor;
    vLocal = aCorner;
    float s = sin(aAngle), c = cos(aAngle);
    vec2 p = mat2(c, s, -s, c) * (aCorner * aScale);
    gl_Position = vec4(p + aCentre, 0.0, 1.0);
}`, `
precision mediump float;
varying vec3 vColor;
varying vec2 vLocal;
void main() {
    // round the corners off, so the instances read as separate objects
    float d = length(vLocal);
    if (d > 1.0) discard;
    gl_FragColor = vec4(vColor * (1.2 - 0.5 * d), 1.0);
}`);
gl.useProgram(p);

// One vertex array object holds every binding below, so the draw loop is a
// single bindVertexArray away from being ready.
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

const attrib = (name, size, data, divisor) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, divisor);
    return loc;
};

attrib('aCorner', 2, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 0);

// A deterministic scatter: a golden-angle spiral, so the instances spread
// evenly without needing a random number generator anyone has to trust.
const centre = new Float32Array(COUNT * 2);
const scale = new Float32Array(COUNT * 2);
const angle = new Float32Array(COUNT);
const color = new Float32Array(COUNT * 3);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < COUNT; i++) {
    const t = i / COUNT;
    const r = 0.95 * Math.sqrt(t);
    const a = i * GOLDEN;
    centre[i * 2] = r * Math.cos(a);
    centre[i * 2 + 1] = r * Math.sin(a);
    const s = 0.004 + 0.020 * (1 - t);
    scale[i * 2] = s;
    scale[i * 2 + 1] = s;
    angle[i] = a;
    // hue around the spiral, brightness by radius
    const h = (a / (Math.PI * 2)) % 1;
    const k = n => {
        const q = (n + h * 6) % 6;
        return Math.max(0, Math.min(1, Math.min(q, 4 - q, 1)));
    };
    color[i * 3] = 0.35 + 0.65 * k(5);
    color[i * 3 + 1] = 0.35 + 0.65 * k(3);
    color[i * 3 + 2] = 0.35 + 0.65 * k(1);
}
attrib('aCentre', 2, centre, 1);
attrib('aScale', 2, scale, 1);
attrib('aAngle', 1, angle, 1);
attrib('aColor', 3, color, 1);

gl.clearColor(0.05, 0.05, 0.08, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.bindVertexArray(vao);
gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, COUNT);

const err = gl.getError();
if (err !== gl.NO_ERROR) {
    console.error(`draw failed: GL error 0x${err.toString(16)}`);
    ctx.close();
    process.exit(1);
}

console.log(`${COUNT} instances, 4 vertices, 1 draw call`);
ctx.save('instancing.png');
ctx.close();
