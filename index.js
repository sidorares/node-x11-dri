'use strict';

// x11-dri: optional native companion to the pure-JS `x11` package.
//
// Gives a Node script the two things the X protocol alone cannot:
//   - a real GPU OpenGL ES 2.0 context (GBM + EGL, dlopen'd at runtime)
//     whose frames are exportable as dma-buf fds, and
//   - dma-buf utilities (udmabuf CPU buffers, DMA_BUF sync, dup).
//
// The fds go to the X server through the x11 package's DRI3 extension
// (X.require('dri3') -> PixmapFromBuffer) and on screen with Present.
// See https://github.com/sidorares/node-x11/blob/master/examples/dri3/cube.js
// for the complete picture.

const fs = require('fs');
const path = require('path');

// A local build wins (dev iteration), then the prebuilt binary bundled in
// the npm tarball for this platform/arch (see scripts/install.js — the
// package works even when install scripts are disabled), then a clear error.
function loadNative() {
    const candidates = [
        'build/Release/x11dri.node',
        'build/Debug/x11dri.node',
        `prebuilds/${process.platform}-${process.arch}/x11dri.node`
    ];
    const errors = [];
    for (const rel of candidates) {
        const abs = path.join(__dirname, rel);
        if (!fs.existsSync(abs))
            continue;
        try {
            return require(abs);
        } catch (e) {
            errors.push(`  ${rel}: ${e.message}`);
        }
    }
    throw new Error(
        `x11-dri: no loadable native binary for ${process.platform}-${process.arch}\n` +
        (errors.length ? `tried:\n${errors.join('\n')}\n` : '') +
        'rebuild with: npm rebuild x11-dri --build-from-source (needs a C toolchain)');
}

const native = loadNative();

// ---- OpenGL ES 2.0 constants (the subset the bindings cover) ----
const GL = {
    DEPTH_BUFFER_BIT: 0x0100,
    COLOR_BUFFER_BIT: 0x4000,
    POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3,
    TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, BLEND: 0x0BE2,
    SCISSOR_TEST: 0x0C11, DITHER: 0x0BD0,
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203,
    GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
    FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
    CW: 0x0900, CCW: 0x0901,
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
    INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
    RGBA: 0x1908, RGB: 0x1907, ALPHA: 0x1906,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
    STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
    FRAGMENT_SHADER: 0x8B30, VERTEX_SHADER: 0x8B31,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, INFO_LOG_LENGTH: 0x8B84,
    UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0D05,
    NO_ERROR: 0,
    VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02,
    SHADING_LANGUAGE_VERSION: 0x8B8C,

    // errors, so a getError() result can be named rather than printed in hex
    INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502,
    OUT_OF_MEMORY: 0x0505, INVALID_FRAMEBUFFER_OPERATION: 0x0506,

    // textures
    TEXTURE_2D: 0x0DE1, TEXTURE: 0x1702,
    TEXTURE_CUBE_MAP: 0x8513,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
    TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517, TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
    TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
    TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, TEXTURE2: 0x84C2, TEXTURE3: 0x84C3,
    TEXTURE4: 0x84C4, TEXTURE5: 0x84C5, TEXTURE6: 0x84C6, TEXTURE7: 0x84C7,
    ACTIVE_TEXTURE: 0x84E0,
    TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600, LINEAR: 0x2601,
    NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
    NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
    REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
    LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A,
    UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034,
    UNSIGNED_SHORT_5_6_5: 0x8363,
    MAX_TEXTURE_SIZE: 0x0D33, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,

    // blending
    ZERO: 0, ONE: 1,
    SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301,
    SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
    DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307,
    SRC_ALPHA_SATURATE: 0x0308,
    CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002,
    CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004,
    BLEND_COLOR: 0x8005,
    FUNC_ADD: 0x8006, FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,

    // stencil
    STENCIL_BUFFER_BIT: 0x0400, STENCIL_TEST: 0x0B90,
    KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03,
    INVERT: 0x150A, INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,

    // framebuffer and renderbuffer objects
    FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41,
    COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
    STENCIL_ATTACHMENT: 0x8D20, DEPTH_STENCIL_ATTACHMENT: 0x821A,
    FRAMEBUFFER_COMPLETE: 0x8CD5,
    FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
    FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
    FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9,
    FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
    DEPTH_COMPONENT16: 0x81A5, STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9,
    RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62,
    MAX_RENDERBUFFER_SIZE: 0x84E8,

    // state a draw loop reads back
    VIEWPORT: 0x0BA2, SCISSOR_BOX: 0x0C10,
    COLOR_CLEAR_VALUE: 0x0C22, COLOR_WRITEMASK: 0x0C23,
    DEPTH_CLEAR_VALUE: 0x0B73, DEPTH_WRITEMASK: 0x0B72,
    LINE_WIDTH: 0x0B21,
    POLYGON_OFFSET_FILL: 0x8037,
    POLYGON_OFFSET_FACTOR: 0x8038, POLYGON_OFFSET_UNITS: 0x2A00,
    SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0,
    MAX_VERTEX_ATTRIBS: 0x8869, MAX_VARYING_VECTORS: 0x8DFC,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
    VALIDATE_STATUS: 0x8B83, DELETE_STATUS: 0x8B80, SHADER_TYPE: 0x8B4F
};

// WebGL-flavored view over the flat native functions ("gl.clearColor" etc).
const gl = {};
for (const k of Object.keys(native)) {
    if (k.startsWith('gl')) {
        const name = k[2].toLowerCase() + k.slice(3);
        gl[name] = native[k];
    }
}
Object.assign(gl, GL);

