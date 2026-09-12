// Type definitions for x11-dri.
//
// The runtime is CommonJS (`module.exports = { ... }`), so these are named
// exports: `import { Gpu } from 'x11-dri'` and `const { Gpu } =
// require('x11-dri')` both describe the same object. There is no default
// export, because there is no `.default` at runtime.
//
// Names and argument order follow WebGL wherever the binding does, so the
// signatures below should read the way the tutorials do. What differs from
// WebGL is deliberate and noted: GL objects are plain numbers rather than
// opaque handles, `getUniformLocation` answers -1 rather than null, and
// `getShaderParameter` answers a number rather than a boolean.
//
// test.js checks these declarations against the runtime surface, so an entry
// point added to the addon without a line here is a test failure rather than
// a silent gap.

/** A GL enum, bitfield, or object name. Every GL type here is a number. */
export type GLenum = number;
export type GLint = number;
export type GLuint = number;
export type GLsizei = number;
export type GLfloat = number;
export type GLbitfield = number;
/** A byte offset into the currently bound buffer. */
export type GLintptr = number;
/**
 * A sync object as `fenceSync` hands it out: a small number this binding
 * issues and checks, never the driver's pointer. 0 is "no sync".
 */
export type GLsync = number;

/**
 * Anything `napi_get_typedarray_info` accepts. Note this excludes `DataView`,
 * which the binding rejects.
 */
export type TypedArray =
    | Int8Array | Uint8Array | Uint8ClampedArray
    | Int16Array | Uint16Array
    | Int32Array | Uint32Array
    | Float32Array | Float64Array
    | BigInt64Array | BigUint64Array;

/** What `getActiveUniform` and `getActiveAttrib` report about one declaration. */
export interface ActiveInfo {
    /** An array is reported once, under its zeroth element: `"uOffsets[0]"`. */
    name: string;
    /** Element count — 1 for anything that is not an array. */
    size: number;
    /** One of the `FLOAT_VEC3`/`SAMPLER_2D`/… constants. */
    type: GLenum;
}

export interface ShaderPrecisionFormat {
    rangeMin: number;
    rangeMax: number;
    precision: number;
}

/**
 * Which optional entry points this driver and context actually have. Most
 * are core in ES 3.0 and extensions before it; the GPU timers are an
 * extension on every ES version. Either way a `false` here is a property of
 * the machine rather than of the build. A feature is `true` only when every
 * entry point it needs resolved; calling one that is missing throws.
 *
 * This is the probe, not `typeof`: the `gl` object is shared by every
 * context of both flavors, so its functions are always there. Read it after
 * `makeCurrent`/`attach` — `Gpu.features`, `AppleContext.features`, or
 * `gl.getFeatures()` for whichever context is current.
 */
export interface GlFeatures {
    /** `createVertexArray`, `bindVertexArray`, `deleteVertexArray`, `isVertexArray` */
    vertexArrayObject: boolean;
    /** `drawArraysInstanced`, `drawElementsInstanced`, `vertexAttribDivisor` */
    instancedArrays: boolean;
    /** `drawBuffers` */
    drawBuffers: boolean;
    /** `texImage3D` and the rest of the 3D/array texture family */
    texture3D: boolean;
    /** `texStorage2D`, `texStorage3D` */
    textureStorage: boolean;
    /**
     * `renderbufferStorageMultisample`, `blitFramebuffer`. Core in ES 3.0
     * and desktop 3.0 — so always on the CGL flavor, the legacy profile too
     * (ARB_framebuffer_object) — and the ANGLE or NV
     * framebuffer_multisample/_blit pair on an ES 2.0 driver.
     * `getParameter(MAX_SAMPLES)` says how many samples.
     */
    multisample: boolean;
    /** `readBuffer`: ES 3.0 or NV_read_buffer; desktop has had it since 1.0. */
    readBuffer: boolean;
    /**
     * `fenceSync`, `clientWaitSync`, `waitSync`, `getSyncParameter`,
     * `deleteSync`, `isSync`. Core in ES 3.0 and desktop 3.2 (ARB_sync on the
     * legacy profile), APPLE_sync on ES 2.0.
     */
    sync: boolean;
    /**
     * `createQuery`, `deleteQuery`, `isQuery`, `beginQuery`, `endQuery`,
     * `getQuery`, `getQueryParameter`, `getQueryObjectui64v`: GPU time
     * elapsed, with `TIME_ELAPSED`. On the GLES flavor it needs
     * GL_EXT_disjoint_timer_query, on ES 3.0 as much as 2.0 — ES's own query
     * objects have no timer. Core in desktop 3.3, so always on the CGL
     * flavor (EXT_timer_query on the legacy profile). A driver may still
     * have a 0-bit counter, so ask `getQuery(TIME_ELAPSED,
     * QUERY_COUNTER_BITS) > 0` before trusting the readings.
     */
    timerQuery: boolean;
    /**
     * `queryCounter`: a GPU timestamp in the command stream. With
     * GL_EXT_disjoint_timer_query on the GLES flavor, desktop 3.3 on the CGL
     * flavor (not the legacy profile). Whether that clock ticks is
     * `getQuery(TIMESTAMP, QUERY_COUNTER_BITS) > 0` — which Apple's GL on
     * Apple Silicon answers with 0.
     */
    timestampQuery: boolean;
    /**
     * `gl.importDmabuf`: wrap a dma-buf descriptor in an EGLImage and point
     * a texture at it. Needs `EGL_EXT_image_dma_buf_import` on the display
     * and `GL_OES_EGL_image` in the driver, so it is `false` on the CGL
     * flavor and on any host without dma-buf at all.
     */
    dmabufImport: boolean;
    /**
     * Whether `importDmabuf` accepts an explicit `modifier` (and a fourth
     * plane), from `EGL_EXT_image_dma_buf_import_modifiers`. Without it only
     * `MODIFIER.INVALID` — the implicit layout — can be imported, which is
     * what a `DRI3.BufferFromPixmap` buffer has anyway.
     */
    dmabufImportModifiers: boolean;
    /**
     * Whether `importDmabuf` can bind to `TEXTURE_EXTERNAL_OES`, from
     * `GL_OES_EGL_image_external`: the target a YUV buffer generally has to
     * be sampled through, with `samplerExternalOES` in the shader.
     */
    externalTexture: boolean;
}

/** What the driver reports through `glGetString(GL_VERSION)`, parsed. */
export interface GlVersion {
    major: number;
    minor: number;
    /** The unparsed string, e.g. `"OpenGL ES 3.0 Mesa 26.0.3"`. */
    string: string;
}

/**
 * What this machine can do. Each capability is `true` when usable or a string
 * explaining why not; `dmabuf: false` is the one to branch on, since it means
 * the host itself rather than the installation is the limit.
 */
export interface ProbeResult {
    platform: string;
    dmabuf: boolean;
    gbm: true | string;
    egl: true | string;
    gles: true | string;
    /**
     * Whether the client half of XQuartz's Apple-DRI direct rendering
     * (libXplugin + the system OpenGL framework) loads. `true` on macOS with
     * those libraries; a string naming the reason everywhere else. Whether
     * the WindowServer will actually talk to this process (a logged-in GUI
     * session, not SSH) is settled later, by `apple.clientId()`.
     */
    appledri: true | string;
    udmabuf: boolean | string;
}

/**
 * The result of `Surface.swap()`. The dma-buf export fields are present only
 * the first time a buffer of the swapchain comes round, which `isNew`
 * discriminates:
 *
 * ```ts
 * const out = surface.swap();
 * if (out && out.isNew) dri3.PixmapFromBuffer(pixmap, drawable, ..., out.fd);
 * ```
 */
export type SwapResult =
    | {
        /** Identifies this buffer for `release()`; stable across frames. */
        key: number;
        isNew: false;
        width: number;
        height: number;
    }
    | {
        key: number;
        isNew: true;
        width: number;
        height: number;
        /** A dma-buf descriptor. `DRI3.PixmapFromBuffer` consumes it. */
        fd: number;
        stride: number;
        offset: number;
        modifier: bigint;
    };

/** CPU memory the kernel has turned into a dma-buf. See `createUdmabuf`. */
export interface Udmabuf {
    /** The dma-buf descriptor — consumed by `DRI3.PixmapFromBuffer`. */
    fd: number;
    memfd: number;
    size: number;
    /** The same memory, mapped for JavaScript to write into. */
    buffer: ArrayBuffer;
    /** Bracket CPU writes with `START | WRITE` and `END | WRITE`. */
    sync(flags: number): void;
    close(): void;
}

