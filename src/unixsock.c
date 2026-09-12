// A unix-domain stream socket that can pass file descriptors, driven by the
// event loop.
//
// Node's own sockets cannot receive descriptors: libuv reads SCM_RIGHTS
// control data expecting a handle it knows how to wrap, and anything else
// aborts the process (nodejs/node#53391, closed "not planned"). Wayland
// sends them routinely — the keymap, shm pools, clipboard pipes — so a
// Wayland client on Node needs a socket of its own. This is that socket.
//
// It is a `uv_poll_t` over an `AF_UNIX` descriptor: readiness comes from the
// loop like every other I/O, reads are `recvmsg(2)` with room for
// SCM_MAX_FD descriptors of control data, writes are `sendmsg(2)` with the
// descriptors of a message attached to its first byte. No thread — the
// Bun/`bun:ffi` transport this replaces needed one, and paid ~37µs a round
// trip for the hop.
//
// The libuv entry points are resolved with `dlsym(RTLD_DEFAULT)` rather than
// linked, deliberately. This object file is part of an addon whose other
// half is GL and works on runtimes that do not export libuv at all; an
// unresolved symbol at load time would take the whole addon down with it.
// Resolved lazily, a runtime without libuv loses only `UnixSocket`, and the
// error says so.
//
// Ownership, the same contract as node-x11's fd transports: descriptors
// given to `sendFds` are consumed (closed once on the wire, or on close);
// descriptors received belong to the caller from `takeFds` on, and any never
// taken are closed with the socket.

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
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <uv.h>

// Linux has flags for what macOS does with fcntl(2) and a socket option.
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
#ifndef MSG_CMSG_CLOEXEC
#define MSG_CMSG_CLOEXEC 0
#endif

#define US_THROW(env, msg)                                                     \
    do {                                                                       \
        napi_throw_error(env, NULL, msg);                                      \
        return NULL;                                                           \
    } while (0)

#define US_THROWF(env, ...)                                                    \
    do {                                                                       \
        char buf_[256];                                                        \
        snprintf(buf_, sizeof(buf_), __VA_ARGS__);                             \
        napi_throw_error(env, NULL, buf_);                                     \
        return NULL;                                                           \
    } while (0)

#define US_ARGS(env, info, n)                                                  \
    size_t argc = (n);                                                         \
    napi_value args[(n) > 0 ? (n) : 1];                                        \
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok)       \
        US_THROW(env, "bad callback info")

#define MAX_FDS 253          /* SCM_MAX_FD */
#define RECV_FDS_CAP 1024    /* received, not yet taken */
#define READ_SIZE 65536

// ---- libuv, resolved at runtime ---------------------------------------------

static struct {
    int tried, ok;
    int (*poll_init)(uv_loop_t *, uv_poll_t *, int);
    int (*poll_start)(uv_poll_t *, int, uv_poll_cb);
    int (*poll_stop)(uv_poll_t *);
    void (*close)(uv_handle_t *, uv_close_cb);
    void (*ref)(uv_handle_t *);
    void (*unref)(uv_handle_t *);
} UV;

static const char *load_uv(void) {
    if (UV.tried) return UV.ok ? NULL : "this runtime does not export libuv (uv_poll_*)";
    UV.tried = 1;
    void *self = RTLD_DEFAULT;
    UV.poll_init = dlsym(self, "uv_poll_init");
    UV.poll_start = dlsym(self, "uv_poll_start");
    UV.poll_stop = dlsym(self, "uv_poll_stop");
    UV.close = dlsym(self, "uv_close");
    UV.ref = dlsym(self, "uv_ref");
    UV.unref = dlsym(self, "uv_unref");
    UV.ok = UV.poll_init && UV.poll_start && UV.poll_stop && UV.close && UV.ref && UV.unref;
    return UV.ok ? NULL : "this runtime does not export libuv (uv_poll_*)";
}

// ---- the socket ---------------------------------------------------------------

