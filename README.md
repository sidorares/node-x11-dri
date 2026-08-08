# x11-dri — native companion for node-x11's DRI3 + Present path

The [`x11`](https://github.com/sidorares/node-x11) package is pure JavaScript
and stays that way: its
[DRI3 extension](https://github.com/sidorares/node-x11/blob/master/docs/ext/dri3.md)
can pass dma-buf descriptors to the X server over the ordinary unix-socket
connection with no native code at all. What JavaScript cannot do is *produce*
those dma-bufs — that takes a GPU driver or an ioctl. This optional addon
fills exactly that hole:

- **`Gpu` / `Surface`** — an OpenGL ES 2.0 or 3.0 rendering context on a DRM render
  node (GBM + EGL) whose finished frames are exportable as dma-buf fds:
  render → `swap()` → `{fd, stride, modifier}` → `DRI3.PixmapFromBuffer` →
  `Present.Pixmap`.
- **`gl`** — a WebGL-flavored subset of GL ES 2.0 driving that context from
  JS: shaders and programs, buffers and vertex attributes, draws, textures
  (including compressed uploads), blending, framebuffer objects for rendering
  to a texture, the uniform setters, program introspection, and `readPixels`
  — plus vertex array objects, instanced drawing, multiple render targets and
  3D/array textures where the driver has them.
- **`createUdmabuf(size)`** — CPU memory turned into a dma-buf by the
  kernel's `/dev/udmabuf`, with the pixels mapped into JS as an
  `ArrayBuffer`: the GPU-less way to feed DRI3 (the same trick Xwayland
  uses), where supported by the server's driver.
- **`dup(fd)`**, **`dmabufSync(fd, flags)`** — descriptor plumbing (DRI3
  sends consume their fds; `dup` keeps a copy) and CPU-access bracketing.

Complete samples live in the main repo — a self-contained folder you can `npm install && npm start`:
[`examples/dri3/cube.js`](https://github.com/sidorares/node-x11/blob/master/examples/dri3/cube.js)
(spinning GPU cube) and
[`examples/dri3/software.js`](https://github.com/sidorares/node-x11/blob/master/examples/dri3/software.js).
The [`examples/`](examples) folder here is the other half of that: no X server
and no DRI3, one GL feature per file, rendering off-screen and writing a PNG
you can open.

## Installing

```sh
npm install x11-dri       # no toolchain needed on linux x64/arm64, macOS arm64
```

The npm tarball bundles **prebuilt binaries** for `linux-x64`,
`linux-arm64` (glibc ≥ 2.31 — Debian 11 / Ubuntu 20.04 and everything
newer) and `darwin-arm64` (macOS 11+, Apple Silicon), built in CI from the
released tag. The install script just verifies the matching one loads, so a
box with no build tools installs from the tarball alone — and because the
loader also resolves the prebuild at `require()` time, the package keeps
working under `npm install --ignore-scripts`. The addon is Node-API, so one
binary per platform/arch covers every supported Node (and Electron)
version.

Anything else (musl/Alpine, armv7, riscv64, Intel Macs, forced rebuilds
with `--build-from-source`) compiles automatically with node-gyp, and that
needs only a C toolchain: the addon has **no build-time dependency** on
gbm/EGL/GLES — `libgbm.so.1`, `libEGL.so.1` and `libGLESv2.so.2` are
`dlopen()`ed at runtime (Mesa's ABI is stable) and it degrades with clear
errors where a library or device is missing. `probe()` reports what is
available; `npm test` runs a self-check that skips whatever this machine
lacks.

**The rendering and dma-buf features are Linux-only.** The package builds
and loads on macOS so cross-platform code can `require()` it
unconditionally, but there it reports every GPU capability as unavailable —
see below for why that is a property of the platform and not a missing
port.

## API sketch

```js
const dri = require('x11-dri');

dri.probe();                              // { gbm, egl, gles, udmabuf }
dri.listRenderNodes();                    // ['/dev/dri/renderD128', ...]

const gpu = new dri.Gpu({                 // opens a render node (no X auth
    devicePath: undefined,                //   needed), gbm + EGL + a context
    format: dri.FORMAT.XRGB8888,          // must match the window depth
    depthSize: 16,                        // EGL depth buffer bits
    glVersion: 'auto'                     // 'auto' | 3 | 2 — see below
});
const surface = gpu.createSurface(w, h);  // GBM swapchain (add
gpu.makeCurrent(surface);                 //   dri.GBM_USE.LINEAR for
                                          //   cross-device consumers)
const gl = gpu.gl;                        // clearColor, shaders, drawElements…
// ... draw ...
const out = surface.swap();
// out: { key, isNew, width, height } and, the first time a buffer appears,
//      { fd, stride, offset, modifier (BigInt) } — hand fd to
//      DRI3.PixmapFromBuffer (it is consumed), cache pixmap by out.key.
// out === null: every buffer still held — wait for PresentIdleNotify.
surface.release(out.key);                 // when PresentIdleNotify says so
surface.destroy(); gpu.destroy();
```

One EGL context per `Gpu`, one thread, GL calls valid between `makeCurrent`
and `destroy` — deliberately no more machinery than a renderer needs.

### TypeScript

Declarations ship with the package (`index.d.ts`), so there is nothing to
install and no `@types` entry to look for. The runtime is CommonJS, so they
are named exports — `import { Gpu } from 'x11-dri'` — with no default export,
because there is no `.default` at runtime.

They describe the binding rather than WebGL, and the differences are the
useful part:

```ts
import { Gpu, GLContext } from 'x11-dri';

const gpu = new Gpu({ glVersion: 3 });
const surface = gpu.createSurface(1024, 768);
gpu.makeCurrent(surface);

const out = surface.swap();
if (out?.isNew) {
    const fd: number = out.fd;   // only in scope because isNew narrowed it
}

if (gpu.features?.instancedArrays)
    gpu.gl.drawArraysInstanced(gpu.gl.TRIANGLE_STRIP, 0, 4, 1000);
```

`swap()` returns a union discriminated on `isNew`, so the dma-buf fields are
reachable exactly where they exist. `features` and `glVersion` are optional
until `makeCurrent` has run, which is when they become knowable. GL objects
are plain numbers, `getUniformLocation` answers `-1` rather than `null`, and
`getShaderParameter` answers a number — all as the binding does, not as
WebGL's typings do.

Two checks keep the declarations honest: `npm test` compares every declared
name against the addon's actual exports in both directions (no GPU and no
TypeScript needed, so it runs everywhere), and `npm run test:types` compiles
`test-types.ts` against them under `strict`, where a row of
`@ts-expect-error` lines fail the build if the mistakes below them stop being
mistakes.

### Which ES version

`glVersion` defaults to `'auto'`: ask EGL for ES 3.0, and fall back to ES 2.0
when the display has no ES 3.0-capable config or refuses the context. Pass
`3` to insist — you get an error naming the version rather than a silent
downgrade — or `2` to pin.

Two numbers come back, and they are not the same one:

```js
gpu.contextVersion   // 2 or 3: what EGL was asked for and granted
gpu.makeCurrent(surface);
gpu.glVersion        // { major, minor, string } — what the driver reports
```

A version request is a **floor, not a ceiling**. ES 3.0 is backward
compatible with ES 2.0 and EGL is allowed to hand back more than was asked
for: Mesa answers `glVersion: 2` with an ES 3.0 context, so
`contextVersion === 2` with `glVersion.major === 3` is normal and not a bug.
`glVersion` is the one to branch on — it is what the driver will actually
honour, and it is what gates the optional entry points above.

`gpu.glVersion` needs a current context to exist, so like `features` it
appears on `makeCurrent` rather than in the constructor.

### What `gl` covers

Enough of ES 2.0 to drive a real renderer, in WebGL's spelling and argument
order, so code and tutorials carry over:

| area | entry points |
| --- | --- |
| programs | `createShader`, `shaderSource`, `compileShader`, `getShaderParameter`, `getShaderInfoLog`, `createProgram`, `attachShader`, `linkProgram`, `getProgramParameter`, `getProgramInfoLog`, `useProgram`, `bindAttribLocation`, deletes |
| geometry | `createBuffer`, `bindBuffer`, `bufferData`, `bufferSubData`, `vertexAttribPointer`, `enableVertexAttribArray`, `disableVertexAttribArray`, `vertexAttrib1f`–`4f`, `drawArrays`, `drawElements` |
| uniforms | `getUniformLocation`, `uniform1f`/`2f`/`3f`/`4f`, `uniform1i`/`2i`/`3i`/`4i`, `uniform1fv`–`4fv`, `uniform1iv`, `uniformMatrix2fv`/`3fv`/`4fv` |
| textures | `createTexture`, `bindTexture`, `activeTexture`, `texImage2D`, `texSubImage2D`, `compressedTexImage2D`, `compressedTexSubImage2D`, `texParameteri`/`f`, `generateMipmap`, `deleteTexture` |
| framebuffers | `createFramebuffer`, `bindFramebuffer`, `framebufferTexture2D`, `framebufferRenderbuffer`, `checkFramebufferStatus`, `createRenderbuffer`, `bindRenderbuffer`, `renderbufferStorage`, deletes |
| per-fragment state | `blendFunc`, `blendFuncSeparate`, `blendEquation`, `blendEquationSeparate`, `blendColor`, `depthFunc`, `depthMask`, `depthRange`, `colorMask`, `scissor`, `polygonOffset`, `stencilFunc`, `stencilOp`, `stencilMask`, `clearStencil`, `cullFace`, `frontFace` |
| introspection | `getActiveUniform`, `getActiveAttrib`, `getUniform`, `getAttachedShaders`, `getShaderSource`, `getShaderPrecisionFormat`, `getVertexAttrib`, `getVertexAttribOffset`, `getBufferParameter`, `getTexParameter`, `getFramebufferAttachmentParameter`, `getRenderbufferParameter`, `getSupportedExtensions`, `validateProgram`, `isBuffer`/`isProgram`/`isShader`/`isTexture`/`isFramebuffer`/`isRenderbuffer`/`isEnabled` |
| optional (see `gpu.features`) | `createVertexArray`, `bindVertexArray`, `deleteVertexArray`, `isVertexArray`; `drawArraysInstanced`, `drawElementsInstanced`, `vertexAttribDivisor`; `drawBuffers`; `texImage3D`, `texSubImage3D`, `copyTexSubImage3D`, `compressedTexImage3D`, `compressedTexSubImage3D`, `framebufferTextureLayer`; `texStorage2D`, `texStorage3D` |
| the rest | `clear`, `clearColor`, `clearDepthf`, `viewport`, `enable`, `disable`, `lineWidth`, `pixelStorei`, `getParameter`, `getIntegerv`, `getFloatv`, `getBooleanv`, `getError`, `getString`, `readPixels`, `finish`, `flush` |

`texImage2D` accepts `null` pixels, which is how a texture is allocated to be
rendered into. `getParameter` answers in the type the parameter has — a
number, a boolean, or an array for `VIEWPORT`, `SCISSOR_BOX`,
`COLOR_CLEAR_VALUE`, `COLOR_WRITEMASK` and `COMPRESSED_TEXTURE_FORMATS`;
`getIntegerv`/`getFloatv`/`getBooleanv` are the raw single-value escape hatch.

Introspection is how code that did not write the shader drives it anyway.
`getActiveUniform(program, i)` walks the uniforms a linked program actually
kept, answering `{ name, size, type }` (and `null` past the end, so a loop
can stop without disturbing `getError()`); arrays appear once, as `u[0]` with
their length. `getUniform(program, location)` reads a value back in its own
type — a `Float32Array` for a vec, a boolean for a `bool` — by asking the
program what that uniform is; `getUniformfv`/`getUniformiv` are the raw form
that takes a component count instead.

Compressed uploads pass their bytes to the driver untouched: the block layout
belongs to the format, and the byte count comes from the TypedArray. Which
`internalformat` values are legal is per-driver, so ask first —
`getSupportedExtensions()` names the formats, `getParameter(gl.COMPRESSED_TEXTURE_FORMATS)`
enumerates the enums. `examples/compressed-texture.js` encodes DXT1 blocks by
hand and renders the result beside the uncompressed original.

### What is optional, and how to ask

Vertex array objects, instanced drawing, multiple render targets, 3D and
array textures, and immutable storage are core in ES 3.0 and extensions
before it, so whether they exist at all is a property of the driver and the
context rather than of this build. They are resolved separately from
everything else, against a live context, and reported per feature:

```js
gpu.makeCurrent(surface);
gpu.features            // { vertexArrayObject, instancedArrays, drawBuffers,
                        //   texture3D, textureStorage }
if (gpu.features.instancedArrays)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
```

`features` appears on `makeCurrent` because that is the first moment the
answer is knowable, and it is refreshed on each call. A feature is `true`
only when every entry point it needs resolved, so a driver offering half an
extension reports it absent rather than throwing partway through a frame.
Calling one that is missing throws a message naming the feature — the
wrappers never call through a null pointer.

Two details this hides. Mesa exports the whole ES 3.2 symbol set from
`libGLESv2.so.2` whatever the context supports, so finding
`glDrawArraysInstanced` there says nothing about being allowed to call it —
the core spellings are gated on the context reporting ES 3.0. And drivers
that have the extension but not the core function often export neither,
offering `glDrawArraysInstancedEXT` (or `…ANGLE`, or `…NV`) through
`eglGetProcAddress` alone — so each feature carries a list of candidate
spellings and takes the first that both resolves and is advertised.

### 3D and array textures

Same call, different target: `TEXTURE_3D` filters across the third axis,
`TEXTURE_2D_ARRAY` keeps its layers independent — a fractional layer index
rounds to one of them rather than blending two, which is what makes an array
texture the right home for an atlas and a 3D texture the right home for a
volume.

```js
gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, layers);  // allocate once
gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, h, layers,
                 gl.RGBA, gl.UNSIGNED_BYTE, pixels);              // then fill
gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, 2);
```

`texStorage2D`/`texStorage3D` allocate the whole mipmap pyramid once in a
sized format and refuse to be called twice; only the contents change
afterwards, through `texSubImage`. Sampling either target needs GLSL ES 3.00
(`sampler3D`, `sampler2DArray`), so it needs an ES 3.0 context — see
`glVersion` above. `examples/texture-3d.js` ray-marches a 64³ volume beside
the array texture and the slices it interpolates between.

### Still not covered

The rest of ES 3.0: sampler objects, uniform buffer objects, transform
feedback, query and sync objects, multisampled renderbuffers, primitive
restart, and `getUniformuiv` for unsigned-integer uniforms (`getUniform`
answers `null` for a type it cannot read). Adding one is still a small
wrapper per entry point in `src/x11dri.c` plus a line in the `EXPORT` block —
the JS name is derived from the `glFoo` export automatically, and anything
past ES 2.0 belongs in the optional table beside the features above.

## How it fits together

```
GPU (render node)                        X server
-----------------                        --------
render into a buffer
export -> dma-buf fd  --- fd over unix socket (DRI3) --->  pixmap
Present.Pixmap(window, pixmap)  ------ vsync'd flip/copy -> on screen
                    <--- PresentCompleteNotify   (pace the next frame)
                    <--- PresentIdleNotify       (buffer reusable)
```

The protocol side — DRI3, Present, and the descriptor-passing socket — is
implemented in pure JS by the main package; see
[docs/ext/dri3.md](https://github.com/sidorares/node-x11/blob/master/docs/ext/dri3.md)
and
[docs/ext/present.md](https://github.com/sidorares/node-x11/blob/master/docs/ext/present.md).

## macOS / XQuartz

Short answer: **the DRI3 path does not work under XQuartz, and cannot be
made to.** Present does work, so the display half of the pipeline is
available on a Mac — but this package supplies the *other* half, and every
mechanism it depends on is Linux-specific. The addon builds and loads on
macOS (Apple Silicon prebuild included) purely so that `require('x11-dri')`
and `probe()` are safe to call from portable code.

Measured against XQuartz 21.1.23 (X.Org 21.1.23) on macOS 15.2, Apple
Silicon:

| Piece | On XQuartz | Consequence |
| --- | --- | --- |
| `Present` | **v1.2, works** — `Present.Pixmap` accepted, `PresentCompleteNotify` *and* `PresentIdleNotify` both delivered | the pacing/buffer-recycling loop from the samples runs unchanged |
| `DRI3` | **not implemented** — `QueryExtension` says absent, `X.require('dri3')` fails | no `PixmapFromBuffer`, so no way to turn a buffer fd into a pixmap |
| dma-buf | no such kernel object on Darwin | nothing to export, and nothing to send |
| GBM | no `libgbm` on macOS | `Gpu` cannot allocate exportable buffers |
| EGL | XQuartz ships Mesa's `libGLESv2`/`libOSMesa` but **no `libEGL`** | no way to create the ES context, even ignoring the above |
| udmabuf | `/dev/udmabuf` is a Linux driver | the CPU-memory fallback is out too |

The two gaps compound: even with a GPU context, there is no dma-buf to
export; even with a dma-buf, there is no DRI3 request to hand it to.

What that leaves on a Mac, using the pure-JS `x11` package alone and no
native code at all: fill an ordinary pixmap with `CreatePixmap` +
`PutImage`, then display it with `Present.Pixmap` and pace off
`PresentCompleteNotify`. That is a copy per frame rather than DRI3's zero
copy, but it is the same protocol shape as the samples and needs nothing
from this package. (`MIT-SHM` is also advertised by XQuartz and would save
the socket copy, though creating the segment needs native code, and macOS
ships very small SysV limits by default — `kern.sysv.shmmax` is 4 MiB, less
than one 1080p frame, and raising it requires a `sysctl`.)

For reference, XQuartz's own direct-rendering mechanism is the `Apple-DRI`
extension, which its `libGL` uses to bind a GLX drawable to a CoreGraphics
surface via Apple's private `Xplugin` API. That is a genuine zero-copy path,
but it shares no protocol, buffer type, or API with DRI3 — supporting it
would be a separate addon, not a port of this one.

`probe()` reports all of the above at runtime:

```js
require('x11-dri').probe();
// {
//   platform: 'darwin',
//   dmabuf: false,                 // false => no library will fix this
//   gbm:  'GBM needs Linux DRM/dma-buf — no equivalent on darwin',
//   egl:  'dlopen(libEGL.dylib) ... no such file',
//   gles: true,                    // XQuartz's Mesa, found under /opt/X11/lib
//   udmabuf: 'dma-buf is a Linux kernel facility with no darwin equivalent ...'
// }
```

Every capability is `true` when usable or a string explaining why not, and
`dmabuf: false` is the one to branch on: it means the host itself, not the
installation, is the limit.

## Why not `DRI3.Open`?

The protocol's own way to get a DRM device fd is a reply carrying a
descriptor, and receiving descriptors is the one thing node-x11's pure-JS
transport must never do (it aborts the Node process — see
[lib/fdpass.js](https://github.com/sidorares/node-x11/blob/master/lib/fdpass.js)
in the main package). Render nodes make it unnecessary: they exist precisely
so applications can render without asking a display server for permission.
On multi-GPU machines, probe: import a test buffer per node with
`DRI3.PixmapFromBuffer(..., cb)` and keep the node the server accepts.
