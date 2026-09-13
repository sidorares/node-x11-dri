'use strict';

// x11-dri: optional native companion to the pure-JS `x11` package.
//
// Gives a Node script the two things the X protocol alone cannot:
//   - a real GPU OpenGL ES 2.0 context (GBM + EGL, dlopen'd at runtime)
//     whose frames are exportable as dma-buf fds, and
//   - dma-buf utilities (udmabuf CPU buffers, DMA_BUF sync, dup).
//
// The fds go to the X server through the x11 package's DRI3 extension
// (X.require('dri3') -> PixmapFromBuffer) and on screen with Present.
// See https://github.com/sidorares/node-x11/blob/master/examples/dri3/cube.js
// for the complete picture.

const fs = require('fs');
const path = require('path');

// A local build wins (dev iteration), then the prebuilt binary bundled in
// the npm tarball for this platform/arch (see scripts/install.js — the
// package works even when install scripts are disabled), then a clear error.
function loadNative() {
    const candidates = [
        'build/Release/x11dri.node',
        'build/Debug/x11dri.node',
        `prebuilds/${process.platform}-${process.arch}/x11dri.node`
    ];
    const errors = [];
    for (const rel of candidates) {
        const abs = path.join(__dirname, rel);
        if (!fs.existsSync(abs))
            continue;
        try {
            return require(abs);
        } catch (e) {
            errors.push(`  ${rel}: ${e.message}`);
        }
    }
    throw new Error(
        `x11-dri: no loadable native binary for ${process.platform}-${process.arch}\n` +
        (errors.length ? `tried:\n${errors.join('\n')}\n` : '') +
        'rebuild with: npm rebuild x11-dri --build-from-source (needs a C toolchain)');
}

const native = loadNative();

