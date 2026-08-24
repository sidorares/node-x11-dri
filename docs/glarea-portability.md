# One `<glarea>` on Linux and macOS: the Apple-DRI integration plan

The goal: a react-x11 app containing

```jsx
<glarea flexGrow={1} clearColor="#0b1021" frameLoop="always"
        onDraw={(gl, { width, height }) => { /* ES2 draw calls */ }} />
```

runs unchanged on a Linux host (DRI3 + Present) and a macOS host (XQuartz +
Apple-DRI), on the real GPU on both — and react-x11-components can build
scene-graph components on top of that same contract.

This document is the map for the work outside this repo. It is written
against the actual code as of 2026-08: ntk's `lib/gl.js` /
`lib/renderingcontext_gles.js` / `lib/glswapchain.js`, and react-x11's
`src/glnodes.js` / `src/glbackend.js`. The good news up front: **the
`<glarea>` element itself should need zero changes** — every hook it uses
(`backend === 'direct'`, `makeCurrent()`, `canRender()`, `onFrameAvailable`,
`SwapBuffers()`, `ready`, camelCase ES2 `gl.*`) maps onto the Apple path
naturally. The work concentrates in ntk's backend-selection module and one
new rendering-context class, plus one file moving into node-x11.

## The stack, and who owns which piece

```
react-x11 <glarea>            unchanged — speaks the RenderingContext contract
   │
ntk                           NEW: darwin branches in lib/gl.js +
   │                          lib/renderingcontext_cgl.js (this doc, §4)
   ├── node-x11               NEW: lib/ext/appledri.js — protocol only, pure JS
   │                          (file ready in this repo, §3)
   └── x11-dri                DONE (this PR): dri.apple.{clientId, Context} —
                              Xplugin + CGL native halves, same `gl` object
```

## 1. The two paths, side by side

The deep difference: DRI3 is *client-allocates, client-pushes* — Apple-DRI is
*server-exports, client-attaches*. Everything else follows from that.

