// Install-time dispatch: use the bundled prebuilt binary when one matches
// this platform/arch and actually loads; otherwise compile with node-gyp.
// A box with no build tools therefore installs from the tarball alone.
// Force a source build with: npm install --build-from-source
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const target = `${process.platform}-${process.arch}`;
const prebuilt = path.join(root, 'prebuilds', target, 'x11dri.node');

if (process.env.npm_config_build_from_source !== 'true' && fs.existsSync(prebuilt)) {
    try {
        require(prebuilt); // loading registers exports and touches nothing else
        console.log(`x11-dri: using bundled prebuilt binary (${target})`);
        process.exit(0);
    } catch (e) {
        console.warn(`x11-dri: bundled prebuild did not load (${e.message}); compiling instead`);
    }
}

// npm points npm_config_node_gyp at its own copy; fall back to PATH
const gyp = process.env.npm_config_node_gyp;
const result = gyp
    ? spawnSync(process.execPath, [gyp, 'rebuild'], { cwd: root, stdio: 'inherit' })
    : spawnSync('node-gyp', ['rebuild'], { cwd: root, stdio: 'inherit' });
if (result.error) {
    console.error(`x11-dri: could not run node-gyp (${result.error.message})`);
    console.error('x11-dri: no prebuilt binary matches this system and no toolchain is available.');
    process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