typedef struct WItem {
    uint8_t *buf;
    size_t len, off;
    int *fds;      /* attached to the first byte sent; NULL once delivered */
    int nfds;
    struct WItem *next;
} WItem;

typedef struct UnixSock {
    int fd;
    uv_poll_t poll;
    int poll_active;     /* uv_poll_init done; must uv_close before free */
    int watching_write;
    int connecting;
    int closed;          /* close() was called; no more events */
    int holds;           /* the uv handle and the JS external; freed at zero */
    napi_env env;
    napi_ref callback;   /* (kind, payload) */
    napi_async_context actx; /* for callbacks from the loop, see emit() */
    napi_ref recv;       /* the async resource, doubling as the callback's `this` */
    int from_loop;       /* inside on_poll: no JavaScript is on the stack */
    WItem *wq_head, *wq_tail;
    size_t wq_bytes;
    int rfds[RECV_FDS_CAP];
    int nrfds;
    uint8_t rbuf[READ_SIZE];
} UnixSock;

static void close_fds(int *fds, int n) {
    for (int i = 0; i < n; i++) if (fds[i] >= 0) close(fds[i]);
}

static void free_item(WItem *it) {
    if (it->fds) { close_fds(it->fds, it->nfds); free(it->fds); }
    free(it->buf);
    free(it);
}

/*
 * Call the JS callback with (kind[, payload]).
 *
 * Two ways in, and the difference is not cosmetic. From the event loop —
 * a readable or writable socket — there is no JavaScript on the stack, and
 * `napi_call_function` from there runs the callback but *not* the microtask
 * queue afterwards: a promise the callback resolved stays resolved-but-
 * unobserved until some other event turns the loop. A client that awaits the
 * reply to its first request then hangs until an unrelated timer fires,
 * which is exactly what happened. `napi_make_callback` is the entry point
 * made for this case; it wraps the call in a callback scope that drains
 * nextTicks and promise jobs on the way out, as a `net.Socket`'s own reads
 * do. From inside one of our own JS-invoked functions (a `write` that
 * flushes and emits 'drain', a `close`), JavaScript *is* on the stack and
 * the plain call is right — the caller's scope drains the queue when it
 * returns.
 */
static void emit(UnixSock *s, const char *kind, napi_value payload) {
    if (s->closed && strcmp(kind, "close") != 0) return;
    napi_env env = s->env;
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return;
    napi_value cb, undef, recv = NULL, argv[2], result;
    if (napi_get_reference_value(env, s->callback, &cb) == napi_ok && cb) {
        napi_get_undefined(env, &undef);
        napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &argv[0]);
        argv[1] = payload ? payload : undef;
        // napi_make_callback insists on an object receiver where
        // napi_call_function takes anything; the failed conversion would also
        // leave a pending exception to ambush the next native call.
        if (s->recv) napi_get_reference_value(env, s->recv, &recv);
        if (!recv) napi_get_global(env, &recv);
        napi_status st;
        if (s->from_loop && s->actx)
            st = napi_make_callback(env, s->actx, recv, cb, 2, argv, &result);
        else
            st = napi_call_function(env, recv, cb, 2, argv, &result);
        if (st == napi_pending_exception) {
            napi_value exc;
            if (napi_get_and_clear_last_exception(env, &exc) == napi_ok)
                napi_fatal_exception(env, exc);
        } else if (st != napi_ok) {
            const napi_extended_error_info *info = NULL;
            napi_get_last_error_info(env, &info);
            fprintf(stderr, "x11-dri UnixSocket: callback '%s' failed: status %d (%s)\n",
                    kind, (int)st, info && info->error_message ? info->error_message : "?");
        }
    }
    napi_close_handle_scope(env, scope);
}

static void emit_error(UnixSock *s, const char *what, int err) {
    char msg[300];
    snprintf(msg, sizeof(msg), "%s: %s", what, strerror(err));
    napi_value v;
    napi_create_string_utf8(s->env, msg, NAPI_AUTO_LENGTH, &v);
    emit(s, "error", v);
}

