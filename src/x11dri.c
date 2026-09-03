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

// A TypedArray as raw bytes. GL sizes its buffer and pixel uploads in bytes,
// while napi reports a length in elements, so the view's element size has to
// come back into it — getting that wrong uploads a fraction of the data.
static bool typed_bytes(napi_env env, napi_value v, void **data, size_t *nbytes) {
    napi_typedarray_type type;
    size_t len;
    if (napi_get_typedarray_info(env, v, &type, &len, data, NULL, NULL) != napi_ok)
        return false;
    size_t elem;
    switch (type) {
        case napi_float64_array: case napi_bigint64_array:
        case napi_biguint64_array:                            elem = 8; break;
        case napi_float32_array: case napi_int32_array:
        case napi_uint32_array:                               elem = 4; break;
        case napi_int16_array: case napi_uint16_array:        elem = 2; break;
        default:                                              elem = 1; break;
    }
    *nbytes = len * elem;
    return true;
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
#define EGL_OPENGL_ES3_BIT        0x0040 // EGL 1.5; EGL_OPENGL_ES3_BIT_KHR before
#define EGL_OPENGL_ES_API         0x30A0
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_VENDOR                0x3053
#define EGL_VERSION               0x3054
#define EGL_PLATFORM_GBM_KHR      0x31D7

// EGL_KHR_image_base + EGL_EXT_image_dma_buf_import(_modifiers): the way in
// for a dma-buf that some other process allocated. eglCreateImageKHR turns
// the descriptor(s) into an EGLImage, glEGLImageTargetTexture2DOES binds
// that image to a texture, and from then on it is an ordinary sampler.
#define EGL_NO_CONTEXT            ((EGLContext)0)
#define EGL_NO_IMAGE_KHR          ((EGLImageKHR)0)
#define EGL_EXTENSIONS            0x3055
#define EGL_HEIGHT                0x3056
#define EGL_WIDTH                 0x3057
#define EGL_LINUX_DMA_BUF_EXT     0x3270
#define EGL_LINUX_DRM_FOURCC_EXT  0x3271
// The per-plane attribute names are tables in ImportDmabuf: planes 0..2 are
// consecutive triples from 0x3272, but plane 3 was added later and sits out
// of sequence at 0x3440, so arithmetic on the first name does not work.

typedef void *EGLImageKHR;
typedef void *EGLClientBuffer;

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

// GL_OES_EGL_image_external: the texture target a multi-planar or YUV
// EGLImage must be bound to (and samples through samplerExternalOES).
#define GL_TEXTURE_2D                   0x0DE1
#define GL_TEXTURE_EXTERNAL_OES         0x8D65
#define GL_TEXTURE_BINDING_2D           0x8069
#define GL_TEXTURE_BINDING_EXTERNAL_OES 0x8D67

#if defined(__APPLE__)
// ---------------------------------------------------------------------------
// Minimal CGL / Xplugin declarations (from OpenGL/CGLTypes.h and the SDK's
// Xplugin.h — both stable ABI, both dlopen'd like everything else here).
//
// This is the client half of XQuartz's own direct-rendering design: the X
// server exports the window's WindowServer surface to us by a two-word key
// (the Apple-DRI extension, spoken in JS by the x11 package), we import it
// over our own WindowServer connection and attach a CGL context to it. From
// then on GL renders straight into the window's backing store — the same
// zero-copy path XQuartz's libGL gives GLX clients, minus GLX.
// ---------------------------------------------------------------------------

#define LIB_XPLUGIN "/usr/lib/libXplugin.1.dylib" // dyld-cache-only file; dlopen works
#define LIB_OPENGL  "/System/Library/Frameworks/OpenGL.framework/OpenGL"
#define LIB_COREGRAPHICS "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
#define LIB_COREVIDEO    "/System/Library/Frameworks/CoreVideo.framework/CoreVideo"

#define XP_SUCCESS       0
#define XP_IN_BACKGROUND (1 << 0)

// CGLPixelFormatAttribute / CGLContextParameter values (CGLTypes.h)
#define kCGLPFADoubleBuffer   5
#define kCGLPFAColorSize      8
#define kCGLPFAAlphaSize      11
#define kCGLPFADepthSize      12
#define kCGLPFAStencilSize    13
#define kCGLPFAAccelerated    73
#define kCGLPFAClosestPolicy  74
#define kCGLPFAOpenGLProfile  99
#define kCGLOGLPVersion_3_2_Core 0x3200 // "3.2 or later" — 4.1 on Metal
#define kCGLCPSwapInterval    222

typedef void *CGLPixelFormatObj;
typedef void *CGLContextObj;
#endif

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
    // EGL_KHR_image_base, resolved per display in resolve_egl_image(): null
    // where the driver has no image extension at all.
    EGLImageKHR (*CreateImageKHR)(EGLDisplay, EGLContext, EGLenum,
                                  EGLClientBuffer, const EGLint *);
    EGLBoolean (*DestroyImageKHR)(EGLDisplay, EGLImageKHR);
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
    // desktop-GL only (may be NULL): the extension list of a core-profile
    // context, where GetString(GL_EXTENSIONS) answers NULL + INVALID_ENUM
    const uint8_t *(*GetStringi)(GLenum, GLuint);
    void (*ReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
    // textures
    void (*GenTextures)(GLsizei, GLuint *);
    void (*DeleteTextures)(GLsizei, const GLuint *);
    void (*BindTexture)(GLenum, GLuint);
    void (*ActiveTexture)(GLenum);
    void (*TexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *);
    void (*TexSubImage2D)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *);
    void (*TexParameteri)(GLenum, GLenum, GLint);
    void (*TexParameterf)(GLenum, GLenum, GLfloat);
    void (*GenerateMipmap)(GLenum);
    // blending and the rest of the per-fragment state
    void (*BlendFunc)(GLenum, GLenum);
    void (*BlendFuncSeparate)(GLenum, GLenum, GLenum, GLenum);
    void (*BlendEquation)(GLenum);
    void (*BlendEquationSeparate)(GLenum, GLenum);
    void (*BlendColor)(GLfloat, GLfloat, GLfloat, GLfloat);
    void (*DepthMask)(GLboolean);
    void (*DepthRangef)(GLfloat, GLfloat);
    void (*ColorMask)(GLboolean, GLboolean, GLboolean, GLboolean);
    void (*Scissor)(GLint, GLint, GLsizei, GLsizei);
    void (*PolygonOffset)(GLfloat, GLfloat);
    void (*StencilFunc)(GLenum, GLint, GLuint);
    void (*StencilOp)(GLenum, GLenum, GLenum);
    void (*StencilMask)(GLuint);
    void (*ClearStencil)(GLint);
    // the rest of the uniform setters
    void (*Uniform2f)(GLint, GLfloat, GLfloat);
    void (*Uniform2i)(GLint, GLint, GLint);
    void (*Uniform3i)(GLint, GLint, GLint, GLint);
    void (*Uniform4i)(GLint, GLint, GLint, GLint, GLint);
    void (*Uniform1fv)(GLint, GLsizei, const GLfloat *);
    void (*Uniform2fv)(GLint, GLsizei, const GLfloat *);
    void (*Uniform3fv)(GLint, GLsizei, const GLfloat *);
    void (*Uniform4fv)(GLint, GLsizei, const GLfloat *);
    void (*Uniform1iv)(GLint, GLsizei, const GLint *);
    void (*UniformMatrix2fv)(GLint, GLsizei, GLboolean, const GLfloat *);
    void (*UniformMatrix3fv)(GLint, GLsizei, GLboolean, const GLfloat *);
    // attributes and buffer updates
    void (*DisableVertexAttribArray)(GLuint);
    void (*BindAttribLocation)(GLuint, GLuint, const GLchar *);
    void (*VertexAttrib1f)(GLuint, GLfloat);
    void (*VertexAttrib2f)(GLuint, GLfloat, GLfloat);
    void (*VertexAttrib3f)(GLuint, GLfloat, GLfloat, GLfloat);
    void (*VertexAttrib4f)(GLuint, GLfloat, GLfloat, GLfloat, GLfloat);
    void (*BufferSubData)(GLenum, GLintptr, GLsizeiptr, const void *);
    // framebuffer and renderbuffer objects: render to texture
    void (*GenFramebuffers)(GLsizei, GLuint *);
    void (*DeleteFramebuffers)(GLsizei, const GLuint *);
    void (*BindFramebuffer)(GLenum, GLuint);
    void (*FramebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, GLint);
    void (*FramebufferRenderbuffer)(GLenum, GLenum, GLenum, GLuint);
    GLenum (*CheckFramebufferStatus)(GLenum);
    void (*GenRenderbuffers)(GLsizei, GLuint *);
    void (*DeleteRenderbuffers)(GLsizei, const GLuint *);
    void (*BindRenderbuffer)(GLenum, GLuint);
    void (*RenderbufferStorage)(GLenum, GLenum, GLsizei, GLsizei);
    // state queries
    void (*GetIntegerv)(GLenum, GLint *);
    void (*GetFloatv)(GLenum, GLfloat *);
    void (*GetBooleanv)(GLenum, GLboolean *);
    // introspection: what a linked program declares, and what an object holds
    void (*GetActiveUniform)(GLuint, GLuint, GLsizei, GLsizei *, GLint *, GLenum *, GLchar *);
    void (*GetActiveAttrib)(GLuint, GLuint, GLsizei, GLsizei *, GLint *, GLenum *, GLchar *);
    void (*GetUniformfv)(GLuint, GLint, GLfloat *);
    void (*GetUniformiv)(GLuint, GLint, GLint *);
    void (*GetVertexAttribfv)(GLuint, GLenum, GLfloat *);
    void (*GetVertexAttribiv)(GLuint, GLenum, GLint *);
    void (*GetVertexAttribPointerv)(GLuint, GLenum, void **);
    void (*GetBufferParameteriv)(GLenum, GLenum, GLint *);
    void (*GetTexParameteriv)(GLenum, GLenum, GLint *);
    void (*GetAttachedShaders)(GLuint, GLsizei, GLsizei *, GLuint *);
    void (*GetShaderPrecisionFormat)(GLenum, GLenum, GLint *, GLint *);
    void (*GetShaderSource)(GLuint, GLsizei, GLsizei *, GLchar *);
    void (*GetFramebufferAttachmentParameteriv)(GLenum, GLenum, GLenum, GLint *);
    void (*GetRenderbufferParameteriv)(GLenum, GLenum, GLint *);
    void (*ValidateProgram)(GLuint);
    GLboolean (*IsBuffer)(GLuint);
    GLboolean (*IsEnabled)(GLenum);
    GLboolean (*IsFramebuffer)(GLuint);
    GLboolean (*IsProgram)(GLuint);
    GLboolean (*IsRenderbuffer)(GLuint);
    GLboolean (*IsShader)(GLuint);
    GLboolean (*IsTexture)(GLuint);
    // compressed texture images (the entry points are core ES 2.0; which
    // formats they accept is per-driver, from the extension string)
    void (*CompressedTexImage2D)(GLenum, GLint, GLenum, GLsizei, GLsizei, GLint, GLsizei, const void *);
    void (*CompressedTexSubImage2D)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLsizei, const void *);
    // Optional: core in ES 3.0, extensions before it, absent on drivers with
    // neither. Null is a legal state for these — see resolve_optional_gl.
    void (*GenVertexArrays)(GLsizei, GLuint *);
    void (*DeleteVertexArrays)(GLsizei, const GLuint *);
    void (*BindVertexArray)(GLuint);
    GLboolean (*IsVertexArray)(GLuint);
    void (*DrawArraysInstanced)(GLenum, GLint, GLsizei, GLsizei);
    void (*DrawElementsInstanced)(GLenum, GLsizei, GLenum, const void *, GLsizei);
    void (*VertexAttribDivisor)(GLuint, GLuint);
    void (*DrawBuffers)(GLsizei, const GLenum *);
    void (*TexImage3D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *);
    void (*TexSubImage3D)(GLenum, GLint, GLint, GLint, GLint, GLsizei, GLsizei, GLsizei, GLenum, GLenum, const void *);
    void (*CopyTexSubImage3D)(GLenum, GLint, GLint, GLint, GLint, GLint, GLint, GLsizei, GLsizei);
    void (*CompressedTexImage3D)(GLenum, GLint, GLenum, GLsizei, GLsizei, GLsizei, GLint, GLsizei, const void *);
    void (*CompressedTexSubImage3D)(GLenum, GLint, GLint, GLint, GLint, GLsizei, GLsizei, GLsizei, GLenum, GLsizei, const void *);
    void (*FramebufferTextureLayer)(GLenum, GLenum, GLuint, GLint, GLint);
    void (*TexStorage2D)(GLenum, GLsizei, GLenum, GLsizei, GLsizei);
    void (*TexStorage3D)(GLenum, GLsizei, GLenum, GLsizei, GLsizei, GLsizei);
    // GL_OES_EGL_image: the receiving end of an EGLImage. Resolved next to
    // the EGL image entry points, and null wherever they are.
    void (*EGLImageTargetTexture2DOES)(GLenum, void *);
} gl;

#if defined(__APPLE__)
// Xplugin: the private-but-ABI-stable client library of the macOS
// WindowServer that XQuartz is built on. Declarations match the SDK's
// Xplugin.h; xp_error is an int, ids are unsigned ints.
static struct {
    void *lib;
    int (*init)(unsigned int options);
    int (*get_client_id)(unsigned int *ret);
    int (*import_surface)(const unsigned int key[2], unsigned int *sid);
    int (*destroy_surface)(unsigned int sid);
    int (*attach_gl_context)(void *cgl_ctx, unsigned int sid);
    int (*update_gl_context)(void *cgl_ctx);
} xp;

static struct {
    void *lib;
    int (*ChoosePixelFormat)(const int *attribs, CGLPixelFormatObj *pf, GLint *npix);
    int (*DestroyPixelFormat)(CGLPixelFormatObj pf);
    int (*CreateContext)(CGLPixelFormatObj pf, CGLContextObj share, CGLContextObj *ctx);
    int (*DestroyContext)(CGLContextObj ctx);
    int (*SetCurrentContext)(CGLContextObj ctx);
    CGLContextObj (*GetCurrentContext)(void);
    int (*FlushDrawable)(CGLContextObj ctx);
    int (*ClearDrawable)(CGLContextObj ctx);
    int (*SetParameter)(CGLContextObj ctx, int pname, const GLint *params);
    const char *(*ErrorString)(int err);
    int (*TexImageIOSurface2D)(CGLContextObj ctx, unsigned target,
                               unsigned internal_format, GLsizei width,
                               GLsizei height, unsigned format, unsigned type,
                               void *iosurface, unsigned plane);
} cgl;

// CoreGraphics + CoreVideo, for the one display question the X side cannot
// answer: how fast the panels actually refresh. XQuartz's RandR advertises
// modes with no timing data (dotClock/hTotal/vTotal all zero), so a consumer
// pacing frames has nobody to ask but macOS itself.
typedef struct { // CVTime (CoreVideo/CVBase.h); returned by value
    int64_t timeValue;
    int32_t timeScale;
    int32_t flags;
} CVTime_;
#define kCVTimeIsIndefinite_ (1 << 0)

static struct {
    void *cg_lib;
    void *cv_lib; // optional — only the fallback lives here
    int32_t (*GetOnlineDisplayList)(uint32_t max, uint32_t *ids, uint32_t *n);
    void *(*CopyDisplayMode)(uint32_t id);
    double (*ModeGetRefreshRate)(void *mode);
    void (*ModeRelease)(void *mode);
    int32_t (*LinkCreateWithCGDisplay)(uint32_t id, void **link);
    CVTime_ (*LinkGetNominalPeriod)(void *link);
    void (*LinkRelease)(void *link);
} dsp;
#endif

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

