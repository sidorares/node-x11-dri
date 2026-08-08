# x11-dri — native companion for node-x11's DRI3 + Present path

The [`x11`](https://github.com/sidorares/node-x11) package is pure JavaScript
and stays that way: its
[DRI3 extension](https://github.com/sidorares/node-x11/blob/master/docs/ext/dri3.md)
can pass dma-buf descriptors to the X server over the ordinary unix-socket
connection with no native code at all. What JavaScript cannot do is *produce*
those dma-bufs — that takes a GPU driver or an ioctl. This optional addon
fills exactly that hole:

- **`Gpu` / `Surface`** — an OpenGL ES 2.0 rendering context on a DRM render
  node (GBM + EGL) whose finished frames are exportable as dma-buf fds:
  render → `swap()` → `{fd, stride, modifier}` → `DRI3.PixmapFromBuffer` →
  `Present.Pixmap`.
- **`gl`** — a WebGL-flavored subset of GL ES 2.0 (shaders, buffers, draws,
  readPixels) driving that context from JS.
- **`createUdmabuf(size)`** — CPU memory turned into a dma-buf by the
  kernel's `/dev/udmabuf`, with the pixels mapped into JS as an
  `ArrayBuffer`: the GPU-less way to feed DRI3 (the same trick Xwayland
  uses), where supported by the server's driver.
- **`dup(fd)`**, **`dmabufSync(fd, flags)`** — descriptor plumbing (DRI3
  sends consume their fds; `dup` keeps a copy) and CPU-access bracketing.

Complete samples live in the main repo:
[`examples/opengl/dri3-cube.js`](https://github.com/sidorares/node-x11/blob/master/examples/opengl/dri3-cube.js)
(spinning GPU cube) and
[`examples/opengl/dri3-software.js`](https://github.com/sidorares/node-x11/blob/master/examples/opengl/dri3-software.js).

## Installing

```sh
npm install x11-dri       # builds with node-gyp; no headers, no libraries needed
```

The addon has **no build-time dependency** on gbm/EGL/GLES — `libgbm.so.1`,
`libEGL.so.1` and `libGLESv2.so.2` are `dlopen()`ed at runtime (Mesa's ABI is
stable), so it compiles on any Linux box with a C toolchain and degrades at
runtime with clear errors where a library or device is missing. `probe()`
reports what is available; `npm test` runs a self-check that skips whatever
this machine lacks. Linux only.

## API sketch

```js
const dri = require('x11-dri');

dri.probe();                              // { gbm, egl, gles, udmabuf }
dri.listRenderNodes();                    // ['/dev/dri/renderD128', ...]

const gpu = new dri.Gpu({                 // opens a render node (no X auth
    devicePath: undefined,                //   needed), gbm + EGL + ES2 context
    format: dri.FORMAT.XRGB8888,          // must match the window depth
    depthSize: 16                         // EGL depth buffer bits
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
and `destroy` — deliberately no more machinery than the examples need. The
`gl` namespace covers the ES 2.0 subset the samples use; extending it is a
matter of adding one small wrapper per entry point in `src/x11dri.c`.

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

## Why not `DRI3.Open`?

The protocol's own way to get a DRM device fd is a reply carrying a
descriptor, and receiving descriptors is the one thing node-x11's pure-JS
transport must never do (it aborts the Node process — see
[lib/fdpass.js](https://github.com/sidorares/node-x11/blob/master/lib/fdpass.js)
in the main package). Render nodes make it unnecessary: they exist precisely
so applications can render without asking a display server for permission.
On multi-GPU machines, probe: import a test buffer per node with
`DRI3.PixmapFromBuffer(..., cb)` and keep the node the server accepts.