/** One plane of a dma-buf, as `DRI3.BuffersFromPixmap` reports it. */
export interface DmabufPlane {
    /**
     * The descriptor. Consumed when the import succeeds — `dup` it first to
     * keep a copy. A multi-planar buffer may name the same descriptor in
     * every plane.
     */
    fd: number;
    /** Bytes per row of this plane. */
    stride: number;
    /** Bytes from the start of the buffer to this plane. Defaults to 0. */
    offset?: number;
}

export interface ImportDmabufOptions {
    width: number;
    height: number;
    /** A DRM fourcc — `FORMAT.XRGB8888` for a depth-24 pixmap, `ARGB8888` for depth 32. */
    fourcc: number;
    /**
     * The buffer's layout. Defaults to `MODIFIER.INVALID`, the implicit
     * layout; anything else needs `features.dmabufImportModifiers`.
     */
    modifier?: bigint | number;
    /**
     * `TEXTURE_2D` (the default) or `TEXTURE_EXTERNAL_OES`, which needs
     * `features.externalTexture` and a `samplerExternalOES` in the shader.
     * A YUV buffer generally needs the latter; an RGB one does not.
     */
    target?: GLenum;
    /** One to four planes. */
    planes: DmabufPlane[];
}

/**
 * A dma-buf someone else allocated, as a GL texture. Obtained from
 * `gl.importDmabuf` — there is no exported constructor. Nothing was copied:
 * the texture samples the buffer where it already lives.
 */
export interface ImportedImage {
    /** Bind with `gl.bindTexture(image.target, image.texture)`. */
    readonly texture: GLuint;
    /** `TEXTURE_2D` or `TEXTURE_EXTERNAL_OES`, whichever the import used. */
    readonly target: GLenum;
    readonly width: number;
    readonly height: number;
    /**
     * `glDeleteTextures` + `eglDestroyImage`. Needs the context the import
     * was made in to be current. Calling it twice, or after that context is
     * gone, does nothing.
     */
    destroy(): void;
}

/** A dma-buf mapped for CPU access. See `mapDmabuf`. */
export interface MappedDmabuf {
    /** The descriptor that was mapped. Still the caller's to close. */
    fd: number;
    size: number;
    /** False when the descriptor was exported read-only — writes would fault. */
    writable: boolean;
    /** The buffer's pixels. Detached by `close()`. */
    buffer: ArrayBuffer;
    /** Bracket access with `START | READ` and `END | READ` (or `WRITE`). */
    sync(flags: number): void;
    /** Unmap now rather than at the next GC. Idempotent. */
    close(): void;
}

export interface GpuOptions {
    /** A specific render node. Defaults to the first of `listRenderNodes()`. */
    devicePath?: string;
    /** An already-open DRM fd to use instead of opening a render node. */
    fd?: number;
    /** A `FORMAT` value; must match the depth of the window it will feed. */
    format?: number;
    /** EGL depth buffer bits. Defaults to 16. */
    depthSize?: number;
    /**
     * `'auto'` (the default) asks for ES 3.0 and falls back to ES 2.0. `3`
     * insists, erroring rather than downgrading silently; `2` pins.
     *
     * This is a floor, not a ceiling: EGL may hand back a higher version than
     * was asked for, so read `Gpu.glVersion` for what the driver gave.
     */
    glVersion?: 2 | 3 | 'auto';
}

/**
 * A GBM swapchain. Obtained from `Gpu.createSurface` — there is no exported
 * constructor.
 */
export interface Surface {
    readonly width: number;
    readonly height: number;
    /**
     * Finish the frame and take the new front buffer. Returns `null` when
     * every buffer is still held by the consumer — wait for a release, redraw
     * and swap again, which is the natural pacing signal.
     *
     * The buffer stays owned by the caller until `release(key)`.
     */
    swap(): SwapResult | null;
    release(key: number): void;
    destroy(): void;
}

/** One EGL context on one render node, plus the GBM device behind it. */
export declare class Gpu {
    constructor(opts?: GpuOptions);

    /** The render node this opened, or `null` when constructed from an fd. */
    readonly devicePath: string | null;
    readonly format: number;
    /** The GL entry points. The same object as the module's `gl` export. */
    readonly gl: GLContext;

    readonly eglVendor: string;
    readonly eglVersion: string;
    /** The ES version EGL was asked for and granted: 2 or 3. */
    readonly contextVersion: 2 | 3;

    /**
     * What the driver reports, which can be higher than `contextVersion` —
     * Mesa answers an ES 2.0 request with an ES 3.0 context. This is the one
     * to branch on.
     *
     * Only knowable with a context current, so it is `undefined` until the
     * first `makeCurrent` and `null` after `makeCurrent(null)`.
     */
    readonly glVersion?: GlVersion | null;
    /** Which optional entry points resolved. Set by `makeCurrent`, like `glVersion`. */
    readonly features?: GlFeatures | null;

    /**
     * @param useFlags A `GBM_USE` mask. `RENDERING` is implied; add `LINEAR`
     *                 when the consuming device may not understand this GPU's
     *                 tiled layouts.
     */
    createSurface(width: number, height: number, useFlags?: number): Surface;
    /** Bind the context, or unbind it with `null`. Refreshes `features` and `glVersion`. */
    makeCurrent(surface: Surface | null): void;
    destroy(): void;
}

export interface AppleContextOptions {
    /** Color buffer bits (R+G+B). Defaults to 24. */
    colorSize?: number;
    /** Defaults to 8. */
    alphaSize?: number;
    /** Defaults to 16. */
    depthSize?: number;
    /** Defaults to 0. */
    stencilSize?: number;
    /** Defaults to true. */
    doubleBuffer?: boolean;
    /**
     * `'core'` (the default) asks CGL for a core profile — GL 4.1 on Metal
     * hardware, whose ES2 compatibility compiles GLSL ES 1.00 shaders
     * unchanged. `'legacy'` is GL 2.1 with GLSL 1.20, for desktop-GL shaders
     * that predate `#version` gating.
     */
    profile?: 'core' | 'legacy';
}

/**
 * A CGL rendering context bound to an XQuartz window's WindowServer surface —
 * the client half of the Apple-DRI direct rendering path. See `apple`.
 */
export declare class AppleContext {
    constructor(opts?: AppleContextOptions);

    /** The GL entry points. The same object as the module's `gl` export. */
    readonly gl: GLContext;
    /** What the driver reports. Set by `attach`/`makeCurrent`. */
    readonly glVersion?: GlVersion;
    /** Which optional entry points resolved. Set by `attach`/`makeCurrent`. */
    readonly features?: GlFeatures;

    /**
     * Import the surface the X server exported for this process (the
     * `key_0`/`key_1` words of the AppleDRICreateSurface reply) and bind the
     * context to it. The context comes out current. Attaching again replaces
     * the surface — the recovery move after a SurfaceNotify(destroyed) once
     * a fresh surface has been created.
     */
    attach(key: [number, number] | number[]): void;
    attach(key0: number, key1: number): void;
    makeCurrent(): void;
    /**
     * Present the frame — this backend's swap. No fd, no Present round-trip:
     * the WindowServer composites the surface directly.
     */
    flush(): void;
    /**
     * Refresh the context's idea of the surface geometry: call on
     * ConfigureNotify, or on an AppleDRISurfaceNotify with kind 0 (changed).
     */
    update(): void;
    /**
     * 0 (the default): `flush` returns immediately. 1: `flush` waits for the
     * vertical retrace — real vsync, but it blocks the event loop for up to
     * a frame, so a timer-paced loop usually serves a Node process better.
     */
    setSwapInterval(n: number): void;
    /**
     * An offscreen render target whose color buffer is an IOSurface — how GL
     * output reaches a Core Animation layer when there is no X server
     * exporting a window surface (the react-x11 Cocoa backend). The id is a
     * process-global IOSurfaceID: the presentation side looks it up and sets
     * the surface as `layer.contents`. Create two and alternate, like any
     * swapchain. Makes the context current. `depth: false` skips the
     * depth/stencil renderbuffer.
     */
    createTarget(width: number, height: number,
                 opts?: { depth?: boolean }): AppleTarget;
    /**
     * Route subsequent GL draws into the target's IOSurface, or back to "no
     * framebuffer" for null. Makes the context current.
     */
    bindTarget(target: AppleTarget | null): void;
    destroy(): void;
}