// ---- OpenGL ES 2.0 constants (the subset the bindings cover) ----
const GL = {
    DEPTH_BUFFER_BIT: 0x0100,
    COLOR_BUFFER_BIT: 0x4000,
    POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3,
    TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, BLEND: 0x0BE2,
    SCISSOR_TEST: 0x0C11, DITHER: 0x0BD0,
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203,
    GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
    FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
    CW: 0x0900, CCW: 0x0901,
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
    INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
    RGBA: 0x1908, RGB: 0x1907, ALPHA: 0x1906,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
    STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
    FRAGMENT_SHADER: 0x8B30, VERTEX_SHADER: 0x8B31,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, INFO_LOG_LENGTH: 0x8B84,
    UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0D05,
    NO_ERROR: 0,
    VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02,
    SHADING_LANGUAGE_VERSION: 0x8B8C,

    // errors, so a getError() result can be named rather than printed in hex
    INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502,
    OUT_OF_MEMORY: 0x0505, INVALID_FRAMEBUFFER_OPERATION: 0x0506,

    // textures
    TEXTURE_2D: 0x0DE1, TEXTURE: 0x1702,
    TEXTURE_CUBE_MAP: 0x8513,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
    TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517, TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
    TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
    // GL_OES_EGL_image_external — the target an imported multi-planar or YUV
    // dma-buf binds to (features.dmabufImportExternal), read in GLSL through
    // a samplerExternalOES rather than a sampler2D.
    TEXTURE_EXTERNAL_OES: 0x8D65, TEXTURE_BINDING_EXTERNAL_OES: 0x8D67,
    SAMPLER_EXTERNAL_OES: 0x8D66,
    TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, TEXTURE2: 0x84C2, TEXTURE3: 0x84C3,
    TEXTURE4: 0x84C4, TEXTURE5: 0x84C5, TEXTURE6: 0x84C6, TEXTURE7: 0x84C7,
    ACTIVE_TEXTURE: 0x84E0,
    TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600, LINEAR: 0x2601,
    NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
    NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
    REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
    LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A,
    UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034,
    UNSIGNED_SHORT_5_6_5: 0x8363,
    MAX_TEXTURE_SIZE: 0x0D33, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,

    // blending
    ZERO: 0, ONE: 1,
    SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301,
    SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
    DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307,
    SRC_ALPHA_SATURATE: 0x0308,
    CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002,
    CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004,
    BLEND_COLOR: 0x8005,
    FUNC_ADD: 0x8006, FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,

    // stencil
    STENCIL_BUFFER_BIT: 0x0400, STENCIL_TEST: 0x0B90,
    KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03,
    INVERT: 0x150A, INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
    // the stencil state getParameter reads back — front-facing (and the
    // one-facing setters') first, then the back-facing copy the *Separate
    // setters can make differ
    STENCIL_FUNC: 0x0B92, STENCIL_REF: 0x0B97, STENCIL_VALUE_MASK: 0x0B93,
    STENCIL_FAIL: 0x0B94, STENCIL_PASS_DEPTH_FAIL: 0x0B95,
    STENCIL_PASS_DEPTH_PASS: 0x0B96, STENCIL_WRITEMASK: 0x0B98,
    STENCIL_CLEAR_VALUE: 0x0B91,
    STENCIL_BACK_FUNC: 0x8800, STENCIL_BACK_REF: 0x8CA3,
    STENCIL_BACK_VALUE_MASK: 0x8CA4, STENCIL_BACK_FAIL: 0x8801,
    STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802, STENCIL_BACK_PASS_DEPTH_PASS: 0x8803,
    STENCIL_BACK_WRITEMASK: 0x8CA5,

    // framebuffer and renderbuffer objects
    FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41,
    COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
    STENCIL_ATTACHMENT: 0x8D20, DEPTH_STENCIL_ATTACHMENT: 0x821A,
    FRAMEBUFFER_COMPLETE: 0x8CD5,
    FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
    FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
    FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9,
    FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
    DEPTH_COMPONENT16: 0x81A5, STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9,
    RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62,
    MAX_RENDERBUFFER_SIZE: 0x84E8,

    // state a draw loop reads back
    VIEWPORT: 0x0BA2, SCISSOR_BOX: 0x0C10,
    COLOR_CLEAR_VALUE: 0x0C22, COLOR_WRITEMASK: 0x0C23,
    DEPTH_CLEAR_VALUE: 0x0B73, DEPTH_WRITEMASK: 0x0B72,
    LINE_WIDTH: 0x0B21,
    POLYGON_OFFSET_FILL: 0x8037,
    POLYGON_OFFSET_FACTOR: 0x8038, POLYGON_OFFSET_UNITS: 0x2A00,
    SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0,
    MAX_VERTEX_ATTRIBS: 0x8869, MAX_VARYING_VECTORS: 0x8DFC,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
    VALIDATE_STATUS: 0x8B83, DELETE_STATUS: 0x8B80, SHADER_TYPE: 0x8B4F,

    // the types getActiveUniform/getActiveAttrib report
    FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52,
    INT_VEC2: 0x8B53, INT_VEC3: 0x8B54, INT_VEC4: 0x8B55,
    BOOL: 0x8B56, BOOL_VEC2: 0x8B57, BOOL_VEC3: 0x8B58, BOOL_VEC4: 0x8B59,
    FLOAT_MAT2: 0x8B5A, FLOAT_MAT3: 0x8B5B, FLOAT_MAT4: 0x8B5C,
    SAMPLER_2D: 0x8B5E, SAMPLER_CUBE: 0x8B60,

    // program and shader properties
    ACTIVE_UNIFORMS: 0x8B86, ACTIVE_UNIFORM_MAX_LENGTH: 0x8B87,
    ACTIVE_ATTRIBUTES: 0x8B89, ACTIVE_ATTRIBUTE_MAX_LENGTH: 0x8B8A,
    ATTACHED_SHADERS: 0x8B85, SHADER_SOURCE_LENGTH: 0x8B88,
    SHADER_COMPILER: 0x8DFA,
    LOW_FLOAT: 0x8DF0, MEDIUM_FLOAT: 0x8DF1, HIGH_FLOAT: 0x8DF2,
    LOW_INT: 0x8DF3, MEDIUM_INT: 0x8DF4, HIGH_INT: 0x8DF5,

    // vertex attribute state, for getVertexAttrib
    VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623,
    VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624, VERTEX_ATTRIB_ARRAY_TYPE: 0x8625,
    VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886A,
    VERTEX_ATTRIB_ARRAY_POINTER: 0x8645,
    VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889F,
    CURRENT_VERTEX_ATTRIB: 0x8626,

    // what is bound, and what the bound thing is made of
    ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
    FRAMEBUFFER_BINDING: 0x8CA6, RENDERBUFFER_BINDING: 0x8CA7,
    CURRENT_PROGRAM: 0x8B8D,
    TEXTURE_BINDING_2D: 0x8069, TEXTURE_BINDING_CUBE_MAP: 0x8514,
    BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765,
    FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0,
    FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8CD1,
    FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8CD2,
    FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8CD3,
    RENDERBUFFER_WIDTH: 0x8D42, RENDERBUFFER_HEIGHT: 0x8D43,
    RENDERBUFFER_INTERNAL_FORMAT: 0x8D44,
    RENDERBUFFER_RED_SIZE: 0x8D50, RENDERBUFFER_GREEN_SIZE: 0x8D51,
    RENDERBUFFER_BLUE_SIZE: 0x8D52, RENDERBUFFER_ALPHA_SIZE: 0x8D53,
    RENDERBUFFER_DEPTH_SIZE: 0x8D54, RENDERBUFFER_STENCIL_SIZE: 0x8D55,

    // compressed textures. The entry points are core ES 2.0 but every format
    // below is an extension: check getSupportedExtensions() or
    // getParameter(COMPRESSED_TEXTURE_FORMATS) before uploading one.
    EXTENSIONS: 0x1F03,
    NUM_COMPRESSED_TEXTURE_FORMATS: 0x86A2, COMPRESSED_TEXTURE_FORMATS: 0x86A3,
    ETC1_RGB8_OES: 0x8D64,
    COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83F0, COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83F1,
    COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83F2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83F3,
    COMPRESSED_R11_EAC: 0x9270, COMPRESSED_SIGNED_R11_EAC: 0x9271,
    COMPRESSED_RG11_EAC: 0x9272, COMPRESSED_SIGNED_RG11_EAC: 0x9273,
    COMPRESSED_RGB8_ETC2: 0x9274, COMPRESSED_SRGB8_ETC2: 0x9275,
    COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276,
    COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277,
    COMPRESSED_RGBA8_ETC2_EAC: 0x9278, COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
    COMPRESSED_RGBA_ASTC_4x4_KHR: 0x93B0, COMPRESSED_RGBA_ASTC_5x4_KHR: 0x93B1,
    COMPRESSED_RGBA_ASTC_5x5_KHR: 0x93B2, COMPRESSED_RGBA_ASTC_6x5_KHR: 0x93B3,
    COMPRESSED_RGBA_ASTC_6x6_KHR: 0x93B4, COMPRESSED_RGBA_ASTC_8x5_KHR: 0x93B5,
    COMPRESSED_RGBA_ASTC_8x6_KHR: 0x93B6, COMPRESSED_RGBA_ASTC_8x8_KHR: 0x93B7,
    COMPRESSED_RGBA_ASTC_10x5_KHR: 0x93B8, COMPRESSED_RGBA_ASTC_10x6_KHR: 0x93B9,
    COMPRESSED_RGBA_ASTC_10x8_KHR: 0x93BA, COMPRESSED_RGBA_ASTC_10x10_KHR: 0x93BB,
    COMPRESSED_RGBA_ASTC_12x10_KHR: 0x93BC, COMPRESSED_RGBA_ASTC_12x12_KHR: 0x93BD,

    // vertex array objects, instancing and multiple render targets. These
    // three are core in ES 3.0 and extensions before it, so the entry points
    // may be missing — gpu.features says which of them this driver has.
    VERTEX_ARRAY_BINDING: 0x85B5,
    VERTEX_ATTRIB_ARRAY_DIVISOR: 0x88FE,
    MAX_DRAW_BUFFERS: 0x8824, MAX_COLOR_ATTACHMENTS: 0x8CDF, NONE: 0,
    DRAW_BUFFER0: 0x8825, DRAW_BUFFER1: 0x8826, DRAW_BUFFER2: 0x8827,
    DRAW_BUFFER3: 0x8828, DRAW_BUFFER4: 0x8829, DRAW_BUFFER5: 0x882A,
    DRAW_BUFFER6: 0x882B, DRAW_BUFFER7: 0x882C,
    COLOR_ATTACHMENT1: 0x8CE1, COLOR_ATTACHMENT2: 0x8CE2,
    COLOR_ATTACHMENT3: 0x8CE3, COLOR_ATTACHMENT4: 0x8CE4,
    COLOR_ATTACHMENT5: 0x8CE5, COLOR_ATTACHMENT6: 0x8CE6,
    COLOR_ATTACHMENT7: 0x8CE7,

    // ---- ES 3.0 textures ----
    // 3D and array textures differ only in the target: TEXTURE_3D filters
    // across the third axis, TEXTURE_2D_ARRAY keeps its layers independent.
    TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A,
    TEXTURE_BINDING_3D: 0x806A, TEXTURE_BINDING_2D_ARRAY: 0x8C1D,
    TEXTURE_WRAP_R: 0x8072,
    TEXTURE_BASE_LEVEL: 0x813C, TEXTURE_MAX_LEVEL: 0x813D,
    TEXTURE_MIN_LOD: 0x813A, TEXTURE_MAX_LOD: 0x813B,
    TEXTURE_COMPARE_MODE: 0x884C, TEXTURE_COMPARE_FUNC: 0x884D,
    COMPARE_REF_TO_TEXTURE: 0x884E,
    TEXTURE_IMMUTABLE_FORMAT: 0x912F,
    MAX_3D_TEXTURE_SIZE: 0x8073, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
    MAX_ELEMENTS_VERTICES: 0x80E8, MAX_ELEMENTS_INDICES: 0x80E9,

    // the pixel-store state a 3D upload needs to walk a subrectangle
    UNPACK_ROW_LENGTH: 0x0CF2, UNPACK_SKIP_ROWS: 0x0CF3,
    UNPACK_SKIP_PIXELS: 0x0CF4, UNPACK_IMAGE_HEIGHT: 0x806E,
    UNPACK_SKIP_IMAGES: 0x806D,
    PACK_ROW_LENGTH: 0x0D02, PACK_SKIP_ROWS: 0x0D03, PACK_SKIP_PIXELS: 0x0D04,

    // formats and types new in ES 3.0
    RED: 0x1903, RG: 0x8227, DEPTH_COMPONENT: 0x1902,
    RED_INTEGER: 0x8D94, RG_INTEGER: 0x8228,
    RGB_INTEGER: 0x8D98, RGBA_INTEGER: 0x8D99,
    HALF_FLOAT: 0x140B,
    UNSIGNED_INT_2_10_10_10_REV: 0x8368,
    UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B, UNSIGNED_INT_5_9_9_9_REV: 0x8C3E,
    UNSIGNED_INT_24_8: 0x84FA, FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8DAD,

    // sized internal formats — texStorage takes only these, and texImage3D
    // wants them too whenever the type is not a plain UNSIGNED_BYTE
    R8: 0x8229, RG8: 0x822B, RGB8: 0x8051, RGBA8: 0x8058,
    SRGB8: 0x8C41, SRGB8_ALPHA8: 0x8C43, RGB10_A2: 0x8059,
    R16F: 0x822D, RG16F: 0x822F, RGB16F: 0x881B, RGBA16F: 0x881A,
    R32F: 0x822E, RG32F: 0x8230, RGB32F: 0x8815, RGBA32F: 0x8814,
    R11F_G11F_B10F: 0x8C3A, RGB9_E5: 0x8C3D,
    R8UI: 0x8232, R8I: 0x8231, RG8UI: 0x8238, RG8I: 0x8237,
    RGBA8UI: 0x8D7C, RGBA8I: 0x8D8E,
    RGBA16UI: 0x8D76, RGBA16I: 0x8D88, RGBA32UI: 0x8D70, RGBA32I: 0x8D82,
    DEPTH_COMPONENT24: 0x81A6, DEPTH_COMPONENT32F: 0x8CAC,
    DEPTH24_STENCIL8: 0x88F0, DEPTH32F_STENCIL8: 0x8CAD,

    // the sampler types getActiveUniform can now report
    SAMPLER_3D: 0x8B5F, SAMPLER_2D_ARRAY: 0x8DC1,
    SAMPLER_2D_SHADOW: 0x8B62, SAMPLER_2D_ARRAY_SHADOW: 0x8DC4,
    SAMPLER_CUBE_SHADOW: 0x8DC5,
    INT_SAMPLER_2D: 0x8DCA, INT_SAMPLER_3D: 0x8DCB,
    INT_SAMPLER_CUBE: 0x8DCC, INT_SAMPLER_2D_ARRAY: 0x8DCF,
    UNSIGNED_INT_SAMPLER_2D: 0x8DD2, UNSIGNED_INT_SAMPLER_3D: 0x8DD3,
    UNSIGNED_INT_SAMPLER_CUBE: 0x8DD4, UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8DD7,
    FLOAT_MAT2x3: 0x8B65, FLOAT_MAT2x4: 0x8B66,
    FLOAT_MAT3x2: 0x8B67, FLOAT_MAT3x4: 0x8B68,
    FLOAT_MAT4x2: 0x8B69, FLOAT_MAT4x3: 0x8B6A,

    // ---- multisampling, blits and the read buffer ----
    // (features.multisample, features.readBuffer)
    READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
    READ_FRAMEBUFFER_BINDING: 0x8CAA, DRAW_FRAMEBUFFER_BINDING: 0x8CA6,
    MAX_SAMPLES: 0x8D57, SAMPLES: 0x80A9, SAMPLE_BUFFERS: 0x80A8,
    RENDERBUFFER_SAMPLES: 0x8CAB, FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: 0x8D56,
    READ_BUFFER: 0x0C02,

    // ---- sync objects (features.sync) ----
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, SYNC_FLUSH_COMMANDS_BIT: 0x00000001,
    ALREADY_SIGNALED: 0x911A, TIMEOUT_EXPIRED: 0x911B,
    CONDITION_SATISFIED: 0x911C, WAIT_FAILED: 0x911D,
    OBJECT_TYPE: 0x9112, SYNC_CONDITION: 0x9113, SYNC_STATUS: 0x9114,
    SYNC_FLAGS: 0x9115, SYNC_FENCE: 0x9116,
    UNSIGNALED: 0x9118, SIGNALED: 0x9119,
    // GL's value is 2^64 - 1, which a Number cannot hold; WebGL 2 spells it
    // -1, and so do the wrappers
    TIMEOUT_IGNORED: -1,

    // ---- query objects, for the GPU timers ----
    // (features.timerQuery, features.timestampQuery). The WebGL extension
    // spells the first three with an _EXT suffix; the values are the same.
    // GPU_DISJOINT_EXT has no other name: only the ES extension has it.
    TIME_ELAPSED: 0x88BF, TIMESTAMP: 0x8E28, QUERY_COUNTER_BITS: 0x8864,
    CURRENT_QUERY: 0x8865, QUERY_RESULT: 0x8866, QUERY_RESULT_AVAILABLE: 0x8867,
    GPU_DISJOINT_EXT: 0x8FBB
};

