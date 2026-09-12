'use strict';

// A dma-buf going the other way: not exported, imported.
//
//     node examples/dmabuf-import.js
//
// Everything else in this folder produces buffers. This one consumes one —
// `gl.importDmabuf` wraps a descriptor in an EGLImage and points a texture
// at it, after which the GPU samples that buffer where it already lies. No
// upload, no copy, no round trip through the CPU.
//
// Writes dmabuf-import.png with two panels:
//
//   1. the imported buffer drawn straight, which is the frame the source
//      surface rendered — proof the texture really is those pixels;
//   2. the same texture sampled with a rippling offset, which is the point:
//      once it is a texture it is an ordinary texture.
//
// The buffer here comes from a second GBM surface, standing in for the X
// server. In a compositor it would arrive over the wire instead:
//
//     Composite.NameWindowPixmap(wid, pixmap)
//     dri3.BuffersFromPixmap(pixmap)   // { width, height, modifier, planes }
//     gl.importDmabuf({ ...that, fourcc })
//
// which is the same call with somebody else's descriptor in it.

const dri = require('..');
const { offscreen, program, quad } = require('./offscreen');

const SIZE = 320;
const SRC = 256; // the "foreign" buffer, deliberately not the output size

const ctx = offscreen(SIZE * 2, SIZE);
const gl = ctx.gl;
const gpu = ctx.gpu;

console.log(`ES ${gpu.contextVersion} context, driver reports ${gpu.glVersion.string}`);
console.log('features:', gpu.features);
if (!gpu.features.dmabufImport) {
    console.error('this driver cannot import dma-bufs: it needs ' +
        'EGL_EXT_image_dma_buf_import and GL_OES_EGL_image');
    ctx.close();
    process.exit(1);
}

// ---- the buffer somebody else allocated -------------------------------------

// A second surface on the same GPU, rendered once and swapped out. `swap()`
// hands back the dma-buf descriptor for the finished frame, which from here
// on is treated as a descriptor that arrived from outside: its fd, stride,
// offset and modifier are all this side knows about it.
const source = gpu.createSurface(SRC, SRC);
gpu.makeCurrent(source);
gl.viewport(0, 0, SRC, SRC);
{
    const p = program(gl, `
        attribute vec2 position;
        varying vec2 vUv;
        void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
    `, `
        precision mediump float;
        varying vec2 vUv;
        void main() {
            // concentric rings over a gradient — something with fine detail,
            // so a resample is visible rather than merely plausible
            float r = distance(vUv, vec2(0.5));
            float rings = smoothstep(0.35, 0.45, abs(fract(r * 9.0) - 0.5));
            gl_FragColor = vec4(mix(vec3(vUv, 0.6), vec3(1.0, 0.85, 0.2), rings), 1.0);
        }
    `);
    gl.useProgram(p);
    quad(gl, p);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
const frame = source.swap();
if (!frame || !frame.isNew) {
    console.error('the source surface exported no descriptor');
    ctx.close();
    process.exit(1);
}
console.log(`exported: fd ${frame.fd}, stride ${frame.stride}, ` +
    `offset ${frame.offset}, modifier 0x${frame.modifier.toString(16)}`);

// ---- the import --------------------------------------------------------------

gpu.makeCurrent(ctx.surface);
gl.viewport(0, 0, SIZE * 2, SIZE);

// Keep a copy of the descriptor: a successful import consumes what it is
// given, the same rule DRI3.PixmapFromBuffer follows at the other end.
const spare = dri.dup(frame.fd);

const image = gl.importDmabuf({
    width: SRC,
    height: SRC,
    fourcc: gpu.format,        // ARGB8888 here — depth 32, what offscreen() asks for
    modifier: frame.modifier,  // MODIFIER.INVALID would mean "implicit layout"
    planes: [{ fd: frame.fd, stride: frame.stride, offset: frame.offset }]
});
console.log(`imported as texture ${image.texture}, target 0x${image.target.toString(16)}` +
    ` (${image.target === gl.TEXTURE_EXTERNAL_OES ? 'TEXTURE_EXTERNAL_OES' : 'TEXTURE_2D'})`);

// It is a texture now, and nothing about drawing with it is special.
const draw = program(gl, `
    attribute vec2 position;
    varying vec2 vUv;
    void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`, `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uRipple;
    void main() {
        vec2 uv = vUv;
        uv.x += uRipple * 0.03 * sin(vUv.y * 26.0);
        uv.y += uRipple * 0.03 * cos(vUv.x * 26.0);
        gl_FragColor = texture2D(uTex, clamp(uv, 0.0, 1.0));
    }
`);
gl.useProgram(draw);
quad(gl, draw);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(image.target, image.texture);
gl.uniform1i(gl.getUniformLocation(draw, 'uTex'), 0);

const uRipple = gl.getUniformLocation(draw, 'uRipple');
for (const [x, ripple] of [[0, 0], [SIZE, 1]]) {
    gl.viewport(x, 0, SIZE, SIZE);
    gl.uniform1f(uRipple, ripple);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---- the CPU half of the same idea -------------------------------------------

// mapDmabuf is the other way in: no GL at all, just the bytes of a
// descriptor this process did not allocate. Whether a buffer can be mapped
// is a property of its exporter — ask, and take the answer.
try {
    const map = dri.mapDmabuf(spare);
    console.log(`the exported frame maps as ${map.size} bytes` +
        `${map.writable ? '' : ', read-only'}`);
    map.close();
} catch (e) {
    console.log(`the exported frame cannot be mapped: ${e.message}`);
}

// Mapping is not the same as *reading what GL drew*: a GPU buffer's pixels
// reach the CPU only if the driver makes them coherent, which is what
// dmabufSync asks for and not every driver can do. Where mapDmabuf is
// unambiguous is the case it exists for — a buffer that was CPU memory all
// along, which is what a udmabuf and a software DRI3 pixmap are.
try {
    const ud = dri.createUdmabuf(4096);
    new Uint32Array(ud.buffer)[0] = 0xff8000ff;     // the allocator's mapping
    const map = dri.mapDmabuf(ud.fd);               // ...and an independent one
    map.sync(dri.DMABUF_SYNC.START | dri.DMABUF_SYNC.READ);
    const first = new Uint32Array(map.buffer)[0];
    map.sync(dri.DMABUF_SYNC.END | dri.DMABUF_SYNC.READ);
    console.log(`a udmabuf maps to the same memory: read back 0x${first.toString(16)}`);
    map.close();
    ud.close();
} catch (e) {
    console.log(`no udmabuf to map here: ${e.message}`);
}

ctx.save('dmabuf-import.png');

image.destroy();
require('fs').closeSync(spare);
source.release(frame.key);
source.destroy();
ctx.close();