/** One IOSurface-backed framebuffer of an {@link AppleContext}. */
export declare class AppleTarget {
    /** The process-global IOSurfaceID the presentation side looks up. */
    readonly iosurfaceId: number;
    /** The GL framebuffer name — what bindFramebuffer(null) should mean to
     *  a consumer treating this target as its default framebuffer. */
    readonly fbo: number;
    readonly width: number;
    readonly height: number;
    /** `ctx.bindTarget(this)`. */
    bind(): void;
    /** Delete the GL objects and release the IOSurface. */
    destroy(): void;
}

/**
 * The macOS / XQuartz accelerated path (Apple-DRI + CGL). The protocol side —
 * AppleDRICreateSurface, carrying `clientId()` and answering the `key` that
 * `AppleContext.attach` consumes — is plain X, spoken by the x11 package.
 * Every entry point throws with a reason on other platforms.
 */
export declare const apple: {
    /**
     * This process's WindowServer client id — the `client_id` argument of
     * AppleDRICreateSurface. Connects to the WindowServer on first call and
     * throws (naming the reason) where there is none, e.g. over SSH.
     */
    clientId(): number;
    /**
     * The fastest refresh rate any connected display is running at, in Hz, or
     * `null` when it cannot be determined (e.g. over SSH — no GUI session,
     * no rate). XQuartz's RandR advertises modes without timing data, so a
     * consumer pacing frames on this path asks macOS directly. The maximum
     * across displays is a pacing *ceiling*, matching the fastest-CRTC
     * semantics RandR gives on Linux; for variable-rate panels (ProMotion)
     * it is the nominal maximum. Needs no WindowServer handshake.
     */
    refreshRate(): number | null;
    Context: typeof AppleContext;
};

/** What `getParameter` can answer, depending on the parameter asked for. */
export type GLParameterValue = number | boolean | number[] | boolean[];

/** What a uniform reads back as, in the type the program declared it with. */
export type GLUniformValue =
    number | boolean | Float32Array | Int32Array | boolean[] | null;

/**
 * The GL ES constants the binding covers. Merged into `gl`, so
 * `gl.TRIANGLE_STRIP` and `GL.TRIANGLE_STRIP` are the same value.
 */
export interface GLConstants {
    readonly DEPTH_BUFFER_BIT: GLenum;
    readonly COLOR_BUFFER_BIT: GLenum;
    readonly POINTS: GLenum;
    readonly LINES: GLenum;
    readonly LINE_LOOP: GLenum;
    readonly LINE_STRIP: GLenum;
    readonly TRIANGLES: GLenum;
    readonly TRIANGLE_STRIP: GLenum;
    readonly TRIANGLE_FAN: GLenum;
    readonly DEPTH_TEST: GLenum;
    readonly CULL_FACE: GLenum;
    readonly BLEND: GLenum;
    readonly SCISSOR_TEST: GLenum;
    readonly DITHER: GLenum;
    readonly NEVER: GLenum;
    readonly LESS: GLenum;
    readonly EQUAL: GLenum;
    readonly LEQUAL: GLenum;
    readonly GREATER: GLenum;
    readonly NOTEQUAL: GLenum;
    readonly GEQUAL: GLenum;
    readonly ALWAYS: GLenum;
    readonly FRONT: GLenum;
    readonly BACK: GLenum;
    readonly FRONT_AND_BACK: GLenum;
    readonly CW: GLenum;
    readonly CCW: GLenum;
    readonly BYTE: GLenum;
    readonly UNSIGNED_BYTE: GLenum;
    readonly SHORT: GLenum;
    readonly UNSIGNED_SHORT: GLenum;
    readonly INT: GLenum;
    readonly UNSIGNED_INT: GLenum;
    readonly FLOAT: GLenum;
    readonly RGBA: GLenum;
    readonly RGB: GLenum;
    readonly ALPHA: GLenum;
    readonly ARRAY_BUFFER: GLenum;
    readonly ELEMENT_ARRAY_BUFFER: GLenum;
    readonly STREAM_DRAW: GLenum;
    readonly STATIC_DRAW: GLenum;
    readonly DYNAMIC_DRAW: GLenum;
    readonly FRAGMENT_SHADER: GLenum;
    readonly VERTEX_SHADER: GLenum;
    readonly COMPILE_STATUS: GLenum;
    readonly LINK_STATUS: GLenum;
    readonly INFO_LOG_LENGTH: GLenum;
    readonly UNPACK_ALIGNMENT: GLenum;
    readonly PACK_ALIGNMENT: GLenum;
    readonly NO_ERROR: GLenum;
    readonly VENDOR: GLenum;
    readonly RENDERER: GLenum;
    readonly VERSION: GLenum;
    readonly SHADING_LANGUAGE_VERSION: GLenum;

    // errors, so a getError() result can be named rather than printed in hex
    readonly INVALID_ENUM: GLenum;
    readonly INVALID_VALUE: GLenum;
    readonly INVALID_OPERATION: GLenum;
    readonly OUT_OF_MEMORY: GLenum;
    readonly INVALID_FRAMEBUFFER_OPERATION: GLenum;

    // textures
    readonly TEXTURE_2D: GLenum;
    readonly TEXTURE: GLenum;
    readonly TEXTURE_CUBE_MAP: GLenum;
    readonly TEXTURE_CUBE_MAP_POSITIVE_X: GLenum;
    readonly TEXTURE_CUBE_MAP_NEGATIVE_X: GLenum;
    readonly TEXTURE_CUBE_MAP_POSITIVE_Y: GLenum;
    readonly TEXTURE_CUBE_MAP_NEGATIVE_Y: GLenum;
    readonly TEXTURE_CUBE_MAP_POSITIVE_Z: GLenum;
    readonly TEXTURE_CUBE_MAP_NEGATIVE_Z: GLenum;
    readonly TEXTURE0: GLenum;
    readonly TEXTURE1: GLenum;
    readonly TEXTURE2: GLenum;
    readonly TEXTURE3: GLenum;
    readonly TEXTURE4: GLenum;
    readonly TEXTURE5: GLenum;
    readonly TEXTURE6: GLenum;
    readonly TEXTURE7: GLenum;
    readonly ACTIVE_TEXTURE: GLenum;
    readonly TEXTURE_MAG_FILTER: GLenum;
    readonly TEXTURE_MIN_FILTER: GLenum;
    readonly TEXTURE_WRAP_S: GLenum;
    readonly TEXTURE_WRAP_T: GLenum;
    readonly NEAREST: GLenum;
    readonly LINEAR: GLenum;
    readonly NEAREST_MIPMAP_NEAREST: GLenum;
    readonly LINEAR_MIPMAP_NEAREST: GLenum;
    readonly NEAREST_MIPMAP_LINEAR: GLenum;
    readonly LINEAR_MIPMAP_LINEAR: GLenum;
    readonly REPEAT: GLenum;
    readonly CLAMP_TO_EDGE: GLenum;
    readonly MIRRORED_REPEAT: GLenum;
    readonly LUMINANCE: GLenum;
    readonly LUMINANCE_ALPHA: GLenum;
    readonly UNSIGNED_SHORT_4_4_4_4: GLenum;
    readonly UNSIGNED_SHORT_5_5_5_1: GLenum;
    readonly UNSIGNED_SHORT_5_6_5: GLenum;
    readonly MAX_TEXTURE_SIZE: GLenum;
    readonly MAX_TEXTURE_IMAGE_UNITS: GLenum;
    readonly MAX_COMBINED_TEXTURE_IMAGE_UNITS: GLenum;
    readonly MAX_VERTEX_TEXTURE_IMAGE_UNITS: GLenum;

