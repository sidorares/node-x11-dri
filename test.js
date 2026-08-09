// Self-test for the native companion. No X server involved: exercises what
// the addon itself provides and skips whatever this machine lacks. Exits
// non-zero only when a capability that IS present malfunctions.
'use strict';

const assert = require('assert');
const fs = require('fs');
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

report('dup', () => {
    const fd = fs.openSync('/dev/null', 'r');
    const d = dri.dup(fd);
    assert.notStrictEqual(d, fd);
    fs.closeSync(fd);
    fs.fstatSync(d); // still open
    fs.closeSync(d);
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
    assert.throws(() => new dri.Gpu({}), /DRI3|DRM/, 'Gpu explains itself');
    return `${caps.platform}: gbm/dma-buf reported unavailable`;
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

// Everything the ES 2.0 binding covers beyond "clear it and read it back":
// textures, blending, render-to-texture and the uniform setters. Pixels are
// the oracle throughout — a wrapper that passes its arguments in the wrong
// order still compiles and still runs, and only the result says otherwise.
report('GL ES 2.0 surface: textures, blending, FBO, uniforms', () => {
    for (const [name, cap] of [['gbm', caps.gbm], ['egl', caps.egl], ['gles', caps.gles]])
        if (cap !== true)
            skip(`${name}: ${cap}`);
    if (dri.listRenderNodes().length === 0)
        skip('no /dev/dri/renderD*');
    let gpu;
    try {
        gpu = new dri.Gpu({ format: dri.FORMAT.ARGB8888, depthSize: 24 });
    } catch (e) {
        skip(`render node unusable: ${e.message}`);
    }
    const W = 64;
    const surf = gpu.createSurface(W, W);
    gpu.makeCurrent(surf);
    const gl = gpu.gl;
    gl.viewport(0, 0, W, W);

    const glOk = what => {
        const e = gl.getError();
        assert.strictEqual(e, gl.NO_ERROR, `${what}: GL error 0x${e.toString(16)}`);
    };
    const build = (vsSrc, fsSrc) => {
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

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} failure(s)` : 'all good');