/* The struct outlives both the uv handle (freed only from uv_close's
   callback) and the JS external (freed only from its finalizer), whichever
   goes second. */
static void sock_release(UnixSock *s) {
    if (--s->holds <= 0) free(s);
}

static void on_uv_closed(uv_handle_t *h) {
    sock_release((UnixSock *)h->data);
}

/* Tear down: stop polling, close the descriptor, drop queues and refs. */
static void sock_close(UnixSock *s, int notify) {
    if (s->closed) return;
    s->closed = 1;
    if (s->poll_active) UV.poll_stop(&s->poll);
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
    WItem *it = s->wq_head;
    while (it) { WItem *n = it->next; free_item(it); it = n; }
    s->wq_head = s->wq_tail = NULL;
    s->wq_bytes = 0;
    close_fds(s->rfds, s->nrfds);
    s->nrfds = 0;
    if (notify) {
        s->closed = 0;           /* let the one 'close' through */
        emit(s, "close", NULL);
        s->closed = 1;
    }
    if (s->callback) { napi_delete_reference(s->env, s->callback); s->callback = NULL; }
    if (s->actx) { napi_async_destroy(s->env, s->actx); s->actx = NULL; }
    if (s->recv) { napi_delete_reference(s->env, s->recv); s->recv = NULL; }
    if (s->poll_active) {
        s->poll_active = 0;
        UV.close((uv_handle_t *)&s->poll, on_uv_closed);
    } else {
        sock_release(s);
    }
}

static void on_poll(uv_poll_t *h, int status, int events);

static void arm(UnixSock *s) {
    if (s->closed || !s->poll_active) return;
    int events = s->connecting ? UV_WRITABLE : (UV_READABLE | (s->wq_head ? UV_WRITABLE : 0));
    UV.poll_start(&s->poll, events, on_poll);
}

/* Push the queue to the kernel as far as it will go. */
static void flush_writes(UnixSock *s) {
    while (s->wq_head && !s->closed) {
        WItem *it = s->wq_head;
        ssize_t n;
        if (it->fds && it->nfds > 0) {
            struct iovec iov = { it->buf + it->off, it->len - it->off };
            union { char buf[CMSG_SPACE(sizeof(int) * MAX_FDS)]; struct cmsghdr align; } ctl;
            struct msghdr msg = {0};
            msg.msg_iov = &iov;
            msg.msg_iovlen = 1;
            msg.msg_control = ctl.buf;
            msg.msg_controllen = CMSG_SPACE(sizeof(int) * it->nfds);
            struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
            c->cmsg_level = SOL_SOCKET;
            c->cmsg_type = SCM_RIGHTS;
            c->cmsg_len = CMSG_LEN(sizeof(int) * it->nfds);
            memcpy(CMSG_DATA(c), it->fds, sizeof(int) * it->nfds);
            n = sendmsg(s->fd, &msg, MSG_NOSIGNAL | MSG_DONTWAIT);
            if (n > 0) {
                /* delivered with the first byte; the copies are ours to close */
                close_fds(it->fds, it->nfds);
                free(it->fds);
                it->fds = NULL;
                it->nfds = 0;
            }
        } else {
            n = send(s->fd, it->buf + it->off, it->len - it->off, MSG_NOSIGNAL | MSG_DONTWAIT);
        }
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
                arm(s);
                return;
            }
            emit_error(s, "write to the connection failed", errno);
            sock_close(s, 1);
            return;
        }
        it->off += (size_t)n;
        s->wq_bytes -= (size_t)n;
        if (it->off >= it->len) {
            s->wq_head = it->next;
            if (!s->wq_head) s->wq_tail = NULL;
            free_item(it);
        }
    }
    if (!s->closed) {
        arm(s);
        if (s->watching_write) {
            s->watching_write = 0;
            emit(s, "drain", NULL);
        }
    }
}