// Fill the gl table from an already-dlopen'd library. Shared between the two
// sources of GL entry points: Linux's libGLESv2, and on macOS the system
// OpenGL framework (whose desktop GL exports the whole ES 2.0 name set —
// glClearDepthf and glDepthRangef included, via GL 4.1's ES2 compatibility).
static const char *fill_gl_table(void *h) {
    static char err[96];
#define S(field, name)                                                        \
    do {                                                                      \
        *(void **)&gl.field = dlsym(h, name);                                 \
        if (!gl.field) {                                                      \
            snprintf(err, sizeof err, "GL library is missing %s", name);      \
            return err;                                                       \
        }                                                                     \
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
    // Everything below is core ES 2.0 as well, so a libGLESv2 that has the
    // above has these too — a miss here means the library is not what it
    // claims to be, which is worth failing the load over rather than
    // discovering as a null call later.
    S(GenTextures, "glGenTextures"); S(DeleteTextures, "glDeleteTextures");
    S(BindTexture, "glBindTexture"); S(ActiveTexture, "glActiveTexture");
    S(TexImage2D, "glTexImage2D"); S(TexSubImage2D, "glTexSubImage2D");
    S(TexParameteri, "glTexParameteri"); S(TexParameterf, "glTexParameterf");
    S(GenerateMipmap, "glGenerateMipmap");
    S(BlendFunc, "glBlendFunc"); S(BlendFuncSeparate, "glBlendFuncSeparate");
    S(BlendEquation, "glBlendEquation");
    S(BlendEquationSeparate, "glBlendEquationSeparate");
    S(BlendColor, "glBlendColor");
    S(DepthMask, "glDepthMask"); S(DepthRangef, "glDepthRangef");
    S(ColorMask, "glColorMask"); S(Scissor, "glScissor");
    S(PolygonOffset, "glPolygonOffset");
    S(StencilFunc, "glStencilFunc"); S(StencilOp, "glStencilOp");
    S(StencilMask, "glStencilMask"); S(ClearStencil, "glClearStencil");
    S(Uniform2f, "glUniform2f"); S(Uniform2i, "glUniform2i");
    S(Uniform3i, "glUniform3i"); S(Uniform4i, "glUniform4i");
    S(Uniform1fv, "glUniform1fv"); S(Uniform2fv, "glUniform2fv");
    S(Uniform3fv, "glUniform3fv"); S(Uniform4fv, "glUniform4fv");
    S(Uniform1iv, "glUniform1iv");
    S(UniformMatrix2fv, "glUniformMatrix2fv");
    S(UniformMatrix3fv, "glUniformMatrix3fv");
    S(DisableVertexAttribArray, "glDisableVertexAttribArray");
    S(BindAttribLocation, "glBindAttribLocation");
    S(VertexAttrib1f, "glVertexAttrib1f"); S(VertexAttrib2f, "glVertexAttrib2f");
    S(VertexAttrib3f, "glVertexAttrib3f"); S(VertexAttrib4f, "glVertexAttrib4f");
    S(BufferSubData, "glBufferSubData");
    S(GenFramebuffers, "glGenFramebuffers");
    S(DeleteFramebuffers, "glDeleteFramebuffers");
    S(BindFramebuffer, "glBindFramebuffer");
    S(FramebufferTexture2D, "glFramebufferTexture2D");
    S(FramebufferRenderbuffer, "glFramebufferRenderbuffer");
    S(CheckFramebufferStatus, "glCheckFramebufferStatus");
    S(GenRenderbuffers, "glGenRenderbuffers");
    S(DeleteRenderbuffers, "glDeleteRenderbuffers");
    S(BindRenderbuffer, "glBindRenderbuffer");
    S(RenderbufferStorage, "glRenderbufferStorage");
    S(GetIntegerv, "glGetIntegerv"); S(GetFloatv, "glGetFloatv");
    S(GetBooleanv, "glGetBooleanv");
    S(GetActiveUniform, "glGetActiveUniform");
    S(GetActiveAttrib, "glGetActiveAttrib");
    S(GetUniformfv, "glGetUniformfv"); S(GetUniformiv, "glGetUniformiv");
    S(GetVertexAttribfv, "glGetVertexAttribfv");
    S(GetVertexAttribiv, "glGetVertexAttribiv");
    S(GetVertexAttribPointerv, "glGetVertexAttribPointerv");
    S(GetBufferParameteriv, "glGetBufferParameteriv");
    S(GetTexParameteriv, "glGetTexParameteriv");
    S(GetAttachedShaders, "glGetAttachedShaders");
    S(GetShaderPrecisionFormat, "glGetShaderPrecisionFormat");
    S(GetShaderSource, "glGetShaderSource");
    S(GetFramebufferAttachmentParameteriv, "glGetFramebufferAttachmentParameteriv");
    S(GetRenderbufferParameteriv, "glGetRenderbufferParameteriv");
    S(ValidateProgram, "glValidateProgram");
    S(IsBuffer, "glIsBuffer"); S(IsEnabled, "glIsEnabled");
    S(IsFramebuffer, "glIsFramebuffer"); S(IsProgram, "glIsProgram");
    S(IsRenderbuffer, "glIsRenderbuffer"); S(IsShader, "glIsShader");
    S(IsTexture, "glIsTexture");
    S(CompressedTexImage2D, "glCompressedTexImage2D");
    S(CompressedTexSubImage2D, "glCompressedTexSubImage2D");
#undef S
    // Desktop GL only; NULL on GLES2 libraries. Used to enumerate extensions
    // where core profiles retired GetString(GL_EXTENSIONS).
    *(void **)&gl.GetStringi = dlsym(h, "glGetStringi");
    gl.lib = h;
    return NULL;
}

static const char *load_gles(void) {
    if (gl.lib) return NULL;
    void *h = dlopen_lib(LIB_GLES);
    if (!h) return dlerror();
    return fill_gl_table(h);
}

#if defined(__APPLE__)
// Load the Apple-DRI client pieces: Xplugin (WindowServer surface plumbing),
// CGL (context creation and presentation) and the GL entry points, all out
// of system libraries that every macOS with XQuartz support has. The GL
// table is shared with the EGL path, and on this platform it must dispatch
// into the system OpenGL framework — CGL contexts belong to it — so it is
// (re)filled from there even if a probe() already filled it from XQuartz's
// Mesa libGLESv2 (which has no way to get a current context on macOS).
static const char *load_apple(void) {
    if (xp.lib && cgl.lib) return NULL;
    void *xh = dlopen(LIB_XPLUGIN, RTLD_NOW | RTLD_GLOBAL);
    if (!xh) return "libXplugin (the WindowServer client library XQuartz "
                    "builds on) did not load — is this macOS?";
    void *oh = dlopen(LIB_OPENGL, RTLD_NOW | RTLD_GLOBAL);
    if (!oh) return "the system OpenGL framework did not load";
#define SX(field, name)                                                       \
    do {                                                                      \
        *(void **)&xp.field = dlsym(xh, name);                                \
        if (!xp.field) return "libXplugin is missing " name;                  \
    } while (0)
    SX(init, "xp_init");
    SX(get_client_id, "xp_get_client_id");
    SX(import_surface, "xp_import_surface");
    SX(destroy_surface, "xp_destroy_surface");
    SX(attach_gl_context, "xp_attach_gl_context");
    SX(update_gl_context, "xp_update_gl_context");
#undef SX
#define SC(field, name)                                                       \
    do {                                                                      \
        *(void **)&cgl.field = dlsym(oh, name);                               \
        if (!cgl.field) return "OpenGL.framework is missing " name;           \
    } while (0)
    SC(ChoosePixelFormat, "CGLChoosePixelFormat");
    SC(DestroyPixelFormat, "CGLDestroyPixelFormat");
    SC(CreateContext, "CGLCreateContext");
    SC(DestroyContext, "CGLDestroyContext");
    SC(SetCurrentContext, "CGLSetCurrentContext");
    SC(GetCurrentContext, "CGLGetCurrentContext");
    SC(FlushDrawable, "CGLFlushDrawable");
    SC(ClearDrawable, "CGLClearDrawable");
    SC(SetParameter, "CGLSetParameter");
    SC(ErrorString, "CGLErrorString");
    SC(TexImageIOSurface2D, "CGLTexImageIOSurface2D");
#undef SC
    const char *e = fill_gl_table(oh);
    if (e) return e;
    xp.lib = xh;
    cgl.lib = oh;
    return NULL;
}

// Load the display-timing query. Deliberately apart from load_apple(): this
// needs neither XQuartz nor the WindowServer handshake, only the system
// frameworks every macOS has.
static const char *load_display(void) {
    if (dsp.cg_lib) return NULL;
    void *cg = dlopen(LIB_COREGRAPHICS, RTLD_NOW | RTLD_GLOBAL);
    if (!cg) return "the CoreGraphics framework did not load";
#define SD(field, name)                                                       \
    do {                                                                      \
        *(void **)&dsp.field = dlsym(cg, name);                               \
        if (!dsp.field) return "CoreGraphics is missing " name;               \
    } while (0)
    // Online, not Active: the active list (displays available for drawing)
    // comes back empty in restricted contexts — observed under a sandboxed
    // shell whose WindowServer handshake nonetheless succeeds — while the
    // online list (everything connected, mirrored and sleeping included)
    // still answers. A superset can only raise the ceiling, never miss it.
    SD(GetOnlineDisplayList, "CGGetOnlineDisplayList");
    SD(CopyDisplayMode, "CGDisplayCopyDisplayMode");
    SD(ModeGetRefreshRate, "CGDisplayModeGetRefreshRate");
    SD(ModeRelease, "CGDisplayModeRelease");
#undef SD
    // CoreVideo covers the panels where CGDisplayModeGetRefreshRate answers
    // 0 (documented for some built-in flat panels). Its absence only narrows
    // the answer, so a miss here is not an error.
    void *cv = dlopen(LIB_COREVIDEO, RTLD_NOW | RTLD_GLOBAL);
    if (cv) {
        *(void **)&dsp.LinkCreateWithCGDisplay =
            dlsym(cv, "CVDisplayLinkCreateWithCGDisplay");
        *(void **)&dsp.LinkGetNominalPeriod =
            dlsym(cv, "CVDisplayLinkGetNominalOutputVideoRefreshPeriod");
        *(void **)&dsp.LinkRelease = dlsym(cv, "CVDisplayLinkRelease");
        if (dsp.LinkCreateWithCGDisplay && dsp.LinkGetNominalPeriod &&
            dsp.LinkRelease)
            dsp.cv_lib = cv;
        else
            dlclose(cv);
    }
    dsp.cg_lib = cg;
    return NULL;
}
#endif

// ---------------------------------------------------------------------------
// Optional GL entry points
//
// Vertex array objects, instanced drawing and multiple render targets are
// core in ES 3.0 and extensions before it, so which spelling exists — and
// whether either does — is a property of the driver and of the context, not
// of this build. They are resolved apart from the mandatory table above: a
// miss leaves a null slot and makes the wrapper throw, where S() would have
// failed the whole module load.
//
// Two things make this more than a dlsym. Mesa exports the entire ES 3.2
// symbol set from libGLESv2.so.2 whatever the context actually supports, so
// finding glDrawArraysInstanced there proves nothing about being allowed to
// call it — hence the version gate on the core spelling. And a driver that
// has the extension but not the core function commonly exports neither,
// offering the suffixed name through eglGetProcAddress alone — hence the
// second lookup. Both facts need a live context, so this runs from
// makeCurrent rather than at load time.
// ---------------------------------------------------------------------------

typedef struct {
    const char *name;
    const char *ext; // NULL means the core spelling, which needs ES 3.0 —
                     // or, on desktop GL (the macOS CGL path), `desk`
    int desk;        // ×10 desktop version the core spelling appeared in;
                     // 0 = ES only, never satisfied by a desktop version
} GlCandidate;

typedef struct {
    void **slot;
    const char *feature; // the name this is reported and complained about under
    GlCandidate cand[4];
} GlOptional;

static const GlOptional gl_optional[] = {
    { (void **)&gl.GenVertexArrays, "vertexArrayObject", {
        { "glGenVertexArrays", NULL, 30 },
        { "glGenVertexArraysOES", "GL_OES_vertex_array_object", 0 } } },
    { (void **)&gl.DeleteVertexArrays, "vertexArrayObject", {
        { "glDeleteVertexArrays", NULL, 30 },
        { "glDeleteVertexArraysOES", "GL_OES_vertex_array_object", 0 } } },
    { (void **)&gl.BindVertexArray, "vertexArrayObject", {
        { "glBindVertexArray", NULL, 30 },
        { "glBindVertexArrayOES", "GL_OES_vertex_array_object", 0 } } },
    { (void **)&gl.IsVertexArray, "vertexArrayObject", {
        { "glIsVertexArray", NULL, 30 },
        { "glIsVertexArrayOES", "GL_OES_vertex_array_object", 0 } } },
    { (void **)&gl.DrawArraysInstanced, "instancedArrays", {
        { "glDrawArraysInstanced", NULL, 31 },
        { "glDrawArraysInstancedEXT", "GL_EXT_instanced_arrays", 0 },
        { "glDrawArraysInstancedANGLE", "GL_ANGLE_instanced_arrays", 0 },
        { "glDrawArraysInstancedNV", "GL_NV_instanced_arrays", 0 } } },
    { (void **)&gl.DrawElementsInstanced, "instancedArrays", {
        { "glDrawElementsInstanced", NULL, 31 },
        { "glDrawElementsInstancedEXT", "GL_EXT_instanced_arrays", 0 },
        { "glDrawElementsInstancedANGLE", "GL_ANGLE_instanced_arrays", 0 },
        { "glDrawElementsInstancedNV", "GL_NV_instanced_arrays", 0 } } },
    { (void **)&gl.VertexAttribDivisor, "instancedArrays", {
        { "glVertexAttribDivisor", NULL, 33 },
        { "glVertexAttribDivisorEXT", "GL_EXT_instanced_arrays", 0 },
        { "glVertexAttribDivisorANGLE", "GL_ANGLE_instanced_arrays", 0 },
        { "glVertexAttribDivisorNV", "GL_NV_instanced_arrays", 0 } } },
    { (void **)&gl.DrawBuffers, "drawBuffers", {
        { "glDrawBuffers", NULL, 20 },
        { "glDrawBuffersEXT", "GL_EXT_draw_buffers", 0 },
        { "glDrawBuffersNV", "GL_NV_draw_buffers", 0 } } },
    { (void **)&gl.TexImage3D, "texture3D", {
        { "glTexImage3D", NULL, 12 },
        { "glTexImage3DOES", "GL_OES_texture_3D", 0 } } },
    { (void **)&gl.TexSubImage3D, "texture3D", {
        { "glTexSubImage3D", NULL, 12 },
        { "glTexSubImage3DOES", "GL_OES_texture_3D", 0 } } },
    { (void **)&gl.CopyTexSubImage3D, "texture3D", {
        { "glCopyTexSubImage3D", NULL, 12 },
        { "glCopyTexSubImage3DOES", "GL_OES_texture_3D", 0 } } },
    { (void **)&gl.CompressedTexImage3D, "texture3D", {
        { "glCompressedTexImage3D", NULL, 13 },
        { "glCompressedTexImage3DOES", "GL_OES_texture_3D", 0 } } },
    { (void **)&gl.CompressedTexSubImage3D, "texture3D", {
        { "glCompressedTexSubImage3D", NULL, 13 },
        { "glCompressedTexSubImage3DOES", "GL_OES_texture_3D", 0 } } },
    // No ES 2.0 extension provides this: OES_texture_3D renders into a 3D
    // slice with glFramebufferTexture3DOES instead, and array textures do not
    // exist there at all. So it is ES 3.0 or nothing.
    { (void **)&gl.FramebufferTextureLayer, "texture3D", {
        { "glFramebufferTextureLayer", NULL, 30 } } },
    // Desktop grew immutable storage in 4.2, later than macOS's 4.1 — there
    // it exists only if GL_ARB_texture_storage is advertised.
    { (void **)&gl.TexStorage2D, "textureStorage", {
        { "glTexStorage2D", NULL, 42 },
        { "glTexStorage2D", "GL_ARB_texture_storage", 0 },
        { "glTexStorage2DEXT", "GL_EXT_texture_storage", 0 } } },
    { (void **)&gl.TexStorage3D, "textureStorage", {
        { "glTexStorage3D", NULL, 42 },
        { "glTexStorage3D", "GL_ARB_texture_storage", 0 },
        { "glTexStorage3DEXT", "GL_EXT_texture_storage", 0 } } }
};

// GL's extension string is space-separated, and one name can be a prefix of
// another (GL_EXT_draw_buffers / GL_EXT_draw_buffers_indexed), so match on
// whole words.
static int has_gl_ext(const char *list, const char *want) {
    if (!list || !want) return 0;
    size_t n = strlen(want);
    for (const char *p = strstr(list, want); p; p = strstr(p + n, want))
        if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == '\0'))
            return 1;
    return 0;
}