// WebGL-flavored view over the flat native functions ("gl.clearColor" etc).
const gl = {};
for (const k of Object.keys(native)) {
    if (k.startsWith('gl')) {
        const name = k[2].toLowerCase() + k.slice(3);
        gl[name] = native[k];
    }
}
Object.assign(gl, GL);

// The component count and reading of every uniform type ES 2.0 can declare:
// [components, 'f'loat | 'i'nt | 'b'ool].
const UNIFORM_SHAPE = {
    [GL.FLOAT]: [1, 'f'],
    [GL.FLOAT_VEC2]: [2, 'f'], [GL.FLOAT_VEC3]: [3, 'f'], [GL.FLOAT_VEC4]: [4, 'f'],
    [GL.FLOAT_MAT2]: [4, 'f'], [GL.FLOAT_MAT3]: [9, 'f'], [GL.FLOAT_MAT4]: [16, 'f'],
    [GL.INT]: [1, 'i'],
    [GL.INT_VEC2]: [2, 'i'], [GL.INT_VEC3]: [3, 'i'], [GL.INT_VEC4]: [4, 'i'],
    [GL.BOOL]: [1, 'b'],
    [GL.BOOL_VEC2]: [2, 'b'], [GL.BOOL_VEC3]: [3, 'b'], [GL.BOOL_VEC4]: [4, 'b'],
    [GL.SAMPLER_2D]: [1, 'i'], [GL.SAMPLER_CUBE]: [1, 'i'],
    [GL.SAMPLER_EXTERNAL_OES]: [1, 'i'],
    // ES 3.0 adds non-square matrices and a longer list of sampler types;
    // samplers are all texture units, so all read back as one int.
    [GL.FLOAT_MAT2x3]: [6, 'f'], [GL.FLOAT_MAT2x4]: [8, 'f'],
    [GL.FLOAT_MAT3x2]: [6, 'f'], [GL.FLOAT_MAT3x4]: [12, 'f'],
    [GL.FLOAT_MAT4x2]: [8, 'f'], [GL.FLOAT_MAT4x3]: [12, 'f'],
    [GL.SAMPLER_3D]: [1, 'i'], [GL.SAMPLER_2D_ARRAY]: [1, 'i'],
    [GL.SAMPLER_2D_SHADOW]: [1, 'i'], [GL.SAMPLER_2D_ARRAY_SHADOW]: [1, 'i'],
    [GL.SAMPLER_CUBE_SHADOW]: [1, 'i'],
    [GL.INT_SAMPLER_2D]: [1, 'i'], [GL.INT_SAMPLER_3D]: [1, 'i'],
    [GL.INT_SAMPLER_CUBE]: [1, 'i'], [GL.INT_SAMPLER_2D_ARRAY]: [1, 'i'],
    [GL.UNSIGNED_INT_SAMPLER_2D]: [1, 'i'], [GL.UNSIGNED_INT_SAMPLER_3D]: [1, 'i'],
    [GL.UNSIGNED_INT_SAMPLER_CUBE]: [1, 'i'],
    [GL.UNSIGNED_INT_SAMPLER_2D_ARRAY]: [1, 'i']
};

