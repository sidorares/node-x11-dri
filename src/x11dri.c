// x11-dri: native companion to the pure-JS x11 package for the DRI3+Present
// direct-rendering path.
//
// What lives here is exactly the part that cannot be JavaScript:
//   - GPU rendering: GBM surface + EGL context + OpenGL ES 2.0 entry points,
//     and exporting each finished frame as a dma-buf fd (what the JS side
//     hands to DRI3 PixmapFromBuffer).
//   - dma-buf plumbing that needs ioctls: udmabuf (turn CPU memory into a
//     dma-buf on GPU-less hosts), DMA_BUF_IOCTL_SYNC, and dup() for
//     keep-a-copy descriptor sends.
//
// Deliberately NO link-time or header dependency on gbm/EGL/GLES: everything
// is dlopen'd/dlsym'd at runtime (the few needed constants and prototypes are
// declared below — they are stable ABI). The addon therefore builds on any
// Linux box with a compiler and degrades at runtime with clear errors when a
// library or device is missing.
//
// It also builds on macOS, where the same degradation contract does the whole
// job: dma-buf, GBM and udmabuf are Linux kernel facilities with no Darwin
// equivalent, and XQuartz does not implement the DRI3 extension that would
// consume them — so probe() reports them unavailable, the buffer-producing
// entry points throw explanatory errors, and the portable descriptor helper
// (dup) still works. See the "macOS / XQuartz" section of the README.

#define _GNU_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/ioctl.h>
#endif

// ---------------------------------------------------------------------------
// Platform traits
// ---------------------------------------------------------------------------
//
// HAVE_DMABUF gates everything that speaks the Linux dma-buf ABI: udmabuf
// (memfd + UDMABUF_CREATE) and DMA_BUF_IOCTL_SYNC. Where it is 0 those entry
// points still exist and still throw a message that says why.
//
// The library names are the runtime dlopen targets. On Darwin the Mach-O
// names are tried both bare (honouring DYLD_* and the standard search path)
// and under /opt/X11/lib, where XQuartz keeps its Mesa build — that makes
// probe() tell the truth about a machine instead of always reporting "not
// found" for libraries that are installed but off the default path.

#if defined(__linux__)
#define HAVE_DMABUF 1
#define PLATFORM_NAME "linux"
#define LIB_GBM  "libgbm.so.1"
#define LIB_EGL  "libEGL.so.1"
#define LIB_GLES "libGLESv2.so.2"
#elif defined(__APPLE__)
#define HAVE_DMABUF 0
#define PLATFORM_NAME "darwin"
#define LIB_GBM  "libgbm.dylib"
#define LIB_EGL  "libEGL.dylib"
#define LIB_GLES "libGLESv2.dylib"
#else
#define HAVE_DMABUF 0
#define PLATFORM_NAME "unknown"
#define LIB_GBM  "libgbm.so.1"
#define LIB_EGL  "libEGL.so.1"
#define LIB_GLES "libGLESv2.so.2"
#endif

// dlopen `name`, then the same name under any extra search directories this
// platform is known to hide graphics libraries in.
static void *dlopen_lib(const char *name) {
    void *h = dlopen(name, RTLD_NOW | RTLD_GLOBAL);
#if defined(__APPLE__)
    if (!h) {
        char path[256];
        snprintf(path, sizeof(path), "/opt/X11/lib/%s", name);
        h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    }
#endif
    return h;
}

// ---------------------------------------------------------------------------
// napi helpers
// ---------------------------------------------------------------------------

#define NAPI_CALL(env, call)                                                  \
    do {                                                                      \
        napi_status status_ = (call);                                         \
        if (status_ != napi_ok) {                                             \
            napi_throw_error(env, NULL, #call " failed");                     \
            return NULL;                                                      \
        }                                                                     \
    } while (0)

#define THROW(env, msg)                                                       \
    do {                                                                      \
        napi_throw_error(env, NULL, msg);                                     \
        return NULL;                                                          \
    } while (0)

#define THROWF(env, ...)                                                      \
    do {                                                                      \
        char buf_[256];                                                       \
        snprintf(buf_, sizeof(buf_), __VA_ARGS__);                            \
        napi_throw_error(env, NULL, buf_);                                    \
        return NULL;                                                          \
    } while (0)

#define GET_ARGS(env, info, n)                                                \
    size_t argc = (n);                                                        \
    napi_value args[(n) > 0 ? (n) : 1];                                       \
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL))

static uint32_t arg_u32(napi_env env, napi_value v) {
    uint32_t out = 0;
    napi_get_value_uint32(env, v, &out);
    return out;
}
static int32_t arg_i32(napi_env env, napi_value v) {
    int32_t out = 0;
    napi_get_value_int32(env, v, &out);
    return out;
}
static double arg_f64(napi_env env, napi_value v) {
    double out = 0;
    napi_get_value_double(env, v, &out);
    return out;
}
static bool arg_bool(napi_env env, napi_value v) {
    bool out = false;
    napi_get_value_bool(env, v, &out);
    return out;
}

static napi_value mk_u32(napi_env env, uint32_t v) {
    napi_value out;
    napi_create_uint32(env, v, &out);
    return out;
}
static napi_value mk_i32(napi_env env, int32_t v) {
    napi_value out;
    napi_create_int32(env, v, &out);
    return out;
}
static napi_value mk_bool(napi_env env, bool v) {
    napi_value out;
    napi_get_boolean(env, v, &out);
    return out;
}
static napi_value mk_str(napi_env env, const char *s) {
    napi_value out;
    napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &out);
    return out;
}
static void obj_set(napi_env env, napi_value obj, const char *k, napi_value v) {
    napi_set_named_property(env, obj, k, v);
}

// ---------------------------------------------------------------------------
// Minimal GBM / EGL / GLES declarations (stable ABI, from gbm.h / egl.h / gl2.h)
// ---------------------------------------------------------------------------

struct gbm_device;
struct gbm_surface;
struct gbm_bo;
union gbm_bo_handle { void *ptr; int32_t s32; uint32_t u32; int64_t s64; uint64_t u64; };

#define GBM_BO_USE_SCANOUT   (1u << 0)
#define GBM_BO_USE_RENDERING (1u << 2)
#define GBM_BO_USE_LINEAR    (1u << 4)