static void drain_reads(UnixSock *s) {
    while (!s->closed) {
        struct iovec iov = { s->rbuf, sizeof(s->rbuf) };
        union { char buf[CMSG_SPACE(sizeof(int) * MAX_FDS)]; struct cmsghdr align; } ctl;
        struct msghdr msg = {0};
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        msg.msg_control = ctl.buf;
        msg.msg_controllen = sizeof(ctl.buf);
        ssize_t n = recvmsg(s->fd, &msg, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return;
            emit_error(s, "read from the connection failed", errno);
            sock_close(s, 1);
            return;
        }
        /* descriptors first, so they are queued by the time the bytes that
           name them are parsed */
        for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
            if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) continue;
            int count = (int)((c->cmsg_len - CMSG_LEN(0)) / sizeof(int));
            int *fds = (int *)CMSG_DATA(c);
            for (int i = 0; i < count; i++) {
                if (!MSG_CMSG_CLOEXEC) fcntl(fds[i], F_SETFD, FD_CLOEXEC);
                if (s->nrfds < RECV_FDS_CAP) s->rfds[s->nrfds++] = fds[i];
                else close(fds[i]);
            }
        }
        if (msg.msg_flags & MSG_CTRUNC) {
            napi_value v;
            napi_create_string_utf8(s->env, "descriptors were dropped: control message truncated", NAPI_AUTO_LENGTH, &v);
            emit(s, "error", v);
            sock_close(s, 1);
            return;
        }
        if (n == 0) {
            emit(s, "end", NULL);
            sock_close(s, 1);
            return;
        }
        napi_value buf;
        void *data;
        if (napi_create_buffer_copy(s->env, (size_t)n, s->rbuf, &data, &buf) == napi_ok)
            emit(s, "data", buf);
        if ((size_t)n < sizeof(s->rbuf)) return; /* drained */
    }
}

static void on_poll_scoped(UnixSock *s, int status, int events);

static void on_poll(uv_poll_t *h, int status, int events) {
    UnixSock *s = (UnixSock *)h->data;
    if (s->closed) return;
    // libuv hands us no handle scope; every napi value made from here — the
    // data Buffer, an error string — needs one or Node aborts.
    napi_handle_scope scope;
    if (napi_open_handle_scope(s->env, &scope) != napi_ok) return;
    s->from_loop = 1;
    on_poll_scoped(s, status, events);
    s->from_loop = 0;
    napi_close_handle_scope(s->env, scope);
}

static void on_poll_scoped(UnixSock *s, int status, int events) {
    if (status < 0) {
        emit_error(s, "waiting on the connection failed", -status);
        sock_close(s, 1);
        return;
    }
    if (s->connecting) {
        int err = 0;
        socklen_t len = sizeof(err);
        getsockopt(s->fd, SOL_SOCKET, SO_ERROR, &err, &len);
        s->connecting = 0;
        if (err) {
            emit_error(s, "connect failed", err);
            sock_close(s, 1);
            return;
        }
        arm(s);
        emit(s, "connect", NULL);
        if (s->closed) return;
        flush_writes(s);
        return;
    }
    if (events & UV_WRITABLE) flush_writes(s);
    if (!s->closed && (events & (UV_READABLE | UV_DISCONNECT))) drain_reads(s);
}

static void sock_finalize(napi_env env, void *data, void *hint) {
    UnixSock *s = data;
    (void)hint;
    if (!s->closed) {
        s->env = env;
        // the external took its hold at creation; sock_close releases the
        // uv one (via uv_close) or immediately when polling never started
        sock_close(s, 0);
    }
    sock_release(s);
}

static UnixSock *sock_from(napi_env env, napi_value v) {
    void *p = NULL;
    if (napi_get_value_external(env, v, &p) != napi_ok || !p) {
        napi_throw_error(env, NULL, "not a UnixSocket handle");
        return NULL;
    }
    return p;
}