    // blending
    readonly ZERO: GLenum;
    readonly ONE: GLenum;
    readonly SRC_COLOR: GLenum;
    readonly ONE_MINUS_SRC_COLOR: GLenum;
    readonly SRC_ALPHA: GLenum;
    readonly ONE_MINUS_SRC_ALPHA: GLenum;
    readonly DST_ALPHA: GLenum;
    readonly ONE_MINUS_DST_ALPHA: GLenum;
    readonly DST_COLOR: GLenum;
    readonly ONE_MINUS_DST_COLOR: GLenum;
    readonly SRC_ALPHA_SATURATE: GLenum;
    readonly CONSTANT_COLOR: GLenum;
    readonly ONE_MINUS_CONSTANT_COLOR: GLenum;
    readonly CONSTANT_ALPHA: GLenum;
    readonly ONE_MINUS_CONSTANT_ALPHA: GLenum;
    readonly BLEND_COLOR: GLenum;
    readonly FUNC_ADD: GLenum;
    readonly FUNC_SUBTRACT: GLenum;
    readonly FUNC_REVERSE_SUBTRACT: GLenum;

    // stencil
    readonly STENCIL_BUFFER_BIT: GLenum;
    readonly STENCIL_TEST: GLenum;
    readonly KEEP: GLenum;
    readonly REPLACE: GLenum;
    readonly INCR: GLenum;
    readonly DECR: GLenum;
    readonly INVERT: GLenum;
    readonly INCR_WRAP: GLenum;
    readonly DECR_WRAP: GLenum;
    // the stencil state getParameter reads back: front-facing (and the
    // one-facing setters') first, then the back-facing copy the *Separate
    // setters can make differ
    readonly STENCIL_FUNC: GLenum;
    readonly STENCIL_REF: GLenum;
    readonly STENCIL_VALUE_MASK: GLenum;
    readonly STENCIL_FAIL: GLenum;
    readonly STENCIL_PASS_DEPTH_FAIL: GLenum;
    readonly STENCIL_PASS_DEPTH_PASS: GLenum;
    readonly STENCIL_WRITEMASK: GLenum;
    readonly STENCIL_CLEAR_VALUE: GLenum;
    readonly STENCIL_BACK_FUNC: GLenum;
    readonly STENCIL_BACK_REF: GLenum;
    readonly STENCIL_BACK_VALUE_MASK: GLenum;
    readonly STENCIL_BACK_FAIL: GLenum;
    readonly STENCIL_BACK_PASS_DEPTH_FAIL: GLenum;
    readonly STENCIL_BACK_PASS_DEPTH_PASS: GLenum;
    readonly STENCIL_BACK_WRITEMASK: GLenum;

    // framebuffer and renderbuffer objects
    readonly FRAMEBUFFER: GLenum;
    readonly RENDERBUFFER: GLenum;
    readonly COLOR_ATTACHMENT0: GLenum;
    readonly DEPTH_ATTACHMENT: GLenum;
    readonly STENCIL_ATTACHMENT: GLenum;
    readonly DEPTH_STENCIL_ATTACHMENT: GLenum;
    readonly FRAMEBUFFER_COMPLETE: GLenum;
    readonly FRAMEBUFFER_INCOMPLETE_ATTACHMENT: GLenum;
    readonly FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: GLenum;
    readonly FRAMEBUFFER_INCOMPLETE_DIMENSIONS: GLenum;
    readonly FRAMEBUFFER_UNSUPPORTED: GLenum;
    readonly DEPTH_COMPONENT16: GLenum;
    readonly STENCIL_INDEX8: GLenum;
    readonly DEPTH_STENCIL: GLenum;
    readonly RGBA4: GLenum;
    readonly RGB5_A1: GLenum;
    readonly RGB565: GLenum;
    readonly MAX_RENDERBUFFER_SIZE: GLenum;

    // state a draw loop reads back
    readonly VIEWPORT: GLenum;
    readonly SCISSOR_BOX: GLenum;
    readonly COLOR_CLEAR_VALUE: GLenum;
    readonly COLOR_WRITEMASK: GLenum;
    readonly DEPTH_CLEAR_VALUE: GLenum;
    readonly DEPTH_WRITEMASK: GLenum;
    readonly LINE_WIDTH: GLenum;
    readonly POLYGON_OFFSET_FILL: GLenum;
    readonly POLYGON_OFFSET_FACTOR: GLenum;
    readonly POLYGON_OFFSET_UNITS: GLenum;
    readonly SAMPLE_ALPHA_TO_COVERAGE: GLenum;
    readonly SAMPLE_COVERAGE: GLenum;
    readonly MAX_VERTEX_ATTRIBS: GLenum;
    readonly MAX_VARYING_VECTORS: GLenum;
    readonly MAX_VERTEX_UNIFORM_VECTORS: GLenum;
    readonly MAX_FRAGMENT_UNIFORM_VECTORS: GLenum;
    readonly VALIDATE_STATUS: GLenum;
    readonly DELETE_STATUS: GLenum;
    readonly SHADER_TYPE: GLenum;

    // the types getActiveUniform/getActiveAttrib report
    readonly FLOAT_VEC2: GLenum;
    readonly FLOAT_VEC3: GLenum;
    readonly FLOAT_VEC4: GLenum;
    readonly INT_VEC2: GLenum;
    readonly INT_VEC3: GLenum;
    readonly INT_VEC4: GLenum;
    readonly BOOL: GLenum;
    readonly BOOL_VEC2: GLenum;
    readonly BOOL_VEC3: GLenum;
    readonly BOOL_VEC4: GLenum;
    readonly FLOAT_MAT2: GLenum;
    readonly FLOAT_MAT3: GLenum;
    readonly FLOAT_MAT4: GLenum;
    readonly SAMPLER_2D: GLenum;
    readonly SAMPLER_CUBE: GLenum;

    // program and shader properties
    readonly ACTIVE_UNIFORMS: GLenum;
    readonly ACTIVE_UNIFORM_MAX_LENGTH: GLenum;
    readonly ACTIVE_ATTRIBUTES: GLenum;
    readonly ACTIVE_ATTRIBUTE_MAX_LENGTH: GLenum;
    readonly ATTACHED_SHADERS: GLenum;
    readonly SHADER_SOURCE_LENGTH: GLenum;
    readonly SHADER_COMPILER: GLenum;
    readonly LOW_FLOAT: GLenum;
    readonly MEDIUM_FLOAT: GLenum;
    readonly HIGH_FLOAT: GLenum;
    readonly LOW_INT: GLenum;
    readonly MEDIUM_INT: GLenum;
    readonly HIGH_INT: GLenum;

    // vertex attribute state, for getVertexAttrib
    readonly VERTEX_ATTRIB_ARRAY_ENABLED: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_SIZE: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_STRIDE: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_TYPE: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_NORMALIZED: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_POINTER: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: GLenum;
    readonly CURRENT_VERTEX_ATTRIB: GLenum;

    // what is bound, and what the bound thing is made of
    readonly ARRAY_BUFFER_BINDING: GLenum;
    readonly ELEMENT_ARRAY_BUFFER_BINDING: GLenum;
    readonly FRAMEBUFFER_BINDING: GLenum;
    readonly RENDERBUFFER_BINDING: GLenum;
    readonly CURRENT_PROGRAM: GLenum;
    readonly TEXTURE_BINDING_2D: GLenum;
    readonly TEXTURE_BINDING_CUBE_MAP: GLenum;
    readonly BUFFER_SIZE: GLenum;
    readonly BUFFER_USAGE: GLenum;
    readonly FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: GLenum;
    readonly FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: GLenum;
    readonly FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: GLenum;
    readonly FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: GLenum;
    readonly RENDERBUFFER_WIDTH: GLenum;
    readonly RENDERBUFFER_HEIGHT: GLenum;
    readonly RENDERBUFFER_INTERNAL_FORMAT: GLenum;
    readonly RENDERBUFFER_RED_SIZE: GLenum;
    readonly RENDERBUFFER_GREEN_SIZE: GLenum;
    readonly RENDERBUFFER_BLUE_SIZE: GLenum;
    readonly RENDERBUFFER_ALPHA_SIZE: GLenum;
    readonly RENDERBUFFER_DEPTH_SIZE: GLenum;
    readonly RENDERBUFFER_STENCIL_SIZE: GLenum;