// Which context the table was last resolved against, so switching contexts
// re-resolves and destroying one forces it. (EGLContext and CGLContextObj are
// both opaque pointers, so the one slot serves either backend.)
static EGLContext optional_ctx;

// A core-profile desktop context (the macOS path) answers NULL +
// INVALID_ENUM to GetString(GL_EXTENSIONS); the modern replacement is one
// GetStringi call per extension. This builds the old-style space-separated
// list from those, so has_gl_ext() and JS's getSupportedExtensions() keep
// one code path. Rebuilt when the current context changes.
static char *synth_exts;

static const char *gl_extensions_string(void) {
    const char *s = (const char *)gl.GetString(0x1F03 /* GL_EXTENSIONS */);
    if (s)
        return s;
    gl.GetError(); // the query above just raised INVALID_ENUM — clear it
    if (synth_exts)
        return synth_exts;
    if (!gl.GetStringi)
        return NULL;
    GLint n = 0;
    gl.GetIntegerv(0x821D /* GL_NUM_EXTENSIONS */, &n);
    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    if (!buf)
        return NULL;
    buf[0] = '\0';
    for (GLint i = 0; i < n; i++) {
        const char *e = (const char *)gl.GetStringi(0x1F03, (GLuint)i);
        if (!e)
            continue;
        size_t el = strlen(e);
        if (len + el + 2 > cap) {
            cap = (len + el + 2) * 2;
            char *nb = realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
        if (len)
            buf[len++] = ' ';
        memcpy(buf + len, e, el + 1);
        len += el;
    }
    synth_exts = buf;
    return synth_exts;
}

static void resolve_optional_gl(EGLContext ctx) {
    if (optional_ctx == ctx)
        return;
    optional_ctx = ctx;
    free(synth_exts);
    synth_exts = NULL;

    // "OpenGL ES N.M <driver>" — the major version is what gates the core
    // spellings. A version with no "ES" is desktop GL (the CGL backend):
    // there the gate is per-entry-point, the ×10 version each one entered
    // desktop core in. Anything unparseable is treated as ES 2.0, which only
    // ever costs an extension lookup that would have worked anyway.
    int es_major = 0, desk = 0;
    const char *version = (const char *)gl.GetString(0x1F02 /* GL_VERSION */);
    const char *es = version ? strstr(version, "ES ") : NULL;
    if (es && es[3] >= '0' && es[3] <= '9') {
        es_major = es[3] - '0';
    } else if (version && version[0] >= '0' && version[0] <= '9') {
        int ma = 0, mi = 0;
        if (sscanf(version, "%d.%d", &ma, &mi) == 2)
            desk = ma * 10 + mi;
    }
    if (!es_major && !desk)
        es_major = 2;
    const char *exts = gl_extensions_string();

    for (size_t i = 0; i < sizeof(gl_optional) / sizeof(gl_optional[0]); i++) {
        const GlOptional *o = &gl_optional[i];
        *o->slot = NULL;
        for (int c = 0; c < 4 && o->cand[c].name; c++) {
            if (o->cand[c].ext
                    ? !has_gl_ext(exts, o->cand[c].ext)
                    : (desk ? (!o->cand[c].desk || desk < o->cand[c].desk)
                            : es_major < 3))
                continue;
            void *fn = gl.lib ? dlsym(gl.lib, o->cand[c].name) : NULL;
            if (!fn && egl.GetProcAddress)
                fn = egl.GetProcAddress(o->cand[c].name);
            if (fn) {
                *o->slot = fn;
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// dma-buf import (EGL_EXT_image_dma_buf_import)
//
// The mirror image of what Surface.swap() exports: a descriptor allocated
// elsewhere — DRI3 BuffersFromPixmap, another process, a video decoder —
// becomes an EGLImage and then a GL texture, with no copy.
//
// Whether it works is a property of the *display* (the two EGL extensions)
// and of the *context* (GL_OES_EGL_image, and GL_OES_EGL_image_external for
// the YUV/multi-planar target), so it is settled at makeCurrent alongside
// the optional GL table rather than at load time. glGetFeatures reports the
// answer, which is what lets a caller branch before it tries.
// ---------------------------------------------------------------------------

static struct {
    EGLDisplay dpy; // the display this was resolved against; NULL = unresolved
    int import;     // EGL_EXT_image_dma_buf_import
    int modifiers;  // EGL_EXT_image_dma_buf_import_modifiers
    int external;   // GL_OES_EGL_image_external (the TEXTURE_EXTERNAL_OES target)
} img;

static void resolve_egl_image(EGLDisplay dpy) {
    if (img.dpy == dpy)
        return;
    img.dpy = dpy;
    img.import = img.modifiers = img.external = 0;
    egl.CreateImageKHR = NULL;
    egl.DestroyImageKHR = NULL;
    gl.EGLImageTargetTexture2DOES = NULL;
    if (!dpy || !egl.lib)
        return;

    const char *ee = egl.QueryString(dpy, EGL_EXTENSIONS);
    img.import = has_gl_ext(ee, "EGL_EXT_image_dma_buf_import");
    img.modifiers = has_gl_ext(ee, "EGL_EXT_image_dma_buf_import_modifiers");

    // The KHR spelling is the portable one: EGL 1.5 core has eglCreateImage
    // with an EGLAttrib list, but every driver that implements the dma-buf
    // import extension also exports the EGLint-attribute KHR entry points.
    *(void **)&egl.CreateImageKHR = egl.GetProcAddress("eglCreateImageKHR");
    *(void **)&egl.DestroyImageKHR = egl.GetProcAddress("eglDestroyImageKHR");

    const char *ge = gl_extensions_string();
    img.external = has_gl_ext(ge, "GL_OES_EGL_image_external");
    if (has_gl_ext(ge, "GL_OES_EGL_image") || img.external)
        *(void **)&gl.EGLImageTargetTexture2DOES =
            egl.GetProcAddress("glEGLImageTargetTexture2DOES");
}

// Everything the import needs, or the first reason it cannot happen.
static const char *egl_image_why_not(void) {
    if (!img.dpy)
        return "no current EGL display — dma-buf import is the GBM/EGL path "
               "(makeCurrent on a Gpu first)";
    if (!img.import)
        return "the driver does not advertise EGL_EXT_image_dma_buf_import";
    if (!egl.CreateImageKHR || !egl.DestroyImageKHR)
        return "EGL is missing eglCreateImageKHR/eglDestroyImageKHR";
    if (!gl.EGLImageTargetTexture2DOES)
        return "the context does not offer GL_OES_EGL_image "
               "(glEGLImageTargetTexture2DOES)";
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
    int es_version;    // the ES version EGL actually gave us: 2 or 3
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

// createGpu(drmFd, formatFourcc, depthSize, glVersion) -> external
// The fd is dup'ed; the caller keeps (and eventually closes) its own.
// glVersion is 2 or 3 to insist on that ES version, or 0 to take the highest
// on offer.
static napi_value CreateGpu(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4);
    int fd = arg_i32(env, args[0]);
    uint32_t format = arg_u32(env, args[1]);
    int depth_size = arg_i32(env, args[2]);
    int want_es = arg_i32(env, args[3]);
    if (want_es != 0 && want_es != 2 && want_es != 3)
        THROWF(env, "glVersion must be 2, 3, or 0 for the highest available (got %d)",
               want_es);

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

    // Try for `es` first, and report whether it worked. A config has to be
    // picked per version, not once: EGL_RENDERABLE_TYPE is part of the config
    // query, so a display with no ES 3.0-capable config fails here rather
    // than at context creation.
    //
    // Note this is a *floor*, not a ceiling. Mesa answers an ES 2.0 request
    // with an ES 3.0 context, because ES 3.0 is backward compatible and EGL
    // permits it — so glVersion 2 does not guarantee an ES 2.0 driver, only
    // that ES 2.0 is all that was asked for. What the driver actually gave
    // is glGetString(GL_VERSION), which is what gpu.glVersion reports and
    // what gates the optional entry points.
    EGLint want_alpha = (g->format == GBM_FORMAT_ARGB8888) ? 8 : 0;
    for (int es = (want_es ? want_es : 3); es >= 2; es--) {
        const EGLint attribs[] = {
            EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
            EGL_RENDERABLE_TYPE, es == 3 ? EGL_OPENGL_ES3_BIT : EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
            EGL_ALPHA_SIZE, want_alpha,
            EGL_DEPTH_SIZE, depth_size,
            EGL_NONE
        };
        EGLConfig cfgs[64];
        EGLint ncfg = 0;
        if (egl.ChooseConfig(g->dpy, attribs, cfgs, 64, &ncfg) && ncfg > 0) {
            // Pick a config whose native visual is exactly our GBM format;
            // EGL is allowed to return both XRGB and ARGB for the same
            // rgb888 request.
            g->cfg = cfgs[0];
            for (EGLint i = 0; i < ncfg; i++) {
                EGLint vid = 0;
                if (egl.GetConfigAttrib(g->dpy, cfgs[i], EGL_NATIVE_VISUAL_ID, &vid) &&
                    (uint32_t)vid == g->format) {
                    g->cfg = cfgs[i];
                    break;
                }
            }
            const EGLint ctx_attribs[] = { EGL_CONTEXT_CLIENT_VERSION, es, EGL_NONE };
            g->ctx = egl.CreateContext(g->dpy, g->cfg, NULL, ctx_attribs);
            if (g->ctx) {
                g->es_version = es;
                break;
            }
        }
        if (want_es) // an explicit request does not fall back
            break;
    }
    if (!g->ctx) {
        EGLint ec = egl.GetError();
        egl.Terminate(g->dpy); gbm.device_destroy(g->gbm); close(dupfd); free(g);
        if (want_es)
            THROWF(env, "no ES %d context: neither a config nor a context for "
                        "rgb888 + depth at that version (0x%x)", want_es, ec);
        THROWF(env, "no EGL config or context for rgb888 + depth on this device (0x%x)", ec);
    }

    napi_value ext;
    NAPI_CALL(env, napi_create_external(env, g, gpu_finalize, NULL, &ext));
    return ext;
}

// gpuInfo(gpu) -> { eglVendor, eglVersion, contextVersion }
static napi_value GpuInfo(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    Gpu *g;
    if (!get_external(env, args[0], (void **)&g)) return NULL;
    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    obj_set(env, obj, "eglVendor", mk_str(env, egl.QueryString(g->dpy, EGL_VENDOR)));
    obj_set(env, obj, "eglVersion", mk_str(env, egl.QueryString(g->dpy, EGL_VERSION)));
    obj_set(env, obj, "contextVersion", mk_i32(env, g->es_version));
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
        // Only now can the optional entry points be settled: it takes
        // glGetString, which takes a current context.
        resolve_optional_gl(g->ctx);
        resolve_egl_image(g->dpy);
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
        if (optional_ctx == g->ctx)
            optional_ctx = NULL; // a later context could land on this address
        if (img.dpy == g->dpy)
            resolve_egl_image(NULL); // same, for the display
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
// Set while a core-profile desktop context (the macOS CGL backend) is
// current. Core profiles refuse version-less shader source outright, but
// accept GLSL ES 1.00 through ARB_ES2_compatibility — so a source with no
// #version of its own (WebGL 1 style, implicitly 1.00) gets one prepended as
// a separate source string, which keeps the user's line numbers intact in
// info logs (their code is string 1).
static int apple_core_current;

static napi_value Gl_shaderSource(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLuint sh = arg_u32(env, args[0]);
    size_t len = 0;
    napi_get_value_string_utf8(env, args[1], NULL, 0, &len);
    char *src = malloc(len + 1);
    napi_get_value_string_utf8(env, args[1], src, len + 1, &len);
    if (apple_core_current && !strstr(src, "#version")) {
        const GLchar *ptrs[2] = { "#version 100\n", src };
        gl.ShaderSource(sh, 2, ptrs, NULL);
    } else {
        const GLchar *ptr = src;
        GLint glen = (GLint)len;
        gl.ShaderSource(sh, 1, &ptr, &glen);
    }
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
    void *data;
    size_t nbytes;
    if (!typed_bytes(env, args[1], &data, &nbytes))
        THROW(env, "bufferData expects a TypedArray");
    gl.BufferData(arg_u32(env, args[0]), (GLsizeiptr)nbytes, data,
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
    GLenum pname = arg_u32(env, args[0]);
    // Core-profile desktop contexts retired GetString(GL_EXTENSIONS); answer
    // with the same synthesized list resolve_optional_gl gates on.
    if (pname == 0x1F03 /* GL_EXTENSIONS */)
        return mk_str(env, gl_extensions_string());
    return mk_str(env, (const char *)gl.GetString(pname));
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

// --- textures --------------------------------------------------------------

// Pixel data for TexImage2D and friends. Null is legal and meaningful: it
// allocates the level without initialising it, which is how a texture is made
// to be rendered into.
static bool pixels_arg(napi_env env, napi_value v, void **out) {
    napi_valuetype type;
    *out = NULL;
    if (napi_typeof(env, v, &type) != napi_ok) return false;
    if (type == napi_null || type == napi_undefined) return true;
    size_t len;
    return napi_get_typedarray_info(env, v, NULL, &len, out, NULL, NULL) == napi_ok;
}

static napi_value Gl_createTexture(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    GLuint t = 0;
    gl.GenTextures(1, &t);
    return mk_u32(env, t);
}
static napi_value Gl_deleteTexture(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint t = arg_u32(env, args[0]);
    gl.DeleteTextures(1, &t);
    return NULL;
}
static napi_value Gl_bindTexture(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.BindTexture(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_activeTexture(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.ActiveTexture(arg_u32(env, args[0]));
    return NULL;
}
// texImage2D(target, level, internalformat, width, height, border, format,
//            type, pixels|null)
static napi_value Gl_texImage2D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 9); NEED_GL(env);
    void *data;
    if (!pixels_arg(env, args[8], &data))
        THROW(env, "texImage2D expects a TypedArray or null as its last argument");
    gl.TexImage2D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                  arg_i32(env, args[2]), arg_i32(env, args[3]),
                  arg_i32(env, args[4]), arg_i32(env, args[5]),
                  arg_u32(env, args[6]), arg_u32(env, args[7]), data);
    return NULL;
}
// texSubImage2D(target, level, xoffset, yoffset, width, height, format, type,
//               pixels)
static napi_value Gl_texSubImage2D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 9); NEED_GL(env);
    void *data;
    if (!pixels_arg(env, args[8], &data) || !data)
        THROW(env, "texSubImage2D expects a TypedArray of pixels");
    gl.TexSubImage2D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                     arg_i32(env, args[2]), arg_i32(env, args[3]),
                     arg_i32(env, args[4]), arg_i32(env, args[5]),
                     arg_u32(env, args[6]), arg_u32(env, args[7]), data);
    return NULL;
}
static napi_value Gl_texParameteri(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.TexParameteri(arg_u32(env, args[0]), arg_u32(env, args[1]), arg_i32(env, args[2]));
    return NULL;
}
static napi_value Gl_texParameterf(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.TexParameterf(arg_u32(env, args[0]), arg_u32(env, args[1]),
                     (GLfloat)arg_f64(env, args[2]));
    return NULL;
}
static napi_value Gl_generateMipmap(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.GenerateMipmap(arg_u32(env, args[0]));
    return NULL;
}

// Compressed texture images. The data is passed through to the driver
// untouched — the block layout is the format's business, not ours, and the
// byte count comes from the view rather than from a size computed here.
// Which `internalformat` values are legal is a per-driver list; ask
// getSupportedExtensions()/COMPRESSED_TEXTURE_FORMATS before uploading one.
//
// compressedTexImage2D(target, level, internalformat, width, height, border,
//                      data)
static napi_value Gl_compressedTexImage2D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 7); NEED_GL(env);
    void *data;
    size_t nbytes;
    if (!typed_bytes(env, args[6], &data, &nbytes))
        THROW(env, "compressedTexImage2D expects a TypedArray of compressed data");
    gl.CompressedTexImage2D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                            arg_u32(env, args[2]), arg_i32(env, args[3]),
                            arg_i32(env, args[4]), arg_i32(env, args[5]),
                            (GLsizei)nbytes, data);
    return NULL;
}
// compressedTexSubImage2D(target, level, xoffset, yoffset, width, height,
//                         format, data)
static napi_value Gl_compressedTexSubImage2D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 8); NEED_GL(env);
    void *data;
    size_t nbytes;
    if (!typed_bytes(env, args[7], &data, &nbytes))
        THROW(env, "compressedTexSubImage2D expects a TypedArray of compressed data");
    gl.CompressedTexSubImage2D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                               arg_i32(env, args[2]), arg_i32(env, args[3]),
                               arg_i32(env, args[4]), arg_i32(env, args[5]),
                               arg_u32(env, args[6]), (GLsizei)nbytes, data);
    return NULL;
}