#define FOURCC(a, b, c, d) \
    ((uint32_t)(a) | ((uint32_t)(b) << 8) | ((uint32_t)(c) << 16) | ((uint32_t)(d) << 24))
#define GBM_FORMAT_XRGB8888 FOURCC('X', 'R', '2', '4')
#define GBM_FORMAT_ARGB8888 FOURCC('A', 'R', '2', '4')

#define DRM_FORMAT_MOD_INVALID ((1ULL << 56) - 1)

typedef void *EGLDisplay;
typedef void *EGLConfig;
typedef void *EGLContext;
typedef void *EGLSurface;
typedef int32_t EGLint;
typedef unsigned int EGLBoolean;
typedef unsigned int EGLenum;
typedef intptr_t EGLAttrib;

#define EGL_FALSE                 0
#define EGL_TRUE                  1
#define EGL_NONE                  0x3038
#define EGL_SUCCESS               0x3000
#define EGL_ALPHA_SIZE            0x3021
#define EGL_BLUE_SIZE             0x3022
#define EGL_GREEN_SIZE            0x3023
#define EGL_RED_SIZE              0x3024
#define EGL_DEPTH_SIZE            0x3025
#define EGL_SURFACE_TYPE          0x3033
#define EGL_NATIVE_VISUAL_ID      0x302E
#define EGL_RENDERABLE_TYPE       0x3040
#define EGL_WINDOW_BIT            0x0004
#define EGL_OPENGL_ES2_BIT        0x0004
#define EGL_OPENGL_ES_API         0x30A0
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_VENDOR                0x3053
#define EGL_VERSION               0x3054
#define EGL_PLATFORM_GBM_KHR      0x31D7

typedef uint32_t GLenum;
typedef uint32_t GLuint;
typedef int32_t GLint;
typedef int32_t GLsizei;
typedef float GLfloat;
typedef uint8_t GLboolean;
typedef char GLchar;
typedef intptr_t GLintptr;
typedef intptr_t GLsizeiptr;
typedef uint32_t GLbitfield;

// ---------------------------------------------------------------------------
// dlopen'd function tables
// ---------------------------------------------------------------------------

static struct {
    void *lib;
    struct gbm_device *(*create_device)(int fd);
    void (*device_destroy)(struct gbm_device *);
    struct gbm_surface *(*surface_create)(struct gbm_device *, uint32_t, uint32_t, uint32_t, uint32_t);
    void (*surface_destroy)(struct gbm_surface *);
    struct gbm_bo *(*surface_lock_front_buffer)(struct gbm_surface *);
    void (*surface_release_buffer)(struct gbm_surface *, struct gbm_bo *);
    int (*bo_get_fd)(struct gbm_bo *);
    uint32_t (*bo_get_stride)(struct gbm_bo *);
    union gbm_bo_handle (*bo_get_handle)(struct gbm_bo *);
    void (*bo_set_user_data)(struct gbm_bo *, void *, void (*)(struct gbm_bo *, void *));
    void *(*bo_get_user_data)(struct gbm_bo *);
    // optional (newer gbm):
    uint64_t (*bo_get_modifier)(struct gbm_bo *);
    uint32_t (*bo_get_offset)(struct gbm_bo *, int plane);
} gbm;

static struct {
    void *lib;
    EGLint (*GetError)(void);
    EGLDisplay (*GetPlatformDisplay)(EGLenum, void *, const EGLAttrib *);
    EGLDisplay (*GetPlatformDisplayEXT)(EGLenum, void *, const EGLint *);
    EGLBoolean (*Initialize)(EGLDisplay, EGLint *, EGLint *);
    EGLBoolean (*Terminate)(EGLDisplay);
    EGLBoolean (*BindAPI)(EGLenum);
    EGLBoolean (*ChooseConfig)(EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *);
    EGLBoolean (*GetConfigAttrib)(EGLDisplay, EGLConfig, EGLint, EGLint *);
    EGLContext (*CreateContext)(EGLDisplay, EGLConfig, EGLContext, const EGLint *);
    EGLBoolean (*DestroyContext)(EGLDisplay, EGLContext);
    EGLSurface (*CreateWindowSurface)(EGLDisplay, EGLConfig, void *, const EGLint *);
    EGLBoolean (*DestroySurface)(EGLDisplay, EGLSurface);
    EGLBoolean (*MakeCurrent)(EGLDisplay, EGLSurface, EGLSurface, EGLContext);
    EGLBoolean (*SwapBuffers)(EGLDisplay, EGLSurface);
    EGLBoolean (*SwapInterval)(EGLDisplay, EGLint);
    const char *(*QueryString)(EGLDisplay, EGLint);
    void *(*GetProcAddress)(const char *);
} egl;

