'use strict';

// Importing a dma-buf as a texture, and mapping one for the CPU.
//
//     node examples/dmabuf-import.js
//
// Writes dmabuf-import.png: the same buffer twice. On the left it is sampled
// where it lies — imported with gl.importDmabuf, no copy and no upload. On
// the right the same bytes are read back through mapDmabuf and uploaded the
// ordinary way with texImage2D. The two halves match because they are one
// buffer, which is the whole point.
//
// The buffer here comes from /dev/udmabuf, because that is the one dma-buf an
// example can allocate with no X server and no second process. In real use it
// arrives from somewhere else entirely — DRI3.BuffersFromPixmap on a
// redirected window, a video decoder, another client — and nothing below
// changes: a descriptor, a stride and an offset is all the import wants.

const dri = require('..');
const { offscreen, program, quad } = require('./offscreen');

const W = 256, H = 256;
const ctx = offscreen(W * 2, H);
const gl = ctx.gl;

if (!ctx.gpu.features.dmabufImport) {
    console.error('this driver has no EGL_EXT_image_dma_buf_import');
    ctx.close();
    process.exit(1);
}

// ---- a dma-buf with something in it ----------------------------------------

let ud;
try {
    ud = dri.createUdmabuf(W * H * 4);
} catch (e) {
    console.error(`no udmabuf to import: ${e.message}`);
    ctx.close();
    process.exit(1);
}

// XR24 is little-endian 0xXXRRGGBB, so one Uint32 write per pixel puts the
// bytes down in the B, G, R, X order the format actually wants. Row 0 is the
// bottom row, the way GL samples it.
const pixels = new Uint32Array(ud.buffer);
ud.sync(dri.DMABUF_SYNC.START | dri.DMABUF_SYNC.WRITE);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const r = Math.round(255 * u);
        const g = Math.round(255 * v);
        const b = Math.hypot(u - 0.5, v - 0.5) < 0.3 ? 230 : 40;
        pixels[y * W + x] = (r << 16) | (g << 8) | b;
    }
}
ud.sync(dri.DMABUF_SYNC.END | dri.DMABUF_SYNC.WRITE);

// ---- left: the descriptor, imported ----------------------------------------

// importDmabuf consumes the descriptors it is given, and this example still
// needs ud.fd afterwards for the mapping below — so it imports a duplicate.
// That is the same dup() a DRI3 PixmapFromBuffer send would need.
let image;
try {
    image = gl.importDmabuf({
        width: W,
        height: H,
        fourcc: dri.FORMAT.XRGB8888,
        // udmabuf memory is plain linear pages. Saying so needs the modifier
        // extension; without it the implicit form is the only one on offer,
        // and the driver assumes its own default layout.
        modifier: ctx.gpu.features.dmabufImportModifiers ? dri.MODIFIER.LINEAR : undefined,
        planes: [{ fd: dri.dup(ud.fd), stride: W * 4, offset: 0 }]
    });
} catch (e) {
    // Not every driver will import every buffer: CPU pages with a linear
    // layout are the easy case, but "easy" is not "guaranteed".
    console.error(`import failed: ${e.message}`);
    ud.close();
    ctx.close();
    process.exit(1);
}

// ---- right: the same memory, read back and uploaded ------------------------

const mapped = dri.mapDmabuf(ud.fd);
mapped.sync(dri.DMABUF_SYNC.START | dri.DMABUF_SYNC.READ);
const bgra = new Uint8Array(mapped.buffer);
const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bgra[i * 4 + 2];     // R
    rgba[i * 4 + 1] = bgra[i * 4 + 1]; // G
    rgba[i * 4 + 2] = bgra[i * 4];     // B
    rgba[i * 4 + 3] = 255;
}
mapped.sync(dri.DMABUF_SYNC.END | dri.DMABUF_SYNC.READ);
mapped.close(); // the fd stays ours: mapDmabuf borrows, it does not consume

const uploaded = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, uploaded);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

// ---- draw both -------------------------------------------------------------

const p = program(gl, `
    attribute vec2 position;
    varying vec2 vUv;
    void main() {
        vUv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
    }
`, `
    precision mediump float;
    uniform sampler2D uMap;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(uMap, vUv); }
`);
gl.useProgram(p);
quad(gl, p);
gl.uniform1i(gl.getUniformLocation(p, 'uMap'), 0);
gl.activeTexture(gl.TEXTURE0);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);

gl.viewport(0, 0, W, H);
gl.bindTexture(image.target, image.texture); // TEXTURE_2D for one RGB plane
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

gl.viewport(W, 0, W, H);
gl.bindTexture(gl.TEXTURE_2D, uploaded);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

ctx.save('dmabuf-import.png');
console.log('left: imported dma-buf (zero copy)   right: mapped and uploaded');

image.destroy();
ud.close();
ctx.close();
