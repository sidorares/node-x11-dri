'use strict';

// One geometry pass filling two textures at once — a G-buffer, the reason
// multiple render targets exist.
//
//     node examples/multiple-render-targets.js
//
// Writes multiple-render-targets.png with three panels: what the pass wrote
// to attachment 0 (albedo), what it wrote to attachment 1 (surface normals,
// packed into RGB), and a second pass lighting one with the other. Without
// MRT the geometry has to be drawn once per output.
//
// drawBuffers is optional — core in ES 3.0, GL_EXT_draw_buffers before it —
// so gpu.features is checked first. The fragment shader writes gl_FragData[i]
// and asks for the extension explicitly, which is the ES 2.0 spelling and
// keeps working on an ES 3.0 context.

const { offscreen, program, quad } = require('./offscreen');

const SIZE = 256;
const ctx = offscreen(SIZE * 3, SIZE);
const gl = ctx.gl;

console.log('features:', ctx.gpu.features);
if (!ctx.gpu.features.drawBuffers) {
    console.error('this driver has no drawBuffers (no ES 3.0, no GL_EXT_draw_buffers)');
    ctx.close();
    process.exit(1);
}
console.log('MAX_DRAW_BUFFERS:', gl.getParameter(gl.MAX_DRAW_BUFFERS));

// ---- the G-buffer ----------------------------------------------------------

const target = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
};
const albedo = target();
const normal = target();

const fbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedo, 0);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normal, 0);
const depth = gl.createRenderbuffer();
gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, SIZE, SIZE);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('the two-attachment framebuffer is not complete');
    ctx.close();
    process.exit(1);
}

// Both outputs, in order: fragment output 0 lands on attachment 0, output 1
// on attachment 1.
gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

// ---- pass one: geometry ----------------------------------------------------

// Each sphere is a quad, turned into a hemisphere in the fragment shader:
// z from x and y, everything outside the disc discarded. Cheap, and it gives
// the second attachment something worth storing.
const geometry = program(gl, `
attribute vec2 position;
uniform vec2 uCentre;
uniform float uRadius;
varying vec2 vLocal;
void main() {
    vLocal = position;
    gl_Position = vec4(position * uRadius + uCentre, 0.0, 1.0);
}`, `
#extension GL_EXT_draw_buffers : require
precision mediump float;
uniform vec3 uAlbedo;
varying vec2 vLocal;
void main() {
    float r2 = dot(vLocal, vLocal);
    if (r2 > 1.0) discard;
    vec3 n = vec3(vLocal, sqrt(1.0 - r2));
    gl_FragData[0] = vec4(uAlbedo, 1.0);          // attachment 0: albedo
    gl_FragData[1] = vec4(n * 0.5 + 0.5, 1.0);    // attachment 1: normal
}`);
gl.useProgram(geometry);
quad(gl, geometry);

gl.viewport(0, 0, SIZE, SIZE);
gl.clearColor(0.06, 0.07, 0.10, 1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

const spheres = [
    { at: [-0.38, 0.30], r: 0.42, c: [0.95, 0.35, 0.35] },
    { at: [0.34, 0.34], r: 0.34, c: [0.35, 0.80, 0.95] },
    { at: [0.00, -0.34], r: 0.50, c: [0.95, 0.80, 0.30] },
    { at: [0.52, -0.44], r: 0.24, c: [0.55, 0.95, 0.45] },
    { at: [-0.58, -0.46], r: 0.26, c: [0.75, 0.50, 0.95] }
];
const uCentre = gl.getUniformLocation(geometry, 'uCentre');
const uRadius = gl.getUniformLocation(geometry, 'uRadius');
const uAlbedo = gl.getUniformLocation(geometry, 'uAlbedo');
for (const s of spheres) {
    gl.uniform2f(uCentre, s.at[0], s.at[1]);
    gl.uniform1f(uRadius, s.r);
    gl.uniform3f(uAlbedo, s.c[0], s.c[1], s.c[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
console.log(`${spheres.length} draws filled 2 attachments`);

// ---- pass two: look at the results -----------------------------------------

const VS = 'attribute vec2 position;\nvarying vec2 vUv;\n' +
    'void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }';

const blit = program(gl, VS,
    'precision mediump float;\nuniform sampler2D uMap;\nvarying vec2 vUv;\n' +
    'void main() { gl_FragColor = texture2D(uMap, vUv); }');
// The deferred part: the shading reads both attachments and never sees the
// geometry at all.
const light = program(gl, VS, `
precision mediump float;
uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
varying vec2 vUv;
void main() {
    vec4 encoded = texture2D(uNormalMap, vUv);
    vec3 n = encoded.rgb * 2.0 - 1.0;
    if (length(n) < 0.1) {                 // background: nothing was written
        gl_FragColor = vec4(0.06, 0.07, 0.10, 1.0);
        return;
    }
    n = normalize(n);
    vec3 l = normalize(vec3(-0.5, 0.6, 0.7));
    float diffuse = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);
    vec3 albedo = texture2D(uAlbedoMap, vUv).rgb;
    gl_FragColor = vec4(albedo * (0.15 + 0.85 * diffuse) + spec * 0.6, 1.0);
}`);

gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);

gl.useProgram(blit);
quad(gl, blit);
gl.uniform1i(gl.getUniformLocation(blit, 'uMap'), 0);
gl.activeTexture(gl.TEXTURE0);
for (const [x, tex] of [[0, albedo], [SIZE, normal]]) {
    gl.viewport(x, 0, SIZE, SIZE);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

gl.useProgram(light);
quad(gl, light);
gl.uniform1i(gl.getUniformLocation(light, 'uAlbedoMap'), 0);
gl.uniform1i(gl.getUniformLocation(light, 'uNormalMap'), 1);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, albedo);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, normal);
gl.viewport(SIZE * 2, 0, SIZE, SIZE);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

const err = gl.getError();
if (err !== gl.NO_ERROR) {
    console.error(`GL error 0x${err.toString(16)}`);
    ctx.close();
    process.exit(1);
}

ctx.save('multiple-render-targets.png');
console.log('panels: albedo | normals | deferred shading from the two');
ctx.close();
