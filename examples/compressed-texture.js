'use strict';

// Uploading a compressed texture, and seeing what the compression cost.
//
//     node examples/compressed-texture.js
//
// Writes compressed-texture.png: the same image twice, uncompressed on the
// left and DXT1 on the right, so the block artefacts are there to look at.
// DXT1 stores a 4x4 block in 8 bytes — two RGB565 endpoints and a 2-bit
// index per texel — which is 8:1 against RGBA8 and is why textures ship
// this way.
//
// The binding does not know or care about block layouts: compressedTexImage2D
// hands the bytes to the driver as they are. Which formats a driver accepts
// is a runtime question, hence the extension check below.

const { offscreen, program, quad } = require('./offscreen');

const SIZE = 256;
const ctx = offscreen(SIZE * 3, SIZE);
const gl = ctx.gl;

if (!gl.getSupportedExtensions().includes('GL_EXT_texture_compression_dxt1')) {
    console.error('this driver has no GL_EXT_texture_compression_dxt1');
    console.error('formats it does advertise:',
        gl.getSupportedExtensions().filter(e => /compress|etc|astc|s3tc/i.test(e)));
    ctx.close();
    process.exit(1);
}

// ---- the source image ------------------------------------------------------

// Smooth ramps with hard-edged shapes on top. The ramps survive almost
// perfectly — two endpoints and two interpolated colours describe a gradient
// well — and the edges are where four colours per 4x4 block runs out. Row 0
// is the bottom row, the way GL samples it.
function sourceImage(size) {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const u = x / size, v = y / size;
            const cx = u - 0.5, cy = v - 0.5;
            const d = Math.sqrt(cx * cx + cy * cy);
            let c = [30 + 200 * u, 90 + 140 * v, 210 - 160 * u]; // diagonal ramp
            if (d > 0.30 && d < 0.35) c = [255, 255, 255];       // thin white ring
            else if (d < 0.16) c = [250, 40, 90];                // solid disc
            if (Math.abs(cx + cy) < 0.045) c = [15, 15, 20];     // dark diagonal
            px[i] = Math.round(c[0]);
            px[i + 1] = Math.round(c[1]);
            px[i + 2] = Math.round(c[2]);
            px[i + 3] = 255;
        }
    }
    return px;
}

// ---- DXT1 ------------------------------------------------------------------

const to565 = ([r, g, b]) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = v => {
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
};
const mix = (a, b, t) => a.map((c, i) => Math.round(c * (1 - t) + b[i] * t));
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// One 8-byte block per 4x4 texels: two endpoints, then sixteen 2-bit indices
// into the four colours they span. Picking the endpoints by luminance extremes
// is the cheap choice — a real encoder fits a line through the block's colours
// in RGB space — but it is enough to see what the format does.
function encodeDxt1(rgba, width, height) {
    const out = new Uint8Array((width >> 2) * (height >> 2) * 8);
    let o = 0;
    for (let by = 0; by < height; by += 4) {
        for (let bx = 0; bx < width; bx += 4) {
            const texel = [];
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const i = ((by + y) * width + bx + x) * 4;
                    texel.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
                }
            }
            let lo = texel[0], hi = texel[0], loL = Infinity, hiL = -Infinity;
            for (const t of texel) {
                const l = t[0] * 299 + t[1] * 587 + t[2] * 114;
                if (l < loL) { loL = l; lo = t; }
                if (l > hiL) { hiL = l; hi = t; }
            }
            let c0 = to565(hi), c1 = to565(lo);
            if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }
            out[o] = c0 & 0xff; out[o + 1] = c0 >> 8;
            out[o + 2] = c1 & 0xff; out[o + 3] = c1 >> 8;
            // c0 > c1 selects the four-colour mode. Equal endpoints instead
            // mean the three-colour mode, where index 3 is transparent black
            // — so a flat block keeps every index at 0 rather than risking it.
            if (c0 !== c1) {
                const pal = [from565(c0), from565(c1)];
                pal.push(mix(pal[0], pal[1], 1 / 3), mix(pal[0], pal[1], 2 / 3));
                for (let i = 0; i < 16; i++) {
                    let best = 0, bestD = Infinity;
                    for (let k = 0; k < 4; k++) {
                        const d = dist2(texel[i], pal[k]);
                        if (d < bestD) { bestD = d; best = k; }
                    }
                    out[o + 4 + (i >> 2)] |= best << ((i & 3) * 2);
                }
            }
            o += 8;
        }
    }
    return out;
}

// ---- upload both, draw them side by side -----------------------------------

const source = sourceImage(SIZE);
const compressed = encodeDxt1(source, SIZE, SIZE);
console.log(`RGBA8 ${source.length} bytes -> DXT1 ${compressed.length} bytes` +
    ` (${(source.length / compressed.length).toFixed(1)}:1)`);

function texture(upload) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    upload();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
}

const plain = texture(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, SIZE, SIZE, 0,
    gl.RGB, gl.UNSIGNED_BYTE, null));
// The RGBA source, uploaded as RGB via a repack, keeps the comparison honest:
// both textures then hold the same three channels.
gl.bindTexture(gl.TEXTURE_2D, plain);
const rgb = new Uint8Array(SIZE * SIZE * 3);
for (let i = 0, j = 0; i < source.length; i += 4, j += 3) {
    rgb[j] = source[i]; rgb[j + 1] = source[i + 1]; rgb[j + 2] = source[i + 2];
}
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, SIZE, SIZE, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);

const dxt = texture(() => gl.compressedTexImage2D(gl.TEXTURE_2D, 0,
    gl.COMPRESSED_RGB_S3TC_DXT1_EXT, SIZE, SIZE, 0, compressed));

const err = gl.getError();
if (err !== gl.NO_ERROR) {
    console.error(`upload failed: GL error 0x${err.toString(16)}`);
    ctx.close();
    process.exit(1);
}

const VS = 'attribute vec2 position;\nvarying vec2 vUv;\n' +
    'void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }';

const show = program(gl, VS,
    'precision mediump float;\nuniform sampler2D uMap;\nvarying vec2 vUv;\n' +
    'void main() { gl_FragColor = texture2D(uMap, vUv); }');
// The third panel is what the format actually cost: the two textures
// subtracted and multiplied up, which turns the error into the block grid
// that produced it.
const diff = program(gl, VS,
    'precision mediump float;\n' +
    'uniform sampler2D uA;\nuniform sampler2D uB;\nvarying vec2 vUv;\n' +
    'void main() {\n' +
    '  vec3 e = abs(texture2D(uA, vUv).rgb - texture2D(uB, vUv).rgb);\n' +
    '  gl_FragColor = vec4(e * 8.0, 1.0);\n}');

gl.useProgram(show);
quad(gl, show);
gl.uniform1i(gl.getUniformLocation(show, 'uMap'), 0);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
for (const [x, tex] of [[0, plain], [SIZE, dxt]]) {
    gl.viewport(x, 0, SIZE, SIZE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

gl.useProgram(diff);
quad(gl, diff);
gl.uniform1i(gl.getUniformLocation(diff, 'uA'), 0);
gl.uniform1i(gl.getUniformLocation(diff, 'uB'), 1);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, plain);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, dxt);
gl.viewport(SIZE * 2, 0, SIZE, SIZE);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

ctx.save('compressed-texture.png');
console.log('panels: RGB8 | DXT1 | 8x the difference');
ctx.close();