// WebGL's getUniform(program, location). GL will write as many components as
// the uniform has and offers no way to ask how many that is, so the raw
// getUniformfv/getUniformiv take a count — and only the program knows it.
// Finding the uniform means walking its active uniforms for the one whose
// location matches, freshly each call: a cache would go stale the moment the
// program is relinked, and this is a debug-path call where that trade runs
// the wrong way.
function getUniform(program, location) {
    if (location == null || location < 0)
        return null;
    const count = gl.getProgramParameter(program, GL.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        const shape = info && UNIFORM_SHAPE[info.type];
        if (!shape)
            continue;
        // An array uniform is reported once, as "u[0]" with size N, but every
        // element has a location of its own.
        const base = info.name.replace(/\[0\]$/, '');
        for (let e = 0; e < info.size; e++) {
            const name = info.size > 1 ? `${base}[${e}]` : base;
            if (gl.getUniformLocation(program, name) !== location)
                continue;
            const [n, kind] = shape;
            const raw = kind === 'f' ? gl.getUniformfv(program, location, n)
                                     : gl.getUniformiv(program, location, n);
            if (kind === 'b')
                return n === 1 ? raw[0] !== 0 : raw.map(v => v !== 0);
            if (n === 1)
                return raw[0];
            return kind === 'f' ? Float32Array.from(raw) : Int32Array.from(raw);
        }
    }
    return null;
}

// The driver's extension list, split — which is how you find out whether a
// compressed format, or anything else optional, is there to be used.
function getSupportedExtensions() {
    return gl.getString(GL.EXTENSIONS).split(/\s+/).filter(Boolean);
}

// A dma-buf someone else allocated, bound to a texture. `texture` is an
// ordinary GL name — bind it to `target` and sample it — and `destroy()`
// drops both it and the EGLImage behind it.
class ImportedImage {
    constructor(res) {
        this._handle = res.handle;
        this.texture = res.texture;
        this.target = res.target;
    }
    destroy() {
        native.destroyImportedImage(this._handle);
    }
}

