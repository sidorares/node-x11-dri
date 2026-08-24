// Direct rendering on macOS/XQuartz: the same spinning cube as the main
// repo's examples/dri3/cube.js, through the path XQuartz actually has.
// XQuartz never implemented DRI3 — its direct rendering is the Apple-DRI
// extension, and it is the *server* that exports a buffer to the client
// rather than the other way round:
//
//   this process                              X server (XQuartz)
//   ------------                              ------------------
//   apple.clientId()  --- AppleDRICreateSurface(win, cid) --->  exports the
//                     <--------- key[2] ---------------------   window's
//   ctx.attach(key)      (import surface, bind CGL context)     surface
//   glDraw... straight into the window's backing store
//   ctx.flush()          (WindowServer composites it — no X, no copies)
//                     <--- AppleDRISurfaceNotify -------------  (moved/resized:
//                                                                ctx.update())
//
// After attach, no pixel data and no per-frame request crosses the X socket
// at all — the socket only carries window management and the occasional
// SurfaceNotify. Rendering is the real GPU (Apple's OpenGL-on-Metal; this
// prints the renderer string), driven by the same WebGL-flavored `gl` and
// the very same ES2 shaders as the DRI3 sample.
//
// Needs: macOS with XQuartz (DISPLAY set), run from a logged-in GUI session
// (the WindowServer refuses SSH sessions). From this folder:
//
//     npm install && npm start
//
// Keys: q / Escape quit.

const x11 = require('x11');
const appledri = require('./appledri');

let dri;
try {
    dri = require('../..');           // this repo's build
} catch (e) {
    try {
        dri = require('x11-dri');     // or the installed package
    } catch (e2) {
        console.error('x11-dri is not built/installed:', e.message);
        process.exit(1);
    }
}

const START_W = 480;
const START_H = 360;

// ---------------------------------------------------------------------------
// Tiny column-major mat4 (just enough for one cube)
// ---------------------------------------------------------------------------

const mat4 = {
    perspective(fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2);
        const nf = 1 / (near - far);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) * nf, -1,
            0, 0, 2 * far * near * nf, 0
        ]);
    },
    multiply(a, b) { // a * b
        const out = new Float32Array(16);
        for (let c = 0; c < 4; c++)
            for (let r = 0; r < 4; r++)
                out[c * 4 + r] =
                    a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                    a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        return out;
    },
    rotateXY(ax, ay) {
        const cx = Math.cos(ax), sx = Math.sin(ax);
        const cy = Math.cos(ay), sy = Math.sin(ay);
        // Ry * Rx
        return new Float32Array([
            cy, 0, -sy, 0,
            sx * sy, cx, sx * cy, 0,
            cx * sy, -sx, cx * cy, 0,
            0, 0, 0, 1
        ]);
    },
    translateZ(z) {
        return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]);
    }
};

// ---------------------------------------------------------------------------
// Cube geometry: 24 vertices (x,y,z,r,g,b), 36 indices
// ---------------------------------------------------------------------------

function cubeGeometry() {
    const faces = [
        { axis: 2, sign: 1, color: [0.90, 0.30, 0.24] },  // +z red
        { axis: 2, sign: -1, color: [0.20, 0.60, 0.86] }, // -z blue
        { axis: 0, sign: 1, color: [0.18, 0.80, 0.44] },  // +x green
        { axis: 0, sign: -1, color: [0.95, 0.77, 0.06] }, // -x yellow
        { axis: 1, sign: 1, color: [0.61, 0.35, 0.71] },  // +y purple
        { axis: 1, sign: -1, color: [0.90, 0.49, 0.13] }  // -y orange
    ];
    const verts = [];
    const idx = [];
    faces.forEach((f, fi) => {
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        corners.forEach(([u, v]) => {
            const p = [0, 0, 0];
            p[f.axis] = f.sign;
            p[(f.axis + 1) % 3] = f.sign > 0 ? u : -u; // keep faces CCW from outside
            p[(f.axis + 2) % 3] = v;
            verts.push(p[0], p[1], p[2], f.color[0], f.color[1], f.color[2]);
        });
        const b = fi * 4;
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    return { verts: new Float32Array(verts), idx: new Uint16Array(idx) };
}

function buildProgram(gl, vsSrc, fsSrc) {
    const compile = (type, src, what) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error(`${what}: ${gl.getShaderInfoLog(s)}`);
        return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc, 'vertex shader'));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc, 'fragment shader'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
    return p;
}

// ---------------------------------------------------------------------------

const runSeconds = process.argv[2] ? Number(process.argv[2]) : 0; // 0 = until closed

x11.createClient((err, display) => {
    if (err) throw err;
    const X = display.client;
    const screen = display.screen[0];

    appledri.requireExt(display, (err, AppleDRI) => {
        if (err) {
            console.error(err.message);
            console.error('(On Linux, the DRI3 path is the one to use: examples/dri3/cube.js in node-x11.)');
            return X.terminate();
        }
        AppleDRI.QueryVersion((err, ver) => {
            if (err) throw err;
            AppleDRI.QueryDirectRenderingCapable(0, (err, capable) => {
                if (err) throw err;
                console.log(`Apple-DRI ${ver.major}.${ver.minor}.${ver.patch}, direct rendering capable: ${capable}`);
                if (!capable) {
                    console.error('server says not capable');
                    return X.terminate();
                }
                start(X, screen, AppleDRI);
            });
        });
    });
}).on('error', err => {
    console.error('X connection:', err.message || err);
    process.exit(0);
});

