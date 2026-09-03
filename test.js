// Self-test for the native companion. No X server involved: exercises what
// the addon itself provides and skips whatever this machine lacks. Exits
// non-zero only when a capability that IS present malfunctions.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dri = require('./');

let failures = 0;
const report = (name, fn) => {
    try {
        const note = fn();
        console.log(`ok   ${name}${note ? ` (${note})` : ''}`);
    } catch (e) {
        if (e && e.skip) {
            console.log(`skip ${name} (${e.skip})`);
        } else {
            failures++;
            console.log(`FAIL ${name}: ${e.message}`);
        }
    }
};
const skip = why => { const e = new Error(why); e.skip = why; throw e; };

const caps = dri.probe();
console.log('probe:', caps);

// Every GL test needs the same preamble — a render node, a context on it, a
// surface to draw into — and every one of them should skip rather than fail
// on a machine with no GPU to offer.
const glSurface = (size, opts) => {
    for (const [name, cap] of [['gbm', caps.gbm], ['egl', caps.egl], ['gles', caps.gles]])
        if (cap !== true)
            skip(`${name}: ${cap}`);
    if (dri.listRenderNodes().length === 0)
        skip('no /dev/dri/renderD*');
    let gpu;
    try {
        gpu = new dri.Gpu(opts);
    } catch (e) {
        skip(`render node unusable: ${e.message}`);
    }
    const surf = gpu.createSurface(size, size);
    gpu.makeCurrent(surf);
    gpu.gl.viewport(0, 0, size, size);
    return { gpu, surf, gl: gpu.gl };
};

// A linked program, or an assertion carrying the log that explains why not.
const buildProgram = (gl, vsSrc, fsSrc) => {
    const compile = (type, src, what) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        assert.ok(gl.getShaderParameter(s, gl.COMPILE_STATUS),
            `${what}: ${gl.getShaderInfoLog(s)}`);
        return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc, 'vertex shader'));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc, 'fragment shader'));
    gl.linkProgram(p);
    assert.ok(gl.getProgramParameter(p, gl.LINK_STATUS), `link: ${gl.getProgramInfoLog(p)}`);
    return p;
};

report('dup', () => {
    const fd = fs.openSync('/dev/null', 'r');
    const d = dri.dup(fd);
    assert.notStrictEqual(d, fd);
    fs.closeSync(fd);
    fs.fstatSync(d); // still open
    fs.closeSync(d);
});