// Import a dma-buf as a texture: the mirror of Surface.swap()'s export, and
// the last step of the compositor path (Composite.NameWindowPixmap ->
// DRI3.BuffersFromPixmap -> here), which is why the plane shape is exactly
// what BuffersFromPixmap replies with.
//
// opts: { width, height, fourcc, modifier?, target?, planes: [{ fd, stride,
// offset }] }. The descriptors are consumed on success and left open on
// failure. Needs a current context whose driver has the import extension —
// gpu.features.dmabufImport says whether it does.
function importDmabuf(opts) {
    opts = opts || {};
    if (!(opts.width > 0) || !(opts.height > 0))
        throw new TypeError('importDmabuf: width and height are required');
    if (typeof opts.fourcc !== 'number')
        throw new TypeError('importDmabuf: fourcc is required — a DRM format code'
            + ' such as FORMAT.XRGB8888');
    const planes = opts.planes;
    if (!Array.isArray(planes) || planes.length < 1 || planes.length > 4)
        throw new TypeError('importDmabuf: planes must be an array of 1 to 4'
            + ' { fd, stride, offset }');
    const fds = [], offsets = [], strides = [];
    planes.forEach((p, i) => {
        if (!p || typeof p.fd !== 'number' || typeof p.stride !== 'number')
            throw new TypeError(`importDmabuf: plane ${i} needs { fd, stride, offset? }`);
        fds.push(p.fd);
        offsets.push(p.offset || 0);
        strides.push(p.stride);
    });
    // MODIFIER.INVALID is how the export side spells "no explicit modifier",
    // and the extension has no attribute for that — so it means send none,
    // which is also what the plain (non-modifier) extension supports.
    let modifier = opts.modifier;
    if (modifier == null || modifier === MODIFIER.INVALID)
        modifier = null;
    else if (typeof modifier !== 'bigint')
        throw new TypeError('importDmabuf: modifier must be a BigInt'
            + ' (from MODIFIER, swap(), or a BuffersFromPixmap reply)');
    return new ImportedImage(native.importDmabuf(
        opts.width, opts.height, opts.fourcc, modifier, opts.target || 0,
        fds, offsets, strides));
}

gl.getUniform = getUniform;
gl.getSupportedExtensions = getSupportedExtensions;
gl.importDmabuf = importDmabuf;

// ---- buffer layout constants ----
const FORMAT = {
    XRGB8888: 0x34325258, // fourcc('X','R','2','4') — depth 24, bpp 32
    ARGB8888: 0x34325241  // fourcc('A','R','2','4') — depth 32, bpp 32
};

const GBM_USE = {
    SCANOUT: 1 << 0,
    RENDERING: 1 << 2,
    LINEAR: 1 << 4
};

const MODIFIER = {
    LINEAR: 0n,
    INVALID: (1n << 56n) - 1n
};

const DMABUF_SYNC = {
    READ: 1, WRITE: 2, RW: 3,
    START: 0, END: 1 << 2
};

// The GPU/dma-buf half of this package is Linux-only, and not for want of a
// port: it produces dma-buf descriptors for DRI3, and neither the buffer type
// nor the extension that consumes it exists elsewhere. On macOS the X server
// (XQuartz) offers Present but no DRI3 — see the README. Everything else in
// here (dup, probe) is portable, so `require('x11-dri')` stays safe to do
// from cross-platform code.
const DMABUF_PLATFORM = process.platform === 'linux';

// Render nodes need no authentication and no window system — the standard
// substitute for DRI3's Open request (whose fd-carrying reply a pure-JS
// client cannot receive; see x11's lib/ext/dri3.js).
function listRenderNodes() {
    let entries;
    try {
        entries = fs.readdirSync('/dev/dri');
    } catch {
        return [];
    }
    return entries.filter(e => e.startsWith('renderD'))
        .sort()
        .map(e => `/dev/dri/${e}`);
}

class Surface {
    constructor(gpu, handle, width, height) {
        this._gpu = gpu;
        this._handle = handle;
        // as the addon saw them (uint32), so they cannot disagree with swap()
        this.width = width >>> 0;
        this.height = height >>> 0;
        // Bumped by every resize that changes the size. `key` is a GEM
        // handle, unique only among the buffers of one swapchain — the kernel
        // recycles a handle once its buffer is freed, so a key from before a
        // resize can name a different buffer after it. Namespace caches by
        // the pair.
        this.generation = 0;
    }
    // Finish the frame; returns { key, generation, isNew, width, height, fd?,
    // stride?, offset?, modifier? }. The buffer stays owned by the caller
    // until release() — release it when Present says IdleNotify.
    //
    // Returns null when every buffer of the surface is still unreleased (the
    // GPU has nothing to render the next frame into): wait for a release,
    // redraw, and swap again — that is the natural pacing signal when
    // presenting faster than the server retires buffers.
    swap() {
        return native.swapBuffers(this._gpu._handle, this._handle);
    }
    // Give a buffer back to the swapchain. Takes the swap() result itself (or
    // anything carrying its key and generation), which is the form to use
    // when the surface can resize: a release that names an older generation
    // is ignored rather than freeing whichever live buffer inherited that GEM
    // handle. Answers whether a buffer was released.
    //
    // A bare key is still accepted, and is then trusted — there is nothing to
    // check it against.
    release(ref) {
        if (typeof ref === 'number') {
            native.releaseBuffer(this._handle, ref);
            return true;
        }
        if (!ref || typeof ref.key !== 'number' || typeof ref.generation !== 'number')
            throw new TypeError('release() takes a swap() result, or its key');
        if (ref.generation !== this.generation)
            return false; // a buffer of the swapchain a resize replaced
        native.releaseBuffer(this._handle, ref.key);
        return true;
    }
    // Rebuild the swapchain at a new size, keeping this surface's identity:
    // the handle stays valid, the context keeps its GL objects and stays
    // current if it was, and only the buffers change. Every buffer locked at
    // the time is released (their pixels live on for whoever imported the
    // dma-buf, but this surface is done with them), `generation` moves on,
    // and the next swap() reports a fresh set with isNew set.
    //
    // Resizing to the size it already has does nothing — no teardown, no
    // generation bump — so a drag can call this per configure event and pay
    // only for the sizes that actually differ. Any rounding policy (allocate
    // in steps, never shrink) belongs to the caller; this is the mechanism.
    //
    // Throws without touching the surface when the driver refuses the size.
    resize(width, height) {
        this.generation = native.resizeSurface(this._handle, width, height);
        this.width = width >>> 0;
        this.height = height >>> 0;
    }
    destroy() {
        native.destroySurface(this._handle);
    }
}