// ---- buffer layout constants ----
const FORMAT = {
    XRGB8888: 0x34325258, // fourcc('X','R','2','4') — depth 24, bpp 32
    ARGB8888: 0x34325241  // fourcc('A','R','2','4') — depth 32, bpp 32
};

const GBM_USE = {
    SCANOUT: 1 << 0,
    RENDERING: 1 << 2,
    LINEAR: 1 << 4
};

const MODIFIER = {
    LINEAR: 0n,
    INVALID: (1n << 56n) - 1n
};

const DMABUF_SYNC = {
    READ: 1, WRITE: 2, RW: 3,
    START: 0, END: 1 << 2
};

// The GPU/dma-buf half of this package is Linux-only, and not for want of a
// port: it produces dma-buf descriptors for DRI3, and neither the buffer type
// nor the extension that consumes it exists elsewhere. On macOS the X server
// (XQuartz) offers Present but no DRI3 — see the README. Everything else in
// here (dup, probe) is portable, so `require('x11-dri')` stays safe to do
// from cross-platform code.
const DMABUF_PLATFORM = process.platform === 'linux';

// Render nodes need no authentication and no window system — the standard
// substitute for DRI3's Open request (whose fd-carrying reply a pure-JS
// client cannot receive; see x11's lib/ext/dri3.js).
function listRenderNodes() {
    let entries;
    try {
        entries = fs.readdirSync('/dev/dri');
    } catch {
        return [];
    }
    return entries.filter(e => e.startsWith('renderD'))
        .sort()
        .map(e => `/dev/dri/${e}`);
}

class Surface {
    constructor(gpu, handle, width, height) {
        this._gpu = gpu;
        this._handle = handle;
        this.width = width;
        this.height = height;
    }
    // Finish the frame; returns { key, isNew, width, height, fd?, stride?,
    // offset?, modifier? }. The buffer stays owned by the caller until
    // release(key) — release it when Present says IdleNotify.
    //
    // Returns null when every buffer of the surface is still unreleased (the
    // GPU has nothing to render the next frame into): wait for a release,
    // redraw, and swap again — that is the natural pacing signal when
    // presenting faster than the server retires buffers.
    swap() {
        return native.swapBuffers(this._gpu._handle, this._handle);
    }
    release(key) {
        native.releaseBuffer(this._handle, key);
    }
    destroy() {
        native.destroySurface(this._handle);
    }
}

class Gpu {
    // opts: { devicePath?, fd?, format?, depthSize? }
    constructor(opts) {
        opts = opts || {};
        this.devicePath = null;
        if (opts.fd != null) {
            this._fd = opts.fd;
            this._ownFd = false;
        } else {
            const nodes = opts.devicePath ? [opts.devicePath] : listRenderNodes();
            if (nodes.length === 0)
                throw new Error(DMABUF_PLATFORM
                    ? 'no DRM render nodes (/dev/dri/renderD*) available'
                    : `GPU rendering needs Linux DRM render nodes, which ${process.platform} does not have` +
                      ' — and the DRI3 extension that would consume the exported buffers is not' +
                      ' implemented by this platform\'s X server either (see the x11-dri README)');
            let lastErr = null;
            this._fd = null;
            for (const path of nodes) {
                try {
                    this._fd = fs.openSync(path, 'r+');
                    this.devicePath = path;
                    break;
                } catch (e) {
                    lastErr = e;
                }
            }
            if (this._fd == null)
                throw lastErr;
            this._ownFd = true;
        }
        this.format = opts.format || FORMAT.XRGB8888;
        this._handle = native.createGpu(this._fd, this.format, opts.depthSize != null ? opts.depthSize : 16);
        Object.assign(this, native.gpuInfo(this._handle));
        this.gl = gl;
    }
    // useFlags: GBM_USE mask; RENDERING is implied. Pass GBM_USE.LINEAR when
    // the consuming device may not understand this GPU's tiled layouts.
    createSurface(width, height, useFlags) {
        const use = GBM_USE.RENDERING | (useFlags || 0);
        const handle = native.createSurface(this._handle, width, height, use);
        return new Surface(this, handle, width, height);
    }
    makeCurrent(surface) {
        native.makeCurrent(this._handle, surface ? surface._handle : null);
    }
    destroy() {
        native.destroyGpu(this._handle);
        if (this._ownFd) {
            try { fs.closeSync(this._fd); } catch { /* ignore */ }
        }
    }
}

// CPU-memory dma-buf (needs /dev/udmabuf). Returns { fd, memfd, size,
// buffer (ArrayBuffer view of the pixels), sync(flags), close() }.
// `fd` is the dma-buf: hand it to DRI3.PixmapFromBuffer (which consumes it);
// keep writing pixels through `buffer` and bracket writes with
// sync(START|WRITE) / sync(END|WRITE).
function createUdmabuf(size) {
    const res = native.udmabufCreate(size);
    return {
        fd: res.fd,
        memfd: res.memfd,
        size: res.size,
        buffer: res.buffer,
        sync(flags) { native.dmabufSync(res.fd, flags); },
        close() {
            try { fs.closeSync(res.memfd); } catch { /* ignore */ }
            // res.fd is normally consumed by sendFds; close here only if not
            try { fs.closeSync(res.fd); } catch { /* ignore */ }
        }
    };
}

module.exports = {
    probe: native.probe,
    dup: native.dup,
    listRenderNodes,
    Gpu,
    createUdmabuf,
    dmabufSync: native.dmabufSync,
    gl,
    GL,
    FORMAT,
    GBM_USE,
    MODIFIER,
    DMABUF_SYNC
};