    // compressed textures. The entry points are core ES 2.0 but every format
    // below is an extension: check getSupportedExtensions() or
    // getParameter(COMPRESSED_TEXTURE_FORMATS) before uploading one.
    readonly EXTENSIONS: GLenum;
    readonly NUM_COMPRESSED_TEXTURE_FORMATS: GLenum;
    readonly COMPRESSED_TEXTURE_FORMATS: GLenum;
    readonly ETC1_RGB8_OES: GLenum;
    readonly COMPRESSED_RGB_S3TC_DXT1_EXT: GLenum;
    readonly COMPRESSED_RGBA_S3TC_DXT1_EXT: GLenum;
    readonly COMPRESSED_RGBA_S3TC_DXT3_EXT: GLenum;
    readonly COMPRESSED_RGBA_S3TC_DXT5_EXT: GLenum;
    readonly COMPRESSED_R11_EAC: GLenum;
    readonly COMPRESSED_SIGNED_R11_EAC: GLenum;
    readonly COMPRESSED_RG11_EAC: GLenum;
    readonly COMPRESSED_SIGNED_RG11_EAC: GLenum;
    readonly COMPRESSED_RGB8_ETC2: GLenum;
    readonly COMPRESSED_SRGB8_ETC2: GLenum;
    readonly COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: GLenum;
    readonly COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: GLenum;
    readonly COMPRESSED_RGBA8_ETC2_EAC: GLenum;
    readonly COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: GLenum;
    readonly COMPRESSED_RGBA_ASTC_4x4_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_5x4_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_5x5_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_6x5_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_6x6_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_8x5_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_8x6_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_8x8_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_10x5_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_10x6_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_10x8_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_10x10_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_12x10_KHR: GLenum;
    readonly COMPRESSED_RGBA_ASTC_12x12_KHR: GLenum;

    // vertex array objects, instancing and multiple render targets. These
    // three are core in ES 3.0 and extensions before it, so the entry points
    // may be missing — gpu.features says which of them this driver has.
    readonly VERTEX_ARRAY_BINDING: GLenum;
    readonly VERTEX_ATTRIB_ARRAY_DIVISOR: GLenum;
    readonly MAX_DRAW_BUFFERS: GLenum;
    readonly MAX_COLOR_ATTACHMENTS: GLenum;
    readonly NONE: GLenum;
    readonly DRAW_BUFFER0: GLenum;
    readonly DRAW_BUFFER1: GLenum;
    readonly DRAW_BUFFER2: GLenum;
    readonly DRAW_BUFFER3: GLenum;
    readonly DRAW_BUFFER4: GLenum;
    readonly DRAW_BUFFER5: GLenum;
    readonly DRAW_BUFFER6: GLenum;
    readonly DRAW_BUFFER7: GLenum;
    readonly COLOR_ATTACHMENT1: GLenum;
    readonly COLOR_ATTACHMENT2: GLenum;
    readonly COLOR_ATTACHMENT3: GLenum;
    readonly COLOR_ATTACHMENT4: GLenum;
    readonly COLOR_ATTACHMENT5: GLenum;
    readonly COLOR_ATTACHMENT6: GLenum;
    readonly COLOR_ATTACHMENT7: GLenum;

    // ---- ES 3.0 textures ----
    // 3D and array textures differ only in the target: TEXTURE_3D filters
    // across the third axis, TEXTURE_2D_ARRAY keeps its layers independent.
    readonly TEXTURE_3D: GLenum;
    readonly TEXTURE_2D_ARRAY: GLenum;
    readonly TEXTURE_BINDING_3D: GLenum;
    readonly TEXTURE_BINDING_2D_ARRAY: GLenum;
    readonly TEXTURE_WRAP_R: GLenum;
    readonly TEXTURE_BASE_LEVEL: GLenum;
    readonly TEXTURE_MAX_LEVEL: GLenum;
    readonly TEXTURE_MIN_LOD: GLenum;
    readonly TEXTURE_MAX_LOD: GLenum;
    readonly TEXTURE_COMPARE_MODE: GLenum;
    readonly TEXTURE_COMPARE_FUNC: GLenum;
    readonly COMPARE_REF_TO_TEXTURE: GLenum;
    readonly TEXTURE_IMMUTABLE_FORMAT: GLenum;
    readonly MAX_3D_TEXTURE_SIZE: GLenum;
    readonly MAX_ARRAY_TEXTURE_LAYERS: GLenum;
    readonly MAX_ELEMENTS_VERTICES: GLenum;
    readonly MAX_ELEMENTS_INDICES: GLenum;

    // the pixel-store state a 3D upload needs to walk a subrectangle
    readonly UNPACK_ROW_LENGTH: GLenum;
    readonly UNPACK_SKIP_ROWS: GLenum;
    readonly UNPACK_SKIP_PIXELS: GLenum;
    readonly UNPACK_IMAGE_HEIGHT: GLenum;
    readonly UNPACK_SKIP_IMAGES: GLenum;
    readonly PACK_ROW_LENGTH: GLenum;
    readonly PACK_SKIP_ROWS: GLenum;
    readonly PACK_SKIP_PIXELS: GLenum;

    // formats and types new in ES 3.0
    readonly RED: GLenum;
    readonly RG: GLenum;
    readonly DEPTH_COMPONENT: GLenum;
    readonly RED_INTEGER: GLenum;
    readonly RG_INTEGER: GLenum;
    readonly RGB_INTEGER: GLenum;
    readonly RGBA_INTEGER: GLenum;
    readonly HALF_FLOAT: GLenum;
    readonly UNSIGNED_INT_2_10_10_10_REV: GLenum;
    readonly UNSIGNED_INT_10F_11F_11F_REV: GLenum;
    readonly UNSIGNED_INT_5_9_9_9_REV: GLenum;
    readonly UNSIGNED_INT_24_8: GLenum;
    readonly FLOAT_32_UNSIGNED_INT_24_8_REV: GLenum;

    // sized internal formats — texStorage takes only these, and texImage3D
    // wants them too whenever the type is not a plain UNSIGNED_BYTE
    readonly R8: GLenum;
    readonly RG8: GLenum;
    readonly RGB8: GLenum;
    readonly RGBA8: GLenum;
    readonly SRGB8: GLenum;
    readonly SRGB8_ALPHA8: GLenum;
    readonly RGB10_A2: GLenum;
    readonly R16F: GLenum;
    readonly RG16F: GLenum;
    readonly RGB16F: GLenum;
    readonly RGBA16F: GLenum;
    readonly R32F: GLenum;
    readonly RG32F: GLenum;
    readonly RGB32F: GLenum;
    readonly RGBA32F: GLenum;
    readonly R11F_G11F_B10F: GLenum;
    readonly RGB9_E5: GLenum;
    readonly R8UI: GLenum;
    readonly R8I: GLenum;
    readonly RG8UI: GLenum;
    readonly RG8I: GLenum;
    readonly RGBA8UI: GLenum;
    readonly RGBA8I: GLenum;
    readonly RGBA16UI: GLenum;
    readonly RGBA16I: GLenum;
    readonly RGBA32UI: GLenum;
    readonly RGBA32I: GLenum;
    readonly DEPTH_COMPONENT24: GLenum;
    readonly DEPTH_COMPONENT32F: GLenum;
    readonly DEPTH24_STENCIL8: GLenum;
    readonly DEPTH32F_STENCIL8: GLenum;

    // the sampler types getActiveUniform can now report
    readonly SAMPLER_3D: GLenum;
    readonly SAMPLER_2D_ARRAY: GLenum;
    readonly SAMPLER_2D_SHADOW: GLenum;
    readonly SAMPLER_2D_ARRAY_SHADOW: GLenum;
    readonly SAMPLER_CUBE_SHADOW: GLenum;
    readonly INT_SAMPLER_2D: GLenum;
    readonly INT_SAMPLER_3D: GLenum;
    readonly INT_SAMPLER_CUBE: GLenum;
    readonly INT_SAMPLER_2D_ARRAY: GLenum;
    readonly UNSIGNED_INT_SAMPLER_2D: GLenum;
    readonly UNSIGNED_INT_SAMPLER_3D: GLenum;
    readonly UNSIGNED_INT_SAMPLER_CUBE: GLenum;
    readonly UNSIGNED_INT_SAMPLER_2D_ARRAY: GLenum;
    readonly FLOAT_MAT2x3: GLenum;
    readonly FLOAT_MAT2x4: GLenum;
    readonly FLOAT_MAT3x2: GLenum;
    readonly FLOAT_MAT3x4: GLenum;
    readonly FLOAT_MAT4x2: GLenum;
    readonly FLOAT_MAT4x3: GLenum;