// index.d.ts is hand-written, and the addon it describes grows entry points,
// so something has to hold the two together. This reads the declarations as
// text and compares names against the objects actually exported — no GPU and
// no TypeScript needed, which makes it the one GL-surface check that runs on
// every machine. `npm run test:types` is the other half: this says the names
// match, that says the signatures compile.
report('index.d.ts covers the runtime surface', () => {
    const dts = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8');
    // members of one `export interface Name {` block, by their declaring line:
    // `readonly FOO: GLenum;` or `bar(...)`. Continuation lines of a wrapped
    // signature are indented further and so cannot match.
    const membersOf = name => {
        const block = new RegExp(`^export interface ${name}[^{]*\\{\\n([\\s\\S]*?)^\\}`, 'm').exec(dts);
        assert.ok(block, `index.d.ts declares interface ${name}`);
        return new Set([...block[1].matchAll(/^ {4}(?:readonly )?(\w+)\??\s*[:(]/gm)].map(m => m[1]));
    };
    // top-level declarations only — matching anywhere in the file would let a
    // missing export pass because some interface happens to have a member of
    // the same name
    const exported = new Set([...dts.matchAll(
        /^export (?:declare )?(?:const|function|class|interface|type) (\w+)/gm)].map(m => m[1]));
    for (const name of Object.keys(dri))
        assert.ok(exported.has(name), `index.d.ts declares the ${name} export`);

    // the two halves of `gl`: constants and entry points
    const constants = membersOf('GLConstants');
    const methods = membersOf('GLContext');
    const both = new Set([...constants, ...methods]);

    for (const name of Object.keys(dri.GL))
        assert.ok(constants.has(name), `index.d.ts declares GL.${name}`);
    for (const name of Object.keys(dri.gl))
        assert.ok(both.has(name), `index.d.ts declares gl.${name}`);

    // and nothing declared has gone away — a typo here would otherwise be a
    // method consumers can call and the addon does not have
    for (const name of both)
        assert.ok(name in dri.gl, `gl.${name} is declared but does not exist`);
    for (const name of constants)
        assert.ok(name in dri.GL, `GL.${name} is declared but does not exist`);

    // the small constant objects, checked the same way
    for (const [group, values] of [['FORMAT', dri.FORMAT], ['GBM_USE', dri.GBM_USE],
        ['MODIFIER', dri.MODIFIER], ['DMABUF_SYNC', dri.DMABUF_SYNC]]) {
        const block = new RegExp(`export declare const ${group}: \\{\\n([\\s\\S]*?)^\\};`, 'm').exec(dts);
        assert.ok(block, `index.d.ts declares ${group}`);
        const names = new Set([...block[1].matchAll(/^ {4}readonly (\w+):/gm)].map(m => m[1]));
        assert.deepStrictEqual([...names].sort(), Object.keys(values).sort(),
            `${group} matches its declaration`);
    }

    return `${constants.size} constants, ${methods.size} entry points`;
});

// The degradation contract on hosts with no dma-buf ABI (macOS and friends):
// the entry points exist and throw something that explains itself, rather
// than being absent or crashing. Loading the addon at all is half the test.
report('non-dma-buf platform degrades cleanly', () => {
    if (caps.dmabuf !== false)
        skip('this host has dma-buf');
    assert.strictEqual(dri.listRenderNodes().length, 0, 'no render nodes off Linux');
    assert.throws(() => dri.createUdmabuf(4096), /dma-buf/, 'udmabufCreate explains itself');
    assert.throws(() => dri.dmabufSync(0, 0), /dma-buf/, 'dmabufSync explains itself');
    assert.throws(() => dri.mapDmabuf(0, 4096), /dma-buf/, 'mapDmabuf explains itself');
    assert.throws(() => new dri.Gpu({}), /DRI3|DRM/, 'Gpu explains itself');
    return `${caps.platform}: gbm/dma-buf reported unavailable`;
});

// The Apple-DRI/CGL backend, as far as it goes with no X server: everything
// except the surface attach — WindowServer handshake, a core-profile context,
// the ES2-shader shim, the default VAO, and an FBO round trip. The attach
// itself needs an XQuartz window to exist (examples/xquartz/cube.js is that
// test). Skips where the WindowServer is unreachable (SSH, CI without a GUI
// session) rather than failing.
report('Apple-DRI context: ES2 shaders + FBO on CGL', () => {
    if (caps.appledri !== true)
        skip(typeof caps.appledri === 'string' ? caps.appledri : 'appledri unavailable');
    try {
        dri.apple.clientId();
    } catch (e) {
        skip(`WindowServer unreachable: ${e.message}`);
    }
    const ctx = new dri.apple.Context({ depthSize: 0 });
    try {
        ctx.makeCurrent();
        const gl = dri.gl;
        assert.ok(ctx.glVersion.major >= 3, `core profile expected, got ${ctx.glVersion.string}`);
        assert.strictEqual(ctx.features.vertexArrayObject, true, 'VAO feature on 4.1');

        const SIZE = 32;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        assert.strictEqual(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
        gl.viewport(0, 0, SIZE, SIZE);

        // WebGL-1 spelling, no #version line — the shim must make the core
        // profile accept it
        const prog = buildProgram(gl, `
            attribute vec2 aPos;
            void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
        `, `
            precision mediump float;
            void main() { gl_FragColor = vec4(1.0, 0.5, 0.0, 1.0); }
        `);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.useProgram(prog);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(aPos);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        assert.strictEqual(gl.getError(), gl.NO_ERROR);

        const px = new Uint8Array(4);
        gl.readPixels(SIZE >> 1, SIZE >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        assert.ok(px[0] === 255 && px[1] >= 120 && px[1] <= 135 && px[2] === 0,
            `fullscreen-triangle pixel: got [${px.join(', ')}]`);

        const exts = gl.getSupportedExtensions();
        assert.ok(Array.isArray(exts) && exts.length > 0, 'extension list on a core profile');
        return `${gl.getString(gl.RENDERER)}, GL ${ctx.glVersion.major}.${ctx.glVersion.minor}`;
    } finally {
        ctx.destroy();
    }
});

// The IOSurface render target — the Cocoa-backend presentation path, tested
// end to end without any compositor: draw into the target, read the pixels
// back off its framebuffer, and check the surface got a process-global id
// the presentation side could look up.
report('Apple IOSurface target: draw, read back, global id', () => {
    if (caps.appledri !== true)
        skip(typeof caps.appledri === 'string' ? caps.appledri : 'appledri unavailable');
    try {
        dri.apple.clientId();
    } catch (e) {
        skip(`WindowServer unreachable: ${e.message}`);
    }
    const ctx = new dri.apple.Context({ depthSize: 16 });
    try {
        const target = ctx.createTarget(24, 16);
        const sid = target.iosurfaceId;
        try {
            assert.ok(target.iosurfaceId > 0, 'IOSurfaceID is global and nonzero');
            assert.strictEqual(target.width, 24);
            assert.strictEqual(target.height, 16);
            const gl = dri.gl;
            target.bind();
            gl.viewport(0, 0, 24, 16);
            gl.clearColor(0.0, 1.0, 0.25, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.flush();
            const px = new Uint8Array(4);
            gl.readPixels(12, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            assert.ok(px[0] === 0 && px[1] === 255 && px[2] >= 60 && px[2] <= 68,
                `clear colour through the IOSurface FBO: got [${px.join(', ')}]`);
            // a second target coexists — the swapchain shape
            const back = ctx.createTarget(24, 16);
            assert.notStrictEqual(back.iosurfaceId, target.iosurfaceId);
            back.destroy();
            ctx.bindTarget(null);
        } finally {
            target.destroy();
        }
        return `IOSurfaceID 0x${sid.toString(16)}`;
    } finally {
        ctx.destroy();
    }
});

// Unlike everything else in the apple namespace this needs no XQuartz and no
// WindowServer handshake — only the system frameworks — so it is gated on
// the platform alone. Null is a legal answer (a headless session has no rate
// to report), a number outside any plausible panel's range is not.
report('apple.refreshRate answers in Hz or null', () => {
    if (caps.platform !== 'darwin')
        skip('needs macOS');
    const hz = dri.apple.refreshRate();
    if (hz === null)
        return 'null (no display would state a rate — headless session?)';
    assert.strictEqual(typeof hz, 'number');
    assert.ok(hz >= 24 && hz <= 500, `a plausible display rate, got ${hz}`);
    return `${hz} Hz`;
});

report('apple path degrades cleanly off macOS', () => {
    if (caps.platform === 'darwin')
        skip('this host is macOS');
    assert.throws(() => dri.apple.clientId(), /macOS|XQuartz/, 'clientId explains itself');
    assert.throws(() => dri.apple.refreshRate(), /macOS|XQuartz/, 'refreshRate explains itself');
    assert.throws(() => new dri.apple.Context(), /macOS|XQuartz/, 'Context explains itself');
    return `${caps.platform}: appledri reported unavailable`;
});

report('udmabuf create/write/sync', () => {
    if (caps.udmabuf !== true)
        skip(typeof caps.udmabuf === 'string' ? caps.udmabuf : '/dev/udmabuf not accessible');
    const ud = dri.createUdmabuf(4096);
    const px = new Uint32Array(ud.buffer);
    ud.sync(dri.DMABUF_SYNC.START | dri.DMABUF_SYNC.WRITE);
    px[0] = 0x11223344;
    px[px.length - 1] = 0x55667788;
    ud.sync(dri.DMABUF_SYNC.END | dri.DMABUF_SYNC.WRITE);
    assert.strictEqual(px[0], 0x11223344);
    assert.ok(fs.fstatSync(ud.fd).size >= 4096, 'dma-buf reports its size');
    ud.close();
});

report('GPU render + readback + dma-buf export', () => {
    for (const [name, cap] of [['gbm', caps.gbm], ['egl', caps.egl], ['gles', caps.gles]])
        if (cap !== true)
            skip(`${name}: ${cap}`);
    if (dri.listRenderNodes().length === 0)
        skip('no /dev/dri/renderD*');
    let gpu;
    try {
        gpu = new dri.Gpu({});
    } catch (e) {
        skip(`render node unusable: ${e.message}`);
    }
    const surf = gpu.createSurface(64, 64);
    gpu.makeCurrent(surf);
    const gl = gpu.gl;
    gl.viewport(0, 0, 64, 64);
    gl.clearColor(0.2, 0.4, 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    assert.deepStrictEqual(Array.from(px), [51, 102, 153, 255]);
    const renderer = gl.getString(gl.RENDERER);
    const out = surf.swap();
    assert.strictEqual(out.isNew, true);
    assert.ok(out.fd >= 0, 'exports a dma-buf fd');
    assert.ok(out.stride >= 64 * 4, 'stride covers the row');
    assert.strictEqual(typeof out.modifier, 'bigint');
    fs.closeSync(out.fd); // normally consumed by the X send
    surf.release(out.key);
    surf.destroy();
    gpu.destroy();
    return renderer;
});

// Every argument check happens in JavaScript, before the addon is asked for
// anything — so this is the one part of the import path that can be tested on
// a machine with no GPU (and it proves a bad call touches no descriptor).
report('importDmabuf argument checking', () => {
    const base = {
        width: 4, height: 4, fourcc: dri.FORMAT.XRGB8888,
        planes: [{ fd: 0, stride: 16, offset: 0 }]
    };
    assert.throws(() => dri.gl.importDmabuf({ ...base, planes: [] }), /planes/);
    assert.throws(() => dri.gl.importDmabuf({ ...base, planes: undefined }), /planes/);
    assert.throws(() => dri.gl.importDmabuf({ ...base, planes: [{ stride: 16 }] }), /plane 0/);
    assert.throws(() => dri.gl.importDmabuf({ ...base, fourcc: undefined }), /fourcc/);
    assert.throws(() => dri.gl.importDmabuf({ ...base, height: 0 }), /width and height/);
    assert.throws(() => dri.gl.importDmabuf({ ...base, modifier: 0 }), /BigInt/);
    fs.fstatSync(0); // nothing above got as far as consuming a descriptor
});

// The other direction of the dma-buf story: a descriptor this process did
// allocate, read back through the borrowed-fd path a foreign one would take.
report('mapDmabuf reads a dma-buf through a borrowed descriptor', () => {
    if (caps.udmabuf !== true)
        skip(typeof caps.udmabuf === 'string' ? caps.udmabuf : '/dev/udmabuf not accessible');
    const ud = dri.createUdmabuf(4096);
    try {
        ud.sync(dri.DMABUF_SYNC.START | dri.DMABUF_SYNC.WRITE);
        new Uint32Array(ud.buffer)[0] = 0xdeadbeef;
        ud.sync(dri.DMABUF_SYNC.END | dri.DMABUF_SYNC.WRITE);

        const m = dri.mapDmabuf(ud.fd); // size taken from the descriptor
        assert.ok(m.size >= 4096, `mapped ${m.size} bytes`);
        m.sync(dri.DMABUF_SYNC.START | dri.DMABUF_SYNC.READ);
        assert.strictEqual(new Uint32Array(m.buffer)[0], 0xdeadbeef,
            'the mapping sees the same memory');
        m.sync(dri.DMABUF_SYNC.END | dri.DMABUF_SYNC.READ);

        const view = new Uint8Array(m.buffer);
        m.close();
        assert.strictEqual(view.byteLength, 0, 'close() detaches views over the mapping');
        m.close(); // idempotent
        fs.fstatSync(ud.fd); // borrowed, not consumed
        return `${m.size} bytes`;
    } finally {
        ud.close();
    }
});

// The round trip, which is the whole point: render a frame, export it as a
// dma-buf (what DRI3 PixmapFromBuffer would be handed), then import that same
// descriptor back as a texture and sample it. If the pixels survive the trip
// the import is real — no copy happened anywhere along it.
report('dma-buf import: export a frame, import it back and sample it', () => {
    const W = 64;
    const { gpu, surf, gl } = glSurface(W, {});
    try {
        if (!gpu.features.dmabufImport)
            skip('driver has no EGL_EXT_image_dma_buf_import');

        gl.clearColor(0.2, 0.4, 0.6, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const out = surf.swap();
        assert.ok(out && out.isNew, 'the first swap of a surface exports a descriptor');

        // A modifier is only legal to pass where the second extension is
        // there to understand it; INVALID means "implicit" either way.
        const withModifier = gpu.features.dmabufImportModifiers &&
            out.modifier !== dri.MODIFIER.INVALID;
        const image = gl.importDmabuf({
            width: W,
            height: W,
            fourcc: gpu.format,
            modifier: withModifier ? out.modifier : undefined,
            planes: [{ fd: out.fd, stride: out.stride, offset: out.offset }]
        });
        try {
            assert.strictEqual(image.target, gl.TEXTURE_2D,
                'one RGB plane imports onto TEXTURE_2D');
            assert.ok(image.texture > 0, 'a texture name came back');
            assert.throws(() => fs.fstatSync(out.fd), /EBADF/,
                'the descriptor was consumed by the import');

            // Sample it into an FBO — the surface's own back buffer belongs
            // to the swapchain now, and this keeps the check independent of it.
            const dest = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, dest);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, W, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, dest, 0);
            assert.strictEqual(gl.checkFramebufferStatus(gl.FRAMEBUFFER),
                gl.FRAMEBUFFER_COMPLETE);

            const prog = buildProgram(gl,
                'attribute vec2 position;\nvarying vec2 vUv;\n' +
                'void main() { vUv = position * 0.5 + 0.5;' +
                ' gl_Position = vec4(position, 0.0, 1.0); }',
                'precision mediump float;\nuniform sampler2D uMap;\nvarying vec2 vUv;\n' +
                'void main() { gl_FragColor = texture2D(uMap, vUv); }');
            const quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            gl.useProgram(prog);
            const loc = gl.getAttribLocation(prog, 'position');
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(image.target, image.texture);
            gl.uniform1i(gl.getUniformLocation(prog, 'uMap'), 0);
            gl.viewport(0, 0, W, W);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            assert.strictEqual(gl.getError(), gl.NO_ERROR, 'sampling the imported texture');

            const px = new Uint8Array(4);
            gl.readPixels(W >> 1, W >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            assert.ok(Math.abs(px[0] - 51) <= 2 && Math.abs(px[1] - 102) <= 2 &&
                Math.abs(px[2] - 153) <= 2,
                `the exported frame came back through the import: [${px.join(', ')}]`);

            gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(dest);
        } finally {
            image.destroy();
            image.destroy(); // idempotent
        }
        surf.release(out.key);
        return `${gpu.format.toString(16)}${withModifier ? ' with modifier' : ' implicit modifier'}`;
    } finally {
        surf.destroy();
        gpu.destroy();
    }
});

// Everything the ES 2.0 binding covers beyond "clear it and read it back":
// textures, blending, render-to-texture and the uniform setters. Pixels are
// the oracle throughout — a wrapper that passes its arguments in the wrong
// order still compiles and still runs, and only the result says otherwise.
report('GL ES 2.0 surface: textures, blending, FBO, uniforms', () => {
    const W = 64;
    const { gpu, surf, gl } = glSurface(W, { format: dri.FORMAT.ARGB8888, depthSize: 24 });

    const glOk = what => {
        const e = gl.getError();
        assert.strictEqual(e, gl.NO_ERROR, `${what}: GL error 0x${e.toString(16)}`);
    };
    const build = (vsSrc, fsSrc) => buildProgram(gl, vsSrc, fsSrc);
    const pixels = new Uint8Array(W * W * 4);
    const read = () => gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const at = (x, y) => {
        const o = (y * W + x) * 4;
        return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
    };
    const near = (got, want, tol) => got.every((c, i) => Math.abs(c - want[i]) <= (tol || 4));

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const bindQuad = p => {
        const loc = gl.getAttribLocation(p, 'position');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        return loc;
    };

    // getParameter answers in the type the parameter actually has
    assert.deepStrictEqual(gl.getParameter(gl.VIEWPORT), [0, 0, W, W], 'VIEWPORT is four ints');
    assert.strictEqual(typeof gl.getParameter(gl.DEPTH_TEST), 'boolean');
    assert.strictEqual(typeof gl.getParameter(gl.LINE_WIDTH), 'number');
    assert.deepStrictEqual(gl.getParameter(gl.COLOR_WRITEMASK), [true, true, true, true]);
    glOk('getParameter');

    // a 2x2 texture sampled with NEAREST, so each texel owns a quadrant.
    // readPixels is bottom-up, so row 0 of the upload is the bottom row here.
    const texVs = 'attribute vec2 position;\nvarying vec2 vUv;\n' +
        'void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }';
    const texFs = 'precision mediump float;\nuniform sampler2D uMap;\nvarying vec2 vUv;\n' +
        'void main() { gl_FragColor = texture2D(uMap, vUv); }';
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glOk('texImage2D');
    const texProgram = build(texVs, texFs);
    gl.useProgram(texProgram);
    bindQuad(texProgram);
    gl.uniform1i(gl.getUniformLocation(texProgram, 'uMap'), 0);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(10, 10), [255, 0, 0, 255]), `texel 0,0: ${at(10, 10)}`);
    assert.ok(near(at(54, 10), [0, 255, 0, 255]), `texel 1,0: ${at(54, 10)}`);
    assert.ok(near(at(10, 54), [0, 0, 255, 255]), `texel 0,1: ${at(10, 54)}`);
    assert.ok(near(at(54, 54), [255, 255, 255, 255]), `texel 1,1: ${at(54, 54)}`);

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 0, 255]));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(10, 10), [255, 255, 0, 255]), `after texSubImage2D: ${at(10, 10)}`);
    glOk('texSubImage2D');

    const flat = build(
        'attribute vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }',
        'precision mediump float;\nuniform vec4 uColor;\nvoid main() { gl_FragColor = uColor; }');
    gl.useProgram(flat);
    const flatPos = bindQuad(flat);
    const uColor = gl.getUniformLocation(flat, 'uColor');

    // half-opaque white over black. Alpha blends by the same factors, so it
    // lands at 0.5*0.5 + 0.5*1 = 0.75 while the colour channels land at 0.5.
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4fv(uColor, new Float32Array([1, 1, 1, 0.5]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [128, 128, 128, 191], 6), `blended: ${at(32, 32)}`);
    gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);
    gl.blendColor(0.25, 0.25, 0.25, 1);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    glOk('blending');

    // scissor confines where a draw lands; colorMask confines which channels move
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 32, 32);
    gl.uniform4fv(uColor, new Float32Array([0, 1, 0, 1]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
    read();
    assert.ok(near(at(10, 10), [0, 255, 0, 255]), `inside the scissor: ${at(10, 10)}`);
    assert.ok(near(at(50, 50), [0, 0, 0, 255]), `outside it: ${at(50, 50)}`);
    assert.deepStrictEqual(gl.getParameter(gl.SCISSOR_BOX), [0, 0, 32, 32]);
    gl.colorMask(true, false, false, true);
    gl.uniform4fv(uColor, new Float32Array([1, 1, 1, 1]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.colorMask(true, true, true, true);
    read();
    assert.strictEqual(at(50, 50)[0], 255, 'red was written');
    assert.strictEqual(at(50, 50)[1], 0, 'green was masked off');
    glOk('scissor and colorMask');

    gl.depthMask(false);
    assert.strictEqual(gl.getParameter(gl.DEPTH_WRITEMASK), false);
    gl.depthMask(true);
    gl.depthRange(0, 1);
    gl.polygonOffset(1, 1);
    glOk('depth state');

    // render into a texture through an FBO, then sample that texture back
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 32, 32);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    assert.strictEqual(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE,
        'the framebuffer is complete');
    gl.viewport(0, 0, 32, 32);
    gl.useProgram(flat);
    gl.uniform4fv(uColor, new Float32Array([1, 0, 1, 1]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const off = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, off);
    assert.ok(near([off[0], off[1], off[2], off[3]], [255, 0, 255, 255]), 'drew into the texture');
    gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
    gl.viewport(0, 0, W, W);
    gl.useProgram(texProgram);
    bindQuad(texProgram);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [255, 0, 255, 255]), `sampled the render target: ${at(32, 32)}`);
    gl.deleteFramebuffer(fbo);
    gl.deleteRenderbuffer(rb);
    gl.deleteTexture(target);
    glOk('render to texture');

    // each uniform setter contributes one term, and six of them make full red
    const sum = build(
        'attribute vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }',
        'precision mediump float;\n' +
        'uniform vec2 uV2;\nuniform vec3 uV3[2];\nuniform mat3 uM3;\nuniform mat2 uM2;\n' +
        'uniform ivec2 uI2;\nuniform float uF[2];\n' +
        'void main() {\n' +
        '  float s = uV2.x + uV3[1].y + uM3[2][2] + uM2[1][1] + float(uI2.y) + uF[1];\n' +
        '  gl_FragColor = vec4(s / 6.0, 0.0, 0.0, 1.0);\n}');
    gl.useProgram(sum);
    bindQuad(sum);
    gl.uniform2f(gl.getUniformLocation(sum, 'uV2'), 1, 0);
    gl.uniform3fv(gl.getUniformLocation(sum, 'uV3[0]'), new Float32Array([0, 0, 0, 0, 1, 0]));
    gl.uniformMatrix3fv(gl.getUniformLocation(sum, 'uM3'), false,
        new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    gl.uniformMatrix2fv(gl.getUniformLocation(sum, 'uM2'), false, new Float32Array([1, 0, 0, 1]));
    gl.uniform2i(gl.getUniformLocation(sum, 'uI2'), 0, 1);
    gl.uniform1fv(gl.getUniformLocation(sum, 'uF[0]'), new Float32Array([0, 1]));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [255, 0, 0, 255], 3), `uniform sum: ${at(32, 32)}`);
    glOk('uniform setters');

    // a disabled attribute array takes the constant value instead, and
    // bufferSubData rewrites geometry without reallocating
    gl.useProgram(flat);
    gl.disableVertexAttribArray(flatPos);
    gl.vertexAttrib4f(flatPos, 0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4fv(uColor, new Float32Array([0, 0, 1, 1]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [0, 0, 0, 255]), `a degenerate quad drew nothing: ${at(32, 32)}`);
    gl.enableVertexAttribArray(flatPos);
    gl.vertexAttribPointer(flatPos, 2, gl.FLOAT, false, 0, 0);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0,
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [0, 0, 255, 255]), `inside the smaller quad: ${at(32, 32)}`);
    assert.ok(near(at(2, 2), [0, 0, 0, 255]), `outside it: ${at(2, 2)}`);
    glOk('attributes and bufferSubData');

    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.disable(gl.STENCIL_TEST);
    glOk('stencil state');

    // a wrong argument is a thrown Error naming what was wanted, not a
    // segfault somewhere inside the driver
    assert.throws(() => gl.uniformMatrix3fv(0, false, new Float32Array([1, 2])), /9\*n floats/);
    assert.throws(() => gl.uniform3fv(0, new Float32Array([1, 2])), /3\*n floats/);
    assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, 'nope'), /TypedArray or null/);
    assert.throws(() => gl.bufferSubData(gl.ARRAY_BUFFER, 0, {}), /TypedArray/);

    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    surf.destroy();
    gpu.destroy();
    return `max texture ${maxTexture}px`;
});