static struct {
    void *lib;
    void (*ClearColor)(GLfloat, GLfloat, GLfloat, GLfloat);
    void (*ClearDepthf)(GLfloat);
    void (*Clear)(GLbitfield);
    void (*Viewport)(GLint, GLint, GLsizei, GLsizei);
    void (*Enable)(GLenum);
    void (*Disable)(GLenum);
    void (*DepthFunc)(GLenum);
    void (*CullFace)(GLenum);
    void (*FrontFace)(GLenum);
    void (*LineWidth)(GLfloat);
    void (*PixelStorei)(GLenum, GLint);
    GLuint (*CreateShader)(GLenum);
    void (*ShaderSource)(GLuint, GLsizei, const GLchar *const *, const GLint *);
    void (*CompileShader)(GLuint);
    void (*GetShaderiv)(GLuint, GLenum, GLint *);
    void (*GetShaderInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
    void (*DeleteShader)(GLuint);
    GLuint (*CreateProgram)(void);
    void (*AttachShader)(GLuint, GLuint);
    void (*LinkProgram)(GLuint);
    void (*GetProgramiv)(GLuint, GLenum, GLint *);
    void (*GetProgramInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
    void (*UseProgram)(GLuint);
    void (*DeleteProgram)(GLuint);
    GLint (*GetAttribLocation)(GLuint, const GLchar *);
    GLint (*GetUniformLocation)(GLuint, const GLchar *);
    void (*UniformMatrix4fv)(GLint, GLsizei, GLboolean, const GLfloat *);
    void (*Uniform1f)(GLint, GLfloat);
    void (*Uniform3f)(GLint, GLfloat, GLfloat, GLfloat);
    void (*Uniform4f)(GLint, GLfloat, GLfloat, GLfloat, GLfloat);
    void (*Uniform1i)(GLint, GLint);
    void (*GenBuffers)(GLsizei, GLuint *);
    void (*BindBuffer)(GLenum, GLuint);
    void (*BufferData)(GLenum, GLsizeiptr, const void *, GLenum);
    void (*DeleteBuffers)(GLsizei, const GLuint *);
    void (*VertexAttribPointer)(GLuint, GLint, GLenum, GLboolean, GLsizei, const void *);
    void (*EnableVertexAttribArray)(GLuint);
    void (*DrawArrays)(GLenum, GLint, GLsizei);
    void (*DrawElements)(GLenum, GLsizei, GLenum, const void *);
    void (*Finish)(void);
    void (*Flush)(void);
    GLenum (*GetError)(void);
    const uint8_t *(*GetString)(GLenum);
    void (*ReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
} gl;

static const char *load_gbm(void) {
    if (gbm.lib) return NULL;
#if !HAVE_DMABUF
    // GBM allocates dma-buf-backed buffer objects on a DRM device. Neither
    // exists here, so say so plainly rather than reporting a dlopen miss.
    return "GBM needs Linux DRM/dma-buf — no equivalent on " PLATFORM_NAME;
#else
    void *h = dlopen_lib(LIB_GBM);
    if (!h) return dlerror();
#define S(field, name)                                                        \
    do {                                                                      \
        *(void **)&gbm.field = dlsym(h, name);                                \
        if (!gbm.field) return LIB_GBM " is missing " name;                   \
    } while (0)
    S(create_device, "gbm_create_device");
    S(device_destroy, "gbm_device_destroy");
    S(surface_create, "gbm_surface_create");
    S(surface_destroy, "gbm_surface_destroy");
    S(surface_lock_front_buffer, "gbm_surface_lock_front_buffer");
    S(surface_release_buffer, "gbm_surface_release_buffer");
    S(bo_get_fd, "gbm_bo_get_fd");
    S(bo_get_stride, "gbm_bo_get_stride");
    S(bo_get_handle, "gbm_bo_get_handle");
    S(bo_set_user_data, "gbm_bo_set_user_data");
    S(bo_get_user_data, "gbm_bo_get_user_data");
#undef S
    // optional symbols (gbm >= 17.1); absence means "implicit modifier only"
    *(void **)&gbm.bo_get_modifier = dlsym(h, "gbm_bo_get_modifier");
    *(void **)&gbm.bo_get_offset = dlsym(h, "gbm_bo_get_offset");
    gbm.lib = h;
    return NULL;
#endif
}

static const char *load_egl(void) {
    if (egl.lib) return NULL;
    void *h = dlopen_lib(LIB_EGL);
    if (!h) return dlerror();
#define S(field, name)                                                        \
    do {                                                                      \
        *(void **)&egl.field = dlsym(h, name);                                \
        if (!egl.field) return LIB_EGL " is missing " name;                   \
    } while (0)
    S(GetError, "eglGetError");
    S(Initialize, "eglInitialize");
    S(Terminate, "eglTerminate");
    S(BindAPI, "eglBindAPI");
    S(ChooseConfig, "eglChooseConfig");
    S(GetConfigAttrib, "eglGetConfigAttrib");
    S(CreateContext, "eglCreateContext");
    S(DestroyContext, "eglDestroyContext");
    S(CreateWindowSurface, "eglCreateWindowSurface");
    S(DestroySurface, "eglDestroySurface");
    S(MakeCurrent, "eglMakeCurrent");
    S(SwapBuffers, "eglSwapBuffers");
    S(SwapInterval, "eglSwapInterval");
    S(QueryString, "eglQueryString");
    S(GetProcAddress, "eglGetProcAddress");
#undef S
    // EGL 1.5 core, else the EXT flavor through GetProcAddress
    *(void **)&egl.GetPlatformDisplay = dlsym(h, "eglGetPlatformDisplay");
    if (!egl.GetPlatformDisplay)
        *(void **)&egl.GetPlatformDisplayEXT =
            egl.GetProcAddress("eglGetPlatformDisplayEXT");
    if (!egl.GetPlatformDisplay && !egl.GetPlatformDisplayEXT)
        return "no eglGetPlatformDisplay(EXT) — EGL too old for GBM platform";
    egl.lib = h;
    return NULL;
}

static const char *load_gles(void) {
    if (gl.lib) return NULL;
    void *h = dlopen_lib(LIB_GLES);
    if (!h) return dlerror();
#define S(field, name)                                                        \
    do {                                                                      \
        *(void **)&gl.field = dlsym(h, name);                                 \
        if (!gl.field) return LIB_GLES " is missing " name;                   \
    } while (0)
    S(ClearColor, "glClearColor"); S(ClearDepthf, "glClearDepthf");
    S(Clear, "glClear"); S(Viewport, "glViewport");
    S(Enable, "glEnable"); S(Disable, "glDisable");
    S(DepthFunc, "glDepthFunc"); S(CullFace, "glCullFace");
    S(FrontFace, "glFrontFace"); S(LineWidth, "glLineWidth");
    S(PixelStorei, "glPixelStorei");
    S(CreateShader, "glCreateShader"); S(ShaderSource, "glShaderSource");
    S(CompileShader, "glCompileShader"); S(GetShaderiv, "glGetShaderiv");
    S(GetShaderInfoLog, "glGetShaderInfoLog"); S(DeleteShader, "glDeleteShader");
    S(CreateProgram, "glCreateProgram"); S(AttachShader, "glAttachShader");
    S(LinkProgram, "glLinkProgram"); S(GetProgramiv, "glGetProgramiv");
    S(GetProgramInfoLog, "glGetProgramInfoLog"); S(UseProgram, "glUseProgram");
    S(DeleteProgram, "glDeleteProgram");
    S(GetAttribLocation, "glGetAttribLocation");
    S(GetUniformLocation, "glGetUniformLocation");
    S(UniformMatrix4fv, "glUniformMatrix4fv");
    S(Uniform1f, "glUniform1f"); S(Uniform3f, "glUniform3f");
    S(Uniform4f, "glUniform4f"); S(Uniform1i, "glUniform1i");
    S(GenBuffers, "glGenBuffers"); S(BindBuffer, "glBindBuffer");
    S(BufferData, "glBufferData"); S(DeleteBuffers, "glDeleteBuffers");
    S(VertexAttribPointer, "glVertexAttribPointer");
    S(EnableVertexAttribArray, "glEnableVertexAttribArray");
    S(DrawArrays, "glDrawArrays"); S(DrawElements, "glDrawElements");
    S(Finish, "glFinish"); S(Flush, "glFlush");
    S(GetError, "glGetError"); S(GetString, "glGetString");
    S(ReadPixels, "glReadPixels");
#undef S
    gl.lib = h;
    return NULL;
}

// ---------------------------------------------------------------------------
// Gpu (drm fd + gbm device + EGL display/config/context)
// ---------------------------------------------------------------------------

typedef struct {
    int drm_fd; // our own dup; closed on destroy
    struct gbm_device *gbm;
    EGLDisplay dpy;
    EGLConfig cfg;
    EGLContext ctx;
    uint32_t format;   // GBM_FORMAT_* fourcc
    int destroyed;
} Gpu;

#define MAX_LOCKED 16

typedef struct {
    Gpu *gpu;
    struct gbm_surface *gs;
    EGLSurface esurf;
    uint32_t width, height;
    struct { uint32_t key; struct gbm_bo *bo; } locked[MAX_LOCKED];
    int nlocked;
    int destroyed;
} Surface;

static int has_current = 0;

static void gpu_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    Gpu *g = data;
    if (!g->destroyed) {
        // JS forgot destroy(); release what we can without touching EGL
        // current state (finalizers can run late in teardown).
        if (g->ctx) egl.DestroyContext(g->dpy, g->ctx);
        if (g->dpy) egl.Terminate(g->dpy);
        if (g->gbm) gbm.device_destroy(g->gbm);
        if (g->drm_fd >= 0) close(g->drm_fd);
    }
    free(g);
}

static void surface_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    Surface *s = data;
    if (!s->destroyed) {
        for (int i = 0; i < s->nlocked; i++)
            gbm.surface_release_buffer(s->gs, s->locked[i].bo);
        if (s->esurf) egl.DestroySurface(s->gpu->dpy, s->esurf);
        if (s->gs) gbm.surface_destroy(s->gs);
    }
    free(s);
}

static napi_value get_external(napi_env env, napi_value v, void **out) {
    if (napi_get_value_external(env, v, out) != napi_ok || !*out) {
        napi_throw_error(env, NULL, "expected a native handle");
        return NULL;
    }
    return v;
}

// createGpu(drmFd, formatFourcc, depthSize) -> external
// The fd is dup'ed; the caller keeps (and eventually closes) its own.
static napi_value CreateGpu(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3);
    int fd = arg_i32(env, args[0]);
    uint32_t format = arg_u32(env, args[1]);
    int depth_size = arg_i32(env, args[2]);

