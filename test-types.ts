// Type-level self-check for index.d.ts. Compiled, never run:
//
//     npm run test:types
//
// Nothing here touches a GPU, so it is the one test that says something on
// every machine. The `@ts-expect-error` lines are the load-bearing half —
// each one fails the build if the mistake below it stops being an error,
// which is what keeps the declarations from quietly widening to `any`.

import {
    probe, dup, listRenderNodes, createUdmabuf, dmabufSync,
    Gpu, GL, gl as sharedGl, apple,
    FORMAT, GBM_USE, MODIFIER, DMABUF_SYNC,
    ActiveInfo, GlFeatures, GLContext, ProbeResult, Surface, SwapResult, TypedArray
} from './index';

// ---- probe and the plumbing ------------------------------------------------

const caps: ProbeResult = probe();
const usable: boolean = caps.dmabuf;
// each capability is `true` or a string saying why not
const why: string = caps.gbm === true ? 'fine' : caps.gbm;
const nodes: string[] = listRenderNodes();
const copy: number = dup(0);

const buf = createUdmabuf(4096);
buf.sync(DMABUF_SYNC.START | DMABUF_SYNC.WRITE);
new Uint8Array(buf.buffer)[0] = 0xff;
buf.sync(DMABUF_SYNC.END | DMABUF_SYNC.WRITE);
dmabufSync(buf.fd, DMABUF_SYNC.RW);
buf.close();

// @ts-expect-error — size is required
createUdmabuf();

// ---- the context -----------------------------------------------------------

const gpu = new Gpu({
    format: FORMAT.ARGB8888,
    depthSize: 24,
    glVersion: 'auto'
});
new Gpu();
new Gpu({ glVersion: 3 });
new Gpu({ devicePath: '/dev/dri/renderD128' });

// @ts-expect-error — 4 is not an ES version this takes
new Gpu({ glVersion: 4 });
// @ts-expect-error — no such option
new Gpu({ depth: 24 });

const surface: Surface = gpu.createSurface(256, 256, GBM_USE.LINEAR);
gpu.makeCurrent(surface);
gpu.makeCurrent(null);
gpu.makeCurrent(surface);

const gl: GLContext = gpu.gl;
const eglVendor: string = gpu.eglVendor;
const contextVersion: 2 | 3 = gpu.contextVersion;

// glVersion and features only exist once a context is current, so strict mode
// makes the check compulsory — which is the intent, not an inconvenience.
// @ts-expect-error — possibly undefined
const major: number = gpu.glVersion.major;
if (gpu.glVersion && gpu.glVersion.major >= 3) {
    const v: string = gpu.glVersion.string;
}
const features: GlFeatures | null | undefined = gpu.features;
if (features?.instancedArrays)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 100);

// ---- swap discriminates on isNew -------------------------------------------

const out: SwapResult | null = surface.swap();
if (out) {
    const key: number = out.key;
    // @ts-expect-error — fd is only there when isNew
    const bad: number = out.fd;
    if (out.isNew) {
        const fd: number = out.fd;
        const stride: number = out.stride;
        const modifier: bigint = out.modifier;
    }
    surface.release(out.key);
}

// ---- drawing ---------------------------------------------------------------

const vs = gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs, 'void main() { gl_Position = vec4(0.0); }');
gl.compileShader(vs);
// a number, not a boolean — COMPILE_STATUS answers 1 or 0
const compiled: number = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
const log: string = gl.getShaderInfoLog(vs);

const program = gl.createProgram();
gl.attachShader(program, vs);
gl.linkProgram(program);
gl.useProgram(program);

// -1 rather than null when the program has no such uniform
const uColor: number = gl.getUniformLocation(program, 'uColor');
gl.uniform4f(uColor, 1, 0, 0, 1);
gl.uniform4fv(uColor, new Float32Array([1, 0, 0, 1]));
gl.uniformMatrix4fv(uColor, false, new Float32Array(16));