// "OpenGL ES 3.0 Mesa 26.0.3" -> { major: 3, minor: 0, string: '...' }.
// Anything that does not parse reports 2.0, which is the floor for a context
// this package can create at all.
function parseGlVersion(string) {
    const m = /OpenGL ES(?:-\w+)?\s+(\d+)\.(\d+)/.exec(string || '');
    return {
        major: m ? Number(m[1]) : 2,
        minor: m ? Number(m[2]) : 0,
        string: string || ''
    };
}

class Gpu {
    // opts: { devicePath?, fd?, format?, depthSize?, stencilSize?, glVersion? }
    constructor(opts) {
        opts = opts || {};
        this.devicePath = null;
        if (opts.fd != null) {
            this._fd = opts.fd;
            this._ownFd = false;
        } else {
            const nodes = opts.devicePath ? [opts.devicePath] : listRenderNodes();
            if (nodes.length === 0)
                throw new Error(DMABUF_PLATFORM
                    ? 'no DRM render nodes (/dev/dri/renderD*) available'
                    : `GPU rendering needs Linux DRM render nodes, which ${process.platform} does not have` +
                      ' — and the DRI3 extension that would consume the exported buffers is not' +
                      ' implemented by this platform\'s X server either (see the x11-dri README)');
            let lastErr = null;
            this._fd = null;
            for (const path of nodes) {
                try {
                    this._fd = fs.openSync(path, 'r+');
                    this.devicePath = path;
                    break;
                } catch (e) {
                    lastErr = e;
                }
            }
            if (this._fd == null)
                throw lastErr;
            this._ownFd = true;
        }
        this.format = opts.format || FORMAT.XRGB8888;
        // glVersion: 2 or 3 to insist, 'auto' (the default) to take the
        // highest the driver offers and fall back rather than fail.
        const wantEs = opts.glVersion == null || opts.glVersion === 'auto'
            ? 0 : opts.glVersion;
        // depthSize and stencilSize pick the EGL config, so they cannot be
        // arranged afterwards: a default framebuffer with no stencil bits
        // passes every stencil test for good. stencilSize defaults to 0 —
        // ask for 8 to stencil-then-cover a vector path.
        //
        // A refused glVersion, a negative bit count, no gbm/EGL/GLES to
        // load, no config for what was asked — every one of them throws
        // with the render node already open and no object left for the
        // caller to destroy(), so the fd has to go back here. An opts.fd
        // belongs to the caller either way.
        try {
            this._handle = native.createGpu(this._fd, this.format,
                opts.depthSize != null ? opts.depthSize : 16,
                opts.stencilSize != null ? opts.stencilSize : 0, wantEs);
            // adds eglVendor, eglVersion, contextVersion (the ES version EGL was
            // asked for and granted — see glVersion after makeCurrent for what
            // the driver actually gave), and depthSize/stencilSize, the bits the
            // chosen config actually carries rather than the ones requested
            Object.assign(this, native.gpuInfo(this._handle));
        } catch (e) {
            // a context that was made but never became usable goes back now
            // rather than at the finalizer
            if (this._handle) {
                try { native.destroyGpu(this._handle); } catch { /* ignore */ }
            }
            if (this._ownFd) {
                try { fs.closeSync(this._fd); } catch { /* ignore */ }
            }
            throw e;
        }
        this.gl = gl;
    }
    // useFlags: GBM_USE mask; RENDERING is implied. Pass GBM_USE.LINEAR when
    // the consuming device may not understand this GPU's tiled layouts.
    createSurface(width, height, useFlags) {
        const use = GBM_USE.RENDERING | (useFlags || 0);
        const handle = native.createSurface(this._handle, width, height, use);
        return new Surface(this, handle, width, height);
    }
    // Two things can only be settled against a live context, so they appear
    // here rather than in the constructor: `glVersion`, what the driver
    // actually gave (which can be higher than `contextVersion` — Mesa answers
    // an ES 2.0 request with an ES 3.0 context), and `features`, which of
    // the optional entry points (the README's "What is optional") this
    // driver offers.
    makeCurrent(surface) {
        native.makeCurrent(this._handle, surface ? surface._handle : null);
        this.glVersion = surface ? parseGlVersion(gl.getString(GL.VERSION)) : null;
        this.features = surface ? native.glGetFeatures() : null;
    }
    destroy() {
        native.destroyGpu(this._handle);
        if (this._ownFd) {
            try { fs.closeSync(this._fd); } catch { /* ignore */ }
        }
    }
}

// ---- macOS / XQuartz: the Apple-DRI + CGL accelerated path ----
//
// XQuartz has no DRI3, but it has a direct-rendering design of its own: the
// Apple-DRI extension makes the X server export the window's WindowServer
// surface to a client by (clientId, key[2]), and the client binds an OpenGL
// context straight to it. No buffers cross the X socket at all — GL renders
// into the window's backing store and CGLFlushDrawable presents.
//
// As with DRI3, the protocol half (AppleDRICreateSurface and the
// SurfaceNotify event) is plain X and belongs to the pure-JS x11 package;
// this is the half that cannot be JavaScript: the WindowServer handshake,
// the surface import, and the CGL context — with `gl` dispatching into the
// system OpenGL framework (GL 4.1 core on Metal), where ES2-style shaders
// compile unchanged.
//
//   const cid = dri.apple.clientId();            // WindowServer handshake
//   // X side: AppleDRI.CreateSurface(screen, wid, cid) -> { key, uid }
//   const ctx = new dri.apple.Context({ depthSize: 16 });
//   ctx.attach(key);                             // import + bind the surface
//   /* render with dri.gl */
//   ctx.flush();                                 // present (the swap)

function parseAppleGlVersion(string) {
    const m = /(\d+)\.(\d+)/.exec(string || '');
    return {
        major: m ? Number(m[1]) : 2,
        minor: m ? Number(m[2]) : 0,
        string: string || ''
    };
}