// Introspection asks GL to describe things this test already knows: a value
// just written through a uniform setter, a size just handed to bufferData, a
// pointer just described to vertexAttribPointer. An answer that disagrees is
// the wrapper marshalling something wrong.
report('GL introspection and compressed textures', () => {
    const W = 64;
    const { gpu, surf, gl } = glSurface(W, { format: dri.FORMAT.ARGB8888, depthSize: 24 });
    const glOk = what => {
        const e = gl.getError();
        assert.strictEqual(e, gl.NO_ERROR, `${what}: GL error 0x${e.toString(16)}`);
    };

    // one of every uniform shape getUniform has to know how to read back,
    // all of them referenced so the linker keeps them
    const vsSrc = 'attribute vec2 position;\nattribute vec3 aTint;\nvarying vec3 vTint;\n' +
        'void main() { vTint = aTint; gl_Position = vec4(position, 0.0, 1.0); }';
    const fsSrc = 'precision mediump float;\n' +
        'uniform vec4 uColor;\nuniform float uScale;\nuniform bool uOn;\n' +
        'uniform int uMode;\nuniform mat2 uM2;\nuniform vec2 uArr[3];\n' +
        'varying vec3 vTint;\n' +
        'void main() {\n' +
        '  vec2 m = uM2 * (uArr[0] + uArr[1] + uArr[2]);\n' +
        '  float s = uScale + float(uMode) + m.x + m.y + (uOn ? 1.0 : 0.0);\n' +
        '  gl_FragColor = vec4(uColor.rgb * vTint * s, uColor.a);\n}';
    const p = buildProgram(gl, vsSrc, fsSrc);
    gl.useProgram(p);

    // enumerate what the program declares
    const uniforms = {};
    const nUniforms = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nUniforms; i++) {
        const info = gl.getActiveUniform(p, i);
        uniforms[info.name] = info;
    }
    assert.ok(uniforms.uColor, `uColor is active: ${Object.keys(uniforms)}`);
    assert.strictEqual(uniforms.uColor.type, gl.FLOAT_VEC4);
    assert.strictEqual(uniforms.uColor.size, 1);
    assert.strictEqual(uniforms.uM2.type, gl.FLOAT_MAT2);
    assert.strictEqual(uniforms.uOn.type, gl.BOOL);
    assert.strictEqual(uniforms.uMode.type, gl.INT);
    // an array is reported once, under its zeroth element, with its length
    assert.ok(uniforms['uArr[0]'], `the array is named uArr[0]: ${Object.keys(uniforms)}`);
    assert.strictEqual(uniforms['uArr[0]'].size, 3);
    assert.strictEqual(gl.getActiveUniform(p, nUniforms), null, 'out of range is null');
    glOk('getActiveUniform');

    const attribs = {};
    const nAttribs = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < nAttribs; i++) {
        const info = gl.getActiveAttrib(p, i);
        attribs[info.name] = info;
    }
    assert.strictEqual(attribs.position.type, gl.FLOAT_VEC2);
    assert.strictEqual(attribs.aTint.type, gl.FLOAT_VEC3);
    assert.strictEqual(gl.getActiveAttrib(p, nAttribs), null);
    glOk('getActiveAttrib');

    // set through the setters, read back through getUniform, in the type the
    // uniform was declared with
    const loc = name => gl.getUniformLocation(p, name);
    gl.uniform4f(loc('uColor'), 0.25, 0.5, 0.75, 1);
    gl.uniform1f(loc('uScale'), 2.5);
    gl.uniform1i(loc('uOn'), 1);
    gl.uniform1i(loc('uMode'), 3);
    gl.uniformMatrix2fv(loc('uM2'), false, new Float32Array([1, 2, 3, 4]));
    gl.uniform2fv(loc('uArr[0]'), new Float32Array([1, 2, 3, 4, 5, 6]));
    assert.deepStrictEqual(Array.from(gl.getUniform(p, loc('uColor'))), [0.25, 0.5, 0.75, 1]);
    assert.strictEqual(gl.getUniform(p, loc('uScale')), 2.5);
    assert.strictEqual(gl.getUniform(p, loc('uOn')), true, 'a bool comes back as a boolean');
    assert.strictEqual(gl.getUniform(p, loc('uMode')), 3);
    assert.deepStrictEqual(Array.from(gl.getUniform(p, loc('uM2'))), [1, 2, 3, 4]);
    assert.deepStrictEqual(Array.from(gl.getUniform(p, loc('uArr[1]'))), [3, 4],
        'each array element reads back on its own location');
    assert.strictEqual(gl.getUniform(p, -1), null, 'a location of -1 has no value');
    glOk('getUniform');

    // the shaders behind the program, and the source GL kept for them
    const shaders = gl.getAttachedShaders(p);
    assert.strictEqual(shaders.length, 2, `two shaders attached: ${shaders}`);
    const sources = shaders.map(s => gl.getShaderSource(s));
    assert.ok(sources.includes(vsSrc), 'the vertex source round-trips');
    assert.ok(sources.includes(fsSrc), 'the fragment source round-trips');
    assert.ok(shaders.every(s => gl.isShader(s)));
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
    assert.ok(precision.rangeMin > 0 && precision.rangeMax > 0 && precision.precision > 0,
        `mediump float has a range: ${JSON.stringify(precision)}`);
    gl.validateProgram(p);
    assert.ok(gl.getProgramParameter(p, gl.VALIDATE_STATUS), 'the program validates');
    glOk('shader introspection');

    // is*: live names are live, and a number nobody handed out is not
    assert.strictEqual(gl.isProgram(p), true);
    assert.strictEqual(gl.isProgram(0), false);
    assert.strictEqual(gl.isShader(0xbeef), false);
    gl.enable(gl.DEPTH_TEST);
    assert.strictEqual(gl.isEnabled(gl.DEPTH_TEST), true);
    gl.disable(gl.DEPTH_TEST);
    assert.strictEqual(gl.isEnabled(gl.DEPTH_TEST), false);
    glOk('is*');

    // buffers: what bufferData was told, read back off the binding
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    assert.strictEqual(gl.isBuffer(buf), true);
    assert.strictEqual(gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE), quad.byteLength);
    assert.strictEqual(gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_USAGE), gl.STATIC_DRAW);
    assert.strictEqual(gl.getParameter(gl.ARRAY_BUFFER_BINDING), buf);
    glOk('getBufferParameter');

    // attributes: the pointer description comes back the way it went in
    const pos = gl.getAttribLocation(p, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 8);
    assert.strictEqual(gl.getVertexAttrib(pos, gl.VERTEX_ATTRIB_ARRAY_ENABLED), true);
    assert.strictEqual(gl.getVertexAttrib(pos, gl.VERTEX_ATTRIB_ARRAY_SIZE), 2);
    assert.strictEqual(gl.getVertexAttrib(pos, gl.VERTEX_ATTRIB_ARRAY_TYPE), gl.FLOAT);
    assert.strictEqual(gl.getVertexAttrib(pos, gl.VERTEX_ATTRIB_ARRAY_STRIDE), 16);
    assert.strictEqual(gl.getVertexAttrib(pos, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED), false);
    assert.strictEqual(gl.getVertexAttrib(pos, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING), buf);
    assert.strictEqual(gl.getVertexAttribOffset(pos, gl.VERTEX_ATTRIB_ARRAY_POINTER), 8);
    const generic = gl.getVertexAttrib(pos, gl.CURRENT_VERTEX_ATTRIB);
    assert.strictEqual(generic.length, 4, `the generic value is four floats: ${generic}`);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    glOk('getVertexAttrib');

    // textures and framebuffers describe their own attachments
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    assert.strictEqual(gl.isTexture(tex), true);
    assert.strictEqual(gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER), gl.NEAREST);
    assert.strictEqual(gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S), gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    assert.strictEqual(gl.isFramebuffer(fbo), true);
    assert.strictEqual(
        gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),
        tex, 'the attachment names the texture it was given');
    assert.strictEqual(
        gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE),
        gl.TEXTURE);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 16, 32);
    assert.strictEqual(gl.isRenderbuffer(rb), true);
    assert.strictEqual(gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH), 16);
    assert.strictEqual(gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT), 32);
    gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
    gl.deleteFramebuffer(fbo);
    gl.deleteRenderbuffer(rb);
    gl.deleteTexture(tex);
    glOk('framebuffer and renderbuffer queries');

    // the driver's format list is as long as it says it is
    const formats = gl.getParameter(gl.COMPRESSED_TEXTURE_FORMATS);
    assert.ok(Array.isArray(formats), 'COMPRESSED_TEXTURE_FORMATS is an array');
    assert.strictEqual(formats.length, gl.getParameter(gl.NUM_COMPRESSED_TEXTURE_FORMATS));
    const exts = gl.getSupportedExtensions();
    assert.ok(exts.length > 0 && exts.every(e => !/\s/.test(e)), 'the extension list splits');
    glOk('extension and format queries');

    assert.throws(() => gl.compressedTexImage2D(gl.TEXTURE_2D, 0, 0, 4, 4, 0, null),
        /TypedArray/, 'compressed uploads want their data');

    // A DXT1 block whose two endpoints are the same colour decodes to exactly
    // that colour, so the readback below is an equality check rather than a
    // tolerance one. Four solid blocks make an 8x8 texture with four
    // quadrants — and readPixels is bottom-up, so block row 0 is the bottom.
    let note = 'no DXT1 on this driver';
    if (exts.includes('GL_EXT_texture_compression_dxt1')) {
        const dxt1Solid = colors => {
            const out = new Uint8Array(colors.length * 8);
            colors.forEach(([r, g, b], i) => {
                const c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
                out[i * 8] = out[i * 8 + 2] = c & 0xff;       // color0 == color1,
                out[i * 8 + 1] = out[i * 8 + 3] = c >> 8;     // indices all zero
            });
            return out;
        };
        const red = [255, 0, 0], green = [0, 255, 0];
        const blue = [0, 0, 255], white = [255, 255, 255];
        const ctex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, ctex);
        gl.compressedTexImage2D(gl.TEXTURE_2D, 0, gl.COMPRESSED_RGB_S3TC_DXT1_EXT, 8, 8, 0,
            dxt1Solid([red, green, blue, white]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        glOk('compressedTexImage2D');

        const show = buildProgram(gl,
            'attribute vec2 position;\nvarying vec2 vUv;\n' +
            'void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }',
            'precision mediump float;\nuniform sampler2D uMap;\nvarying vec2 vUv;\n' +
            'void main() { gl_FragColor = texture2D(uMap, vUv); }');
        gl.useProgram(show);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        const sp = gl.getAttribLocation(show, 'position');
        gl.enableVertexAttribArray(sp);
        gl.vertexAttribPointer(sp, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(gl.getUniformLocation(show, 'uMap'), 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const px = new Uint8Array(W * W * 4);
        gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const at = (x, y) => {
            const o = (y * W + x) * 4;
            return [px[o], px[o + 1], px[o + 2]];
        };
        assert.deepStrictEqual(at(16, 16), red, `block 0: ${at(16, 16)}`);
        assert.deepStrictEqual(at(48, 16), green, `block 1: ${at(48, 16)}`);
        assert.deepStrictEqual(at(16, 48), blue, `block 2: ${at(16, 48)}`);
        assert.deepStrictEqual(at(48, 48), white, `block 3: ${at(48, 48)}`);

        // one block replaced in place
        gl.compressedTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, 4,
            gl.COMPRESSED_RGB_S3TC_DXT1_EXT, dxt1Solid([[255, 255, 0]]));
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
        assert.deepStrictEqual(at(16, 16), [255, 255, 0], `after subimage: ${at(16, 16)}`);
        assert.deepStrictEqual(at(48, 48), white, 'the other blocks are untouched');
        gl.deleteTexture(ctex);
        glOk('compressedTexSubImage2D');
        note = 'DXT1 blocks decoded exactly';
    }

    surf.destroy();
    gpu.destroy();
    return `${exts.length} extensions, ${note}`;
});