// --- blending and per-fragment state ---------------------------------------

static napi_value Gl_blendFunc(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.BlendFunc(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_blendFuncSeparate(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.BlendFuncSeparate(arg_u32(env, args[0]), arg_u32(env, args[1]),
                         arg_u32(env, args[2]), arg_u32(env, args[3]));
    return NULL;
}
static napi_value Gl_blendEquation(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.BlendEquation(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_blendEquationSeparate(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.BlendEquationSeparate(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_blendColor(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.BlendColor((GLfloat)arg_f64(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                  (GLfloat)arg_f64(env, args[2]), (GLfloat)arg_f64(env, args[3]));
    return NULL;
}
static napi_value Gl_depthMask(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.DepthMask(arg_bool(env, args[0]) ? 1 : 0);
    return NULL;
}
static napi_value Gl_depthRange(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.DepthRangef((GLfloat)arg_f64(env, args[0]), (GLfloat)arg_f64(env, args[1]));
    return NULL;
}
static napi_value Gl_colorMask(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.ColorMask(arg_bool(env, args[0]) ? 1 : 0, arg_bool(env, args[1]) ? 1 : 0,
                 arg_bool(env, args[2]) ? 1 : 0, arg_bool(env, args[3]) ? 1 : 0);
    return NULL;
}
static napi_value Gl_scissor(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.Scissor(arg_i32(env, args[0]), arg_i32(env, args[1]),
               arg_i32(env, args[2]), arg_i32(env, args[3]));
    return NULL;
}
static napi_value Gl_polygonOffset(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.PolygonOffset((GLfloat)arg_f64(env, args[0]), (GLfloat)arg_f64(env, args[1]));
    return NULL;
}
static napi_value Gl_stencilFunc(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.StencilFunc(arg_u32(env, args[0]), arg_i32(env, args[1]), arg_u32(env, args[2]));
    return NULL;
}
static napi_value Gl_stencilOp(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.StencilOp(arg_u32(env, args[0]), arg_u32(env, args[1]), arg_u32(env, args[2]));
    return NULL;
}
static napi_value Gl_stencilMask(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.StencilMask(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_clearStencil(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.ClearStencil(arg_i32(env, args[0]));
    return NULL;
}

// --- uniforms --------------------------------------------------------------

static napi_value Gl_uniform2f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.Uniform2f(arg_i32(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                 (GLfloat)arg_f64(env, args[2]));
    return NULL;
}
static napi_value Gl_uniform2i(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.Uniform2i(arg_i32(env, args[0]), arg_i32(env, args[1]), arg_i32(env, args[2]));
    return NULL;
}
static napi_value Gl_uniform3i(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.Uniform3i(arg_i32(env, args[0]), arg_i32(env, args[1]),
                 arg_i32(env, args[2]), arg_i32(env, args[3]));
    return NULL;
}
static napi_value Gl_uniform4i(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    gl.Uniform4i(arg_i32(env, args[0]), arg_i32(env, args[1]), arg_i32(env, args[2]),
                 arg_i32(env, args[3]), arg_i32(env, args[4]));
    return NULL;
}

// The *v setters all differ only in components-per-element and which entry
// point they reach, so they share one body.
static napi_value uniform_fv(napi_env env, napi_callback_info info, int components,
                             void (*fn)(GLint, GLsizei, const GLfloat *), const char *what) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    napi_typedarray_type type;
    size_t len;
    void *data;
    if (napi_get_typedarray_info(env, args[1], &type, &len, &data, NULL, NULL) != napi_ok ||
        type != napi_float32_array || len == 0 || len % (size_t)components != 0)
        THROWF(env, "%s expects a Float32Array of %d*n floats", what, components);
    fn(arg_i32(env, args[0]), (GLsizei)(len / (size_t)components), data);
    return NULL;
}
static napi_value Gl_uniform1fv(napi_env env, napi_callback_info info) {
    return uniform_fv(env, info, 1, gl.Uniform1fv, "uniform1fv");
}
static napi_value Gl_uniform2fv(napi_env env, napi_callback_info info) {
    return uniform_fv(env, info, 2, gl.Uniform2fv, "uniform2fv");
}
static napi_value Gl_uniform3fv(napi_env env, napi_callback_info info) {
    return uniform_fv(env, info, 3, gl.Uniform3fv, "uniform3fv");
}
static napi_value Gl_uniform4fv(napi_env env, napi_callback_info info) {
    return uniform_fv(env, info, 4, gl.Uniform4fv, "uniform4fv");
}
// sampler arrays: one texture unit per element
static napi_value Gl_uniform1iv(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    napi_typedarray_type type;
    size_t len;
    void *data;
    if (napi_get_typedarray_info(env, args[1], &type, &len, &data, NULL, NULL) != napi_ok ||
        type != napi_int32_array || len == 0)
        THROW(env, "uniform1iv expects an Int32Array");
    gl.Uniform1iv(arg_i32(env, args[0]), (GLsizei)len, data);
    return NULL;
}

static napi_value uniform_matrix(napi_env env, napi_callback_info info, int order,
                                 void (*fn)(GLint, GLsizei, GLboolean, const GLfloat *),
                                 const char *what) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    bool transpose = arg_bool(env, args[1]);
    napi_typedarray_type type;
    size_t len;
    void *data;
    size_t stride = (size_t)(order * order);
    if (napi_get_typedarray_info(env, args[2], &type, &len, &data, NULL, NULL) != napi_ok ||
        type != napi_float32_array || len == 0 || len % stride != 0)
        THROWF(env, "%s expects a Float32Array of %zu*n floats", what, stride);
    fn(arg_i32(env, args[0]), (GLsizei)(len / stride), transpose ? 1 : 0, data);
    return NULL;
}
static napi_value Gl_uniformMatrix2fv(napi_env env, napi_callback_info info) {
    return uniform_matrix(env, info, 2, gl.UniformMatrix2fv, "uniformMatrix2fv");
}
static napi_value Gl_uniformMatrix3fv(napi_env env, napi_callback_info info) {
    return uniform_matrix(env, info, 3, gl.UniformMatrix3fv, "uniformMatrix3fv");
}

// --- attributes and buffer updates -----------------------------------------

static napi_value Gl_disableVertexAttribArray(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.DisableVertexAttribArray(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_bindAttribLocation(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    char name[256];
    size_t n = 0;
    if (napi_get_value_string_utf8(env, args[2], name, sizeof(name), &n) != napi_ok)
        THROW(env, "bindAttribLocation expects an attribute name");
    gl.BindAttribLocation(arg_u32(env, args[0]), arg_u32(env, args[1]), name);
    return NULL;
}
static napi_value Gl_vertexAttrib1f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.VertexAttrib1f(arg_u32(env, args[0]), (GLfloat)arg_f64(env, args[1]));
    return NULL;
}
static napi_value Gl_vertexAttrib2f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    gl.VertexAttrib2f(arg_u32(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                      (GLfloat)arg_f64(env, args[2]));
    return NULL;
}
static napi_value Gl_vertexAttrib3f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.VertexAttrib3f(arg_u32(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                      (GLfloat)arg_f64(env, args[2]), (GLfloat)arg_f64(env, args[3]));
    return NULL;
}
static napi_value Gl_vertexAttrib4f(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    gl.VertexAttrib4f(arg_u32(env, args[0]), (GLfloat)arg_f64(env, args[1]),
                      (GLfloat)arg_f64(env, args[2]), (GLfloat)arg_f64(env, args[3]),
                      (GLfloat)arg_f64(env, args[4]));
    return NULL;
}
// bufferSubData(target, offset, data) — update part of a buffer in place,
// which is how a geometry that changes every frame avoids a reallocation
static napi_value Gl_bufferSubData(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    void *data;
    size_t nbytes;
    if (!typed_bytes(env, args[2], &data, &nbytes))
        THROW(env, "bufferSubData expects a TypedArray");
    gl.BufferSubData(arg_u32(env, args[0]), (GLintptr)arg_i32(env, args[1]),
                     (GLsizeiptr)nbytes, data);
    return NULL;
}

// --- framebuffer objects ---------------------------------------------------

static napi_value Gl_createFramebuffer(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    GLuint f = 0;
    gl.GenFramebuffers(1, &f);
    return mk_u32(env, f);
}
static napi_value Gl_deleteFramebuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint f = arg_u32(env, args[0]);
    gl.DeleteFramebuffers(1, &f);
    return NULL;
}
// bindFramebuffer(target, framebuffer) — 0 is the window's own framebuffer,
// the one whose buffer gets presented
static napi_value Gl_bindFramebuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.BindFramebuffer(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_framebufferTexture2D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    gl.FramebufferTexture2D(arg_u32(env, args[0]), arg_u32(env, args[1]),
                            arg_u32(env, args[2]), arg_u32(env, args[3]),
                            arg_i32(env, args[4]));
    return NULL;
}
static napi_value Gl_framebufferRenderbuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.FramebufferRenderbuffer(arg_u32(env, args[0]), arg_u32(env, args[1]),
                               arg_u32(env, args[2]), arg_u32(env, args[3]));
    return NULL;
}
static napi_value Gl_checkFramebufferStatus(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    return mk_u32(env, gl.CheckFramebufferStatus(arg_u32(env, args[0])));
}
static napi_value Gl_createRenderbuffer(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    GLuint r = 0;
    gl.GenRenderbuffers(1, &r);
    return mk_u32(env, r);
}
static napi_value Gl_deleteRenderbuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint r = arg_u32(env, args[0]);
    gl.DeleteRenderbuffers(1, &r);
    return NULL;
}
static napi_value Gl_bindRenderbuffer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    gl.BindRenderbuffer(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}
static napi_value Gl_renderbufferStorage(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    gl.RenderbufferStorage(arg_u32(env, args[0]), arg_u32(env, args[1]),
                           arg_i32(env, args[2]), arg_i32(env, args[3]));
    return NULL;
}

// --- state queries ---------------------------------------------------------

// getParameter(pname) — a number, a boolean, or an array, per what ES 2.0
// says that parameter is. The three raw getters below are the escape hatch
// for anything this does not know about.
static napi_value Gl_getParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLenum pname = arg_u32(env, args[0]);
    napi_value out;
    switch (pname) {
        // booleans
        case 0x0B44: case 0x0BE2: case 0x0B71: case 0x0C11: // CULL_FACE, BLEND, DEPTH_TEST, SCISSOR_TEST
        case 0x0B90: case 0x0BD0: case 0x0B72: { // STENCIL_TEST, DITHER, DEPTH_WRITEMASK
            GLboolean b = 0;
            gl.GetBooleanv(pname, &b);
            return mk_bool(env, b != 0);
        }
        // floats
        case 0x0B21: case 0x0B73: case 0x2A00: case 0x8038: { // LINE_WIDTH, DEPTH_CLEAR_VALUE, POLYGON_OFFSET_UNITS, POLYGON_OFFSET_FACTOR
            GLfloat f = 0;
            gl.GetFloatv(pname, &f);
            NAPI_CALL(env, napi_create_double(env, f, &out));
            return out;
        }
        // four floats
        case 0x0C22: case 0x0C01: { // COLOR_CLEAR_VALUE, BLEND_COLOR
            GLfloat v[4] = { 0, 0, 0, 0 };
            gl.GetFloatv(pname, v);
            NAPI_CALL(env, napi_create_array_with_length(env, 4, &out));
            for (uint32_t i = 0; i < 4; i++) {
                napi_value e;
                NAPI_CALL(env, napi_create_double(env, v[i], &e));
                NAPI_CALL(env, napi_set_element(env, out, i, e));
            }
            return out;
        }
        // four ints
        case 0x0BA2: case 0x0C10: { // VIEWPORT, SCISSOR_BOX
            GLint v[4] = { 0, 0, 0, 0 };
            gl.GetIntegerv(pname, v);
            NAPI_CALL(env, napi_create_array_with_length(env, 4, &out));
            for (uint32_t i = 0; i < 4; i++) {
                NAPI_CALL(env, napi_set_element(env, out, i, mk_i32(env, v[i])));
            }
            return out;
        }
        // a run of ints whose length only the driver knows
        case 0x86A3: { // COMPRESSED_TEXTURE_FORMATS
            GLint n = 0;
            gl.GetIntegerv(0x86A2 /* NUM_COMPRESSED_TEXTURE_FORMATS */, &n);
            if (n < 0) n = 0;
            GLint *v = calloc((size_t)n + 1, sizeof(GLint));
            if (!v) THROW(env, "getParameter: out of memory");
            if (n) gl.GetIntegerv(pname, v);
            out = NULL; // see getAttachedShaders on the unchecked statuses
            napi_create_array_with_length(env, (size_t)n, &out);
            for (GLint i = 0; i < n; i++)
                napi_set_element(env, out, (uint32_t)i, mk_i32(env, v[i]));
            free(v);
            return out;
        }
        // four booleans
        case 0x0C23: { // COLOR_WRITEMASK
            GLboolean v[4] = { 0, 0, 0, 0 };
            gl.GetBooleanv(pname, v);
            NAPI_CALL(env, napi_create_array_with_length(env, 4, &out));
            for (uint32_t i = 0; i < 4; i++) {
                NAPI_CALL(env, napi_set_element(env, out, i, mk_bool(env, v[i] != 0)));
            }
            return out;
        }
        default: {
            GLint v = 0;
            gl.GetIntegerv(pname, &v);
            return mk_i32(env, v);
        }
    }
}
static napi_value Gl_getIntegerv(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLint v = 0;
    gl.GetIntegerv(arg_u32(env, args[0]), &v);
    return mk_i32(env, v);
}
static napi_value Gl_getFloatv(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLfloat v = 0;
    napi_value out;
    gl.GetFloatv(arg_u32(env, args[0]), &v);
    NAPI_CALL(env, napi_create_double(env, v, &out));
    return out;
}
static napi_value Gl_getBooleanv(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLboolean v = 0;
    gl.GetBooleanv(arg_u32(env, args[0]), &v);
    return mk_bool(env, v != 0);
}

// --- introspection ---------------------------------------------------------
//
// What a linked program declares, and what an object currently holds. All of
// it is core ES 2.0; the shapes follow WebGL, so `getActiveUniform` answers
// { name, size, type } rather than filling caller-supplied out-parameters.

// getActiveUniform and getActiveAttrib differ only in which entry point and
// which pair of program properties they read. Both size the name buffer from
// the program's own longest name, and both answer null for an out-of-range
// index rather than raising GL_INVALID_VALUE — walking indices upward until
// null is a natural way to enumerate, and it should not disturb getError().
static napi_value active_var(napi_env env, napi_callback_info info, int uniform) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLuint program = arg_u32(env, args[0]);
    GLuint index = arg_u32(env, args[1]);
    GLint count = 0, maxlen = 0;
    gl.GetProgramiv(program, uniform ? 0x8B86 /* ACTIVE_UNIFORMS */
                                     : 0x8B89 /* ACTIVE_ATTRIBUTES */, &count);
    if (count <= 0 || index >= (GLuint)count) {
        napi_value nul;
        NAPI_CALL(env, napi_get_null(env, &nul));
        return nul;
    }
    gl.GetProgramiv(program, uniform ? 0x8B87 /* ACTIVE_UNIFORM_MAX_LENGTH */
                                     : 0x8B8A /* ACTIVE_ATTRIBUTE_MAX_LENGTH */,
                    &maxlen);
    if (maxlen < 1) maxlen = 1;
    char *buf = calloc(1, (size_t)maxlen + 1);
    if (!buf) THROW(env, "getActive*: out of memory");
    GLint size = 0;
    GLenum type = 0;
    if (uniform)
        gl.GetActiveUniform(program, index, maxlen + 1, NULL, &size, &type, buf);
    else
        gl.GetActiveAttrib(program, index, maxlen + 1, NULL, &size, &type, buf);
    napi_value obj;
    if (napi_create_object(env, &obj) != napi_ok) {
        free(buf);
        THROW(env, "napi_create_object failed");
    }
    obj_set(env, obj, "name", mk_str(env, buf));
    obj_set(env, obj, "size", mk_i32(env, size));
    obj_set(env, obj, "type", mk_u32(env, type));
    free(buf);
    return obj;
}
static napi_value Gl_getActiveUniform(napi_env env, napi_callback_info info) {
    return active_var(env, info, 1);
}
static napi_value Gl_getActiveAttrib(napi_env env, napi_callback_info info) {
    return active_var(env, info, 0);
}

// getUniformfv/getUniformiv(program, location, count) -> [numbers]
//
// GL writes as many components as the uniform has and offers no way to ask
// first, so the destination here is always wide enough for the largest thing
// ES 2.0 can name (mat4, 16 floats) and `count` says how many of them to
// hand back. index.js builds WebGL's getUniform() on top by asking the
// program for the uniform's type.
static napi_value uniform_value(napi_env env, napi_callback_info info, int as_float) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    GLuint program = arg_u32(env, args[0]);
    GLint location = arg_i32(env, args[1]);
    uint32_t count = arg_u32(env, args[2]);
    if (count < 1 || count > 16)
        THROW(env, "getUniform*: count must be between 1 and 16");
    GLfloat fv[16] = { 0 };
    GLint iv[16] = { 0 };
    if (as_float) gl.GetUniformfv(program, location, fv);
    else          gl.GetUniformiv(program, location, iv);
    napi_value out;
    NAPI_CALL(env, napi_create_array_with_length(env, count, &out));
    for (uint32_t i = 0; i < count; i++) {
        napi_value e;
        if (as_float)
            NAPI_CALL(env, napi_create_double(env, fv[i], &e));
        else
            e = mk_i32(env, iv[i]);
        NAPI_CALL(env, napi_set_element(env, out, i, e));
    }
    return out;
}
static napi_value Gl_getUniformfv(napi_env env, napi_callback_info info) {
    return uniform_value(env, info, 1);
}
static napi_value Gl_getUniformiv(napi_env env, napi_callback_info info) {
    return uniform_value(env, info, 0);
}

// getVertexAttrib(index, pname) — typed the way the attribute state is:
// booleans for the flags, four floats for the current generic value, and a
// plain integer (buffer name, size, stride, type) for the rest.
static napi_value Gl_getVertexAttrib(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLuint index = arg_u32(env, args[0]);
    GLenum pname = arg_u32(env, args[1]);
    switch (pname) {
        case 0x8626: { // CURRENT_VERTEX_ATTRIB
            GLfloat v[4] = { 0, 0, 0, 0 };
            gl.GetVertexAttribfv(index, pname, v);
            napi_value out;
            NAPI_CALL(env, napi_create_array_with_length(env, 4, &out));
            for (uint32_t i = 0; i < 4; i++) {
                napi_value e;
                NAPI_CALL(env, napi_create_double(env, v[i], &e));
                NAPI_CALL(env, napi_set_element(env, out, i, e));
            }
            return out;
        }
        case 0x8622: case 0x886A: { // ARRAY_ENABLED, ARRAY_NORMALIZED
            GLint v = 0;
            gl.GetVertexAttribiv(index, pname, &v);
            return mk_bool(env, v != 0);
        }
        default: {
            GLint v = 0;
            gl.GetVertexAttribiv(index, pname, &v);
            return mk_i32(env, v);
        }
    }
}
// getVertexAttribOffset(index, pname) -> byte offset into the bound buffer
// (client-side arrays do not exist here, so the pointer is always an offset)
static napi_value Gl_getVertexAttribOffset(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    void *p = NULL;
    gl.GetVertexAttribPointerv(arg_u32(env, args[0]), arg_u32(env, args[1]), &p);
    return mk_i32(env, (int32_t)(intptr_t)p);
}

static napi_value Gl_getBufferParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLint v = 0;
    gl.GetBufferParameteriv(arg_u32(env, args[0]), arg_u32(env, args[1]), &v);
    return mk_i32(env, v);
}
static napi_value Gl_getTexParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLint v = 0;
    gl.GetTexParameteriv(arg_u32(env, args[0]), arg_u32(env, args[1]), &v);
    return mk_i32(env, v);
}
static napi_value Gl_getFramebufferAttachmentParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3); NEED_GL(env);
    GLint v = 0;
    gl.GetFramebufferAttachmentParameteriv(arg_u32(env, args[0]), arg_u32(env, args[1]),
                                           arg_u32(env, args[2]), &v);
    return mk_i32(env, v);
}
static napi_value Gl_getRenderbufferParameter(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLint v = 0;
    gl.GetRenderbufferParameteriv(arg_u32(env, args[0]), arg_u32(env, args[1]), &v);
    return mk_i32(env, v);
}