/* Wrap an already-open descriptor as a socket on the loop. */
static napi_value wrap_fd(napi_env env, int fd, napi_value callback, int connecting) {
    const char *why = load_uv();
    if (why) { close(fd); US_THROW(env, why); }
    uv_loop_t *loop = NULL;
    if (napi_get_uv_event_loop(env, &loop) != napi_ok || !loop) { close(fd); US_THROW(env, "no event loop"); }
    int fl = fcntl(fd, F_GETFL);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    fcntl(fd, F_SETFD, FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
    // macOS: a write to a peer that went away must be an EPIPE, not a signal
    int nosig = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosig, sizeof(nosig));
#endif

    UnixSock *s = calloc(1, sizeof(UnixSock));
    s->fd = fd;
    s->env = env;
    s->connecting = connecting;
    s->poll.data = s;
    s->holds = 1;                       /* the JS external's */
    int rc = UV.poll_init(loop, &s->poll, fd);
    if (rc != 0) { close(fd); free(s); US_THROWF(env, "uv_poll_init failed (%d)", rc); }
    s->poll_active = 1;
    s->holds++;                         /* the uv handle's, released by on_uv_closed */
    {
        napi_value resource, name;
        napi_create_object(env, &resource);
        napi_create_string_utf8(env, "x11-dri.UnixSocket", NAPI_AUTO_LENGTH, &name);
        if (napi_async_init(env, resource, name, &s->actx) != napi_ok) s->actx = NULL;
        if (napi_create_reference(env, resource, 1, &s->recv) != napi_ok) s->recv = NULL;
    }
    if (napi_create_reference(env, callback, 1, &s->callback) != napi_ok) {
        s->poll_active = 0;
        close(fd);
        s->fd = -1;
        s->closed = 1;
        UV.close((uv_handle_t *)&s->poll, on_uv_closed);
        sock_release(s);
        US_THROW(env, "could not keep the callback");
    }
    arm(s);
    napi_value ext;
    if (napi_create_external(env, s, sock_finalize, NULL, &ext) != napi_ok) US_THROW(env, "napi_create_external failed");
    return ext;
}

// sockConnect(path, callback) -> handle. 'connect' is emitted once connected.
static napi_value SockConnect(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 2);
    char path[sizeof(((struct sockaddr_un *)0)->sun_path)];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, args[0], path, sizeof(path), &len) != napi_ok)
        US_THROW(env, "path must be a string");
    if (len == 0 || len >= sizeof(path) - 1) US_THROW(env, "socket path is empty or too long for sockaddr_un");
#if defined(SOCK_CLOEXEC) && defined(SOCK_NONBLOCK)
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
#else
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd >= 0) {
        fcntl(fd, F_SETFD, FD_CLOEXEC);
        int fl0 = fcntl(fd, F_GETFL);
        if (fl0 >= 0) fcntl(fd, F_SETFL, fl0 | O_NONBLOCK);
    }
#endif
    if (fd < 0) US_THROWF(env, "socket failed: %s", strerror(errno));
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof(sa));
    sa.sun_family = AF_UNIX;
    memcpy(sa.sun_path, path, len + 1);
    int connecting = 0;
    if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
        if (errno == EINPROGRESS) connecting = 1;
        else {
            int e = errno;
            close(fd);
            US_THROWF(env, "connect to %s failed: %s", path, strerror(e));
        }
    }
    napi_value ext = wrap_fd(env, fd, args[1], connecting);
    if (!ext) return NULL;
    if (!connecting) {
        /* connected synchronously; say so on the next tick from JS's side */
        UnixSock *s = sock_from(env, ext);
        (void)s;
    }
    return ext;
}