// The three optional features. Each may be absent — that is the whole point
// of resolving them separately — so each is checked against gpu.features
// first and noted as skipped rather than failing the run. What is NOT
// optional is the contract: when features says false the wrapper throws a
// message rather than jumping through a null pointer.
report('GL vertex arrays, instancing and multiple render targets', () => {
    const W = 64;
    const { gpu, surf, gl } = glSurface(W, { format: dri.FORMAT.ARGB8888, depthSize: 24 });
    const glOk = what => {
        const e = gl.getError();
        assert.strictEqual(e, gl.NO_ERROR, `${what}: GL error 0x${e.toString(16)}`);
    };
    const px = new Uint8Array(W * W * 4);
    const read = () => gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (x, y) => {
        const o = (y * W + x) * 4;
        return [px[o], px[o + 1], px[o + 2]];
    };
    const near = (got, want, tol) => got.every((c, i) => Math.abs(c - want[i]) <= (tol || 4));

    const features = gpu.features;
    assert.ok(features && typeof features.vertexArrayObject === 'boolean',
        `makeCurrent reports features: ${JSON.stringify(features)}`);
    // whatever is missing must say so, not crash
    if (!features.vertexArrayObject)
        assert.throws(() => gl.createVertexArray(), /not available/);
    if (!features.instancedArrays)
        assert.throws(() => gl.vertexAttribDivisor(0, 1), /not available/);
    if (!features.drawBuffers)
        assert.throws(() => gl.drawBuffers([gl.COLOR_ATTACHMENT0]), /not available/);

    const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);

    const done = [];

    // A vertex array object captures the attribute state set while it is
    // bound, so tearing that state down afterwards and rebinding the object
    // has to bring it back — which is what the second draw proves.
    if (features.vertexArrayObject) {
        const p = buildProgram(gl,
            'attribute vec2 position;\nvoid main() { gl_Position = vec4(position * 0.5, 0.0, 1.0); }',
            'precision mediump float;\nvoid main() { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }');
        gl.useProgram(p);
        const loc = gl.getAttribLocation(p, 'position');
        const vao = gl.createVertexArray();
        assert.strictEqual(gl.isVertexArray(vao), false, 'a name is not an object until bound');
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        assert.strictEqual(gl.isVertexArray(vao), true);
        assert.strictEqual(gl.getParameter(gl.VERTEX_ARRAY_BINDING), vao);
        gl.bindVertexArray(0);
        assert.strictEqual(gl.getParameter(gl.VERTEX_ARRAY_BINDING), 0);
        // dismantle the default vertex array's state, so a rebind is the only
        // thing that could make the draw work
        gl.disableVertexAttribArray(loc);
        gl.bindBuffer(gl.ARRAY_BUFFER, 0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        read();
        assert.ok(near(at(32, 32), [0, 255, 0]), `the object restored its state: ${at(32, 32)}`);
        assert.ok(near(at(4, 4), [0, 0, 0]), `and only where it should: ${at(4, 4)}`);
        gl.bindVertexArray(0);
        gl.deleteVertexArray(vao);
        assert.strictEqual(gl.isVertexArray(vao), false, 'deleted');
        glOk('vertex array objects');
        done.push('VAO');
    }

    // One draw call, four quads, differing only by attributes marked as
    // advancing per instance rather than per vertex.
    if (features.instancedArrays) {
        const p = buildProgram(gl,
            'attribute vec2 position;\nattribute vec2 aOffset;\nattribute vec3 aColor;\n' +
            'varying vec3 vColor;\n' +
            'void main() {\n' +
            '  vColor = aColor;\n' +
            '  gl_Position = vec4(position * 0.2 + aOffset, 0.0, 1.0);\n}',
            'precision mediump float;\nvarying vec3 vColor;\n' +
            'void main() { gl_FragColor = vec4(vColor, 1.0); }');
        gl.useProgram(p);
        const pos = gl.getAttribLocation(p, 'position');
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(pos, 0);

        const corners = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
        const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]];
        const perInstance = (data, name, size) => {
            const b = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, b);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.flat()), gl.STATIC_DRAW);
            const l = gl.getAttribLocation(p, name);
            gl.enableVertexAttribArray(l);
            gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(l, 1);
            assert.strictEqual(gl.getVertexAttrib(l, gl.VERTEX_ATTRIB_ARRAY_DIVISOR), 1);
            return l;
        };
        const offLoc = perInstance(corners, 'aOffset', 2);
        const colLoc = perInstance(colors, 'aColor', 3);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 4);
        read();
        // NDC (-0.5,-0.5) is a quarter across and a quarter up, and readPixels
        // is bottom-up, so instance 0 sits at (16,16)
        assert.ok(near(at(16, 16), colors[0].map(c => c * 255)), `instance 0: ${at(16, 16)}`);
        assert.ok(near(at(48, 16), colors[1].map(c => c * 255)), `instance 1: ${at(48, 16)}`);
        assert.ok(near(at(16, 48), colors[2].map(c => c * 255)), `instance 2: ${at(16, 48)}`);
        assert.ok(near(at(48, 48), colors[3].map(c => c * 255)), `instance 3: ${at(48, 48)}`);
        assert.ok(near(at(32, 32), [0, 0, 0]), `and nothing between them: ${at(32, 32)}`);

        // fewer instances than there are offsets: only the first two draw
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 2);
        read();
        assert.ok(near(at(16, 16), [255, 0, 0]), 'instance 0 still there');
        assert.ok(near(at(16, 48), [0, 0, 0]), 'instance 2 was not asked for');

        // indexed instancing draws the same thing through an index buffer
        const idx = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 2, 1, 3]),
            gl.STATIC_DRAW);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 4);
        read();
        assert.ok(near(at(48, 48), [255, 255, 0]), `indexed instance 3: ${at(48, 48)}`);
        glOk('instanced drawing');

        gl.vertexAttribDivisor(offLoc, 0);
        gl.vertexAttribDivisor(colLoc, 0);
        gl.disableVertexAttribArray(offLoc);
        gl.disableVertexAttribArray(colLoc);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, 0);
        done.push('instancing');
    }

    // Two colour attachments written by one fragment shader in one pass.
    // ES 2.0 has no glReadBuffer, so each attachment is read back through a
    // framebuffer that has only that texture on attachment 0.
    if (features.drawBuffers) {
        assert.ok(gl.getParameter(gl.MAX_DRAW_BUFFERS) >= 2,
            'a driver with drawBuffers has at least two of them');
        const S = 32;
        const targets = [0, 1].map(() => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            return t;
        });
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets[0], 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, targets[1], 0);
        assert.strictEqual(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

        const p = buildProgram(gl,
            'attribute vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }',
            '#extension GL_EXT_draw_buffers : require\n' +
            'precision mediump float;\n' +
            'void main() {\n' +
            '  gl_FragData[0] = vec4(1.0, 0.0, 0.0, 1.0);\n' +
            '  gl_FragData[1] = vec4(0.0, 0.0, 1.0, 1.0);\n}');
        gl.useProgram(p);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        const loc = gl.getAttribLocation(p, 'position');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.viewport(0, 0, S, S);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        glOk('drawBuffers');

        const one = gl.createFramebuffer();
        const readTarget = t => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, one);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
            const out = new Uint8Array(S * S * 4);
            gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, out);
            return [out[0], out[1], out[2]];
        };
        assert.ok(near(readTarget(targets[0]), [255, 0, 0]),
            `attachment 0 took gl_FragData[0]: ${readTarget(targets[0])}`);
        assert.ok(near(readTarget(targets[1]), [0, 0, 255]),
            `attachment 1 took gl_FragData[1]: ${readTarget(targets[1])}`);

        // NONE in a slot takes that attachment out of the pass entirely: not
        // just the draw, but the clear too, so attachment 1 comes through
        // holding what the previous pass left in it.
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
        gl.clearColor(0, 1, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        assert.ok(near(readTarget(targets[0]), [255, 0, 0]), 'attachment 0 was still written');
        assert.ok(near(readTarget(targets[1]), [0, 0, 255]),
            `attachment 1 was left alone: ${readTarget(targets[1])}`);
        glOk('drawBuffers with NONE');

        gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
        gl.viewport(0, 0, W, W);
        gl.deleteFramebuffer(fbo);
        gl.deleteFramebuffer(one);
        targets.forEach(t => gl.deleteTexture(t));
        done.push('MRT');
    }

    surf.destroy();
    gpu.destroy();
    return done.length ? done.join(', ') : 'none of the three offered by this driver';
});