| | Linux: DRI3 + Present | macOS: Apple-DRI + CGL |
| --- | --- | --- |
| buffer origin | client allocates GBM buffers, exports dma-buf fds | server exports the window's WindowServer surface as a `key[2]` |
| server-side setup | `DRI3.PixmapFromBuffer` per buffer | `AppleDRI.CreateSurface(screen, wid, clientId)` once per window |
| client native setup | GBM + EGL context (`dri.Gpu`) | `dri.apple.clientId()` once, `dri.apple.Context` + `attach(key)` |
| show a frame | `Present.Pixmap` (a request per frame) | `ctx.flush()` (CGLFlushDrawable — zero X traffic per frame) |
| pacing signal | `PresentCompleteNotify` / `PresentIdleNotify` events | none from X — self-paced (timer; vsync via `setSwapInterval(1)` blocks) |
| buffer recycling | swapchain generations, IdleNotify returns buffers | none — the surface *is* the window's backing store |
| resize | new buffer generation at the new size | `ctx.update()`; the surface tracks the window |
| move / clip change | nothing (buffers are position-free) | `AppleDRISurfaceNotify(kind=0)` → `ctx.update()` |
| surface loss | n/a | `AppleDRISurfaceNotify(kind=1)` → `CreateSurface` + `attach` again |
| child windows | yes (it's just a drawable) | **yes, verified** — server positions the surface at the child's offset in the top-level frame and shapes it by the child's clip region (`DRIUpdateSurface` in xorg-server `hw/xquartz/xpr/dri.c`) |
| GL dialect | OpenGL ES 2/3 (Mesa) | desktop GL **4.1 core** on Metal, ES2-compatible (see §6) |
| fd passing needed | yes (`DRI3.fdCapable`) | **no** — nothing crosses the socket but requests |
| locality requirement | local unix socket | same machine **and** a logged-in GUI session (WindowServer refuses SSH) |
| depth 24 / 32 | XRGB8888 / ARGB8888 formats | colorSize 24 (+alphaSize); server maps bpp 32 → `XP_DEPTH_ARGB8888` (untested here, expected to work) |

What is already identical, by construction (this PR): the **`gl` object** —
same WebGL-flavored functions and constants, same `features`
(`vertexArrayObject`, `instancedArrays`, `drawBuffers`, `texture3D`,
`textureStorage` — all `true` on Apple GL 4.1), same
`getSupportedExtensions()`, same error contract.

## 2. What this repo now provides (`dri.apple`)

```js
const cid = dri.apple.clientId();     // WindowServer handshake; throws w/ reason over SSH
// X side answers: AppleDRI.CreateSurface(screen, wid, cid) -> { key: [k0,k1], uid }
const ctx = new dri.apple.Context({ colorSize: 24, alphaSize: 8, depthSize: 16,
                                    stencilSize: 0, doubleBuffer: true,
                                    profile: 'core' });   // all optional
ctx.attach(key);          // xp_import_surface + xp_attach_gl_context; ctx comes out current
ctx.makeCurrent();        // CGLSetCurrentContext (+ default VAO, feature resolve)
ctx.gl / ctx.glVersion / ctx.features
ctx.flush();              // present — this backend's SwapBuffers
ctx.update();             // after move/resize (ConfigureNotify or SurfaceNotify kind 0)
ctx.setSwapInterval(n);   // 0 = free-running flush (default), 1 = block to vsync
ctx.destroy();
```

`probe().appledri` is `true` when libXplugin + OpenGL.framework load, else a
string reason. All entry points exist off macOS and throw a self-explaining
error. Full types in [index.d.ts](../index.d.ts).

Verified on Apple M1 Pro / macOS 15 / XQuartz 21.1.23: 59 fps cube driven by
node-x11 ([examples/xquartz/cube.js](../examples/xquartz/cube.js)), resize +
SurfaceNotify + readback, child-window surfaces incl. mid-run moves, headless
FBO in `npm test`.

## 3. node-x11 work

Small and mechanical — the protocol half is pure JS and already written:

1. **Move [`examples/xquartz/appledri.js`](../examples/xquartz/appledri.js) to
   `lib/ext/appledri.js`** (verbatim — it is already in `lib/ext` style, cf.
   `apple-wm.js`). `X.require('appledri')` then works via the filename map.
   Surface: `QueryVersion(cb)`, `QueryDirectRenderingCapable(screen, cb)`,
   `CreateSurface(screen, drawable, clientId, cb) -> { key: [k0,k1], uid }`,
   `DestroySurface(screen, drawable)`, `ext.events.AppleDRISurfaceNotify`,
   `ext.NotifyKind.{Changed,Destroyed}`, and an `eventParsers` entry that
   yields `{ name: 'AppleDRISurfaceNotify', kind, time, arg }` (`arg` = the
   `uid` from CreateSurface — **not** a window id; route by uid, §4.3).
2. **`docs/ext/appledri.md`** — protocol reference. There is no shipped
   header; source of truth is the XQuartz server tree
   ([appledristr.h](https://github.com/XQuartz/xorg-server/blob/master/hw/xquartz/xpr/appledristr.h),
   [appledri.h](https://github.com/XQuartz/xorg-server/blob/master/hw/xquartz/xpr/appledri.h)).
   Wire summary (all little-endian on this transport, replies shown after the
   8-byte header node-x11 strips):

   | request | opcode | body | reply (offsets into stripped buffer) |
   | --- | --- | --- | --- |
   | QueryVersion | 0 | — | major u16@0, minor u16@2, patch u32@4 |
   | QueryDirectRenderingCapable | 1 | screen u32 | isCapable u8@0 |
   | CreateSurface | 2 | screen, drawable, client_id u32×3 | key_0 u32@0, key_1 u32@4, uid u32@8 |
   | DestroySurface | 3 | screen, drawable u32×2 | (void) |

   Event (classic, `firstEvent + 3`): byte1 = kind (0 changed, 1 destroyed),
   `time` in the extra word, `arg` (surface uid) at raw offset 4. Sent
   unsolicited to the client that created the surface; there is no mask to
   select. Opcodes 4–8 (AuthConnection, shm CreateSharedBuffer/SwapBuffers,
   CreatePixmap/DestroyPixmap) exist but the accelerated path does not need
   them; bind later if ever.
3. Optionally: an `examples/appledri/` mirroring `examples/dri3` — the cube
   in this repo's `examples/xquartz/` is exactly that, with the `require`
   paths flipped.
4. **No transport work.** Apple-DRI needs no fd passing, so `fdCapable`,
   `sendFds`, Bun caveats — none of it applies.

## 4. ntk work — the substance

### 4.1 Backend decision (`lib/gl.js`)

Keep one public backend name: **`direct`**. Which *flavor* of direct is a
per-platform implementation detail, exposed as e.g. `caps.flavor: 'dri3' |
'appledri'` for the curious, so react-x11's `hasDirectGL` /
`useSupports('shaders')` work untouched.

- `probeDirect(policy)`: on `probe.platform === 'darwin'`, require
  `probe.appledri === true` instead of gbm/egl/gles, and skip the render-node
  scan (`devices: []`, `device: null`). New coded error for the one darwin-only
  failure worth naming: `GL_NO_WINDOWSERVER` — `dri.apple.clientId()` threw,
  i.e. an SSH session; the remedy ("run from the logged-in GUI session") is
  nothing like `GL_NO_DRIVER`'s. Note `clientId()` connects on first call —
  either accept that at probe time or defer it to context creation and let
  probe only check `probe.appledri`.
- `glCapabilities(app)`: darwin branch —
  - still require a local socket (Apple-DRI is same-machine by construction),
  - **do not** require `canPassDescriptors` / `DRI3.fdCapable`,
  - `X.require('appledri')` instead of `dri3` + `present`; absence →
    `GL_NO_DRI3`-style coded error naming XQuartz ("this server has no
    Apple-DRI — not XQuartz?"). Optionally follow with
    `QueryDirectRenderingCapable(screen)`.
  - resolve `{ direct: true, flavor: 'appledri', AppleDRI, device: null }`.
- `backendFor(app)` unchanged.
- The `INSTALL_HINT` / `NO_DRIVER` hint text currently says "Direct rendering
  is Linux-only" — update.

### 4.2 The context: `lib/renderingcontext_cgl.js`

A sibling of `renderingcontext_gles.js` implementing the **same contract**
(this is the whole trick — `<glarea>` already speaks it):

| member | GLES/DRI3 backend does | CGL/Apple backend must do |
| --- | --- | --- |
| `backend` | `'direct'` | `'direct'` |
| `gl.*` on the context | `_installGL()` copies `dri.gl` with a currency check | same, `_bind()` = `ctx.makeCurrent()` |
| `makeCurrent()` | size check → maybe new generation → EGL make-current | CGL make-current; on size change also `ctx.update()` |
| `canRender()` | false while every buffer is with the server | **false until attached, and false while frame-throttled** (§4.4) |
| `onFrameAvailable` | fires on IdleNotify | fires on attach completing, and on each pacing tick |
| `SwapBuffers()` | swapchain.swap(): fd/pixmap/Present dance | `ctx.flush()`; return true |
| `ready` | resolves when the server accepted the first buffer | resolves when `attach(key)` succeeded (the path proven) |
| `renderer` | `gl.getString(RENDERER)` | same (reports e.g. "Apple M1 Pro") |
| `destroy()` | swapchain teardown | `AppleDRI.DestroySurface(screen, wid)` + `ctx.destroy()` |
| registration | `Drawable.renderingContextFactory['gles']` + `'opengl'` dispatcher | register `'cgl'`; the existing `'opengl'` dispatcher needs only to pick by `caps.flavor` |

Construction sequence (differs from GLES, which is fully synchronous): the
CGL context is created synchronously (so `gl.*` works immediately —
verified: an unattached context compiles shaders and renders to FBOs), but
the *surface* needs the X window to exist server-side:

1. constructor: `dri.apple.clientId()` (cache per app; first call connects),
   `new dri.apple.Context({...})`, install `gl`, `canRender -> false`.
2. after the window is created **and mapped** (the physical Quartz window
   must exist — `MapNotify` is the trustworthy signal):
   `AppleDRI.CreateSurface(screen, wid, cid)` → `ctx.attach(key)` → settle
   `ready`, flip `canRender`, fire `onFrameAvailable`. `<glarea>` already
   calls `wnd.map()` then `requestFrame()`, and already re-requests via
   `onFrameAvailable` when `canRender()` said no — so the pre-attach frames
   are absorbed by the existing machinery with no element changes.
3. re-attach path: on `SurfaceNotify(kind=Destroyed)` (window unmapped or
   frame recreated), drop `canRender`, and on the next MapNotify redo step 2
   — `attach()` on the same context replaces the old surface.

Unlike the GLES backend there is **no shared-GPU cache**: one CGL context per
`<glarea>`. CGL contexts are cheap, and one context can only be attached to
one surface. Consequence for consumers in §6 (resources are per-area);
follow-up to erase the difference in §7.

### 4.3 Event routing

Two ntk plumbing details, both small:

- `AppleDRISurfaceNotify` is a **classic** extension event, not a
  GenericEvent — the `_setGenericEventSink` path used for Present does not
  see it, and its payload identifies the surface by **uid**, not window id.
  Keep an app-level map `uid -> context` (filled from CreateSurface's reply),
  and route from one app-level `'event'` listener: kind 0 → `ctx.update()`
  (plus a repaint request), kind 1 → the §4.2 re-attach path.
- `ConfigureNotify` on the GL child window: after the size/position applies,
  call `ctx.update()`. (`<glarea>._syncGeometry` already calls
  `requestFrame()`; the `update()` belongs next to where the backend learns
  its new size — `makeCurrent()`'s size check is the natural place, and the
  child-move case is covered by SurfaceNotify anyway.)

### 4.4 Pacing (the one real design decision)

On Linux the display paces the loop for free: `frameLoop="always"` requests
a frame per draw, `canRender()` goes false while `maxInFlight` presents are
out, and `PresentIdleNotify` reopens the gate — net: display-rate.

Apple-DRI has no such backpressure: `flush()` returns immediately and always
succeeds, so `frameLoop="always"` + `setImmediate` would spin at 100% CPU.
Rather than teaching `<glarea>` a second pacing model, **reuse the same
gate**: after each `SwapBuffers()`, the CGL context sets `canRender()` false
and arms a ~16.6 ms timer (or `setSwapInterval(1)` remains available for
callers who accept a blocking flush); the timer fires → `canRender` true →
`onFrameAvailable()`. `<glarea>._drawFrame` then behaves identically on both
backends, and `frameLoop="always"` runs at ~display rate on both. A later
x11-dri addition can replace the timer with a real vsync callback (§7).

### 4.5 `chooseGLConfig` on darwin

react-x11 calls `app.chooseGLConfig(spec)` before creating the child window
and expects `{ backend, visual, depth }`. On the Apple flavor there is no
fbconfig query: answer synchronously with the root visual and depth
(`CopyFromParent` works — the verified child test used exactly that), map
`spec.DEPTH_SIZE` → `Context({ depthSize })`, and `depth: 32` + ARGB visual
when the spec asks for alpha (verify — §7).

## 5. react-x11 work

Expected: **none for correctness**, a few polish items:

- `glbackend.js` hint strings mention descriptors/DRI3/Linux — generalize
  ("direct rendering", "see ntk docs") so macOS failures read sensibly.
- `useSupports('shaders')` / `hasDirectGL` — work as-is once ntk resolves
  `{ direct: true }` on darwin.
- The `glx` prop naming (`<glarea glx={{ DEPTH_SIZE: 24 }}>`) is now
  backend-neutral in meaning; fine to keep, worth a doc note.
- Run the existing GL demos/tests on a Mac and fix what falls out — the
  verification matrix in §2 says the odds are good.

## 6. react-x11-components: scene-graph ground rules

For components (`<mesh>`, `<material>`, `<camera>`, …) that must render
identically on both hosts, the portable envelope is:

1. **Write shaders in GLSL ES 1.00** — no `#version` line (the addon
   handles the core-profile `#version 100` injection on macOS) or an explicit
   `#version 100`. **`#version 300 es` does not compile on macOS** (Apple GL
   4.1 has ES2 compatibility, not ES3). ES3-class *entry points* (VAOs,
   instancing, MRT, 3D textures) still work on both — gate on
   `gl`/context `features`, which reports identically — but their *shading*
   side (`sampler3D`, `in/out`, integer attributes) is ES 3.00-only and
   therefore Linux-only today. Practical rule: geometry/instancing features
   freely, shading features behind a `features`+dialect check.
2. **Treat GL resources as per-`<glarea>`.** On Linux ntk shares one EGL
   context across areas (resources incidentally shared); on macOS each area
   owns a CGL context (not shared until §7's share-group follow-up). Key
   caches by the `gl` object identity handed to `onDraw`/`onCreated` — that
   is correct on both.
3. **Do per-frame work in `onDraw`, sized from the `info` argument** — both
   backends guarantee viewport+clear happened and `SwapBuffers` follows; a
   scene graph is then a retained tree compiled to an ordered draw list run
   inside `onDraw`. Nothing about that list is platform-specific.
4. Pixel readback (`gl.readPixels`) works on both — usable for picking and
   for cross-platform golden-image tests of the scene graph (the CI-able
   macOS test shape is headless FBO rendering, as this repo's `npm test`
   does; XQuartz itself is not needed for that).

## 7. Follow-ups / open items

- **x11-dri**: `share` option on `apple.Context` (CGL share groups) so ntk
  can offer cross-area resource sharing matching Linux; a real vsync source
  (CVDisplayLink behind a napi threadsafe callback) to replace the §4.4
  timer; expose `AppleDRICreatePixmap`-based offscreen surfaces if a use
  appears.
- **Verify on macOS**: depth-32/ARGB `<glarea>` (server maps bpp 32 →
  `XP_DEPTH_ARGB8888`; untested), behavior under `quartz-wm` reparenting
  (the child-offset math in `DRIUpdateSurface` handles it server-side;
  re-check SurfaceNotify traffic), Intel macs (the addon compiles from
  source there; the path itself is the same).
- **XQuartz quirk to document in ntk**: X-side screenshots (`GetImage`,
  `import`) of a GL-surfaced window show stale X contents — the surface is
  composited by the WindowServer above the X framebuffer. Verify rendering
  with `readPixels`, not `GetImage`.
- **Not applicable on macOS, silently**: `GBM_USE.LINEAR` fallbacks,
  render-node selection, `maxInFlight` (policy knobs the CGL flavor ignores).