class AppleContext {
    // opts: { colorSize?, alphaSize?, depthSize?, stencilSize?,
    //         doubleBuffer?, profile? ('core' | 'legacy') }
    constructor(opts) {
        opts = opts || {};
        this._handle = native.appleCreateContext(
            opts.colorSize != null ? opts.colorSize : 24,
            opts.alphaSize != null ? opts.alphaSize : 8,
            opts.depthSize != null ? opts.depthSize : 16,
            opts.stencilSize != null ? opts.stencilSize : 0,
            opts.doubleBuffer !== false,
            opts.profile !== 'legacy');
        this.gl = gl;
    }
    // key: the [key_0, key_1] pair from the AppleDRICreateSurface reply (or
    // the two words as separate arguments). Imports the exported surface and
    // binds the context to it; the context comes out current. Attaching
    // again replaces the surface — the recovery move after a
    // SurfaceNotify(destroyed) once a fresh surface has been created.
    attach(key0, key1) {
        if (Array.isArray(key0))
            [key0, key1] = key0;
        native.appleAttach(this._handle, key0 >>> 0, key1 >>> 0);
        this._settle();
    }
    makeCurrent() {
        native.appleMakeCurrent(this._handle);
        this._settle();
    }
    _settle() {
        this.glVersion = parseAppleGlVersion(gl.getString(GL.VERSION));
        this.features = native.glGetFeatures();
    }
    // Present the frame — this backend's swap. There is no fd and no Present
    // round-trip: the WindowServer composites the surface directly.
    flush() { native.appleFlush(this._handle); }
    // Refresh the context's idea of the surface after the window resized or
    // moved: call on ConfigureNotify, or on AppleDRISurfaceNotify kind 0.
    update() { native.appleUpdate(this._handle); }
    // 0 (the default): flush returns immediately. 1: flush waits for the
    // vertical retrace — real vsync, but it blocks the event loop for up to
    // a frame, so a timer-paced loop usually serves a Node process better.
    setSwapInterval(n) { native.appleSetSwapInterval(this._handle, n); }
    // An offscreen render target whose color buffer is an IOSurface — how GL
    // reaches a Core Animation layer when no X server is exporting a window
    // surface (the react-x11 Cocoa backend). The IOSurfaceID is process-
    // global: hand it to the presentation side (IOSurfaceLookup there) and
    // set the surface as `layer.contents`. Draw with two of these and
    // alternate, like any swapchain. Makes the context current.
    createTarget(width, height, opts) {
        const handle = native.appleCreateTarget(this._handle, width, height,
            !opts || opts.depth !== false);
        return new AppleTarget(this, handle);
    }
    // Route subsequent GL draws into `target`'s IOSurface (null: back to no
    // framebuffer). Makes the context current.
    bindTarget(target) {
        native.appleBindTarget(this._handle, target ? target._handle : null);
    }
    destroy() { native.appleDestroyContext(this._handle); }
}

class AppleTarget {
    constructor(ctx, handle) {
        this._ctx = ctx;
        this._handle = handle;
        const info = native.appleTargetInfo(handle);
        this.iosurfaceId = info.iosurfaceId;
        // the GL framebuffer name, for a consumer whose "default
        // framebuffer" must mean this target (WebGL's bindFramebuffer(null))
        this.fbo = info.fbo;
        this.width = info.width;
        this.height = info.height;
    }
    bind() { this._ctx.bindTarget(this); }
    // Deleting the GL half needs the context, which is why this is a method
    // on a live target rather than work left to GC (GC would only release
    // the IOSurface).
    destroy() { native.appleDestroyTarget(this._ctx._handle, this._handle); }
}

const apple = {
    // The WindowServer client id of this process — the client_id argument of
    // AppleDRICreateSurface. Connects to the WindowServer on first call, and
    // throws (naming the reason) where there is none to connect to, e.g. an
    // SSH session or a non-macOS host.
    clientId() { return native.appleClientId(); },
    // The fastest refresh rate any connected display is running at, in Hz, or
    // null when there is no rate to be had (e.g. over SSH). XQuartz's RandR
    // advertises modes with no timing data, so a frame loop pacing itself
    // (flush() never blocks by default) asks macOS directly. Max across
    // displays — a pacing ceiling, the same semantics as taking the fastest
    // CRTC from RandR on Linux. Needs no WindowServer handshake.
    refreshRate() { return native.appleRefreshRate(); },
    Context: AppleContext
};

// CPU-memory dma-buf (needs /dev/udmabuf). Returns { fd, memfd, size,
// buffer (ArrayBuffer view of the pixels), sync(flags), close() }.
// `fd` is the dma-buf: hand it to DRI3.PixmapFromBuffer (which consumes it);
// keep writing pixels through `buffer` and bracket writes with
// sync(START|WRITE) / sync(END|WRITE).
function createUdmabuf(size) {
    const res = native.udmabufCreate(size);
    return {
        fd: res.fd,
        memfd: res.memfd,
        size: res.size,
        buffer: res.buffer,
        sync(flags) { native.dmabufSync(res.fd, flags); },
        close() {
            try { fs.closeSync(res.memfd); } catch { /* ignore */ }
            // res.fd is normally consumed by sendFds; close here only if not
            try { fs.closeSync(res.fd); } catch { /* ignore */ }
        }
    };
}

// Map a dma-buf the caller did not allocate — the CPU-read counterpart of
// createUdmabuf's `buffer`, for a descriptor that arrived from elsewhere
// (DRI3.BufferFromPixmap, another process). Returns { buffer, size,
// sync(flags), close() }. The fd is borrowed, never consumed: it stays the
// caller's to send on or close. `size` defaults to the descriptor's own.
//
// Only exporters that implement mmap can be mapped — udmabuf and linear/dumb
// buffers do, most tiled GPU allocations do not, and those throw here.
// Bracket reads with sync(START|READ) / sync(END|READ).
function mapDmabuf(fd, size) {
    if (size == null)
        size = fs.fstatSync(fd).size;
    const res = native.mapDmabuf(fd, size);
    let mapped = true;
    return {
        buffer: res.buffer,
        size: res.size,
        // False when the descriptor was exported read-only — a dma-buf fd
        // carries an access mode, and DRM_RDWR is opt-in. Writing through
        // the mapping would fault.
        writable: res.writable,
        sync(flags) { native.dmabufSync(fd, flags); },
        // Releases the mapping now rather than at the next GC, and detaches
        // `buffer` so nothing can read through it afterwards.
        close() {
            if (!mapped)
                return;
            mapped = false;
            native.unmapDmabuf(res.handle, res.buffer);
        }
    };
}