// sockFromFd(fd, callback) -> handle. For socketpair ends and tests.
static napi_value SockFromFd(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 2);
    int32_t fd = -1;
    napi_get_value_int32(env, args[0], &fd);
    if (fd < 0) US_THROW(env, "fd must be a descriptor");
    return wrap_fd(env, fd, args[1], 0);
}

// sockConnected(handle) -> bool
static napi_value SockConnected(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 1);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    napi_value out;
    napi_get_boolean(env, !s->closed && !s->connecting, &out);
    return out;
}

static int queue_item(napi_env env, UnixSock *s, napi_value buf, int *fds, int nfds) {
    void *data = NULL;
    size_t len = 0;
    bool isbuf = false;
    napi_is_buffer(env, buf, &isbuf);
    if (isbuf) napi_get_buffer_info(env, buf, &data, &len);
    else {
        napi_typedarray_type t;
        if (napi_get_typedarray_info(env, buf, &t, &len, &data, NULL, NULL) != napi_ok) {
            napi_throw_error(env, NULL, "write takes a Buffer or Uint8Array");
            return 0;
        }
    }
    WItem *it = calloc(1, sizeof(WItem));
    it->len = len;
    it->buf = malloc(len ? len : 1);
    if (len) memcpy(it->buf, data, len);
    it->fds = fds;
    it->nfds = nfds;
    if (s->wq_tail) s->wq_tail->next = it; else s->wq_head = it;
    s->wq_tail = it;
    s->wq_bytes += len;
    return 1;
}

// sockWrite(handle, bytes) -> bool (false: queued, wait for 'drain')
static napi_value SockWrite(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 2);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    if (s->closed) US_THROW(env, "write after close");
    if (!queue_item(env, s, args[1], NULL, 0)) return NULL;
    if (!s->connecting) flush_writes(s);
    napi_value out;
    int flushed = s->wq_head == NULL;
    if (!flushed) s->watching_write = 1;
    napi_get_boolean(env, flushed, &out);
    return out;
}

// sockSendFds(handle, bytes, fds: Int32Array|number[]) -> bool. Consumes fds.
static napi_value SockSendFds(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 3);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    uint32_t n = 0;
    napi_get_array_length(env, args[2], &n);
    if (n == 0 || n > MAX_FDS) US_THROWF(env, "sendFds takes 1..%d descriptors", MAX_FDS);
    int *fds = malloc(sizeof(int) * n);
    for (uint32_t i = 0; i < n; i++) {
        napi_value v;
        int32_t fd = -1;
        napi_get_element(env, args[2], i, &v);
        napi_get_value_int32(env, v, &fd);
        fds[i] = fd;
    }
    if (s->closed) { close_fds(fds, (int)n); free(fds); US_THROW(env, "write after close"); }
    if (!queue_item(env, s, args[1], fds, (int)n)) { close_fds(fds, (int)n); free(fds); return NULL; }
    if (!s->connecting) flush_writes(s);
    napi_value out;
    int flushed = s->wq_head == NULL;
    if (!flushed) s->watching_write = 1;
    napi_get_boolean(env, flushed, &out);
    return out;
}

// sockTakeFds(handle, n) -> number[]  (oldest first; caller owns them)
static napi_value SockTakeFds(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 2);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    int32_t n = 0;
    napi_get_value_int32(env, args[1], &n);
    if (n < 0) n = 0;
    if (n > s->nrfds) n = s->nrfds;
    napi_value arr;
    napi_create_array_with_length(env, (size_t)n, &arr);
    for (int i = 0; i < n; i++) {
        napi_value v;
        napi_create_int32(env, s->rfds[i], &v);
        napi_set_element(env, arr, (uint32_t)i, v);
    }
    if (n > 0) {
        memmove(s->rfds, s->rfds + n, sizeof(int) * (size_t)(s->nrfds - n));
        s->nrfds -= n;
    }
    return arr;
}

// sockPending(handle) -> bytes not yet written
static napi_value SockPending(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 1);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    napi_value out;
    napi_create_double(env, (double)s->wq_bytes, &out);
    return out;
}