// Which ES version the context is, and what that buys. Two numbers matter
// and they are not the same one: contextVersion is what EGL was asked for and
// granted, glVersion is what the driver then reported — a request for ES 2.0
// is a floor, and Mesa answers it with an ES 3.0 context.
report('GL ES 3.0 context selection', () => {
    const W = 64;
    const { gpu, surf, gl } = glSurface(W, { format: dri.FORMAT.ARGB8888, depthSize: 24 });
    const glOk = what => {
        const e = gl.getError();
        assert.strictEqual(e, gl.NO_ERROR, `${what}: GL error 0x${e.toString(16)}`);
    };

    assert.ok([2, 3].includes(gpu.contextVersion),
        `auto picked an ES version: ${gpu.contextVersion}`);
    assert.ok(gpu.glVersion.major >= gpu.contextVersion,
        `the driver gives at least what was asked: ${gpu.glVersion.string}`);
    assert.ok(gpu.glVersion.string.includes('OpenGL ES'),
        `and says so: ${gpu.glVersion.string}`);

    let note = `auto -> ES ${gpu.contextVersion}, driver ${gpu.glVersion.major}.${gpu.glVersion.minor}`;

    // The point of the whole exercise: on an ES 3.0 driver, GLSL ES 3.00
    // compiles — `in`/`out` instead of attribute/varying, an explicit output,
    // and attribute locations chosen in the shader rather than by the linker.
    if (gpu.glVersion.major >= 3) {
        const p = buildProgram(gl,
            '#version 300 es\n' +
            'layout(location = 0) in vec2 position;\n' +
            'out vec2 vUv;\n' +
            'void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }',
            '#version 300 es\n' +
            'precision mediump float;\n' +
            'uniform vec3 uColor;\n' +
            'in vec2 vUv;\n' +
            'layout(location = 0) out vec4 fragColor;\n' +
            'void main() { fragColor = vec4(uColor * vUv.x, 1.0); }');
        gl.useProgram(p);
        assert.strictEqual(gl.getAttribLocation(p, 'position'), 0,
            'layout(location = 0) is where the attribute went');
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform3f(gl.getUniformLocation(p, 'uColor'), 1, 0, 0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const px = new Uint8Array(W * W * 4);
        gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const redAt = x => px[(32 * W + x) * 4];
        // fragColor.r = vUv.x, so the quad is a ramp across the viewport
        assert.ok(Math.abs(redAt(48) - 191) <= 6, `three quarters across: ${redAt(48)}`);
        assert.ok(Math.abs(redAt(16) - 64) <= 6, `one quarter across: ${redAt(16)}`);
        glOk('GLSL ES 3.00');
        note += ', GLSL ES 3.00 compiles';
    }
    surf.destroy();
    gpu.destroy();

    // An explicit version is honoured, and a nonsense one is refused before
    // any device is touched.
    const pinned = new dri.Gpu({ glVersion: 2, format: dri.FORMAT.ARGB8888 });
    assert.strictEqual(pinned.contextVersion, 2, 'glVersion: 2 asks for exactly that');
    pinned.destroy();
    assert.throws(() => new dri.Gpu({ glVersion: 4 }), /must be 2, 3, or 0/);

    // ES 3.0 either works or says which version could not be had — never a
    // silent downgrade, which is the difference from 'auto'.
    try {
        const three = new dri.Gpu({ glVersion: 3, format: dri.FORMAT.ARGB8888 });
        assert.strictEqual(three.contextVersion, 3);
        three.destroy();
    } catch (e) {
        assert.match(e.message, /no ES 3 context/, `and explains itself: ${e.message}`);
        note += ' (no ES 3.0 config here)';
    }
    return note;
});

// 3D textures, array textures and immutable storage. The distinction the
// pixels have to show is that TEXTURE_3D filters across its third axis while
// TEXTURE_2D_ARRAY does not — same call, same data, different target, and a
// wrapper that mixed the two up would still run.
report('GL 3D textures, array textures and immutable storage', () => {
    const W = 64;
    const { gpu, surf, gl } = glSurface(W, { format: dri.FORMAT.ARGB8888, depthSize: 24 });
    const glOk = what => {
        const e = gl.getError();
        assert.strictEqual(e, gl.NO_ERROR, `${what}: GL error 0x${e.toString(16)}`);
    };
    const px = new Uint8Array(W * W * 4);
    const read = () => gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (x, y) => {
        const o = (y * W + x) * 4;
        return [px[o], px[o + 1], px[o + 2]];
    };
    const near = (got, want, tol) => got.every((c, i) => Math.abs(c - want[i]) <= (tol || 4));

    if (!gpu.features.texture3D) {
        assert.throws(() => gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, 1, 1, 1, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null), /not available/);
        surf.destroy();
        gpu.destroy();
        return 'no 3D textures on this driver';
    }
    // The sampler side needs GLSL ES 3.00: sampler2DArray does not exist in
    // ES 1.00, and GL_OES_texture_3D only brings the 3D half.
    if (gpu.glVersion.major < 3) {
        surf.destroy();
        gpu.destroy();
        return 'entry points present, but no GLSL ES 3.00 to sample them with';
    }

    const VS = '#version 300 es\n' +
        'layout(location = 0) in vec2 position;\n' +
        'out vec2 vUv;\n' +
        'void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }';
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const solidLayers = colors => {
        const out = new Uint8Array(colors.length * 4 * 4); // 2x2 RGBA per layer
        colors.forEach(([r, g, b], i) => {
            for (let t = 0; t < 4; t++) {
                const o = (i * 4 + t) * 4;
                out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
            }
        });
        return out;
    };
    const red = [255, 0, 0], green = [0, 255, 0], blue = [0, 0, 255], yellow = [255, 255, 0];

    // --- a 2D array texture: four layers, addressed by index ---------------
    const arrayProgram = buildProgram(gl, VS, '#version 300 es\n' +
        'precision mediump float;\nprecision mediump sampler2DArray;\n' +
        'uniform sampler2DArray uTex;\nuniform float uLayer;\n' +
        'in vec2 vUv;\nlayout(location = 0) out vec4 fragColor;\n' +
        'void main() { fragColor = texture(uTex, vec3(vUv, uLayer)); }');
    gl.useProgram(arrayProgram);
    const arr = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, arr);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, 2, 2, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        solidLayers([red, green, blue, yellow]));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glOk('texImage3D(TEXTURE_2D_ARRAY)');
    assert.strictEqual(gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY), arr);

    gl.uniform1i(gl.getUniformLocation(arrayProgram, 'uTex'), 0);
    const uLayer = gl.getUniformLocation(arrayProgram, 'uLayer');
    const drawLayer = (layer, x, y) => {
        gl.viewport(x, y, 32, 32);
        gl.uniform1f(uLayer, layer);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawLayer(0, 0, 0);
    drawLayer(1, 32, 0);
    drawLayer(2, 0, 32);
    drawLayer(3, 32, 32);
    read();
    assert.ok(near(at(16, 16), red), `layer 0: ${at(16, 16)}`);
    assert.ok(near(at(48, 16), green), `layer 1: ${at(48, 16)}`);
    assert.ok(near(at(16, 48), blue), `layer 2: ${at(16, 48)}`);
    assert.ok(near(at(48, 48), yellow), `layer 3: ${at(48, 48)}`);

    // The defining property: layers are not filtered between. A fractional
    // index rounds to one layer rather than blending two.
    gl.viewport(0, 0, W, W);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uLayer, 0.4);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), red), `layer 0.4 rounds to layer 0, unblended: ${at(32, 32)}`);
    glOk('array layer selection');

    // one layer replaced in place
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 1, 2, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE,
        solidLayers([[255, 0, 255]]));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uLayer, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [255, 0, 255]), `after texSubImage3D: ${at(32, 32)}`);
    glOk('texSubImage3D');

    // --- a 3D texture: the third axis filters ------------------------------
    const volumeProgram = buildProgram(gl, VS, '#version 300 es\n' +
        'precision mediump float;\nprecision mediump sampler3D;\n' +
        'uniform sampler3D uTex;\nuniform float uR;\n' +
        'in vec2 vUv;\nlayout(location = 0) out vec4 fragColor;\n' +
        'void main() { fragColor = texture(uTex, vec3(vUv, uR)); }');
    gl.useProgram(volumeProgram);
    const vol = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, vol);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        solidLayers([red, blue]));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    glOk('texImage3D(TEXTURE_3D)');
    gl.uniform1i(gl.getUniformLocation(volumeProgram, 'uTex'), 0);
    const uR = gl.getUniformLocation(volumeProgram, 'uR');
    const sampleAt = r => {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uR, r);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        read();
        return at(32, 32);
    };
    assert.ok(near(sampleAt(0.0), red), `the near slice: ${sampleAt(0.0)}`);
    assert.ok(near(sampleAt(1.0), blue), `the far slice: ${sampleAt(1.0)}`);
    // texel centres sit at r = 0.25 and 0.75, so the midpoint is an even mix
    assert.ok(near(sampleAt(0.5), [128, 0, 128], 6),
        `halfway is a blend, which an array texture would not do: ${sampleAt(0.5)}`);
    glOk('3D filtering');

    // --- rendering into one layer ------------------------------------------
    const flat = buildProgram(gl, VS, '#version 300 es\n' +
        'precision mediump float;\nuniform vec4 uColor;\n' +
        'in vec2 vUv;\nlayout(location = 0) out vec4 fragColor;\n' +
        'void main() { fragColor = uColor; }');
    const rt = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, rt);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, 32, 32, 3, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, new Uint8Array(32 * 32 * 3 * 4));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, rt, 0, 1);
    assert.strictEqual(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE,
        'one layer of an array texture is a complete attachment');
    gl.useProgram(flat);
    gl.uniform4f(gl.getUniformLocation(flat, 'uColor'), 0, 1, 1, 1);
    gl.viewport(0, 0, 32, 32);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
    gl.viewport(0, 0, W, W);
    glOk('framebufferTextureLayer');

    gl.useProgram(arrayProgram);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, rt);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uLayer, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [0, 255, 255]), `layer 1 was drawn into: ${at(32, 32)}`);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uLayer, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    read();
    assert.ok(near(at(32, 32), [0, 0, 0]), `and layer 0 was not: ${at(32, 32)}`);
    glOk('rendering to a layer');

    // --- immutable storage --------------------------------------------------
    let storageNote = 'no texStorage';
    if (gpu.features.textureStorage) {
        const imm = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, imm);
        gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, 4, 4);
        glOk('texStorage2D');
        assert.strictEqual(gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_IMMUTABLE_FORMAT), 1,
            'the texture reports itself immutable');
        // contents still change; shape does not
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array([1, 2, 3, 4]));
        glOk('texSubImage2D into immutable storage');
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 8, 8);
        assert.strictEqual(gl.getError(), gl.INVALID_OPERATION,
            'a second allocation is refused, which is the whole point');

        const immArray = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, immArray);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 2, 2, 4);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 2, 2, 4, gl.RGBA,
            gl.UNSIGNED_BYTE, solidLayers([red, green, blue, yellow]));
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        glOk('texStorage3D + texSubImage3D');
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uLayer, 2);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        read();
        assert.ok(near(at(32, 32), blue), `immutable array layer 2: ${at(32, 32)}`);
        gl.deleteTexture(imm);
        gl.deleteTexture(immArray);
        storageNote = 'immutable storage';
    }

    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(arr);
    gl.deleteTexture(vol);
    gl.deleteTexture(rt);
    surf.destroy();
    gpu.destroy();
    return `${maxLayers} layers, ${max3d}px volumes, ${storageNote}`;
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} failure(s)` : 'all good');