// ---------------------------------------------------------------------------
// UnixSocket: a unix-domain stream socket that passes file descriptors
// ---------------------------------------------------------------------------
//
// The shape is net.Socket's where it matters — 'connect'/'data'/'drain'/
// 'end'/'error'/'close', write() answering false for backpressure — plus the
// two descriptor calls node-x11's fd transports have: sendFds() and
// takeFds(). A Wayland client library that takes an injected socket can be
// handed one of these unchanged.
//
// Ownership: descriptors given to sendFds() are consumed; descriptors that
// arrive are the caller's from takeFds() on, and any never taken are closed
// with the socket. Descriptors are matched to messages by their position in
// the stream, so takeFds() is called by the parser, in order, and nothing
// else.
const { EventEmitter } = require('events');

class UnixSocket extends EventEmitter {
    constructor(pathOrOpts) {
        super();
        this.setMaxListeners(0);
        this.destroyed = false;
        this.connecting = true;
        this.writableEnded = false;
        this.readableEnded = false;
        this.pending = true;
        // what lib/ext/{shm,dri3}.js and wayland clients check
        this._fdCapable = true;
        this._fdReceiving = true;
        // Bun exports libuv's names but several are stubs that abort the
        // process — uv_poll_init among them — so there is nothing to probe
        // for at runtime; the only safe rule is not to try. Bun clients use
        // its own bun:ffi transport (node-x11's lib/fdpass-bun.js).
        if (typeof Bun !== 'undefined') {
            throw new Error('UnixSocket needs libuv polling, which Bun does not provide to addons; use a bun:ffi transport instead');
        }
        const onEvent = (kind, payload) => this._onEvent(kind, payload);
        if (pathOrOpts && typeof pathOrOpts === 'object' && typeof pathOrOpts.fd === 'number') {
            this._handle = native.sockFromFd(pathOrOpts.fd, onEvent);
        } else {
            this._handle = native.sockConnect(String(pathOrOpts), onEvent);
        }
        if (native.sockConnected(this._handle)) {
            // connected synchronously (the normal case for a unix socket with
            // a listener): report it the way net.Socket would, next tick
            process.nextTick(() => {
                if (!this.destroyed && this.connecting) this._onEvent('connect');
            });
        }
    }

    /** Wrap an already-connected descriptor — a socketpair end, say. */
    static fromFd(fd) {
        return new UnixSocket({ fd });
    }

    _onEvent(kind, payload) {
        switch (kind) {
            case 'connect':
                this.connecting = false;
                this.pending = false;
                this.emit('connect');
                this.emit('ready');
                break;
            case 'data':
                this.emit('data', payload);
                break;
            case 'drain':
                this.emit('drain');
                break;
            case 'end':
                this.readableEnded = true;
                this.emit('end');
                break;
            case 'error':
                this.emit('error', new Error(payload));
                break;
            case 'close':
                this.destroyed = true;
                this._handle = null;
                this.emit('close', false);
                break;
        }
    }

    get writableLength() {
        return this._handle ? native.sockPending(this._handle) : 0;
    }

    write(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding || 'utf8');
        if (this.destroyed || this.writableEnded || !this._handle) {
            if (cb) process.nextTick(cb, new Error('write after end'));
            return false;
        }
        const ok = native.sockWrite(this._handle, chunk);
        if (cb) process.nextTick(cb);
        return ok;
    }

    /** Write `buf` with `fds` attached to its first byte. Consumes the fds. */
    sendFds(buf, fds, cb) {
        const list = Array.from(fds, (fd) => fd | 0);
        if (this.destroyed || this.writableEnded || !this._handle) {
            for (const fd of list) { try { require('fs').closeSync(fd); } catch { /* */ } }
            if (cb) process.nextTick(cb, new Error('connection is not fd-capable or already closed'));
            return false;
        }
        const ok = native.sockSendFds(this._handle, buf, list);
        if (cb) process.nextTick(cb);
        return ok;
    }

    /** The next `n` received descriptors, oldest first. The caller owns them. */
    takeFds(n) {
        return this._handle ? native.sockTakeFds(this._handle, n) : [];
    }

    ref() { if (this._handle) native.sockRef(this._handle, true); return this; }
    unref() { if (this._handle) native.sockRef(this._handle, false); return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }

    end(data, cb) {
        if (typeof data === 'function') { cb = data; data = undefined; }
        if (data) this.write(data);
        this.writableEnded = true;
        // no half-close on this socket: once the queue is out, close it
        const finish = () => { this.destroy(); if (cb) cb(); };
        if (this.writableLength === 0) process.nextTick(finish);
        else this.once('drain', finish);
        return this;
    }

    destroy(err) {
        if (this.destroyed || !this._handle) return this;
        if (err) this.emit('error', err);
        native.sockClose(this._handle);
        return this;
    }
}

/** pipe(2), close-on-exec: `{ read, write }`. */
function pipe() {
    return native.pipe();
}

/** A connected pair of unix stream sockets, as descriptors. */
function socketpair() {
    return native.socketpair();
}

/** A sealed memfd of `size` bytes — shareable memory for wl_shm and friends. Linux only. */
function memfdCreate(size, name = 'x11-dri') {
    return native.memfdCreate(name, size);
}

module.exports = {
    probe: native.probe,
    dup: native.dup,
    listRenderNodes,
    Gpu,
    apple,
    createUdmabuf,
    mapDmabuf,
    dmabufSync: native.dmabufSync,
    gl,
    GL,
    FORMAT,
    GBM_USE,
    MODIFIER,
    DMABUF_SYNC,
    UnixSocket,
    pipe,
    socketpair,
    memfdCreate
};