// @ts-expect-error — the fv setters want a Float32Array specifically
gl.uniform4fv(uColor, [1, 0, 0, 1]);
// @ts-expect-error — and uniform1iv wants an Int32Array
gl.uniform1iv(uColor, new Float32Array([0]));
// @ts-expect-error — transpose is a boolean
gl.uniformMatrix4fv(uColor, 0, new Float32Array(16));

const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0]), gl.STATIC_DRAW);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(0);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

// @ts-expect-error — a plain array is not a TypedArray
gl.bufferData(gl.ARRAY_BUFFER, [0, 0], gl.STATIC_DRAW);
// @ts-expect-error — normalized is a boolean, and the argument order is fixed
gl.vertexAttribPointer(0, 2, gl.FLOAT, 0, 0, 0);

// ---- textures --------------------------------------------------------------

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
// null pixels is how a texture is allocated to be rendered into
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array(4));
gl.compressedTexImage2D(gl.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT,
    4, 4, 0, new Uint8Array(8));

// @ts-expect-error — texSubImage2D has no null form
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, null);

if (features?.texture3D) {
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, 2, 2, 4, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64));
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, 2);
}
if (features?.textureStorage)
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 2, 2, 4);
if (features?.drawBuffers) {
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
    gl.drawBuffers(new Uint32Array([gl.COLOR_ATTACHMENT0]));
}

// ---- queries answer in the shape the parameter has -------------------------

const viewport = gl.getParameter(gl.VIEWPORT);
if (Array.isArray(viewport)) {
    const x = viewport[0];
}
const maxTexture: number = gl.getIntegerv(gl.MAX_TEXTURE_SIZE);
const dithering: boolean = gl.getBooleanv(gl.DITHER);
const extensions: string[] = gl.getSupportedExtensions();
const live: boolean = gl.isProgram(program);

// @ts-expect-error — getParameter cannot promise a number for every pname
const notANumber: number = gl.getParameter(gl.VIEWPORT);

const info: ActiveInfo | null = gl.getActiveUniform(program, 0);
if (info) {
    const name: string = info.name;
    const size: number = info.size;
    if (info.type === GL.FLOAT_VEC4) { /* ... */ }
}
const value = gl.getUniform(program, uColor);
if (value instanceof Float32Array) {
    const first: number = value[0];
}
const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, GL.MEDIUM_FLOAT);
const bits: number = precision.precision;

const pixels: TypedArray = new Uint8Array(4 * 4 * 4);
gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

// ---- the macOS / XQuartz path ----------------------------------------------

const appledriWhy: string = caps.appledri === true ? 'fine' : caps.appledri;
const cid: number = apple.clientId();
const actx = new apple.Context({ depthSize: 16, profile: 'core' });
actx.attach([0, 0]);
actx.attach(0, 0);
const actxGl: GLContext = actx.gl;
if (actx.features?.instancedArrays)
    actx.glVersion?.major.toFixed();
actx.update();
actx.setSwapInterval(1);
actx.flush();
actx.destroy();

// @ts-expect-error — profile is an enum of two spellings
new apple.Context({ profile: 'compatibility' });
// @ts-expect-error — a key has two words
actx.attach(1);

// ---- the module-level gl is the same object --------------------------------

const alsoGl: GLContext = sharedGl;
const modifierLinear: bigint = MODIFIER.LINEAR;
const constantsOnly: number = GL.TRIANGLE_STRIP;

// @ts-expect-error — constants are read-only
GL.TRIANGLE_STRIP = 1;
// @ts-expect-error — no such constant
const nope = GL.TRIANGLE_SPIRAL;

surface.destroy();
gpu.destroy();

// Keep every binding used, so noUnusedLocals stays available as a real check.
export {
    usable, why, nodes, copy, eglVendor, contextVersion, major, compiled, log,
    viewport, maxTexture, dithering, extensions, live, notANumber, bits,
    alsoGl, modifierLinear, constantsOnly, nope, gl, out, info, value, precision,
    appledriWhy, cid, actxGl
};