function start(X, screen, AppleDRI) {
    let cid;
    try {
        cid = dri.apple.clientId(); // WindowServer handshake
    } catch (e) {
        console.error(e.message);
        return X.terminate();
    }

    // --- window ------------------------------------------------------------
    const depth = screen.root_depth;
    const wid = X.AllocID();
    X.CreateWindow(wid, screen.root, 0, 0, START_W, START_H, 0, depth, 1, 0, {
        backgroundPixel: screen.black_pixel,
        eventMask: x11.eventMask.StructureNotify | x11.eventMask.KeyPress
    });
    X.ChangeProperty(0, wid, X.atoms.WM_NAME, X.atoms.STRING, 8,
        Buffer.from('Apple-DRI cube - node-x11', 'latin1'));
    X.MapWindow(wid);

    let ctx = null;
    let width = START_W, height = START_H;
    let timer = null;
    let closing = false;

    // The physical (Quartz) window exists once the X window is mapped; only
    // then can the server create and export a surface for it.
    function createSurfaceAndRun() {
        AppleDRI.CreateSurface(0, wid, cid, (err, surf) => {
            if (err) {
                console.error('CreateSurface:', err.message);
                return shutdown(1);
            }
            console.log(`surface key [${surf.key.map(k => '0x' + k.toString(16)).join(', ')}], uid ${surf.uid}`);
            if (ctx) {
                ctx.attach(surf.key); // re-attach after a Destroyed notify
                return;
            }
            ctx = new dri.apple.Context({ depthSize: 16 });
            ctx.attach(surf.key);
            const gl = ctx.gl;
            console.log(`GL_RENDERER: ${gl.getString(gl.RENDERER)}`);
            console.log(`GL_VERSION:  ${gl.getString(gl.VERSION)} (${ctx.glVersion.major}.${ctx.glVersion.minor})`);
            run(gl);
        });
    }

    function run(gl) {
        // --- GL scene: same shaders as the DRI3 cube, ES2 spelling ---------
        const prog = buildProgram(gl, `
            attribute vec3 aPos;
            attribute vec3 aColor;
            uniform mat4 uMVP;
            varying vec3 vColor;
            void main() {
                gl_Position = uMVP * vec4(aPos, 1.0);
                vColor = aColor;
            }
        `, `
            precision mediump float;
            varying vec3 vColor;
            void main() {
                gl_FragColor = vec4(vColor, 1.0);
            }
        `);
        const geo = cubeGeometry();
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, geo.verts, gl.STATIC_DRAW);
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.idx, gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        const aColor = gl.getAttribLocation(prog, 'aColor');
        const uMVP = gl.getUniformLocation(prog, 'uMVP');
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);

        const t0 = Date.now();
        let frames = 0;
        let statT = Date.now();

        // No swapchain and no Present pacing on this path: draw, flush, and
        // let a timer set the rate. (setSwapInterval(1) would vsync the
        // flush at the cost of blocking the event loop each frame.)
        timer = setInterval(() => {
            gl.viewport(0, 0, width, height);
            gl.clearColor(0.09, 0.09, 0.12, 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(prog);
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 24, 12);
            gl.enableVertexAttribArray(aColor);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);

            const t = (Date.now() - t0) / 1000;
            const proj = mat4.perspective(Math.PI / 4, width / height, 0.1, 100);
            const mv = mat4.multiply(mat4.translateZ(-6), mat4.rotateXY(t * 0.9, t * 1.3));
            gl.uniformMatrix4fv(uMVP, false, mat4.multiply(proj, mv));
            gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);

            ctx.flush();

            frames++;
            const now = Date.now();
            if (now - statT >= 2000) {
                console.log(`${(frames * 1000 / (now - statT)).toFixed(1)} fps`);
                frames = 0;
                statT = now;
            }
            if (runSeconds && now - t0 >= runSeconds * 1000)
                shutdown(0);
        }, 16);
    }

    // --- events --------------------------------------------------------------
    let mapped = false;
    X.on('event', ev => {
        switch (ev.name) {
        case 'MapNotify':
            if (!mapped) {
                mapped = true;
                createSurfaceAndRun();
            }
            break;

        case 'ConfigureNotify':
            if (ev.width !== width || ev.height !== height) {
                width = ev.width;
                height = ev.height;
                if (ctx)
                    ctx.update(); // refresh the surface geometry in the context
            }
            break;

        case 'AppleDRISurfaceNotify':
            // kind 0 (changed): the window moved or resized under the surface
            // kind 1 (destroyed): the surface is gone — make a fresh one
            if (!ctx)
                break;
            if (ev.kind === AppleDRI.NotifyKind.Changed)
                ctx.update();
            else if (ev.kind === AppleDRI.NotifyKind.Destroyed && !closing)
                createSurfaceAndRun();
            break;

        case 'KeyPress':
            // keycodes, not keysyms — good enough for a demo:
            // Escape/q on pc105 (9/24) and on XQuartz's mac layout (61/20)
            if ([9, 24, 61, 20].includes(ev.keycode))
                shutdown(0);
            break;

        case 'DestroyNotify':
            shutdown(0);
            break;
        }
    });

    function shutdown(codeOrErr) {
        if (closing)
            return;
        closing = true;
        if (timer)
            clearInterval(timer);
        if (ctx)
            ctx.destroy();
        AppleDRI.DestroySurface(0, wid);
        X.DestroyWindow(wid);
        X.terminate();
        process.exitCode = typeof codeOrErr === 'number' ? codeOrErr : 1;
    }
}