    const char *e;
    if ((e = load_gbm()) || (e = load_egl()) || (e = load_gles()))
        THROWF(env, "GPU support unavailable: %s", e);

    int dupfd = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    if (dupfd < 0)
        THROWF(env, "dup of DRM fd failed: %s", strerror(errno));

    Gpu *g = calloc(1, sizeof(Gpu));
    g->drm_fd = dupfd;
    g->format = format ? format : GBM_FORMAT_XRGB8888;

    g->gbm = gbm.create_device(dupfd);
    if (!g->gbm) {
        close(dupfd); free(g);
        THROW(env, "gbm_create_device failed (not a DRM device fd?)");
    }

    g->dpy = egl.GetPlatformDisplay
        ? egl.GetPlatformDisplay(EGL_PLATFORM_GBM_KHR, g->gbm, NULL)
        : egl.GetPlatformDisplayEXT(EGL_PLATFORM_GBM_KHR, g->gbm, NULL);
    EGLint maj, min;
    if (!g->dpy || !egl.Initialize(g->dpy, &maj, &min)) {
        EGLint ec = egl.GetError();
        gbm.device_destroy(g->gbm); close(dupfd); free(g);
        THROWF(env, "eglInitialize on GBM platform failed (0x%x)", ec);
    }
    egl.BindAPI(EGL_OPENGL_ES_API);

    // Pick a config whose native visual is exactly our GBM format; EGL is
    // allowed to return both XRGB and ARGB for the same rgb888 request.
    EGLint want_alpha = (g->format == GBM_FORMAT_ARGB8888) ? 8 : 0;
    const EGLint attribs[] = {
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, want_alpha,
        EGL_DEPTH_SIZE, depth_size,
        EGL_NONE
    };
    EGLConfig cfgs[64];
    EGLint ncfg = 0;
    if (!egl.ChooseConfig(g->dpy, attribs, cfgs, 64, &ncfg) || ncfg == 0) {
        egl.Terminate(g->dpy); gbm.device_destroy(g->gbm); close(dupfd); free(g);
        THROW(env, "no EGL config for rgb888 + depth on this device");
    }
    g->cfg = cfgs[0];
    for (EGLint i = 0; i < ncfg; i++) {
        EGLint vid = 0;
        if (egl.GetConfigAttrib(g->dpy, cfgs[i], EGL_NATIVE_VISUAL_ID, &vid) &&
            (uint32_t)vid == g->format) {
            g->cfg = cfgs[i];
            break;
        }
    }

    const EGLint ctx_attribs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    g->ctx = egl.CreateContext(g->dpy, g->cfg, NULL, ctx_attribs);
    if (!g->ctx) {
        EGLint ec = egl.GetError();
        egl.Terminate(g->dpy); gbm.device_destroy(g->gbm); close(dupfd); free(g);
        THROWF(env, "eglCreateContext(ES2) failed (0x%x)", ec);
    }

    napi_value ext;
    NAPI_CALL(env, napi_create_external(env, g, gpu_finalize, NULL, &ext));
    return ext;
}

// gpuInfo(gpu) -> { eglVendor, eglVersion }
static napi_value GpuInfo(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    Gpu *g;
    if (!get_external(env, args[0], (void **)&g)) return NULL;
    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    obj_set(env, obj, "eglVendor", mk_str(env, egl.QueryString(g->dpy, EGL_VENDOR)));
    obj_set(env, obj, "eglVersion", mk_str(env, egl.QueryString(g->dpy, EGL_VERSION)));
    return obj;
}