// getAttachedShaders(program) -> [shader, ...]
static napi_value Gl_getAttachedShaders(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint program = arg_u32(env, args[0]);
    GLint n = 0;
    gl.GetProgramiv(program, 0x8B85 /* ATTACHED_SHADERS */, &n);
    if (n < 0) n = 0;
    GLuint *list = calloc((size_t)n + 1, sizeof(GLuint));
    if (!list) THROW(env, "getAttachedShaders: out of memory");
    GLsizei got = 0;
    if (n) gl.GetAttachedShaders(program, n, &got, list);
    // Nothing below can fail except under OOM, and the buffer has to be freed
    // on the way out either way, so the statuses go unchecked here rather than
    // through NAPI_CALL's early return.
    napi_value out = NULL;
    napi_create_array_with_length(env, (size_t)got, &out);
    for (GLsizei i = 0; i < got; i++)
        napi_set_element(env, out, (uint32_t)i, mk_u32(env, list[i]));
    free(list);
    return out;
}

// getShaderPrecisionFormat(shaderType, precisionType) ->
//     { rangeMin, rangeMax, precision }
static napi_value Gl_getShaderPrecisionFormat(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    GLint range[2] = { 0, 0 };
    GLint precision = 0;
    gl.GetShaderPrecisionFormat(arg_u32(env, args[0]), arg_u32(env, args[1]),
                                range, &precision);
    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    obj_set(env, obj, "rangeMin", mk_i32(env, range[0]));
    obj_set(env, obj, "rangeMax", mk_i32(env, range[1]));
    obj_set(env, obj, "precision", mk_i32(env, precision));
    return obj;
}

// getShaderSource(shader) -> the source GL kept, which is what it compiled
static napi_value Gl_getShaderSource(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    GLuint shader = arg_u32(env, args[0]);
    GLint len = 0;
    gl.GetShaderiv(shader, 0x8B88 /* SHADER_SOURCE_LENGTH */, &len);
    if (len < 0) len = 0;
    char *buf = calloc(1, (size_t)len + 1);
    if (!buf) THROW(env, "getShaderSource: out of memory");
    gl.GetShaderSource(shader, len + 1, NULL, buf);
    napi_value out = mk_str(env, buf);
    free(buf);
    return out;
}

static napi_value Gl_validateProgram(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    gl.ValidateProgram(arg_u32(env, args[0]));
    return NULL;
}

// is*(object) — whether the name is live in this context. Every one of them
// takes a single name, except isEnabled which takes a capability.
#define IS_FN(jsname, glfn)                                                   \
    static napi_value jsname(napi_env env, napi_callback_info info) {         \
        GET_ARGS(env, info, 1); NEED_GL(env);                                 \
        return mk_bool(env, gl.glfn(arg_u32(env, args[0])) != 0);             \
    }
IS_FN(Gl_isBuffer, IsBuffer)
IS_FN(Gl_isEnabled, IsEnabled)
IS_FN(Gl_isFramebuffer, IsFramebuffer)
IS_FN(Gl_isProgram, IsProgram)
IS_FN(Gl_isRenderbuffer, IsRenderbuffer)
IS_FN(Gl_isShader, IsShader)
IS_FN(Gl_isTexture, IsTexture)
#undef IS_FN

// --- vertex array objects, instancing, multiple render targets -------------
//
// Everything below can be missing, so every wrapper says so in terms of the
// feature rather than the symbol — a caller that wants to branch instead of
// catch should read glFeatures().

#define NEED_FN(env, field, feature)                                          \
    do {                                                                      \
        if (!gl.field)                                                        \
            THROW(env, feature " is not available here: the context is not "  \
                               "ES 3.0 and the driver offers no equivalent "  \
                               "extension (see gpu.features)");               \
    } while (0)

static napi_value Gl_createVertexArray(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    NEED_FN(env, GenVertexArrays, "vertex array objects");
    GLuint v = 0;
    gl.GenVertexArrays(1, &v);
    return mk_u32(env, v);
}
static napi_value Gl_deleteVertexArray(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    NEED_FN(env, DeleteVertexArrays, "vertex array objects");
    GLuint v = arg_u32(env, args[0]);
    gl.DeleteVertexArrays(1, &v);
    return NULL;
}
static napi_value Gl_bindVertexArray(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    NEED_FN(env, BindVertexArray, "vertex array objects");
    gl.BindVertexArray(arg_u32(env, args[0]));
    return NULL;
}
static napi_value Gl_isVertexArray(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    NEED_FN(env, IsVertexArray, "vertex array objects");
    return mk_bool(env, gl.IsVertexArray(arg_u32(env, args[0])) != 0);
}

// drawArraysInstanced(mode, first, count, instanceCount)
static napi_value Gl_drawArraysInstanced(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4); NEED_GL(env);
    NEED_FN(env, DrawArraysInstanced, "instanced drawing");
    gl.DrawArraysInstanced(arg_u32(env, args[0]), arg_i32(env, args[1]),
                           arg_i32(env, args[2]), arg_i32(env, args[3]));
    return NULL;
}
// drawElementsInstanced(mode, count, type, offset, instanceCount)
static napi_value Gl_drawElementsInstanced(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    NEED_FN(env, DrawElementsInstanced, "instanced drawing");
    gl.DrawElementsInstanced(arg_u32(env, args[0]), arg_i32(env, args[1]),
                             arg_u32(env, args[2]),
                             (const void *)(intptr_t)arg_i32(env, args[3]),
                             arg_i32(env, args[4]));
    return NULL;
}
// vertexAttribDivisor(index, divisor) — 0 advances the attribute per vertex,
// 1 per instance, n every n instances
static napi_value Gl_vertexAttribDivisor(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2); NEED_GL(env);
    NEED_FN(env, VertexAttribDivisor, "instanced drawing");
    gl.VertexAttribDivisor(arg_u32(env, args[0]), arg_u32(env, args[1]));
    return NULL;
}

// drawBuffers([COLOR_ATTACHMENT0, NONE, COLOR_ATTACHMENT2, ...]) — which
// attachment each fragment output writes to, by position. Takes a plain
// array or a Uint32Array.
static napi_value Gl_drawBuffers(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1); NEED_GL(env);
    NEED_FN(env, DrawBuffers, "multiple render targets");
    GLenum bufs[16];
    uint32_t n = 0;
    bool is_array = false;
    napi_is_array(env, args[0], &is_array);
    if (is_array) {
        NAPI_CALL(env, napi_get_array_length(env, args[0], &n));
        if (n > 16)
            THROW(env, "drawBuffers: at most 16 attachments");
        for (uint32_t i = 0; i < n; i++) {
            napi_value e;
            NAPI_CALL(env, napi_get_element(env, args[0], i, &e));
            bufs[i] = arg_u32(env, e);
        }
    } else {
        void *data;
        size_t nbytes;
        if (!typed_bytes(env, args[0], &data, &nbytes))
            THROW(env, "drawBuffers expects an array of attachment enums");
        n = (uint32_t)(nbytes / sizeof(GLenum));
        if (n > 16)
            THROW(env, "drawBuffers: at most 16 attachments");
        memcpy(bufs, data, n * sizeof(GLenum));
    }
    gl.DrawBuffers((GLsizei)n, bufs);
    return NULL;
}

// --- 3D and array textures, immutable storage ------------------------------
//
// A 3D texture and a 2D array texture are the same call with a different
// target: TEXTURE_3D filters across the third axis, TEXTURE_2D_ARRAY keeps
// its layers independent. Both are ES 3.0 (or GL_OES_texture_3D for the 3D
// half), so all of it goes through NEED_FN.

// texImage3D(target, level, internalformat, width, height, depth, border,
//            format, type, pixels|null)
static napi_value Gl_texImage3D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 10); NEED_GL(env);
    NEED_FN(env, TexImage3D, "3D and array textures");
    void *data;
    if (!pixels_arg(env, args[9], &data))
        THROW(env, "texImage3D expects a TypedArray or null as its last argument");
    gl.TexImage3D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                  arg_i32(env, args[2]), arg_i32(env, args[3]),
                  arg_i32(env, args[4]), arg_i32(env, args[5]),
                  arg_i32(env, args[6]), arg_u32(env, args[7]),
                  arg_u32(env, args[8]), data);
    return NULL;
}
// texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height,
//               depth, format, type, pixels)
static napi_value Gl_texSubImage3D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 11); NEED_GL(env);
    NEED_FN(env, TexSubImage3D, "3D and array textures");
    void *data;
    if (!pixels_arg(env, args[10], &data) || !data)
        THROW(env, "texSubImage3D expects a TypedArray of pixels");
    gl.TexSubImage3D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                     arg_i32(env, args[2]), arg_i32(env, args[3]),
                     arg_i32(env, args[4]), arg_i32(env, args[5]),
                     arg_i32(env, args[6]), arg_i32(env, args[7]),
                     arg_u32(env, args[8]), arg_u32(env, args[9]), data);
    return NULL;
}
// copyTexSubImage3D(target, level, xoffset, yoffset, zoffset, x, y, width,
//                   height) — one layer, from the framebuffer
static napi_value Gl_copyTexSubImage3D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 9); NEED_GL(env);
    NEED_FN(env, CopyTexSubImage3D, "3D and array textures");
    gl.CopyTexSubImage3D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                         arg_i32(env, args[2]), arg_i32(env, args[3]),
                         arg_i32(env, args[4]), arg_i32(env, args[5]),
                         arg_i32(env, args[6]), arg_i32(env, args[7]),
                         arg_i32(env, args[8]));
    return NULL;
}
// compressedTexImage3D(target, level, internalformat, width, height, depth,
//                      border, data)
static napi_value Gl_compressedTexImage3D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 8); NEED_GL(env);
    NEED_FN(env, CompressedTexImage3D, "3D and array textures");
    void *data;
    size_t nbytes;
    if (!typed_bytes(env, args[7], &data, &nbytes))
        THROW(env, "compressedTexImage3D expects a TypedArray of compressed data");
    gl.CompressedTexImage3D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                            arg_u32(env, args[2]), arg_i32(env, args[3]),
                            arg_i32(env, args[4]), arg_i32(env, args[5]),
                            arg_i32(env, args[6]), (GLsizei)nbytes, data);
    return NULL;
}
// compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width,
//                         height, depth, format, data)
static napi_value Gl_compressedTexSubImage3D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 10); NEED_GL(env);
    NEED_FN(env, CompressedTexSubImage3D, "3D and array textures");
    void *data;
    size_t nbytes;
    if (!typed_bytes(env, args[9], &data, &nbytes))
        THROW(env, "compressedTexSubImage3D expects a TypedArray of compressed data");
    gl.CompressedTexSubImage3D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                               arg_i32(env, args[2]), arg_i32(env, args[3]),
                               arg_i32(env, args[4]), arg_i32(env, args[5]),
                               arg_i32(env, args[6]), arg_i32(env, args[7]),
                               arg_u32(env, args[8]), (GLsizei)nbytes, data);
    return NULL;
}
// framebufferTextureLayer(target, attachment, texture, level, layer) — how a
// single slice of a 3D or array texture becomes a render target
static napi_value Gl_framebufferTextureLayer(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    NEED_FN(env, FramebufferTextureLayer, "3D and array textures");
    gl.FramebufferTextureLayer(arg_u32(env, args[0]), arg_u32(env, args[1]),
                               arg_u32(env, args[2]), arg_i32(env, args[3]),
                               arg_i32(env, args[4]));
    return NULL;
}