    // ---- multisampling, blits and the read buffer ----
    // (features.multisample, features.readBuffer)
    readonly READ_FRAMEBUFFER: GLenum;
    readonly DRAW_FRAMEBUFFER: GLenum;
    readonly READ_FRAMEBUFFER_BINDING: GLenum;
    readonly DRAW_FRAMEBUFFER_BINDING: GLenum;
    readonly MAX_SAMPLES: GLenum;
    readonly SAMPLES: GLenum;
    readonly SAMPLE_BUFFERS: GLenum;
    readonly RENDERBUFFER_SAMPLES: GLenum;
    readonly FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: GLenum;
    readonly READ_BUFFER: GLenum;

    // ---- sync objects (features.sync) ----
    readonly SYNC_GPU_COMMANDS_COMPLETE: GLenum;
    readonly SYNC_FLUSH_COMMANDS_BIT: GLbitfield;
    readonly ALREADY_SIGNALED: GLenum;
    readonly TIMEOUT_EXPIRED: GLenum;
    readonly CONDITION_SATISFIED: GLenum;
    readonly WAIT_FAILED: GLenum;
    readonly OBJECT_TYPE: GLenum;
    readonly SYNC_CONDITION: GLenum;
    readonly SYNC_STATUS: GLenum;
    readonly SYNC_FLAGS: GLenum;
    readonly SYNC_FENCE: GLenum;
    readonly UNSIGNALED: GLenum;
    readonly SIGNALED: GLenum;
    /** -1: WebGL 2's spelling of GL's 2^64 - 1, which a Number cannot hold. */
    readonly TIMEOUT_IGNORED: number;

    // ---- query objects, for the GPU timers ----
    // (features.timerQuery, features.timestampQuery). WebGL's extension
    // spells the first three with an _EXT suffix; the values are the same.
    readonly TIME_ELAPSED: GLenum;
    readonly TIMESTAMP: GLenum;
    readonly QUERY_COUNTER_BITS: GLenum;
    readonly CURRENT_QUERY: GLenum;
    readonly QUERY_RESULT: GLenum;
    readonly QUERY_RESULT_AVAILABLE: GLenum;
    /**
     * `getParameter` answers a boolean on every flavor: whether timer results
     * read since the last ask are void. Only the ES extension has the notion,
     * so it has no other name — and elsewhere the answer is `false`.
     */
    readonly GPU_DISJOINT_EXT: GLenum;

    // ---- imported dma-buf textures (features.dmabufImport) ----
    /** The second target `importDmabuf` can bind to; needs `features.externalTexture`. */
    readonly TEXTURE_EXTERNAL_OES: GLenum;
    /** The GLSL type of a `TEXTURE_EXTERNAL_OES` sampler, as `getActiveUniform` reports it. */
    readonly SAMPLER_EXTERNAL_OES: GLenum;
    readonly TEXTURE_BINDING_EXTERNAL_OES: GLenum;
    readonly REQUIRED_TEXTURE_IMAGE_UNITS_OES: GLenum;
}

/**
 * The GL entry points, in WebGL's spelling and argument order, with the
 * constants merged in.
 *
 * Objects are plain numbers here rather than opaque handles: `createShader`
 * returns a `GLuint`, and `getUniformLocation` answers -1 for a name the
 * program does not have, where WebGL answers `null`.
 *
 * Everything under "optional" throws unless the matching `features` flag is
 * set (`Gpu.features`, `AppleContext.features`, or `getFeatures()`).
 */
export interface GLContext extends GLConstants {
    // ---- programs and shaders ----
    createShader(type: GLenum): GLuint;
    shaderSource(shader: GLuint, source: string): void;
    compileShader(shader: GLuint): void;
    /** A number, not a boolean — `COMPILE_STATUS` answers 1 or 0. */
    getShaderParameter(shader: GLuint, pname: GLenum): number;
    getShaderInfoLog(shader: GLuint): string;
    getShaderSource(shader: GLuint): string;
    deleteShader(shader: GLuint): void;
    createProgram(): GLuint;
    attachShader(program: GLuint, shader: GLuint): void;
    linkProgram(program: GLuint): void;
    getProgramParameter(program: GLuint, pname: GLenum): number;
    getProgramInfoLog(program: GLuint): string;
    validateProgram(program: GLuint): void;
    useProgram(program: GLuint): void;
    deleteProgram(program: GLuint): void;
    bindAttribLocation(program: GLuint, index: GLuint, name: string): void;
    getAttribLocation(program: GLuint, name: string): GLint;
    /** -1 when the program has no such uniform — WebGL would answer null. */
    getUniformLocation(program: GLuint, name: string): GLint;
    getAttachedShaders(program: GLuint): GLuint[];
    getShaderPrecisionFormat(
        shaderType: GLenum, precisionType: GLenum): ShaderPrecisionFormat;

    // ---- uniforms ----
    uniform1f(location: GLint, x: number): void;
    uniform2f(location: GLint, x: number, y: number): void;
    uniform3f(location: GLint, x: number, y: number, z: number): void;
    uniform4f(location: GLint, x: number, y: number, z: number, w: number): void;
    uniform1i(location: GLint, x: number): void;
    uniform2i(location: GLint, x: number, y: number): void;
    uniform3i(location: GLint, x: number, y: number, z: number): void;
    uniform4i(location: GLint, x: number, y: number, z: number, w: number): void;
    uniform1fv(location: GLint, value: Float32Array): void;
    uniform2fv(location: GLint, value: Float32Array): void;
    uniform3fv(location: GLint, value: Float32Array): void;
    uniform4fv(location: GLint, value: Float32Array): void;
    uniform1iv(location: GLint, value: Int32Array): void;
    uniformMatrix2fv(location: GLint, transpose: boolean, value: Float32Array): void;
    uniformMatrix3fv(location: GLint, transpose: boolean, value: Float32Array): void;
    uniformMatrix4fv(location: GLint, transpose: boolean, value: Float32Array): void;

    // ---- buffers and vertex attributes ----
    createBuffer(): GLuint;
    bindBuffer(target: GLenum, buffer: GLuint): void;
    bufferData(target: GLenum, data: TypedArray, usage: GLenum): void;
    bufferSubData(target: GLenum, offset: GLintptr, data: TypedArray): void;
    deleteBuffer(buffer: GLuint): void;
    getBufferParameter(target: GLenum, pname: GLenum): number;
    vertexAttribPointer(index: GLuint, size: GLint, type: GLenum,
        normalized: boolean, stride: GLsizei, offset: GLintptr): void;
    enableVertexAttribArray(index: GLuint): void;
    disableVertexAttribArray(index: GLuint): void;
    vertexAttrib1f(index: GLuint, x: number): void;
    vertexAttrib2f(index: GLuint, x: number, y: number): void;
    vertexAttrib3f(index: GLuint, x: number, y: number, z: number): void;
    vertexAttrib4f(index: GLuint, x: number, y: number, z: number, w: number): void;

    // ---- draws ----
    drawArrays(mode: GLenum, first: GLint, count: GLsizei): void;
    drawElements(mode: GLenum, count: GLsizei, type: GLenum, offset: GLintptr): void;

    // ---- textures ----
    createTexture(): GLuint;
    bindTexture(target: GLenum, texture: GLuint): void;
    activeTexture(texture: GLenum): void;
    /** `pixels` may be null, which allocates the level to be rendered into. */
    texImage2D(target: GLenum, level: GLint, internalformat: GLint,
        width: GLsizei, height: GLsizei, border: GLint,
        format: GLenum, type: GLenum, pixels: TypedArray | null): void;
    texSubImage2D(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint,
        width: GLsizei, height: GLsizei,
        format: GLenum, type: GLenum, pixels: TypedArray): void;
    /**
     * The bytes go to the driver untouched — the block layout belongs to the
     * format. Which `internalformat` values are legal is per-driver: ask
     * `getSupportedExtensions()` or `getParameter(COMPRESSED_TEXTURE_FORMATS)`.
     */
    compressedTexImage2D(target: GLenum, level: GLint, internalformat: GLenum,
        width: GLsizei, height: GLsizei, border: GLint, data: TypedArray): void;
    compressedTexSubImage2D(target: GLenum, level: GLint,
        xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei,
        format: GLenum, data: TypedArray): void;
    texParameteri(target: GLenum, pname: GLenum, param: GLint): void;
    texParameterf(target: GLenum, pname: GLenum, param: number): void;
    getTexParameter(target: GLenum, pname: GLenum): number;
    generateMipmap(target: GLenum): void;
    deleteTexture(texture: GLuint): void;

