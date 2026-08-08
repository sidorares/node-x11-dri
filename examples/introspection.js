'use strict';

// Asking a linked program what it contains, without being told first.
//
//     node examples/introspection.js
//
// This is what a material system, a shader hot-reloader, or a debug overlay
// needs: given a program it did not write, enumerate the uniforms and
// attributes, bind by name, and read values back in their own types.

const { offscreen, program } = require('./offscreen');

const ctx = offscreen(64, 64);
const gl = ctx.gl;

const vs = `
attribute vec3 aPosition;
attribute vec2 aUv;
uniform mat4 uModelView;
varying vec2 vUv;
void main() {
    vUv = aUv;
    gl_Position = uModelView * vec4(aPosition, 1.0);
}`;

const fs = `
precision mediump float;
uniform sampler2D uAlbedo;
uniform vec3 uLightDir;
uniform vec4 uTint;
uniform float uRoughness;
uniform int uMode;
uniform bool uFog;
uniform vec2 uOffsets[4];
varying vec2 vUv;
void main() {
    vec2 uv = vUv + uOffsets[0] + uOffsets[1] + uOffsets[2] + uOffsets[3];
    vec4 base = texture2D(uAlbedo, uv) * uTint;
    float l = max(dot(normalize(uLightDir), vec3(0.0, 0.0, 1.0)), 0.0);
    float f = uFog ? 0.5 : 1.0;
    gl_FragColor = vec4(base.rgb * l * f * uRoughness * float(uMode), base.a);
}`;

const p = program(gl, vs, fs);
gl.useProgram(p);

// Names for the type enums, so the dump reads like the shader source.
const TYPE_NAME = {};
for (const k of ['FLOAT', 'FLOAT_VEC2', 'FLOAT_VEC3', 'FLOAT_VEC4', 'INT', 'INT_VEC2',
    'INT_VEC3', 'INT_VEC4', 'BOOL', 'BOOL_VEC2', 'BOOL_VEC3', 'BOOL_VEC4',
    'FLOAT_MAT2', 'FLOAT_MAT3', 'FLOAT_MAT4', 'SAMPLER_2D', 'SAMPLER_CUBE'])
    TYPE_NAME[gl[k]] = k;
const typeName = t => TYPE_NAME[t] || `0x${t.toString(16)}`;

// Give every uniform a value, so there is something to read back.
gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uModelView'), false,
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
gl.uniform1i(gl.getUniformLocation(p, 'uAlbedo'), 0);
gl.uniform3f(gl.getUniformLocation(p, 'uLightDir'), 0.0, 0.5, 1.0);
gl.uniform4f(gl.getUniformLocation(p, 'uTint'), 1.0, 0.85, 0.7, 1.0);
gl.uniform1f(gl.getUniformLocation(p, 'uRoughness'), 0.35);
gl.uniform1i(gl.getUniformLocation(p, 'uMode'), 2);
gl.uniform1i(gl.getUniformLocation(p, 'uFog'), 1);
gl.uniform2fv(gl.getUniformLocation(p, 'uOffsets[0]'),
    new Float32Array([0, 0, 0.1, 0, 0, 0.1, 0.1, 0.1]));

console.log('attributes');
const nAttribs = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
for (let i = 0; i < nAttribs; i++) {
    const a = gl.getActiveAttrib(p, i);
    const loc = gl.getAttribLocation(p, a.name);
    console.log(`  ${a.name.padEnd(14)} ${typeName(a.type).padEnd(12)} location ${loc}`);
}

console.log('\nuniforms');
const nUniforms = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
for (let i = 0; i < nUniforms; i++) {
    const u = gl.getActiveUniform(p, i);
    // Arrays are reported once, as "uOffsets[0]" with the element count.
    const base = u.name.replace(/\[0\]$/, '');
    for (let e = 0; e < u.size; e++) {
        const name = u.size > 1 ? `${base}[${e}]` : base;
        const value = gl.getUniform(p, gl.getUniformLocation(p, name));
        const shown = ArrayBuffer.isView(value) ? `[${Array.from(value).join(', ')}]`
                                                : String(value);
        console.log(`  ${name.padEnd(14)} ${typeName(u.type).padEnd(12)} = ${shown}`);
    }
}

console.log('\nshaders');
for (const s of gl.getAttachedShaders(p)) {
    const kind = gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER
        ? 'vertex' : 'fragment';
    const lines = gl.getShaderSource(s).trim().split('\n').length;
    console.log(`  ${String(s).padEnd(4)} ${kind.padEnd(9)} ${lines} lines of source`);
}

const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
console.log(`\nfragment mediump float: +-2^${precision.rangeMax},` +
    ` ${precision.precision} bits of mantissa`);

gl.validateProgram(p);
console.log('validates:', !!gl.getProgramParameter(p, gl.VALIDATE_STATUS));
console.log('GL error:', gl.getError() === gl.NO_ERROR ? 'none' : 'yes');

ctx.close();