// texStorage2D/3D(target, levels, internalformat, width, height[, depth])
//
// Immutable storage: the whole mipmap pyramid is allocated once, in a sized
// format, and cannot be reshaped afterwards — only its contents change, via
// texSubImage. That is the difference from texImage2D, which reallocates on
// every call and leaves the driver unable to assume anything.
static napi_value Gl_texStorage2D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 5); NEED_GL(env);
    NEED_FN(env, TexStorage2D, "immutable texture storage");
    gl.TexStorage2D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                    arg_u32(env, args[2]), arg_i32(env, args[3]),
                    arg_i32(env, args[4]));
    return NULL;
}
static napi_value Gl_texStorage3D(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 6); NEED_GL(env);
    NEED_FN(env, TexStorage3D, "immutable texture storage");
    gl.TexStorage3D(arg_u32(env, args[0]), arg_i32(env, args[1]),
                    arg_u32(env, args[2]), arg_i32(env, args[3]),
                    arg_i32(env, args[4]), arg_i32(env, args[5]));
    return NULL;
}

// getFeatures() -> { vertexArrayObject, instancedArrays, drawBuffers,
//                    texture3D, textureStorage }
//
// A feature is present only when every entry point it needs resolved, so a
// driver offering half an extension reports it as absent rather than
// throwing partway through a frame.
static napi_value GlFeatures(napi_env env, napi_callback_info info) {
    (void)info; NEED_GL(env);
    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    for (size_t i = 0; i < sizeof(gl_optional) / sizeof(gl_optional[0]); i++) {
        const GlOptional *o = &gl_optional[i];
        napi_value prev;
        bool ok = true;
        napi_valuetype t = napi_undefined;
        if (napi_get_named_property(env, obj, o->feature, &prev) == napi_ok &&
            napi_typeof(env, prev, &t) == napi_ok && t == napi_boolean)
            napi_get_value_bool(env, prev, &ok);
        obj_set(env, obj, o->feature, mk_bool(env, ok && *o->slot != NULL));
    }
    // dma-buf import is not an entry point of the GL table but a property of
    // the EGL display the context belongs to, so it is reported rather than
    // resolved: `dmabufImport` false means importDmabuf() would throw here.
    bool can_import = egl_image_why_not() == NULL;
    obj_set(env, obj, "dmabufImport", mk_bool(env, can_import));
    obj_set(env, obj, "dmabufImportModifiers",
            mk_bool(env, can_import && img.modifiers));
    obj_set(env, obj, "dmabufImportExternal",
            mk_bool(env, can_import && img.external));
    return obj;
}

// ---------------------------------------------------------------------------
// dma-buf -> EGLImage -> GL texture
//
// The way back in for a descriptor this addon did not allocate: DRI3
// BuffersFromPixmap (a redirected window's pixmap), a video decoder, another
// process. One eglCreateImageKHR over the plane descriptors, one
// glEGLImageTargetTexture2DOES to bind the result to a texture, and the
// pixels are sampleable with no copy and no upload.
//
// Ownership follows the rest of the addon: the descriptors are consumed on
// success (closed here, once each, however many planes share one) and left
// untouched on failure, so the caller can report or retry.
// ---------------------------------------------------------------------------

typedef struct {
    EGLDisplay dpy;
    EGLImageKHR image;
    GLuint texture;
    GLenum target;
    int destroyed;
} Import;

static void import_release(Import *im) {
    if (im->destroyed)
        return;
    // The texture belongs to a context, so drop it only while one is current
    // (a finalizer can run after teardown); the image belongs to the display
    // alone, and eglDestroyImageKHR needs nothing current.
    if (im->texture && has_current)
        gl.DeleteTextures(1, &im->texture);
    if (im->image && egl.DestroyImageKHR)
        egl.DestroyImageKHR(im->dpy, im->image);
    im->destroyed = 1;
}

static void import_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    import_release(data);
    free(data);
}

// One of the three parallel plane arrays, which JS has already checked are
// the same length.
static bool plane_ints(napi_env env, napi_value arr, uint32_t want, int32_t *out) {
    bool is_array = false;
    uint32_t len = 0;
    if (napi_is_array(env, arr, &is_array) != napi_ok || !is_array)
        return false;
    if (napi_get_array_length(env, arr, &len) != napi_ok || len != want)
        return false;
    for (uint32_t i = 0; i < want; i++) {
        napi_value el;
        if (napi_get_element(env, arr, i, &el) != napi_ok)
            return false;
        out[i] = arg_i32(env, el);
    }
    return true;
}

// importDmabuf(width, height, fourcc, modifier|null, target, fds[], offsets[],
//              strides[]) -> { handle, texture, target }
// `target` of 0 means "decide here": TEXTURE_2D for a single plane,
// TEXTURE_EXTERNAL_OES for the multi-planar formats that need a
// samplerExternalOES to read.
static napi_value ImportDmabuf(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 8);
    NEED_GL(env);
    const char *why = egl_image_why_not();
    if (why)
        THROWF(env, "importDmabuf: %s", why);

    int32_t width = arg_i32(env, args[0]);
    int32_t height = arg_i32(env, args[1]);
    uint32_t fourcc = arg_u32(env, args[2]);
    GLenum target = arg_u32(env, args[4]);

    uint32_t nplanes = 0;
    bool is_array = false;
    if (napi_is_array(env, args[5], &is_array) != napi_ok || !is_array ||
        napi_get_array_length(env, args[5], &nplanes) != napi_ok)
        THROW(env, "importDmabuf: planes must be an array");
    if (nplanes < 1 || nplanes > 4)
        THROWF(env, "importDmabuf: 1 to 4 planes, got %u", nplanes);

    int32_t fds[4], offsets[4], strides[4];
    if (!plane_ints(env, args[5], nplanes, fds) ||
        !plane_ints(env, args[6], nplanes, offsets) ||
        !plane_ints(env, args[7], nplanes, strides))
        THROW(env, "importDmabuf: fd/offset/stride arrays disagree");

    // A modifier is optional, and asking for one needs the second extension:
    // the plain import handles the implicit-modifier case only.
    bool have_modifier = false;
    uint64_t modifier = 0;
    napi_valuetype mt;
    napi_typeof(env, args[3], &mt);
    if (mt != napi_null && mt != napi_undefined) {
        bool lossless = false;
        if (napi_get_value_bigint_uint64(env, args[3], &modifier, &lossless) != napi_ok)
            THROW(env, "importDmabuf: modifier must be a BigInt or null");
        if (!lossless)
            THROW(env, "importDmabuf: modifier does not fit an unsigned 64-bit "
                       "integer");
        have_modifier = true;
    }
    if (have_modifier && !img.modifiers)
        THROW(env, "importDmabuf: this driver has no "
                   "EGL_EXT_image_dma_buf_import_modifiers — pass no modifier "
                   "(implicit) or check features.dmabufImportModifiers first");

    if (!target)
        target = nplanes > 1 ? GL_TEXTURE_EXTERNAL_OES : GL_TEXTURE_2D;
    if (target != GL_TEXTURE_2D && target != GL_TEXTURE_EXTERNAL_OES)
        THROWF(env, "importDmabuf: target must be TEXTURE_2D or "
                    "TEXTURE_EXTERNAL_OES (got 0x%x)", target);
    if (target == GL_TEXTURE_EXTERNAL_OES && !img.external)
        THROW(env, "importDmabuf: this context has no GL_OES_EGL_image_external "
                   "for the TEXTURE_EXTERNAL_OES target");

    // Plane 3's attribute names were added after the first three and sit at
    // their own base, so these are tables rather than arithmetic.
    static const EGLint A_FD[4]     = { 0x3272, 0x3275, 0x3278, 0x3440 };
    static const EGLint A_OFFSET[4] = { 0x3273, 0x3276, 0x3279, 0x3441 };
    static const EGLint A_PITCH[4]  = { 0x3274, 0x3277, 0x327A, 0x3442 };
    static const EGLint A_MOD_LO[4] = { 0x3443, 0x3445, 0x3447, 0x3449 };
    static const EGLint A_MOD_HI[4] = { 0x3444, 0x3446, 0x3448, 0x344A };

    EGLint attribs[6 + 4 * 10 + 1];
    int n = 0;
    attribs[n++] = EGL_WIDTH;              attribs[n++] = width;
    attribs[n++] = EGL_HEIGHT;             attribs[n++] = height;
    attribs[n++] = EGL_LINUX_DRM_FOURCC_EXT; attribs[n++] = (EGLint)fourcc;
    for (uint32_t i = 0; i < nplanes; i++) {
        attribs[n++] = A_FD[i];     attribs[n++] = fds[i];
        attribs[n++] = A_OFFSET[i]; attribs[n++] = offsets[i];
        attribs[n++] = A_PITCH[i];  attribs[n++] = strides[i];
        if (have_modifier) {
            // The modifier describes the layout and so is per plane, even
            // though one buffer has one layout: every plane gets the same.
            attribs[n++] = A_MOD_LO[i];
            attribs[n++] = (EGLint)(uint32_t)(modifier & 0xFFFFFFFFu);
            attribs[n++] = A_MOD_HI[i];
            attribs[n++] = (EGLint)(uint32_t)(modifier >> 32);
        }
    }
    attribs[n] = EGL_NONE;

    EGLImageKHR image = egl.CreateImageKHR(img.dpy, EGL_NO_CONTEXT,
                                           EGL_LINUX_DMA_BUF_EXT,
                                           (EGLClientBuffer)NULL, attribs);
    if (image == EGL_NO_IMAGE_KHR)
        THROWF(env, "eglCreateImageKHR(EGL_LINUX_DMA_BUF_EXT) failed (0x%x) — "
                    "a format, modifier or plane layout this driver will not "
                    "import? (the descriptors are left open)", egl.GetError());

    GLint prev = 0;
    gl.GetIntegerv(target == GL_TEXTURE_2D ? GL_TEXTURE_BINDING_2D
                                           : GL_TEXTURE_BINDING_EXTERNAL_OES,
                   &prev);
    GLuint tex = 0;
    gl.GenTextures(1, &tex);
    gl.BindTexture(target, tex);
    // An imported image has exactly one level: the default minification
    // filter would sample a mipmap that does not exist and leave the texture
    // incomplete, and TEXTURE_EXTERNAL_OES refuses any wrap but CLAMP_TO_EDGE.
    gl.TexParameteri(target, 0x2801 /* MIN_FILTER */, 0x2601 /* LINEAR */);
    gl.TexParameteri(target, 0x2800 /* MAG_FILTER */, 0x2601);
    gl.TexParameteri(target, 0x2802 /* WRAP_S */, 0x812F /* CLAMP_TO_EDGE */);
    gl.TexParameteri(target, 0x2803 /* WRAP_T */, 0x812F);
    for (int i = 0; i < 8 && gl.GetError() != 0; i++)
        ; // drain errors the caller left behind, so the next one is ours
    gl.EGLImageTargetTexture2DOES(target, image);
    GLenum gerr = gl.GetError();
    gl.BindTexture(target, (GLuint)prev); // leave the binding as we found it
    if (gerr != 0) {
        gl.DeleteTextures(1, &tex);
        egl.DestroyImageKHR(img.dpy, image);
        THROWF(env, "glEGLImageTargetTexture2DOES failed (0x%x) — the image "
                    "does not suit this target? (the descriptors are left open)",
               gerr);
    }

    // Consumed: EGL holds its own reference to the buffer now. Planes of one
    // buffer commonly repeat a descriptor, so close each distinct fd once.
    for (uint32_t i = 0; i < nplanes; i++) {
        bool already = false;
        for (uint32_t j = 0; j < i; j++)
            if (fds[j] == fds[i])
                already = true;
        if (!already && fds[i] >= 0)
            close(fds[i]);
    }

    Import *im = calloc(1, sizeof(Import));
    im->dpy = img.dpy;
    im->image = image;
    im->texture = tex;
    im->target = target;

    napi_value obj, ext;
    NAPI_CALL(env, napi_create_object(env, &obj));
    NAPI_CALL(env, napi_create_external(env, im, import_finalize, NULL, &ext));
    obj_set(env, obj, "handle", ext);
    obj_set(env, obj, "texture", mk_u32(env, tex));
    obj_set(env, obj, "target", mk_u32(env, target));
    return obj;
}

// destroyImportedImage(handle) — glDeleteTextures + eglDestroyImageKHR
static napi_value DestroyImportedImage(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    Import *im;
    if (!get_external(env, args[0], (void **)&im)) return NULL;
    import_release(im);
    return NULL;
}

// ---------------------------------------------------------------------------
// Apple-DRI / CGL backend (macOS + XQuartz)
//
// XQuartz never grew DRI3 — its direct rendering is the Apple-DRI extension:
// the server owns a WindowServer surface for the drawable and *exports* it
// to a client by (client_id, key[2]); the client imports the key over its
// own WindowServer connection and attaches a CGL context, after which GL
// renders into the window's backing store with no copies and no X protocol
// in the frame loop. CGLFlushDrawable is the swap.
//
// Division of labor mirrors the DRI3 path exactly: the X requests
// (AppleDRICreateSurface and friends) are plain protocol, spoken in JS by
// the x11 package; what cannot be JavaScript — the WindowServer handshake,
// the surface import, the CGL context — lives here.
//
// The contexts this creates default to the core profile (GL 4.1 on Metal
// hardware), where ARB_ES2_compatibility accepts GLSL ES 1.00 — so the same
// WebGL-flavored `gl` and the same shaders run unchanged; see the #version
// shim in Gl_shaderSource and the default VAO below for the two core-profile
// potholes this smooths over.
// ---------------------------------------------------------------------------

#if defined(__APPLE__)

typedef struct {
    CGLPixelFormatObj pf;
    CGLContextObj ctx;
    unsigned int sid; // imported xp surface id; 0 = not attached
    GLuint vao;       // the default vertex array object of a core context
    int core;
    int destroyed;
} AppleCtx;

static void apple_ctx_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    AppleCtx *a = data;
    if (!a->destroyed) {
        if (a->ctx) cgl.DestroyContext(a->ctx);
        if (a->pf) cgl.DestroyPixelFormat(a->pf);
        if (a->sid) xp.destroy_surface(a->sid);
    }
    free(a);
}

// ---------------------------------------------------------------------------
// IOSurface render targets — how GL output reaches a Core Animation layer
// when there is no X server exporting a window surface (the react-x11 Cocoa
// backend). The mirror of the Linux GBM surface: the GPU addon owns the
// buffer and exports a process-global handle — there the dma-buf fd, here
// the IOSurfaceID — and the presentation side (node-calayers) looks it up
// and sets it as `layer.contents`. Rendering goes through an FBO whose
// color attachment is the IOSurface, wired by CGLTexImageIOSurface2D onto a
// GL_TEXTURE_RECTANGLE — the one target that call accepts.
// ---------------------------------------------------------------------------

#define LIB_IOSURFACE \
    "/System/Library/Frameworks/IOSurface.framework/IOSurface"
#define LIB_COREFOUNDATION \
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

// the target/format triple CGLTexImageIOSurface2D documents for BGRA
#define GL_TEXTURE_RECTANGLE_          0x84F5
#define GL_BGRA_                       0x80E1
#define GL_UNSIGNED_INT_8_8_8_8_REV_   0x8367
#define GL_RGBA_                       0x1908
#define GL_FRAMEBUFFER_                0x8D40
#define GL_COLOR_ATTACHMENT0_          0x8CE0
#define GL_FRAMEBUFFER_COMPLETE_       0x8CD5
#define GL_RENDERBUFFER_               0x8D41
#define GL_DEPTH24_STENCIL8_           0x88F0
#define GL_DEPTH_ATTACHMENT_           0x8D00
#define GL_STENCIL_ATTACHMENT_         0x8D20
#define kCFNumberSInt32Type_           3

static struct {
    void *lib;
    void *cf_lib;
    void *(*Create)(const void *props);                        // IOSurfaceCreate
    uint32_t (*GetID)(void *surface);                          // IOSurfaceGetID
    void *(*DictionaryCreate)(const void *allocator, const void **keys,
                              const void **values, long count,
                              const void *keyCallbacks,
                              const void *valueCallbacks);
    void *(*NumberCreate)(const void *allocator, long type, const void *value);
    void (*Release)(const void *cf);
    const void *keyWidth, *keyHeight, *keyBytesPerElement, *keyPixelFormat;
    const void *keyCallbacks, *valueCallbacks;
} ios;