    // ---- framebuffers and renderbuffers ----
    createFramebuffer(): GLuint;
    bindFramebuffer(target: GLenum, framebuffer: GLuint): void;
    framebufferTexture2D(target: GLenum, attachment: GLenum, textarget: GLenum,
        texture: GLuint, level: GLint): void;
    framebufferRenderbuffer(target: GLenum, attachment: GLenum,
        renderbuffertarget: GLenum, renderbuffer: GLuint): void;
    checkFramebufferStatus(target: GLenum): GLenum;
    getFramebufferAttachmentParameter(
        target: GLenum, attachment: GLenum, pname: GLenum): number;
    deleteFramebuffer(framebuffer: GLuint): void;
    createRenderbuffer(): GLuint;
    bindRenderbuffer(target: GLenum, renderbuffer: GLuint): void;
    renderbufferStorage(target: GLenum, internalformat: GLenum,
        width: GLsizei, height: GLsizei): void;
    getRenderbufferParameter(target: GLenum, pname: GLenum): number;
    deleteRenderbuffer(renderbuffer: GLuint): void;

    // ---- per-fragment state ----
    blendFunc(sfactor: GLenum, dfactor: GLenum): void;
    blendFuncSeparate(srcRGB: GLenum, dstRGB: GLenum,
        srcAlpha: GLenum, dstAlpha: GLenum): void;
    blendEquation(mode: GLenum): void;
    blendEquationSeparate(modeRGB: GLenum, modeAlpha: GLenum): void;
    blendColor(red: number, green: number, blue: number, alpha: number): void;
    depthFunc(func: GLenum): void;
    depthMask(flag: boolean): void;
    depthRange(zNear: number, zFar: number): void;
    colorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void;
    scissor(x: GLint, y: GLint, width: GLsizei, height: GLsizei): void;
    polygonOffset(factor: number, units: number): void;
    stencilFunc(func: GLenum, ref: GLint, mask: GLuint): void;
    stencilOp(fail: GLenum, zfail: GLenum, zpass: GLenum): void;
    stencilMask(mask: GLuint): void;
    /**
     * The *Separate forms set one facing's state — `face` is `FRONT`, `BACK`
     * or `FRONT_AND_BACK` — and leave the other's alone: how a non-zero
     * winding fill counts front faces up and back faces down in one pass.
     * Core since ES 2.0, so never optional.
     */
    stencilFuncSeparate(face: GLenum, func: GLenum, ref: GLint, mask: GLuint): void;
    stencilOpSeparate(face: GLenum, fail: GLenum, zfail: GLenum, zpass: GLenum): void;
    stencilMaskSeparate(face: GLenum, mask: GLuint): void;
    clearStencil(s: GLint): void;
    cullFace(mode: GLenum): void;
    frontFace(mode: GLenum): void;

