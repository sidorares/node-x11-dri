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
    FLOAT_MAT4x2: 0x8B69, FLOAT_MAT4x3: 0x8B6A
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

gl.getUniform = getUniform;
gl.getSupportedExtensions = getSupportedExtensions;

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
        this.width = width;
        this.height = height;
    }
    // Finish the frame; returns { key, isNew, width, height, fd?, stride?,
    // offset?, modifier? }. The buffer stays owned by the caller until
    // release(key) — release it when Present says IdleNotify.
    //
    // Returns null when every buffer of the surface is still unreleased (the
    // GPU has nothing to render the next frame into): wait for a release,
    // redraw, and swap again — that is the natural pacing signal when
    // presenting faster than the server retires buffers.
    swap() {
        return native.swapBuffers(this._gpu._handle, this._handle);
    }
    release(key) {
        native.releaseBuffer(this._handle, key);
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
    // opts: { devicePath?, fd?, format?, depthSize?, glVersion? }
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
        this._handle = native.createGpu(this._fd, this.format,
            opts.depthSize != null ? opts.depthSize : 16, wantEs);
        // adds eglVendor, eglVersion, contextVersion (the ES version EGL was
        // asked for and granted — see glVersion after makeCurrent for what
        // the driver actually gave)
        Object.assign(this, native.gpuInfo(this._handle));
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
    // vertex array objects, instanced drawing and multiple render targets
    // this driver offers.
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

module.exports = {
    probe: native.probe,
    dup: native.dup,
    listRenderNodes,
    Gpu,
    apple,
    createUdmabuf,
    dmabufSync: native.dmabufSync,
    gl,
    GL,
    FORMAT,
    GBM_USE,
    MODIFIER,
    DMABUF_SYNC
};