// sockRef(handle, bool): whether an open socket keeps the process alive
static napi_value SockRef(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 2);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    bool on = true;
    napi_get_value_bool(env, args[1], &on);
    if (s->poll_active) (on ? UV.ref : UV.unref)((uv_handle_t *)&s->poll);
    return NULL;
}

// sockClose(handle): close now; emits 'close'
static napi_value SockClose(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 1);
    UnixSock *s = sock_from(env, args[0]);
    if (!s) return NULL;
    s->env = env;
    sock_close(s, 1);
    return NULL;
}

// ---- small descriptor helpers ------------------------------------------------

// pipe() -> { read, write }, close-on-exec
static napi_value Pipe(napi_env env, napi_callback_info info) {
    (void)info;
    int fds[2];
#if defined(__linux__)
    if (pipe2(fds, O_CLOEXEC) != 0) US_THROWF(env, "pipe2 failed: %s", strerror(errno));
#else
    if (pipe(fds) != 0) US_THROWF(env, "pipe failed: %s", strerror(errno));
    fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    fcntl(fds[1], F_SETFD, FD_CLOEXEC);
#endif
    napi_value obj, r, w;
    napi_create_object(env, &obj);
    napi_create_int32(env, fds[0], &r);
    napi_create_int32(env, fds[1], &w);
    napi_set_named_property(env, obj, "read", r);
    napi_set_named_property(env, obj, "write", w);
    return obj;
}

// socketpair() -> [fd, fd], a connected AF_UNIX stream pair (tests, mock compositors)
static napi_value Socketpair(napi_env env, napi_callback_info info) {
    (void)info;
    int fds[2];
#if defined(__linux__)
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) != 0)
#else
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0)
#endif
        US_THROWF(env, "socketpair failed: %s", strerror(errno));
    napi_value arr, a, b;
    napi_create_array_with_length(env, 2, &arr);
    napi_create_int32(env, fds[0], &a);
    napi_create_int32(env, fds[1], &b);
    napi_set_element(env, arr, 0, a);
    napi_set_element(env, arr, 1, b);
    return arr;
}

// memfdCreate(name, size) -> fd, sealed against shrinking. Linux only.
static napi_value MemfdCreate(napi_env env, napi_callback_info info) {
    US_ARGS(env, info, 2);
#if defined(__linux__)
    char name[64];
    size_t n = 0;
    napi_get_value_string_utf8(env, args[0], name, sizeof(name), &n);
    double size = 0;
    napi_get_value_double(env, args[1], &size);
    if (!(size > 0)) US_THROW(env, "size must be positive");
    int fd = memfd_create(n ? name : "x11-dri", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) US_THROWF(env, "memfd_create failed: %s", strerror(errno));
    if (ftruncate(fd, (off_t)size) != 0) { int e = errno; close(fd); US_THROWF(env, "ftruncate failed: %s", strerror(e)); }
    fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK);
    napi_value out;
    napi_create_int32(env, fd, &out);
    return out;
#else
    US_THROW(env, "memfd_create is Linux-only");
#endif
}

static napi_value us_fn(napi_env env, napi_callback cb) {
    napi_value fn;
    napi_create_function(env, NULL, 0, cb, NULL, &fn);
    return fn;
}

void unixsock_register(napi_env env, napi_value exports) {
#define X(name, cb) napi_set_named_property(env, exports, name, us_fn(env, cb))
    X("sockConnect", SockConnect);
    X("sockFromFd", SockFromFd);
    X("sockConnected", SockConnected);
    X("sockWrite", SockWrite);
    X("sockSendFds", SockSendFds);
    X("sockTakeFds", SockTakeFds);
    X("sockPending", SockPending);
    X("sockRef", SockRef);
    X("sockClose", SockClose);
    X("pipe", Pipe);
    X("socketpair", Socketpair);
    X("memfdCreate", MemfdCreate);
#undef X
}
