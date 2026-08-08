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
    SHADING_LANGUAGE_VERSION: 0x8B8C
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
                throw new Error('no DRM render nodes (/dev/dri/renderD*) available');
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