static const char *load_iosurface(void) {
    if (ios.lib) return NULL;
    void *ih = dlopen(LIB_IOSURFACE, RTLD_NOW | RTLD_GLOBAL);
    if (!ih) return "the IOSurface framework did not load";
    void *ch = dlopen(LIB_COREFOUNDATION, RTLD_NOW | RTLD_GLOBAL);
    if (!ch) return "the CoreFoundation framework did not load";
#define SI(field, lib, name)                                                  \
    do {                                                                      \
        *(void **)&ios.field = dlsym(lib, name);                              \
        if (!ios.field) return "missing " name;                               \
    } while (0)
    SI(Create, ih, "IOSurfaceCreate");
    SI(GetID, ih, "IOSurfaceGetID");
    SI(DictionaryCreate, ch, "CFDictionaryCreate");
    SI(NumberCreate, ch, "CFNumberCreate");
    SI(Release, ch, "CFRelease");
#undef SI
    // exported CFStringRef constants: dlsym answers the variable's address
#define SK(field, lib, name)                                                  \
    do {                                                                      \
        void **p = (void **)dlsym(lib, name);                                 \
        if (!p || !*p) return "missing " name;                                \
        ios.field = *p;                                                       \
    } while (0)
    SK(keyWidth, ih, "kIOSurfaceWidth");
    SK(keyHeight, ih, "kIOSurfaceHeight");
    SK(keyBytesPerElement, ih, "kIOSurfaceBytesPerElement");
    SK(keyPixelFormat, ih, "kIOSurfacePixelFormat");
#undef SK
    // callback tables are structs, passed by address as-is
    ios.keyCallbacks = dlsym(ch, "kCFTypeDictionaryKeyCallBacks");
    ios.valueCallbacks = dlsym(ch, "kCFTypeDictionaryValueCallBacks");
    if (!ios.keyCallbacks || !ios.valueCallbacks)
        return "missing CFDictionary callback tables";
    ios.lib = ih;
    ios.cf_lib = ch;
    return NULL;
}

static bool apple_make_current_impl(napi_env env, AppleCtx *a);

typedef struct {
    void *surface;   // IOSurfaceRef, retained by Create
    uint32_t sid;    // its process-global IOSurfaceID
    GLuint tex;
    GLuint fbo;
    GLuint depth_rb; // 0 when the context asked for no depth/stencil
    int32_t width, height;
    int destroyed;
} AppleTarget;

static void apple_target_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    AppleTarget *t = data;
    // GL names need a current context and GC gives none; destroyTarget is
    // the real teardown. The IOSurface itself is safe to drop from here.
    if (!t->destroyed && t->surface) ios.Release(t->surface);
    free(t);
}

static void *cf_i32(int32_t v) {
    return ios.NumberCreate(NULL, kCFNumberSInt32Type_, &v);
}

// appleCreateTarget(ctx, width, height, wantDepth) -> external
// Renders arrive in the IOSurface named by appleTargetInfo().iosurfaceId —
// BGRA, premultiplied by whatever the drawing did, ready for
// `layer.contents`. Makes the context current.
static napi_value AppleCreateTarget(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 4);
    const char *e = load_iosurface();
    if (e) THROWF(env, "IOSurface unavailable: %s", e);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    int32_t w = arg_i32(env, args[1]);
    int32_t h = arg_i32(env, args[2]);
    bool want_depth = arg_bool(env, args[3]);
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (!apple_make_current_impl(env, a)) return NULL;

    const void *keys[4] = { ios.keyWidth, ios.keyHeight,
                            ios.keyBytesPerElement, ios.keyPixelFormat };
    void *vw = cf_i32(w), *vh = cf_i32(h), *vb = cf_i32(4);
    void *vf = cf_i32(0x42475241); // 'BGRA'
    const void *vals[4] = { vw, vh, vb, vf };
    void *props = ios.DictionaryCreate(NULL, keys, vals, 4,
                                       ios.keyCallbacks, ios.valueCallbacks);
    void *surface = ios.Create(props);
    ios.Release(props);
    ios.Release(vw); ios.Release(vh); ios.Release(vb); ios.Release(vf);
    if (!surface) THROWF(env, "IOSurfaceCreate(%dx%d) failed", w, h);

    AppleTarget *t = calloc(1, sizeof(AppleTarget));
    t->surface = surface;
    t->sid = ios.GetID(surface);
    t->width = w;
    t->height = h;

    gl.GenTextures(1, &t->tex);
    gl.BindTexture(GL_TEXTURE_RECTANGLE_, t->tex);
    int cerr = cgl.TexImageIOSurface2D(a->ctx, GL_TEXTURE_RECTANGLE_,
                                       GL_RGBA_, w, h, GL_BGRA_,
                                       GL_UNSIGNED_INT_8_8_8_8_REV_,
                                       surface, 0);
    if (cerr != 0) {
        gl.DeleteTextures(1, &t->tex);
        ios.Release(surface);
        free(t);
        THROWF(env, "CGLTexImageIOSurface2D: %s", cgl.ErrorString(cerr));
    }
    gl.BindTexture(GL_TEXTURE_RECTANGLE_, 0);

    gl.GenFramebuffers(1, &t->fbo);
    gl.BindFramebuffer(GL_FRAMEBUFFER_, t->fbo);
    gl.FramebufferTexture2D(GL_FRAMEBUFFER_, GL_COLOR_ATTACHMENT0_,
                            GL_TEXTURE_RECTANGLE_, t->tex, 0);
    if (want_depth) {
        gl.GenRenderbuffers(1, &t->depth_rb);
        gl.BindRenderbuffer(GL_RENDERBUFFER_, t->depth_rb);
        gl.RenderbufferStorage(GL_RENDERBUFFER_, GL_DEPTH24_STENCIL8_, w, h);
        // two calls rather than GL_DEPTH_STENCIL_ATTACHMENT: both profiles
        // accept the pair, and the combined enum is core-only
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER_, GL_DEPTH_ATTACHMENT_,
                                   GL_RENDERBUFFER_, t->depth_rb);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER_, GL_STENCIL_ATTACHMENT_,
                                   GL_RENDERBUFFER_, t->depth_rb);
    }
    unsigned status = gl.CheckFramebufferStatus(GL_FRAMEBUFFER_);
    if (status != GL_FRAMEBUFFER_COMPLETE_) {
        gl.BindFramebuffer(GL_FRAMEBUFFER_, 0);
        gl.DeleteFramebuffers(1, &t->fbo);
        if (t->depth_rb) gl.DeleteRenderbuffers(1, &t->depth_rb);
        gl.DeleteTextures(1, &t->tex);
        ios.Release(surface);
        free(t);
        THROWF(env, "IOSurface framebuffer incomplete: 0x%x", status);
    }
    napi_value ext;
    NAPI_CALL(env, napi_create_external(env, t, apple_target_finalize, NULL,
                                        &ext));
    return ext;
}

// appleBindTarget(ctx, target | null) — subsequent GL draws land in the
// target's IOSurface (or back in "no framebuffer" for null). Makes the
// context current.
static napi_value AppleBindTarget(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    if (!apple_make_current_impl(env, a)) return NULL;
    napi_valuetype vt;
    NAPI_CALL(env, napi_typeof(env, args[1], &vt));
    if (vt == napi_null || vt == napi_undefined) {
        gl.BindFramebuffer(GL_FRAMEBUFFER_, 0);
        return NULL;
    }
    AppleTarget *t;
    if (!get_external(env, args[1], (void **)&t)) return NULL;
    if (t->destroyed) THROWF(env, "target already destroyed");
    gl.BindFramebuffer(GL_FRAMEBUFFER_, t->fbo);
    return NULL;
}

// appleTargetInfo(target) -> { iosurfaceId, width, height }
static napi_value AppleTargetInfo(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    AppleTarget *t;
    if (!get_external(env, args[0], (void **)&t)) return NULL;
    napi_value obj;
    NAPI_CALL(env, napi_create_object(env, &obj));
    obj_set(env, obj, "iosurfaceId", mk_u32(env, t->sid));
    obj_set(env, obj, "fbo", mk_u32(env, t->fbo));
    obj_set(env, obj, "width", mk_i32(env, t->width));
    obj_set(env, obj, "height", mk_i32(env, t->height));
    return obj;
}

// appleDestroyTarget(ctx, target) — needs the context so the GL names can
// actually be deleted; the finalizer alone would only drop the IOSurface.
static napi_value AppleDestroyTarget(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    AppleCtx *a;
    AppleTarget *t;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    if (!get_external(env, args[1], (void **)&t)) return NULL;
    if (t->destroyed) return NULL;
    if (apple_make_current_impl(env, a)) {
        gl.BindFramebuffer(GL_FRAMEBUFFER_, 0);
        gl.DeleteFramebuffers(1, &t->fbo);
        if (t->depth_rb) gl.DeleteRenderbuffers(1, &t->depth_rb);
        gl.DeleteTextures(1, &t->tex);
    }
    ios.Release(t->surface);
    t->surface = NULL;
    t->destroyed = 1;
    return NULL;
}

// appleClientId() -> number. Connects this process to the WindowServer on
// first use (xp_init) and reports its client id — the value the X server
// needs in AppleDRICreateSurface to export a drawable's surface to us.
static napi_value AppleClientId(napi_env env, napi_callback_info info) {
    (void)info;
    const char *e = load_apple();
    if (e) THROWF(env, "Apple-DRI unavailable: %s", e);
    static unsigned int cid; // one WindowServer identity per process
    if (!cid) {
        int err = xp.init(XP_IN_BACKGROUND);
        if (err != XP_SUCCESS)
            THROWF(env, "xp_init failed (%d) — no WindowServer session? "
                        "(this path needs a logged-in GUI session, not SSH)", err);
        err = xp.get_client_id(&cid);
        if (err != XP_SUCCESS || !cid)
            THROWF(env, "xp_get_client_id failed (%d)", err);
    }
    return mk_u32(env, cid);
}

// appleRefreshRate() -> number | null. The fastest refresh rate any
// connected display is running at, in Hz — asked of macOS because XQuartz's RandR has
// no timing data to give. Max across displays is a pacing *ceiling*, the
// same semantics RandR's fastest CRTC gives consumers on Linux, not
// per-window tracking. Null when there is no rate to be had (no GUI
// session, or no display would state one).
static napi_value AppleRefreshRate(napi_env env, napi_callback_info info) {
    (void)info;
    const char *e = load_display();
    if (e) THROWF(env, "display refresh rate unavailable: %s", e);
    napi_value ret;
    uint32_t ids[16], n = 0;
    if (dsp.GetOnlineDisplayList(16, ids, &n) != 0 || n == 0) {
        NAPI_CALL(env, napi_get_null(env, &ret));
        return ret;
    }
    double best = 0;
    for (uint32_t i = 0; i < n; i++) {
        double hz = 0;
        void *mode = dsp.CopyDisplayMode(ids[i]);
        if (mode) {
            hz = dsp.ModeGetRefreshRate(mode);
            dsp.ModeRelease(mode);
        }
        // 0 is CGDisplayModeGetRefreshRate's documented answer for some
        // built-in panels; a throwaway display link still knows the nominal
        // rate (for variable-rate panels like ProMotion, the maximum — the
        // right number for a pacing ceiling).
        if (hz <= 0 && dsp.cv_lib) {
            void *link = NULL;
            if (dsp.LinkCreateWithCGDisplay(ids[i], &link) == 0 && link) {
                CVTime_ t = dsp.LinkGetNominalPeriod(link);
                if (!(t.flags & kCVTimeIsIndefinite_) && t.timeValue > 0)
                    hz = (double)t.timeScale / (double)t.timeValue;
                dsp.LinkRelease(link);
            }
        }
        if (hz > best) best = hz;
    }
    if (best <= 0) {
        NAPI_CALL(env, napi_get_null(env, &ret));
        return ret;
    }
    NAPI_CALL(env, napi_create_double(env, best, &ret));
    return ret;
}

// appleCreateContext(colorSize, alphaSize, depthSize, stencilSize,
//                    doubleBuffer, coreProfile) -> external
static napi_value AppleCreateContext(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 6);
    const char *e = load_apple();
    if (e) THROWF(env, "Apple-DRI unavailable: %s", e);
    int color = arg_i32(env, args[0]);
    int alpha = arg_i32(env, args[1]);
    int depth = arg_i32(env, args[2]);
    int stencil = arg_i32(env, args[3]);
    bool dbl = arg_bool(env, args[4]);
    bool core = arg_bool(env, args[5]);

    // Hardware first; when there is none (a VM, say) retry without insisting,
    // which lets Apple's software renderer through.
    CGLPixelFormatObj pf = NULL;
    int cerr = 0;
    for (int accelerated = 1; accelerated >= 0 && !pf; accelerated--) {
        int attrs[16], n = 0;
        if (accelerated) attrs[n++] = kCGLPFAAccelerated;
        attrs[n++] = kCGLPFAClosestPolicy;
        if (dbl) attrs[n++] = kCGLPFADoubleBuffer;
        attrs[n++] = kCGLPFAColorSize;  attrs[n++] = color > 0 ? color : 24;
        attrs[n++] = kCGLPFAAlphaSize;  attrs[n++] = alpha > 0 ? alpha : 0;
        attrs[n++] = kCGLPFADepthSize;  attrs[n++] = depth > 0 ? depth : 0;
        if (stencil > 0) { attrs[n++] = kCGLPFAStencilSize; attrs[n++] = stencil; }
        if (core) { attrs[n++] = kCGLPFAOpenGLProfile;
                    attrs[n++] = kCGLOGLPVersion_3_2_Core; }
        attrs[n] = 0;
        GLint npix = 0;
        cerr = cgl.ChoosePixelFormat(attrs, &pf, &npix);
        if (cerr != 0)
            pf = NULL;
    }
    if (!pf)
        THROWF(env, "CGLChoosePixelFormat found nothing: %s",
               cgl.ErrorString(cerr));
    CGLContextObj ctx = NULL;
    cerr = cgl.CreateContext(pf, NULL, &ctx);
    if (cerr != 0 || !ctx) {
        cgl.DestroyPixelFormat(pf);
        THROWF(env, "CGLCreateContext: %s", cgl.ErrorString(cerr));
    }
    AppleCtx *a = calloc(1, sizeof(AppleCtx));
    a->pf = pf;
    a->ctx = ctx;
    a->core = core ? 1 : 0;
    napi_value ext;
    NAPI_CALL(env, napi_create_external(env, a, apple_ctx_finalize, NULL, &ext));
    return ext;
}

static bool apple_make_current_impl(napi_env env, AppleCtx *a) {
    int cerr = cgl.SetCurrentContext(a->ctx);
    if (cerr != 0) {
        napi_throw_error(env, NULL, cgl.ErrorString(cerr));
        return false;
    }
    has_current = 1;
    apple_core_current = a->core;
    resolve_optional_gl((EGLContext)a->ctx);
    resolve_egl_image(NULL); // a CGL context has no EGL display to import into
    // A core profile refuses to draw with no vertex array object bound, and
    // a WebGL-1-style caller has no reason to know VAOs exist — so the
    // context carries one default VAO, exactly as the browsers do it.
    if (a->core && !a->vao && gl.GenVertexArrays && gl.BindVertexArray) {
        gl.GenVertexArrays(1, &a->vao);
        gl.BindVertexArray(a->vao);
    }
    return true;
}

// appleMakeCurrent(ctx)
static napi_value AppleMakeCurrent(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    apple_make_current_impl(env, a);
    return NULL;
}

// appleAttach(ctx, key0, key1) — import the surface the X server exported
// for our client id (the AppleDRICreateSurface reply) and bind the context
// to it. Makes the context current as a side effect (Xplugin wants it so).
// Attaching again replaces the previous surface — that is the recovery path
// after a SurfaceNotify(destroyed) once a fresh surface has been created.
static napi_value AppleAttach(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 3);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    unsigned int key[2] = { arg_u32(env, args[1]), arg_u32(env, args[2]) };
    if (a->sid) {
        cgl.ClearDrawable(a->ctx);
        xp.destroy_surface(a->sid);
        a->sid = 0;
    }
    int err = xp.import_surface(key, &a->sid);
    if (err != XP_SUCCESS || !a->sid) {
        a->sid = 0;
        THROWF(env, "xp_import_surface failed (%d) — was the surface created "
                    "with this process's appleClientId()?", err);
    }
    if (!apple_make_current_impl(env, a)) return NULL;
    err = xp.attach_gl_context(a->ctx, a->sid);
    if (err != XP_SUCCESS)
        THROWF(env, "xp_attach_gl_context failed (%d)", err);
    return NULL;
}