// createSurface(gpu, width, height, useFlags) -> external
static napi_value CreateSurface(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4);
    Gpu *g;
    if (!get_external(env, args[0], (void **)&g)) return NULL;
    uint32_t w = arg_u32(env, args[1]);
    uint32_t h = arg_u32(env, args[2]);
    uint32_t use = arg_u32(env, args[3]);
    if (!use) use = GBM_BO_USE_RENDERING;

    struct gbm_surface *gs = gbm.surface_create(g->gbm, w, h, g->format, use);
    if (!gs)
        THROW(env, "gbm_surface_create failed (format/use not supported by driver)");
    EGLSurface esurf = egl.CreateWindowSurface(g->dpy, g->cfg, gs, NULL);
    if (!esurf) {
        EGLint ec = egl.GetError();
        gbm.surface_destroy(gs);
        THROWF(env, "eglCreateWindowSurface on gbm_surface failed (0x%x)", ec);
    }

    Surface *s = calloc(1, sizeof(Surface));
    s->gpu = g;
    s->gs = gs;
    s->esurf = esurf;
    s->width = w;
    s->height = h;

    napi_value ext;
    NAPI_CALL(env, napi_create_external(env, s, surface_finalize, NULL, &ext));
    return ext;
}

// makeCurrent(gpu, surface|null)
static napi_value MakeCurrent(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    Gpu *g;
    if (!get_external(env, args[0], (void **)&g)) return NULL;
    napi_valuetype t;
    napi_typeof(env, args[1], &t);
    Surface *s = NULL;
    if (t == napi_external && !get_external(env, args[1], (void **)&s)) return NULL;
    EGLSurface es = s ? s->esurf : NULL;
    if (!egl.MakeCurrent(g->dpy, es, es, s ? g->ctx : NULL))
        THROWF(env, "eglMakeCurrent failed (0x%x)", egl.GetError());
    if (s) {
        egl.SwapInterval(g->dpy, 0); // gbm surfaces have no vblank; Present paces us
        has_current = 1;
    } else {
        has_current = 0;
    }
    return NULL;
}

// swapBuffers(gpu, surface) -> { key, isNew, width, height, stride?, offset?, fd?, modifier? (BigInt) }
// Finishes the frame, locks the new front buffer and reports it. The buffer
// stays locked (owned by the caller) until releaseBuffer(key) — that is what
// keeps the pixels alive while the X server still reads them (Present
// IdleNotify is the release signal). On first sight of a buffer (isNew) a
// fresh dma-buf export fd is included; the receiver owns it.
static napi_value SwapBuffers(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    Gpu *g;
    Surface *s;
    if (!get_external(env, args[0], (void **)&g)) return NULL;
    if (!get_external(env, args[1], (void **)&s)) return NULL;

    if (s->nlocked >= MAX_LOCKED)
        THROW(env, "too many locked buffers — releaseBuffer() lost?");
    if (!egl.SwapBuffers(g->dpy, s->esurf)) {
        EGLint ec = egl.GetError();
        if (ec == 0x3003 /* EGL_BAD_ALLOC */) {
            // every buffer of the gbm surface is still locked by the caller:
            // not an error, a pacing signal — wait for a release and retry
            napi_value nul;
            napi_get_null(env, &nul);
            return nul;
        }
        THROWF(env, "eglSwapBuffers failed (0x%x)", ec);
    }

    struct gbm_bo *bo = gbm.surface_lock_front_buffer(s->gs);
    if (!bo) { // same pacing signal, reported at lock time by some drivers
        napi_value nul;
        napi_get_null(env, &nul);
        return nul;
    }

    uint32_t key = gbm.bo_get_handle(bo).u32;
    s->locked[s->nlocked].key = key;
    s->locked[s->nlocked].bo = bo;
    s->nlocked++;

    int is_new = gbm.bo_get_user_data(bo) == NULL;

    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    obj_set(env, obj, "key", mk_u32(env, key));
    obj_set(env, obj, "isNew", mk_bool(env, is_new));
    obj_set(env, obj, "width", mk_u32(env, s->width));
    obj_set(env, obj, "height", mk_u32(env, s->height));

    if (is_new) {
        gbm.bo_set_user_data(bo, (void *)1, NULL);
        int fd = gbm.bo_get_fd(bo);
        if (fd < 0)
            THROW(env, "gbm_bo_get_fd failed — device cannot export dma-bufs");
        uint64_t modifier = gbm.bo_get_modifier ? gbm.bo_get_modifier(bo)
                                                : DRM_FORMAT_MOD_INVALID;
        uint32_t offset = gbm.bo_get_offset ? gbm.bo_get_offset(bo, 0) : 0;
        obj_set(env, obj, "fd", mk_i32(env, fd));
        obj_set(env, obj, "stride", mk_u32(env, gbm.bo_get_stride(bo)));
        obj_set(env, obj, "offset", mk_u32(env, offset));
        napi_value big;
        NAPI_CALL(env, napi_create_bigint_uint64(env, modifier, &big));
        obj_set(env, obj, "modifier", big);
    }
    return obj;
}

// releaseBuffer(surface, key)
static napi_value ReleaseBuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    Surface *s;
    if (!get_external(env, args[0], (void **)&s)) return NULL;
    uint32_t key = arg_u32(env, args[1]);
    for (int i = 0; i < s->nlocked; i++) {
        if (s->locked[i].key == key) {
            gbm.surface_release_buffer(s->gs, s->locked[i].bo);
            s->locked[i] = s->locked[--s->nlocked];
            return NULL;
        }
    }
    THROWF(env, "releaseBuffer: no locked buffer with key %u", key);
}

// destroySurface(surface) — all locked buffers are released first
static napi_value DestroySurface(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    Surface *s;
    if (!get_external(env, args[0], (void **)&s)) return NULL;
    if (!s->destroyed) {
        for (int i = 0; i < s->nlocked; i++)
            gbm.surface_release_buffer(s->gs, s->locked[i].bo);
        s->nlocked = 0;
        egl.DestroySurface(s->gpu->dpy, s->esurf);
        gbm.surface_destroy(s->gs);
        s->destroyed = 1;
    }
    return NULL;
}

