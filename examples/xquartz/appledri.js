// Apple-DRI: XQuartz's direct-rendering extension — the macOS counterpart of
// DRI3. Where DRI3 passes dma-buf fds, Apple-DRI passes a *surface key*: the
// server owns a WindowServer surface for the drawable and exports it to a
// client's WindowServer connection, identified by (client_id, key[2]). What
// the client does with the key (import it and attach an OpenGL context via
// the Xplugin/CGL system libraries) is native-code territory — the x11-dri
// package's `apple` namespace.
//
// Protocol source (there is no shipped header — the extension is defined in
// the XQuartz server tree):
//   https://github.com/XQuartz/xorg-server/blob/master/hw/xquartz/xpr/appledristr.h
//   https://github.com/XQuartz/xorg-server/blob/master/hw/xquartz/xpr/appledri.h
//
// This file is written in node-x11's lib/ext style so it can move there
// verbatim as lib/ext/appledri.js (X.require('appledri')); until then, call
// requireExt(display, cb) directly.

/*
#define X_AppleDRIQueryVersion                0
#define X_AppleDRIQueryDirectRenderingCapable 1
#define X_AppleDRICreateSurface               2
#define X_AppleDRIDestroySurface              3
(4..8: AuthConnection and the shm pixmap requests — not bound here)
*/

exports.requireExt = (display, callback) => {
    const X = display.client;
    X.QueryExtension('Apple-DRI', (err, ext) => {
        if (err)
            return callback(err);
        if (!ext.present)
            return callback(new Error('Apple-DRI extension not available (not an XQuartz server?)'));

        // -> { major, minor, patch }
        ext.QueryVersion = cb => {
            X.seq_num++;
            const b = Buffer.alloc(4);
            b.writeUInt8(ext.majorOpcode, 0);
            b.writeUInt8(0, 1);
            b.writeUInt16LE(1, 2);
            X.pack_stream.put(b);
            X.replies[X.seq_num] = [
                (buf, opt) => ({
                    major: buf.readUInt16LE(0),
                    minor: buf.readUInt16LE(2),
                    patch: buf.readUInt32LE(4)
                }),
                cb
            ];
            X.pack_stream.submit(true);
        };

        // -> boolean
        ext.QueryDirectRenderingCapable = (screen, cb) => {
            X.seq_num++;
            const b = Buffer.alloc(8);
            b.writeUInt8(ext.majorOpcode, 0);
            b.writeUInt8(1, 1);
            b.writeUInt16LE(2, 2);
            b.writeUInt32LE(screen >>> 0, 4);
            X.pack_stream.put(b);
            X.replies[X.seq_num] = [
                (buf, opt) => buf.readUInt8(0) !== 0,
                cb
            ];
            X.pack_stream.submit(true);
        };

        // The server creates (or refs) a WindowServer surface for the
        // drawable — a window or a pixmap — and exports it to the process
        // whose WindowServer id is `clientId` (x11-dri: apple.clientId()).
        // -> { key: [key0, key1], uid }
        // `key` is what AppleContext.attach() consumes; `uid` is the
        // server-side surface id that SurfaceNotify events carry as `arg`.
        ext.CreateSurface = (screen, drawable, clientId, cb) => {
            X.seq_num++;
            const b = Buffer.alloc(16);
            b.writeUInt8(ext.majorOpcode, 0);
            b.writeUInt8(2, 1);
            b.writeUInt16LE(4, 2);
            b.writeUInt32LE(screen >>> 0, 4);
            b.writeUInt32LE(drawable >>> 0, 8);
            b.writeUInt32LE(clientId >>> 0, 12);
            X.pack_stream.put(b);
            X.replies[X.seq_num] = [
                (buf, opt) => ({
                    key: [buf.readUInt32LE(0), buf.readUInt32LE(4)],
                    uid: buf.readUInt32LE(8)
                }),
                cb
            ];
            X.pack_stream.submit(true);
        };

        ext.DestroySurface = (screen, drawable) => {
            X.seq_num++;
            const b = Buffer.alloc(12);
            b.writeUInt8(ext.majorOpcode, 0);
            b.writeUInt8(3, 1);
            b.writeUInt16LE(3, 2);
            b.writeUInt32LE(screen >>> 0, 4);
            b.writeUInt32LE(drawable >>> 0, 8);
            X.pack_stream.put(b);
            X.pack_stream.submit(false);
        };

        ext.events = {
            AppleDRISurfaceNotify: 3 // 0..2 are obsolete
        };
        ext.NotifyKind = {
            Changed: 0,   // window moved/resized: AppleContext.update()
            Destroyed: 1  // surface gone: CreateSurface + attach() anew
        };

        // Sent unsolicited to the client that created the surface — there is
        // no event mask to select. `arg` is the surface uid.
        X.eventParsers[ext.firstEvent + ext.events.AppleDRISurfaceNotify] =
            (type, seq, extra, code, raw) => ({
                type,
                seq,
                name: 'AppleDRISurfaceNotify',
                kind: code,
                time: extra,
                arg: raw.readUInt32LE(4)
            });

        callback(null, ext);
    });
};
