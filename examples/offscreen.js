'use strict';

// Shared scaffolding for the examples: a GPU context rendering into an
// off-screen surface, and a way to look at the result.
//
// There is no X server here and no DRI3 — the surface's frames never leave
// the process. That is deliberate: it keeps each example about the GL
// feature it is demonstrating. For the full pipeline (render -> dma-buf ->
// PixmapFromBuffer -> Present) see examples/dri3 in the node-x11 repo.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dri = require('..');

// ---- PNG output, so a frame can be opened and looked at -------------------

let crcTable = null;
function crc32(buf) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++)
        c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, tail]);
}

// RGBA rows, top-down.
function writePng(file, width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter type: none
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
            .copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = 6; // truecolour with alpha
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]));
}

// ---- context ---------------------------------------------------------------

// Returns { gpu, surface, gl, save, close }. `save(name)` reads the frame
// back and writes it next to the example as a PNG.
function offscreen(width, height, opts) {
    if (dri.listRenderNodes().length === 0) {
        console.error('no /dev/dri/renderD* on this machine — nothing to render with');
        process.exit(1);
    }
    const gpu = new dri.Gpu(Object.assign({ format: dri.FORMAT.ARGB8888 }, opts));
    const surface = gpu.createSurface(width, height);
    gpu.makeCurrent(surface);
    const gl = gpu.gl;
    gl.viewport(0, 0, width, height);
    return {
        gpu,
        surface,
        gl,
        save(name) {
            const px = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
            // GL's origin is bottom-left, PNG's is top-left
            const flipped = new Uint8Array(px.length);
            const stride = width * 4;
            for (let y = 0; y < height; y++)
                flipped.set(px.subarray(y * stride, y * stride + stride),
                    (height - 1 - y) * stride);
            const file = path.join(__dirname, name);
            writePng(file, width, height, flipped);
            console.log(`wrote ${file}`);
            return file;
        },
        close() {
            surface.destroy();
            gpu.destroy();
        }
    };
}

// A linked program, or an exit with the log that says why not.
function program(gl, vsSrc, fsSrc) {
    const compile = (type, src, what) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error(`${what} failed to compile:\n${gl.getShaderInfoLog(s)}`);
            process.exit(1);
        }
        return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc, 'vertex shader'));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc, 'fragment shader'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error(`link failed:\n${gl.getProgramInfoLog(p)}`);
        process.exit(1);
    }
    return p;
}

// The unit quad every example draws, as a TRIANGLE_STRIP.
function quad(gl, p, attrib) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, attrib || 'position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return buf;
}

module.exports = { offscreen, program, quad, writePng };