// destroyGpu(gpu)
static napi_value DestroyGpu(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    Gpu *g;
    if (!get_external(env, args[0], (void **)&g)) return NULL;
    if (!g->destroyed) {
        egl.MakeCurrent(g->dpy, NULL, NULL, NULL);
        has_current = 0;
        egl.DestroyContext(g->dpy, g->ctx);
        egl.Terminate(g->dpy);
        gbm.device_destroy(g->gbm);
        close(g->drm_fd);
        g->destroyed = 1;
    }
    return NULL;
}

// ---------------------------------------------------------------------------
// GL wrappers (valid while a context is current)
// ---------------------------------------------------------------------------

#define NEED_GL(env)                                                          \
    do {                                                                      \
        if (!gl.lib || !has_current)                                          \
            THROW(env, "no current GL context (call makeCurrent first)");     \
    } while (0)

static napi_value Gl_clearColor(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.ClearColor((GLfloat)arg_f64(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                  (GLfloat)arg_f64(env, args[2]), (GLfloat)arg_f64(env, args[3]));
    return NULL;
}
static napi_value Gl_clearDepthf(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.ClearDepthf((GLfloat)arg_f64(env, args[0]));
    return NULL;
}
static napi_value Gl_clear(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.Clear(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_viewport(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.Viewport(arg_i32(env, args[0]), arg_i32(env, args[1]),
                arg_i32(env, args[2]), arg_i32(env, args[3]));
    return NULL;
}
static napi_value Gl_enable(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.Enable(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_disable(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.Disable(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_depthFunc(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.DepthFunc(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_cullFace(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.CullFace(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_frontFace(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.FrontFace(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_lineWidth(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.LineWidth((GLfloat)arg_f64(env, args[0]));
    return NULL;
}
static napi_value Gl_pixelStorei(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.PixelStorei(arg_u32(env, args[0]), arg_i32(env, args[1]));
    return NULL;
}
static napi_value Gl_createShader(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    return mk_u32(env, gl.CreateShader(arg_u32(env, args[0])));
}
static napi_value Gl_shaderSource(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLuint sh = arg_u32(env, args[0]);
    size_t len = 0;
    napi_get_value_string_utf8(env, args[1], NULL, 0, &len);
    char *src = malloc(len + 1);
    napi_get_value_string_utf8(env, args[1], src, len + 1, &len);
    const GLchar *ptr = src;
    GLint glen = (GLint)len;
    gl.ShaderSource(sh, 1, &ptr, &glen);
    free(src);
    return NULL;
}
static napi_value Gl_compileShader(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.CompileShader(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_getShaderParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLint out = 0;
    gl.GetShaderiv(arg_u32(env, args[0]), arg_u32(env, args[1]), &out);
    return mk_i32(env, out);
}
static napi_value Gl_getShaderInfoLog(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint sh = arg_u32(env, args[0]);
    GLint len = 0;
    gl.GetShaderiv(sh, 0x8B84 /* GL_INFO_LOG_LENGTH */, &len);
    char *buf = calloc(1, len + 1);
    gl.GetShaderInfoLog(sh, len + 1, NULL, buf);
    napi_value out = mk_str(env, buf);
    free(buf);
    return out;
}
static napi_value Gl_deleteShader(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.DeleteShader(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_createProgram(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    return mk_u32(env, gl.CreateProgram());
}
static napi_value Gl_attachShader(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.AttachShader(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_linkProgram(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.LinkProgram(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_getProgramParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLint out = 0;
    gl.GetProgramiv(arg_u32(env, args[0]), arg_u32(env, args[1]), &out);
    return mk_i32(env, out);
}
static napi_value Gl_getProgramInfoLog(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint p = arg_u32(env, args[0]);
    GLint len = 0;
    gl.GetProgramiv(p, 0x8B84 /* GL_INFO_LOG_LENGTH */, &len);
    char *buf = calloc(1, len + 1);
    gl.GetProgramInfoLog(p, len + 1, NULL, buf);
    napi_value out = mk_str(env, buf);
    free(buf);
    return out;
}
static napi_value Gl_useProgram(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.UseProgram(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_deleteProgram(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.DeleteProgram(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_getAttribLocation(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    char name[256];
    size_t n = 0;
    napi_get_value_string_utf8(env, args[1], name, sizeof(name), &n);
    (void)n;
    return mk_i32(env, gl.GetAttribLocation(arg_u32(env, args[0]), name));
}
static napi_value Gl_getUniformLocation(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    char name[256];
    size_t n = 0;
    napi_get_value_string_utf8(env, args[1], name, sizeof(name), &n);
    (void)n;
    return mk_i32(env, gl.GetUniformLocation(arg_u32(env, args[0]), name));
}
static napi_value Gl_uniformMatrix4fv(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    bool transpose = arg_bool(env, args[1]);
    napi_typedarray_type type;
    size_t len;
    void *data;
    if (napi_get_typedarray_info(env, args[2], &type, &len, &data, NULL, NULL) != napi_ok ||
        type != napi_float32_array || len % 16 != 0)
        THROW(env, "uniformMatrix4fv expects a Float32Array of 16*n floats");
    gl.UniformMatrix4fv(arg_i32(env, args[0]), (GLsizei)(len / 16),
                        transpose ? 1 : 0, data);
    return NULL;
}
static napi_value Gl_uniform1f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.Uniform1f(arg_i32(env, args[0]), (GLfloat)arg_f64(env, args[1]));
    return NULL;
}
static napi_value Gl_uniform3f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.Uniform3f(arg_i32(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                 (GLfloat)arg_f64(env, args[2]), (GLfloat)arg_f64(env, args[3]));
    return NULL;
}
static napi_value Gl_uniform4f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    gl.Uniform4f(arg_i32(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                 (GLfloat)arg_f64(env, args[2]), (GLfloat)arg_f64(env, args[3]),
                 (GLfloat)arg_f64(env, args[4]));
    return NULL;
}
static napi_value Gl_uniform1i(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.Uniform1i(arg_i32(env, args[0]), arg_i32(env, args[1]));
    return NULL;
}
static napi_value Gl_createBuffer(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    GLuint b = 0;
    gl.GenBuffers(1, &b);
    return mk_u32(env, b);
}
static napi_value Gl_bindBuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.BindBuffer(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_bufferData(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    size_t len;
    void *data;
    napi_typedarray_type type;
    if (napi_get_typedarray_info(env, args[1], &type, &len, &data, NULL, NULL) != napi_ok)
        THROW(env, "bufferData expects a TypedArray");
    size_t elem = (type == napi_float32_array || type == napi_int32_array ||
                   type == napi_uint32_array) ? 4
                : (type == napi_int16_array || type == napi_uint16_array) ? 2 : 1;
    gl.BufferData(arg_u32(env, args[0]), (GLsizeiptr)(len * elem), data,
                  arg_u32(env, args[2]));
    return NULL;
}
static napi_value Gl_deleteBuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint b = arg_u32(env, args[0]);
    gl.DeleteBuffers(1, &b);
    return NULL;
}
static napi_value Gl_vertexAttribPointer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 6); NEED_GL(env);
    gl.VertexAttribPointer(arg_u32(env, args[0]), arg_i32(env, args[1]),
                           arg_u32(env, args[2]), arg_bool(env, args[3]) ? 1 : 0,
                           arg_i32(env, args[4]),
                           (const void *)(intptr_t)arg_i32(env, args[5]));
    return NULL;
}
static napi_value Gl_enableVertexAttribArray(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.EnableVertexAttribArray(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_drawArrays(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.DrawArrays(arg_u32(env, args[0]), arg_i32(env, args[1]), arg_i32(env, args[2]));
    return NULL;
}
static napi_value Gl_drawElements(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.DrawElements(arg_u32(env, args[0]), arg_i32(env, args[1]),
                    arg_u32(env, args[2]), (const void *)(intptr_t)arg_i32(env, args[3]));
    return NULL;
}
static napi_value Gl_finish(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    gl.Finish();
    return NULL;
}
static napi_value Gl_flush(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    gl.Flush();
    return NULL;
}
static napi_value Gl_getError(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    return mk_u32(env, gl.GetError());
}
static napi_value Gl_getString(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    return mk_str(env, (const char *)gl.GetString(arg_u32(env, args[0])));
}
static napi_value Gl_readPixels(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 7); NEED_GL(env);
    size_t len;
    void *data;
    if (napi_get_typedarray_info(env, args[6], NULL, &len, &data, NULL, NULL) != napi_ok)
        THROW(env, "readPixels expects a TypedArray destination");
    gl.ReadPixels(arg_i32(env, args[0]), arg_i32(env, args[1]),
                  arg_i32(env, args[2]), arg_i32(env, args[3]),
                  arg_u32(env, args[4]), arg_u32(env, args[5]), data);
    return NULL;
}

// ---------------------------------------------------------------------------
// dma-buf plumbing: udmabuf, DMA_BUF_IOCTL_SYNC, dup
//
// The first two are the Linux dma-buf ABI itself and are compiled out where
// the kernel has no such thing; the exported functions remain, and throw a
// message naming the reason. dup() is plain POSIX and works everywhere.
// ---------------------------------------------------------------------------

#if HAVE_DMABUF

struct udmabuf_create_args {
    uint32_t memfd;
    uint32_t flags;
    uint64_t offset;
    uint64_t size;
};
#define UDMABUF_FLAGS_CLOEXEC 0x01
#define UDMABUF_CREATE _IOW('u', 0x42, struct udmabuf_create_args)

struct dma_buf_sync_args { uint64_t flags; };
#define DMA_BUF_IOCTL_SYNC _IOW('b', 0, struct dma_buf_sync_args)

static void unmap_finalize(napi_env env, void *data, void *hint) {
    (void)env;
    munmap(data, (size_t)(uintptr_t)hint);
}

// udmabufCreate(size) -> { fd, memfd, size, buffer }
// Builds a dma-buf out of plain CPU memory: memfd -> seal -> UDMABUF_CREATE.
// `buffer` is the memfd mapping as an ArrayBuffer — writing into it writes
// the pixels the dma-buf (and thus a DRI3 pixmap made from it) shows. The
// software path to DRI3/Present on hosts without a usable GPU.
static napi_value UdmabufCreate(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    uint32_t req_size = arg_u32(env, args[0]);
    long page = sysconf(_SC_PAGESIZE);
    uint64_t size = (req_size + page - 1) & ~(uint64_t)(page - 1);

    int memfd = memfd_create("x11-dri-soft", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (memfd < 0)
        THROWF(env, "memfd_create failed: %s", strerror(errno));
    if (ftruncate(memfd, size) != 0 ||
        fcntl(memfd, F_ADD_SEALS, F_SEAL_SHRINK) != 0) {
        int e = errno; close(memfd);
        THROWF(env, "memfd setup failed: %s", strerror(e));
    }

    int ud = open("/dev/udmabuf", O_RDWR | O_CLOEXEC);
    if (ud < 0) {
        int e = errno; close(memfd);
        THROWF(env, "/dev/udmabuf unavailable: %s", strerror(e));
    }
    struct udmabuf_create_args create = {
        .memfd = (uint32_t)memfd,
        .flags = UDMABUF_FLAGS_CLOEXEC,
        .offset = 0,
        .size = size
    };
    int dmabuf = ioctl(ud, UDMABUF_CREATE, &create);
    close(ud);
    if (dmabuf < 0) {
        int e = errno; close(memfd);
        THROWF(env, "UDMABUF_CREATE failed: %s", strerror(e));
    }

    void *map = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, memfd, 0);
    if (map == MAP_FAILED) {
        int e = errno; close(memfd); close(dmabuf);
        THROWF(env, "mmap of memfd failed: %s", strerror(e));
    }

    napi_value obj, ab;
    NAPI_CALL(env, napi_create_object(env, &obj));
    obj_set(env, obj, "fd", mk_i32(env, dmabuf));
    obj_set(env, obj, "memfd", mk_i32(env, memfd));
    obj_set(env, obj, "size", mk_u32(env, (uint32_t)size));
    // unmapped when the ArrayBuffer is collected; the fds are closed by JS
    NAPI_CALL(env, napi_create_external_arraybuffer(
        env, map, size, unmap_finalize, (void *)(uintptr_t)size, &ab));
    obj_set(env, obj, "buffer", ab);
    return obj;
}

// dmabufSync(fd, flags) — bracket CPU access (DMA_BUF_SYNC_* flags)
static napi_value DmabufSync(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    struct dma_buf_sync_args sync = { .flags = (uint64_t)arg_u32(env, args[1]) };
    if (ioctl(arg_i32(env, args[0]), DMA_BUF_IOCTL_SYNC, &sync) != 0)
        THROWF(env, "DMA_BUF_IOCTL_SYNC failed: %s", strerror(errno));
    return NULL;
}

#else // !HAVE_DMABUF

#define NO_DMABUF                                                             \
    "dma-buf is a Linux kernel facility with no " PLATFORM_NAME " equivalent" \
    " (and XQuartz implements no DRI3 extension to receive one)"

static napi_value UdmabufCreate(napi_env env, napi_callback_info info) {
    (void)info;
    THROW(env, "udmabufCreate: " NO_DMABUF);
}
static napi_value DmabufSync(napi_env env, napi_callback_info info) {
    (void)info;
    THROW(env, "dmabufSync: " NO_DMABUF);
}

#endif // HAVE_DMABUF

// dup(fd) -> fd (CLOEXEC). For "send a copy, keep mine" descriptor passing.
static napi_value Dup(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    int nfd = fcntl(arg_i32(env, args[0]), F_DUPFD_CLOEXEC, 3);
    if (nfd < 0)
        THROWF(env, "dup failed: %s", strerror(errno));
    return mk_i32(env, nfd);
}

// probe() -> availability report, never throws.
// Each capability is `true` when usable, or a string saying why it is not.
// `platform` and `dmabuf` describe the host itself: dmabuf === false means no
// amount of installing libraries will make the DRI3 path work here.
static napi_value Probe(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    const char *e;
    obj_set(env, obj, "platform", mk_str(env, PLATFORM_NAME));
    obj_set(env, obj, "dmabuf", mk_bool(env, HAVE_DMABUF));
    e = load_gbm();
    obj_set(env, obj, "gbm", e ? mk_str(env, e) : mk_bool(env, true));
    e = load_egl();
    obj_set(env, obj, "egl", e ? mk_str(env, e) : mk_bool(env, true));
    e = load_gles();
    obj_set(env, obj, "gles", e ? mk_str(env, e) : mk_bool(env, true));
#if HAVE_DMABUF
    obj_set(env, obj, "udmabuf", mk_bool(env, access("/dev/udmabuf", W_OK) == 0));
#else
    obj_set(env, obj, "udmabuf", mk_str(env, NO_DMABUF));
#endif
    return obj;
}

// ---------------------------------------------------------------------------
// module init
// ---------------------------------------------------------------------------

static napi_value make_fn(napi_env env, napi_callback cb) {
    napi_value fn;
    napi_create_function(env, NULL, 0, cb, NULL, &fn);
    return fn;
}

NAPI_MODULE_INIT() {
#define EXPORT(name, cb) obj_set(env, exports, name, make_fn(env, cb))
    EXPORT("probe", Probe);
    EXPORT("dup", Dup);
    EXPORT("udmabufCreate", UdmabufCreate);
    EXPORT("dmabufSync", DmabufSync);

    EXPORT("createGpu", CreateGpu);
    EXPORT("gpuInfo", GpuInfo);
    EXPORT("createSurface", CreateSurface);
    EXPORT("makeCurrent", MakeCurrent);
    EXPORT("swapBuffers", SwapBuffers);
    EXPORT("releaseBuffer", ReleaseBuffer);
    EXPORT("destroySurface", DestroySurface);
    EXPORT("destroyGpu", DestroyGpu);

    EXPORT("glClearColor", Gl_clearColor);
    EXPORT("glClearDepthf", Gl_clearDepthf);
    EXPORT("glClear", Gl_clear);
    EXPORT("glViewport", Gl_viewport);
    EXPORT("glEnable", Gl_enable);
    EXPORT("glDisable", Gl_disable);
    EXPORT("glDepthFunc", Gl_depthFunc);
    EXPORT("glCullFace", Gl_cullFace);
    EXPORT("glFrontFace", Gl_frontFace);
    EXPORT("glLineWidth", Gl_lineWidth);
    EXPORT("glPixelStorei", Gl_pixelStorei);
    EXPORT("glCreateShader", Gl_createShader);
    EXPORT("glShaderSource", Gl_shaderSource);
    EXPORT("glCompileShader", Gl_compileShader);
    EXPORT("glGetShaderParameter", Gl_getShaderParameter);
    EXPORT("glGetShaderInfoLog", Gl_getShaderInfoLog);
    EXPORT("glDeleteShader", Gl_deleteShader);
    EXPORT("glCreateProgram", Gl_createProgram);
    EXPORT("glAttachShader", Gl_attachShader);
    EXPORT("glLinkProgram", Gl_linkProgram);
    EXPORT("glGetProgramParameter", Gl_getProgramParameter);
    EXPORT("glGetProgramInfoLog", Gl_getProgramInfoLog);
    EXPORT("glUseProgram", Gl_useProgram);
    EXPORT("glDeleteProgram", Gl_deleteProgram);
    EXPORT("glGetAttribLocation", Gl_getAttribLocation);
    EXPORT("glGetUniformLocation", Gl_getUniformLocation);
    EXPORT("glUniformMatrix4fv", Gl_uniformMatrix4fv);
    EXPORT("glUniform1f", Gl_uniform1f);
    EXPORT("glUniform3f", Gl_uniform3f);
    EXPORT("glUniform4f", Gl_uniform4f);
    EXPORT("glUniform1i", Gl_uniform1i);
    EXPORT("glCreateBuffer", Gl_createBuffer);
    EXPORT("glBindBuffer", Gl_bindBuffer);
    EXPORT("glBufferData", Gl_bufferData);
    EXPORT("glDeleteBuffer", Gl_deleteBuffer);
    EXPORT("glVertexAttribPointer", Gl_vertexAttribPointer);
    EXPORT("glEnableVertexAttribArray", Gl_enableVertexAttribArray);
    EXPORT("glDrawArrays", Gl_drawArrays);
    EXPORT("glDrawElements", Gl_drawElements);
    EXPORT("glFinish", Gl_finish);
    EXPORT("glFlush", Gl_flush);
    EXPORT("glGetError", Gl_getError);
    EXPORT("glGetString", Gl_getString);
    EXPORT("glReadPixels", Gl_readPixels);
#undef EXPORT
    return exports;
}
