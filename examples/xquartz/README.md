# Accelerated GL into an XQuartz window, from Node

The macOS counterpart of node-x11's
[`examples/dri3/cube.js`](https://github.com/sidorares/node-x11/tree/master/examples/dri3):
the same spinning cube, on the direct-rendering path XQuartz actually has.

XQuartz never implemented DRI3. What it has instead is the **Apple-DRI**
extension, and the buffer flows the other way around: the client does not
send the server a buffer — the *server* exports the window's WindowServer
surface to the client (`AppleDRICreateSurface` → a two-word key), the client
imports it over its own WindowServer connection and attaches a CGL context
(`x11-dri`'s `apple` namespace, dlopen'ing `libXplugin` and the system
OpenGL framework). From then on GL renders straight into the window's
backing store — zero copies, nothing per-frame on the X socket — and
`ctx.flush()` presents. This is exactly the machinery XQuartz's own libGL
uses for GLX clients, minus GLX: the renderer string it prints is the real
GPU ("Apple M1 Pro", OpenGL on Metal).

- [appledri.js](appledri.js) — the Apple-DRI protocol in node-x11's
  extension style (candidate for `lib/ext/appledri.js` upstream)
- [cube.js](cube.js) — window + surface + render loop

## Run

Needs macOS with [XQuartz](https://www.xquartz.org) and a logged-in GUI
session (the WindowServer refuses SSH logins), plus the parent package built
(`npm install` at the repo root, or the npm prebuild).

```sh
npm install
npm start
```

`node cube.js 10` exits after 10 seconds; `q`/Escape close it. Resize the
window — `ConfigureNotify`/`AppleDRISurfaceNotify` drive
`ctx.update()`.

## What the pieces are

| piece | where | why |
| --- | --- | --- |
| `AppleDRICreateSurface`, `SurfaceNotify` | [appledri.js](appledri.js), pure JS | plain X protocol |
| `xp_import_surface`, `xp_attach_gl_context`, CGL | `x11-dri` native (`apple.*`) | private-but-stable system libraries, unreachable from JS |
| shaders, buffers, draws | `dri.gl` — same object as the Linux path | OpenGL.framework exports the ES 2.0 name set; GL 4.1 core compiles GLSL ES 1.00 |