    // ---- the frame, and reading it back ----
    clear(mask: GLbitfield): void;
    clearColor(red: number, green: number, blue: number, alpha: number): void;
    clearDepthf(depth: number): void;
    viewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei): void;
    enable(cap: GLenum): void;
    disable(cap: GLenum): void;
    isEnabled(cap: GLenum): boolean;
    lineWidth(width: number): void;
    pixelStorei(pname: GLenum, param: GLint): void;
    readPixels(x: GLint, y: GLint, width: GLsizei, height: GLsizei,
        format: GLenum, type: GLenum, dest: TypedArray): void;
    finish(): void;
    flush(): void;
    getError(): GLenum;
    getString(name: GLenum): string;

    // ---- state queries ----
    /**
     * Answers in the type the parameter has: a number, a boolean, or an array
     * for `VIEWPORT`, `SCISSOR_BOX`, `COLOR_CLEAR_VALUE`, `COLOR_WRITEMASK`
     * and `COMPRESSED_TEXTURE_FORMATS`. The stencil masks come back unsigned
     * (all ones is 4294967295, not -1), and `GPU_DISJOINT_EXT` is a boolean
     * on every flavor — `false`, without asking GL, where GL has no such
     * notion.
     */
    getParameter(pname: GLenum): GLParameterValue;
    /** The raw single-value escape hatch, for anything `getParameter` does not know. */
    getIntegerv(pname: GLenum): number;
    getFloatv(pname: GLenum): number;
    getBooleanv(pname: GLenum): boolean;
    /** The driver's extension list, split. */
    getSupportedExtensions(): string[];
    /** Which optional entry points resolved. Also on `Gpu.features`. */
    getFeatures(): GlFeatures;

    // ---- introspection ----
    /** `null` past the last index, so a loop can enumerate without disturbing `getError()`. */
    getActiveUniform(program: GLuint, index: GLuint): ActiveInfo | null;
    getActiveAttrib(program: GLuint, index: GLuint): ActiveInfo | null;
    /**
     * A uniform's value, in the type the program declared it with. Answers
     * `null` for a location of -1, and for the few types it cannot read
     * (unsigned-integer uniforms would need `getUniformuiv`).
     */
    getUniform(program: GLuint, location: GLint): GLUniformValue;
    /** The raw form: GL writes as many components as the uniform has, so say how many to take. */
    getUniformfv(program: GLuint, location: GLint, count: number): number[];
    getUniformiv(program: GLuint, location: GLint, count: number): number[];
    /** Booleans for the flags, four floats for `CURRENT_VERTEX_ATTRIB`, an integer otherwise. */
    getVertexAttrib(index: GLuint, pname: GLenum): number | boolean | number[];
    getVertexAttribOffset(index: GLuint, pname: GLenum): GLintptr;
    isBuffer(buffer: GLuint): boolean;
    isFramebuffer(framebuffer: GLuint): boolean;
    isProgram(program: GLuint): boolean;
    isRenderbuffer(renderbuffer: GLuint): boolean;
    isShader(shader: GLuint): boolean;
    isTexture(texture: GLuint): boolean;

    // ---- optional: vertex array objects (features.vertexArrayObject) ----
    createVertexArray(): GLuint;
    bindVertexArray(array: GLuint): void;
    deleteVertexArray(array: GLuint): void;
    isVertexArray(array: GLuint): boolean;

    // ---- optional: instanced drawing (features.instancedArrays) ----
    drawArraysInstanced(mode: GLenum, first: GLint, count: GLsizei,
        instanceCount: GLsizei): void;
    drawElementsInstanced(mode: GLenum, count: GLsizei, type: GLenum,
        offset: GLintptr, instanceCount: GLsizei): void;
    /** 0 advances the attribute per vertex, 1 per instance, n every n instances. */
    vertexAttribDivisor(index: GLuint, divisor: GLuint): void;

    // ---- optional: multiple render targets (features.drawBuffers) ----
    /** Which attachment each fragment output writes to, by position. `NONE` discards one. */
    drawBuffers(buffers: readonly GLenum[] | Uint32Array | Int32Array): void;

    // ---- optional: 3D and array textures (features.texture3D) ----
    texImage3D(target: GLenum, level: GLint, internalformat: GLint,
        width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint,
        format: GLenum, type: GLenum, pixels: TypedArray | null): void;
    texSubImage3D(target: GLenum, level: GLint,
        xoffset: GLint, yoffset: GLint, zoffset: GLint,
        width: GLsizei, height: GLsizei, depth: GLsizei,
        format: GLenum, type: GLenum, pixels: TypedArray): void;
    copyTexSubImage3D(target: GLenum, level: GLint,
        xoffset: GLint, yoffset: GLint, zoffset: GLint,
        x: GLint, y: GLint, width: GLsizei, height: GLsizei): void;
    compressedTexImage3D(target: GLenum, level: GLint, internalformat: GLenum,
        width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint,
        data: TypedArray): void;
    compressedTexSubImage3D(target: GLenum, level: GLint,
        xoffset: GLint, yoffset: GLint, zoffset: GLint,
        width: GLsizei, height: GLsizei, depth: GLsizei,
        format: GLenum, data: TypedArray): void;
    /** One slice of a 3D or array texture as a render target. */
    framebufferTextureLayer(target: GLenum, attachment: GLenum,
        texture: GLuint, level: GLint, layer: GLint): void;

    // ---- optional: immutable storage (features.textureStorage) ----
    /** Allocates the whole pyramid once, in a sized format. A second call is refused. */
    texStorage2D(target: GLenum, levels: GLsizei, internalformat: GLenum,
        width: GLsizei, height: GLsizei): void;
    texStorage3D(target: GLenum, levels: GLsizei, internalformat: GLenum,
        width: GLsizei, height: GLsizei, depth: GLsizei): void;

    // ---- optional: multisampling (features.multisample) ----
    /**
     * Storage keeping `samples` coverage samples per pixel. It cannot be read
     * or sampled as it is: `blitFramebuffer` resolves it into a single-sample
     * framebuffer first. The driver may give more samples than asked
     * (`getRenderbufferParameter(RENDERBUFFER_SAMPLES)`), up to
     * `getParameter(MAX_SAMPLES)`.
     */
    renderbufferStorageMultisample(target: GLenum, samples: GLsizei,
        internalformat: GLenum, width: GLsizei, height: GLsizei): void;
    /**
     * Copy a rectangle of the `READ_FRAMEBUFFER`'s read buffer into the
     * `DRAW_FRAMEBUFFER`. Out of a multisampled source into a single-sample
     * one, the copy is the resolve.
     */
    blitFramebuffer(srcX0: GLint, srcY0: GLint, srcX1: GLint, srcY1: GLint,
        dstX0: GLint, dstY0: GLint, dstX1: GLint, dstY1: GLint,
        mask: GLbitfield, filter: GLenum): void;

    // ---- optional: choosing the read buffer (features.readBuffer) ----
    /** Which colour attachment (or `BACK`) `readPixels` and `blitFramebuffer` read. */
    readBuffer(src: GLenum): void;

    // ---- optional: sync objects (features.sync) ----
    /**
     * A fence after everything issued so far: `condition` is
     * `SYNC_GPU_COMMANDS_COMPLETE`, `flags` 0. The handle is a number like
     * every other object here, never the driver's pointer, and 0 means GL
     * refused the arguments (`getError()` says why).
     */
    fenceSync(condition: GLenum, flags: GLbitfield): GLsync;
    /**
     * `ALREADY_SIGNALED`, `CONDITION_SATISFIED`, `TIMEOUT_EXPIRED` or
     * `WAIT_FAILED`. A `timeout` of 0 polls without blocking; anything else
     * is nanoseconds, as a Number or a BigInt. Pass `SYNC_FLUSH_COMMANDS_BIT`
     * (or `flush()` first), or the fence may never reach the GPU to signal.
     * Throws for a handle that is not a live sync of the current context.
     */
    clientWaitSync(sync: GLsync, flags: GLbitfield, timeout: number | bigint): GLenum;
    /** Make the GPU wait for the fence, not this thread: `flags` 0, `timeout` `TIMEOUT_IGNORED`. */
    waitSync(sync: GLsync, flags: GLbitfield, timeout: number | bigint): void;
    /** `SYNC_STATUS` (`SIGNALED` or `UNSIGNALED`), `OBJECT_TYPE`, `SYNC_CONDITION`, `SYNC_FLAGS`. Never waits. */
    getSyncParameter(sync: GLsync, pname: GLenum): number;
    /** 0, or a handle already deleted, is ignored. */
    deleteSync(sync: GLsync): void;
    /** Whether the handle names a live sync object of the current context. */
    isSync(sync: GLsync): boolean;

    // ---- optional: GPU timers (features.timerQuery, timestampQuery) ----
    createQuery(): GLuint;
    deleteQuery(query: GLuint): void;
    /** False for a name from `createQuery` until `beginQuery` has used it — GL's rule. */
    isQuery(query: GLuint): boolean;
    /** One active query per target; `TIME_ELAPSED` is the one that times. */
    beginQuery(target: GLenum, query: GLuint): void;
    endQuery(target: GLenum): void;
    /**
     * `CURRENT_QUERY` (the query active on `target`, 0 for none) or
     * `QUERY_COUNTER_BITS` — the timer's width, where 0 means the driver has
     * no working timer for that target: the probe to make before trusting
     * one.
     */
    getQuery(target: GLenum, pname: GLenum): number;
    /**
     * A boolean for `QUERY_RESULT_AVAILABLE`, which never waits; a Number for
     * `QUERY_RESULT` — nanoseconds for a timer, exact below 2^53 (104 days,
     * so every duration a frame can have). `QUERY_RESULT` waits for a result
     * that is not available yet, which is the stall timers exist to avoid:
     * ask `QUERY_RESULT_AVAILABLE` first.
     */
    getQueryParameter(query: GLuint, pname: GLenum): number | boolean;
    /** The raw form: every bit of the 64-bit result, as a BigInt — for an absolute `TIMESTAMP`. */
    getQueryObjectui64v(query: GLuint, pname: GLenum): bigint;
    /** The GPU clock's reading when the command stream reaches this point: `target` is `TIMESTAMP`. */
    queryCounter(query: GLuint, target: GLenum): void;

    // ---- optional: dma-buf import (features.dmabufImport) ----
    /**
     * Wrap a dma-buf descriptor in an EGLImage and hand back a texture bound
     * to it — the way in, where `Surface.swap()` is the way out. Nothing is
     * copied.
     *
     * The options are the shape `DRI3.BuffersFromPixmap` already answers
     * with, which is how a compositor turns a redirected window's pixmap
     * into a texture:
     *
     * ```ts
     * const buf = await dri3.BuffersFromPixmap(pixmap);
     * const img = gl.importDmabuf(buf);
     * gl.bindTexture(img.target, img.texture);
     * ```
     *
     * The plane descriptors are consumed on success; a throw leaves them
     * open and owned by the caller. The texture comes back with `LINEAR`
     * filtering and `CLAMP_TO_EDGE` wrapping, since an EGLImage texture has
     * no mipmaps and the GL defaults would leave it incomplete. The binding
     * in force when the call was made is restored.
     */
    importDmabuf(opts: ImportDmabufOptions): ImportedImage;
}

/** DRM fourcc buffer formats. Must match the depth of the window being fed. */
export declare const FORMAT: {
    /** depth 24, bpp 32 */
    readonly XRGB8888: number;
    /** depth 32, bpp 32 */
    readonly ARGB8888: number;
};

/** GBM buffer use flags for `createSurface`. `RENDERING` is implied. */
export declare const GBM_USE: {
    readonly SCANOUT: number;
    readonly RENDERING: number;
    /** For consumers that may not understand this GPU's tiled layouts. */
    readonly LINEAR: number;
};

/** Format modifiers, as reported by `swap()`. */
export declare const MODIFIER: {
    readonly LINEAR: bigint;
    readonly INVALID: bigint;
};

/** Flags for `dmabufSync` — one of READ/WRITE/RW, or'ed with START or END. */
export declare const DMABUF_SYNC: {
    readonly READ: number;
    readonly WRITE: number;
    readonly RW: number;
    readonly START: number;
    readonly END: number;
};

/** The GL constants on their own. The same values `gl` carries. */
export declare const GL: GLConstants;

/**
 * The GL entry points. There is one context per process, so this is the same
 * object as `Gpu.gl`; calls are valid between `makeCurrent` and `destroy`.
 */
export declare const gl: GLContext;

/** What this machine can do. Safe to call on any platform. */
export declare function probe(): ProbeResult;

/**
 * `dup(2)`. DRI3 sends consume the descriptor they are given, so duplicate it
 * first to keep a copy. Portable — this one works everywhere.
 */
export declare function dup(fd: number): number;

/** The DRM render nodes on this machine, sorted. Empty on non-Linux. */
export declare function listRenderNodes(): string[];

/**
 * CPU memory turned into a dma-buf by `/dev/udmabuf` — the GPU-less way to
 * feed DRI3, where the server's driver supports it. Linux only.
 */
export declare function createUdmabuf(size: number): Udmabuf;

/** Bracket CPU access to a dma-buf. Flags come from `DMABUF_SYNC`. */
export declare function dmabufSync(fd: number, flags: number): void;

/**
 * Map a dma-buf someone else allocated, for CPU reads and writes — what
 * `createUdmabuf` returns, for memory this package did not allocate. Makes
 * a `DRI3.BufferFromPixmap` descriptor readable with no GL involved.
 *
 * `size` defaults to the whole buffer. The descriptor is not consumed. Only
 * an exporter that implements mmap can be mapped at all: udmabuf and linear
 * GPU buffers can, tiled ones throw saying so — for those use
 * `gl.importDmabuf` instead.
 */
export declare function mapDmabuf(fd: number, size?: number): MappedDmabuf;
