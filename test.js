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

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} failure(s)` : 'all good');