// appleFlush(ctx) — present the frame; the swap of this backend
static napi_value AppleFlush(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    int cerr = cgl.FlushDrawable(a->ctx);
    if (cerr != 0)
        THROWF(env, "CGLFlushDrawable: %s", cgl.ErrorString(cerr));
    return NULL;
}

// appleUpdate(ctx) — refresh the context's idea of the surface after the
// window moved or resized (on ConfigureNotify or SurfaceNotify kind 0)
static napi_value AppleUpdate(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    xp.update_gl_context(a->ctx);
    return NULL;
}

// appleSetSwapInterval(ctx, n) — 0: flush returns at once (default);
// 1: flush blocks to vertical retrace, which also blocks the event loop
static napi_value AppleSetSwapInterval(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    GLint v = arg_i32(env, args[1]);
    cgl.SetParameter(a->ctx, kCGLCPSwapInterval, &v);
    return NULL;
}

// appleDestroyContext(ctx)
static napi_value AppleDestroyContext(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 1);
    AppleCtx *a;
    if (!get_external(env, args[0], (void **)&a)) return NULL;
    if (!a->destroyed) {
        if (cgl.GetCurrentContext() == a->ctx) {
            cgl.SetCurrentContext(NULL);
            has_current = 0;
            apple_core_current = 0;
        }
        if (optional_ctx == (EGLContext)a->ctx)
            optional_ctx = NULL; // a later context could land on this address
        cgl.ClearDrawable(a->ctx);
        cgl.DestroyContext(a->ctx);
        cgl.DestroyPixelFormat(a->pf);
        if (a->sid)
            xp.destroy_surface(a->sid);
        a->destroyed = 1;
    }
    return NULL;
}

#else // !__APPLE__

#define NO_APPLEDRI                                                           \
    "the Apple-DRI/CGL path is XQuartz's direct rendering and exists only "   \
    "on macOS — on " PLATFORM_NAME " use the DRI3 path (Gpu)"

static napi_value AppleClientId(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleClientId: " NO_APPLEDRI);
}
static napi_value AppleRefreshRate(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleRefreshRate: " NO_APPLEDRI);
}
static napi_value AppleCreateContext(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleCreateContext: " NO_APPLEDRI);
}
static napi_value AppleMakeCurrent(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleMakeCurrent: " NO_APPLEDRI);
}
static napi_value AppleAttach(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleAttach: " NO_APPLEDRI);
}
static napi_value AppleFlush(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleFlush: " NO_APPLEDRI);
}
static napi_value AppleUpdate(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleUpdate: " NO_APPLEDRI);
}
static napi_value AppleSetSwapInterval(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleSetSwapInterval: " NO_APPLEDRI);
}
static napi_value AppleDestroyContext(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleDestroyContext: " NO_APPLEDRI);
}
static napi_value AppleCreateTarget(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleCreateTarget: " NO_APPLEDRI);
}
static napi_value AppleBindTarget(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleBindTarget: " NO_APPLEDRI);
}
static napi_value AppleTargetInfo(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleTargetInfo: " NO_APPLEDRI);
}
static napi_value AppleDestroyTarget(napi_env env, napi_callback_info info) {
    (void)info; THROW(env, "appleDestroyTarget: " NO_APPLEDRI);
}

#endif // __APPLE__

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

// A mapping of a dma-buf somebody else allocated. Two owners can outlive
// each other in either order — the ArrayBuffer handed to JS, and the handle
// that close() unmaps through — so the mapping is refcounted and whichever
// goes last gives the address space back.
typedef struct {
    void *addr;
    size_t len;
    int unmapped;
    int refs;
} Mapping;

static void mapping_unref(Mapping *m) {
    if (--m->refs > 0)
        return;
    if (!m->unmapped)
        munmap(m->addr, m->len);
    free(m);
}
static void mapping_ab_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)data;
    mapping_unref(hint);
}
static void mapping_ext_finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    mapping_unref(data);
}

// mapDmabuf(fd, size) -> { handle, buffer, size }
// The CPU side of a descriptor that arrived from elsewhere: DRI3
// BufferFromPixmap, or the udmabuf another process made. The fd is only
// read, never taken — the caller still owns it and can still send it on.
// Only exporters that implement mmap can be mapped at all (udmabuf, dumb
// and linear buffers do; most tiled GPU allocations do not), which is what
// the errno on failure is saying.
static napi_value MapDmabuf(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    int fd = arg_i32(env, args[0]);
    double want = arg_f64(env, args[1]);
    if (!(want > 0) || want > (double)SIZE_MAX)
        THROW(env, "mapDmabuf: size must be a positive number of bytes");
    size_t len = (size_t)want;

    void *addr = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (addr == MAP_FAILED)
        THROWF(env, "mmap of dma-buf failed: %s (not every exporter implements "
                    "mmap — tiled GPU buffers generally do not)", strerror(errno));

    Mapping *m = calloc(1, sizeof(Mapping));
    m->addr = addr;
    m->len = len;
    m->refs = 2; // the ArrayBuffer and the handle

    napi_value obj, ab, ext;
    NAPI_CALL(env, napi_create_object(env, &obj));
    NAPI_CALL(env, napi_create_external_arraybuffer(env, addr, len,
        mapping_ab_finalize, m, &ab));
    NAPI_CALL(env, napi_create_external(env, m, mapping_ext_finalize, NULL, &ext));
    obj_set(env, obj, "handle", ext);
    obj_set(env, obj, "buffer", ab);
    napi_value size_v; // a foreign buffer can be larger than a uint32 holds
    NAPI_CALL(env, napi_create_double(env, (double)len, &size_v));
    obj_set(env, obj, "size", size_v);
    return obj;
}

// unmapDmabuf(handle, buffer) — give the address space back now rather than
// at the next GC. The ArrayBuffer is detached first, so a TypedArray still
// held over it reads as empty instead of as freed memory.
static napi_value UnmapDmabuf(napi_env env, napi_callback_info info) {
    GET_ARGS(env, info, 2);
    Mapping *m;
    if (!get_external(env, args[0], (void **)&m)) return NULL;
    if (m->unmapped)
        return NULL;
    if (napi_detach_arraybuffer(env, args[1]) != napi_ok)
        THROW(env, "close(): the buffer would not detach, so the mapping is "
                   "left for the garbage collector to release");
    munmap(m->addr, m->len);
    m->unmapped = 1;
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
static napi_value MapDmabuf(napi_env env, napi_callback_info info) {
    (void)info;
    THROW(env, "mapDmabuf: " NO_DMABUF);
}
static napi_value UnmapDmabuf(napi_env env, napi_callback_info info) {
    (void)info;
    THROW(env, "unmapDmabuf: " NO_DMABUF);
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
#if defined(__APPLE__)
    // The XQuartz direct-rendering client pieces: libXplugin + CGL. True
    // means they load — whether the WindowServer will talk to this process
    // (a GUI session, not SSH) is settled by appleClientId().
    e = load_apple();
    obj_set(env, obj, "appledri", e ? mk_str(env, e) : mk_bool(env, true));
#else
    obj_set(env, obj, "appledri", mk_str(env, NO_APPLEDRI));
#endif
#if HAVE_DMABUF
    obj_set(env, obj, "udmabuf", mk_bool(env, access("/dev/udmabuf", W_OK) == 0));
    // The import extensions belong to an initialized EGLDisplay, which this
    // report deliberately does not create (probe() opens no devices). So the
    // honest answer here is where to look for the real one.
    obj_set(env, obj, "dmabufImport", mk_str(env,
        "an EGL display extension — read gpu.features.dmabufImport "
        "after makeCurrent()"));
#else
    obj_set(env, obj, "udmabuf", mk_str(env, NO_DMABUF));
    obj_set(env, obj, "dmabufImport", mk_str(env, NO_DMABUF));
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
    EXPORT("mapDmabuf", MapDmabuf);
    EXPORT("unmapDmabuf", UnmapDmabuf);
    EXPORT("importDmabuf", ImportDmabuf);
    EXPORT("destroyImportedImage", DestroyImportedImage);

    EXPORT("createGpu", CreateGpu);
    EXPORT("gpuInfo", GpuInfo);
    EXPORT("createSurface", CreateSurface);
    EXPORT("makeCurrent", MakeCurrent);
    EXPORT("swapBuffers", SwapBuffers);
    EXPORT("releaseBuffer", ReleaseBuffer);
    EXPORT("destroySurface", DestroySurface);
    EXPORT("destroyGpu", DestroyGpu);

    EXPORT("appleClientId", AppleClientId);
    EXPORT("appleRefreshRate", AppleRefreshRate);
    EXPORT("appleCreateContext", AppleCreateContext);
    EXPORT("appleCreateTarget", AppleCreateTarget);
    EXPORT("appleBindTarget", AppleBindTarget);
    EXPORT("appleTargetInfo", AppleTargetInfo);
    EXPORT("appleDestroyTarget", AppleDestroyTarget);
    EXPORT("appleAttach", AppleAttach);
    EXPORT("appleMakeCurrent", AppleMakeCurrent);
    EXPORT("appleFlush", AppleFlush);
    EXPORT("appleUpdate", AppleUpdate);
    EXPORT("appleSetSwapInterval", AppleSetSwapInterval);
    EXPORT("appleDestroyContext", AppleDestroyContext);

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

    EXPORT("glCreateTexture", Gl_createTexture);
    EXPORT("glDeleteTexture", Gl_deleteTexture);
    EXPORT("glBindTexture", Gl_bindTexture);
    EXPORT("glActiveTexture", Gl_activeTexture);
    EXPORT("glTexImage2D", Gl_texImage2D);
    EXPORT("glTexSubImage2D", Gl_texSubImage2D);
    EXPORT("glTexParameteri", Gl_texParameteri);
    EXPORT("glTexParameterf", Gl_texParameterf);
    EXPORT("glGenerateMipmap", Gl_generateMipmap);

    EXPORT("glBlendFunc", Gl_blendFunc);
    EXPORT("glBlendFuncSeparate", Gl_blendFuncSeparate);
    EXPORT("glBlendEquation", Gl_blendEquation);
    EXPORT("glBlendEquationSeparate", Gl_blendEquationSeparate);
    EXPORT("glBlendColor", Gl_blendColor);
    EXPORT("glDepthMask", Gl_depthMask);
    EXPORT("glDepthRange", Gl_depthRange);
    EXPORT("glColorMask", Gl_colorMask);
    EXPORT("glScissor", Gl_scissor);
    EXPORT("glPolygonOffset", Gl_polygonOffset);
    EXPORT("glStencilFunc", Gl_stencilFunc);
    EXPORT("glStencilOp", Gl_stencilOp);
    EXPORT("glStencilMask", Gl_stencilMask);
    EXPORT("glClearStencil", Gl_clearStencil);

    EXPORT("glUniform2f", Gl_uniform2f);
    EXPORT("glUniform2i", Gl_uniform2i);
    EXPORT("glUniform3i", Gl_uniform3i);
    EXPORT("glUniform4i", Gl_uniform4i);
    EXPORT("glUniform1fv", Gl_uniform1fv);
    EXPORT("glUniform2fv", Gl_uniform2fv);
    EXPORT("glUniform3fv", Gl_uniform3fv);
    EXPORT("glUniform4fv", Gl_uniform4fv);
    EXPORT("glUniform1iv", Gl_uniform1iv);
    EXPORT("glUniformMatrix2fv", Gl_uniformMatrix2fv);
    EXPORT("glUniformMatrix3fv", Gl_uniformMatrix3fv);

    EXPORT("glDisableVertexAttribArray", Gl_disableVertexAttribArray);
    EXPORT("glBindAttribLocation", Gl_bindAttribLocation);
    EXPORT("glVertexAttrib1f", Gl_vertexAttrib1f);
    EXPORT("glVertexAttrib2f", Gl_vertexAttrib2f);
    EXPORT("glVertexAttrib3f", Gl_vertexAttrib3f);
    EXPORT("glVertexAttrib4f", Gl_vertexAttrib4f);
    EXPORT("glBufferSubData", Gl_bufferSubData);

    EXPORT("glCreateFramebuffer", Gl_createFramebuffer);
    EXPORT("glDeleteFramebuffer", Gl_deleteFramebuffer);
    EXPORT("glBindFramebuffer", Gl_bindFramebuffer);
    EXPORT("glFramebufferTexture2D", Gl_framebufferTexture2D);
    EXPORT("glFramebufferRenderbuffer", Gl_framebufferRenderbuffer);
    EXPORT("glCheckFramebufferStatus", Gl_checkFramebufferStatus);
    EXPORT("glCreateRenderbuffer", Gl_createRenderbuffer);
    EXPORT("glDeleteRenderbuffer", Gl_deleteRenderbuffer);
    EXPORT("glBindRenderbuffer", Gl_bindRenderbuffer);
    EXPORT("glRenderbufferStorage", Gl_renderbufferStorage);

    EXPORT("glGetParameter", Gl_getParameter);
    EXPORT("glGetIntegerv", Gl_getIntegerv);
    EXPORT("glGetFloatv", Gl_getFloatv);
    EXPORT("glGetBooleanv", Gl_getBooleanv);

    EXPORT("glCompressedTexImage2D", Gl_compressedTexImage2D);
    EXPORT("glCompressedTexSubImage2D", Gl_compressedTexSubImage2D);

    EXPORT("glGetActiveUniform", Gl_getActiveUniform);
    EXPORT("glGetActiveAttrib", Gl_getActiveAttrib);
    EXPORT("glGetUniformfv", Gl_getUniformfv);
    EXPORT("glGetUniformiv", Gl_getUniformiv);
    EXPORT("glGetVertexAttrib", Gl_getVertexAttrib);
    EXPORT("glGetVertexAttribOffset", Gl_getVertexAttribOffset);
    EXPORT("glGetBufferParameter", Gl_getBufferParameter);
    EXPORT("glGetTexParameter", Gl_getTexParameter);
    EXPORT("glGetFramebufferAttachmentParameter", Gl_getFramebufferAttachmentParameter);
    EXPORT("glGetRenderbufferParameter", Gl_getRenderbufferParameter);
    EXPORT("glGetAttachedShaders", Gl_getAttachedShaders);
    EXPORT("glGetShaderPrecisionFormat", Gl_getShaderPrecisionFormat);
    EXPORT("glGetShaderSource", Gl_getShaderSource);
    EXPORT("glValidateProgram", Gl_validateProgram);
    EXPORT("glIsBuffer", Gl_isBuffer);
    EXPORT("glIsEnabled", Gl_isEnabled);
    EXPORT("glIsFramebuffer", Gl_isFramebuffer);
    EXPORT("glIsProgram", Gl_isProgram);
    EXPORT("glIsRenderbuffer", Gl_isRenderbuffer);
    EXPORT("glIsShader", Gl_isShader);
    EXPORT("glIsTexture", Gl_isTexture);

    EXPORT("glCreateVertexArray", Gl_createVertexArray);
    EXPORT("glDeleteVertexArray", Gl_deleteVertexArray);
    EXPORT("glBindVertexArray", Gl_bindVertexArray);
    EXPORT("glIsVertexArray", Gl_isVertexArray);
    EXPORT("glDrawArraysInstanced", Gl_drawArraysInstanced);
    EXPORT("glDrawElementsInstanced", Gl_drawElementsInstanced);
    EXPORT("glVertexAttribDivisor", Gl_vertexAttribDivisor);
    EXPORT("glDrawBuffers", Gl_drawBuffers);
    EXPORT("glTexImage3D", Gl_texImage3D);
    EXPORT("glTexSubImage3D", Gl_texSubImage3D);
    EXPORT("glCopyTexSubImage3D", Gl_copyTexSubImage3D);
    EXPORT("glCompressedTexImage3D", Gl_compressedTexImage3D);
    EXPORT("glCompressedTexSubImage3D", Gl_compressedTexSubImage3D);
    EXPORT("glFramebufferTextureLayer", Gl_framebufferTextureLayer);
    EXPORT("glTexStorage2D", Gl_texStorage2D);
    EXPORT("glTexStorage3D", Gl_texStorage3D);
    EXPORT("glGetFeatures", GlFeatures);
#undef EXPORT
    return exports;
}
