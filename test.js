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

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} failure(s)` : 'all good');
