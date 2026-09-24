/* SPDX-License-Identifier: MIT */
#ifndef BCWEBMUX_H
#define BCWEBMUX_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BCWMUX_ABI_VERSION 2u
#define BCWMUX_UUID_BYTES 16u

/*
 * The library never retains an input pointer after the call returns.  Output
 * buffers are owned by the library and must be released with the matching
 * *_free function. Inputs are borrowed length-delimited bytes; output buffers
 * are not necessarily NUL-terminated. No function invokes a Go callback.
 * Recoverable Zig errors map to status codes; panics are not caught.
 * Worker processes, including the legacy worker entry, exclusively use forkpty.
 */
typedef struct bcwebmux_engine bcwebmux_engine;
typedef struct bcwebmux_socket bcwebmux_socket;

typedef enum bcwebmux_status {
    BCWMUX_OK = 0, /* Successful ABI operation or HTTP response. */
    BCWMUX_INVALID_ARGUMENT = 1, /* Caller input or ABI version invalid. */
    BCWMUX_OUT_OF_MEMORY = 2, /* Allocation failure. */
    BCWMUX_CLOSED = 3, /* Terminal handle. */
    BCWMUX_BUSY = 4, /* Socket handles remain open. */
    BCWMUX_PROTOCOL_ERROR = 5, /* Wire validation failed. */
    BCWMUX_QUEUE_OVERFLOW = 6, /* Bounded output queue overflowed; terminal. */
    BCWMUX_NOT_READY = 7, /* Operation requested before hello. */
    BCWMUX_SHUTTING_DOWN = 8, /* Native runtime is shutting down. */
    BCWMUX_INTERNAL = 9, /* Native failure. */
    BCWMUX_TOO_LARGE = 10, /* Bounded input or frame is too large. */
    BCWMUX_NOT_FOUND = 11, /* Non-API target or session was not found. */
    BCWMUX_WOULD_BLOCK = 12 /* Outgoing queue is empty. */
} bcwebmux_status;

typedef struct bcwebmux_engine_config {
    uint32_t abi_version;
    const uint8_t *worker_path;
    size_t worker_path_len;
    const uint8_t *shell;
    size_t shell_len;
    /* NULL/zero selects xterm-ghostty for new PTY sessions. */
    const uint8_t *term;
    size_t term_len;
    uint32_t disable_kitty_graphics; /* 1 suppresses the Kitty graphics environment hint. */
    /* NULL/zero disables native same-origin validation only for migration
     * callers that validate externally. */
    const uint8_t *expected_origin;
    size_t expected_origin_len;
    uint32_t max_live_sessions; /* 0 selects manifest default; maximum 64.
                                * All other limits use native manifest defaults. */
} bcwebmux_engine_config;

/* A request is a borrowed, length-delimited view.  method is ASCII (GET,
 * POST, PATCH, DELETE); target may include a query string.  origin,
 * content_type, and idempotency_key are optional and may be NULL with length 0.
 */
typedef struct bcwebmux_http_request_input {
    const uint8_t *method;
    size_t method_len;
    const uint8_t *target;
    size_t target_len;
    const uint8_t *origin;
    size_t origin_len;
    const uint8_t *content_type;
    size_t content_type_len;
    const uint8_t *idempotency_key;
    size_t idempotency_key_len;
    const uint8_t *body;
    size_t body_len;
} bcwebmux_http_request_input;

typedef struct bcwebmux_http_response {
    uint16_t status; /* HTTP status, meaningful when the ABI call returns OK. */
    uint8_t replayed;
    uint8_t reserved[5];
    uint8_t *body;
    size_t body_len;
    char *content_type;
    size_t content_type_len;
    char *location;
    size_t location_len;
} bcwebmux_http_response;

/* Socket queue sizing.  The queue contains complete WebSocket binary message
 * payloads, not TCP/WebSocket framing.  zero selects the native bounded
 * default.  max_message_bytes of zero selects the native protocol maximum.
 */
typedef struct bcwebmux_socket_options {
    uint32_t abi_version;
    size_t max_queue_bytes;
    size_t max_message_bytes;
} bcwebmux_socket_options;

typedef struct bcwebmux_message {
    uint8_t *data;
    size_t len;
} bcwebmux_message;

/*
 * Engine lifecycle and REST adapter.
 *
 * engine_open copies worker_path, shell, and expected_origin. Worker and shell
 * must be nonempty and contain no NUL bytes. The worker is invoked as
 * worker_path --session-worker SHELL COLS ROWS.
 * Callers must serialize ALL calls sharing an engine, including calls through
 * its sockets, and own handle lifetime. Native ABI handles have no outer lock.
 * engine_close returns BUSY without changing the engine while any socket
 * handle remains, including a protocol-terminal socket. Otherwise it joins
 * native tasks and frees the engine. Close each socket first.
 * Successful close is ONCE ONLY: never reuse the freed pointer. Wrappers must
 * clear their pointer and implement idempotence themselves. No release API.
 * REST returns OK when a response exists; inspect its HTTP status and free
 * the response even for HTTP errors. Outputs are zeroed on ABI failure.
 * Free previous output buffers before reusing response/message output slots.
 */
bcwebmux_status bcwebmux_engine_open(const bcwebmux_engine_config *config,
                                      bcwebmux_engine **out_engine);
bcwebmux_status bcwebmux_engine_close(bcwebmux_engine *engine);
bcwebmux_status bcwebmux_http_request(bcwebmux_engine *engine,
                                       const bcwebmux_http_request_input *request,
                                       bcwebmux_http_response *response);
void bcwebmux_http_response_free(bcwebmux_http_response *response);

/*
 * Native application session protocol adapter.  socket_open allocates an
 * opaque connection and an empty bounded outgoing queue.  The first call to
 * socket_receive_binary must be the existing protocol hello frame; the
 * resulting welcome is queued for drain.  receive_binary only processes one
 * complete binary message and never waits for a peer.
 *
 * Apply the engine-wide serialization rule above. socket_tick performs the
 * existing heartbeat and publication pass (normally every publish interval),
 * and may queue zero or more complete binary messages.  socket_drain moves one
 * queued message into a newly-owned buffer; an empty queue returns
 * BCWMUX_WOULD_BLOCK.  Every drained message must be freed with
 * bcwebmux_message_free.  Queue overflow closes the connection, detaches all
 * attachments, resets compression state, and returns BCWMUX_QUEUE_OVERFLOW.
 * Protocol errors terminate the socket endpoint, not its terminal sessions;
 * queued messages remain drainable. socket_close detaches and frees the handle once,
 * including terminal handles; stop all users before closing and never reuse
 * the freed pointer.
 */
bcwebmux_status bcwebmux_socket_open(bcwebmux_engine *engine,
                                      const bcwebmux_socket_options *options,
                                      bcwebmux_socket **out_socket);
/* Optional additive ABI operation, serialized like all socket calls. Call before
 * HELLO. managed=1 gives the embedding transport sole liveness authority:
 * application probes remain observations, but their timeout cannot terminate
 * this socket. managed=0 (the default) retains standalone heartbeat policy.
 * Values other than 0/1 or changing policy after HELLO are invalid. */
bcwebmux_status bcwebmux_socket_set_transport_managed(bcwebmux_socket *socket,
                                                       uint8_t managed);
bcwebmux_status bcwebmux_socket_receive_binary(bcwebmux_socket *socket,
                                                const uint8_t *data,
                                                size_t len);
bcwebmux_status bcwebmux_socket_tick(bcwebmux_socket *socket);
bcwebmux_status bcwebmux_socket_drain(bcwebmux_socket *socket,
                                      bcwebmux_message *message);
bcwebmux_status bcwebmux_socket_close(bcwebmux_socket *socket);
void bcwebmux_message_free(bcwebmux_message *message);

/* Returns a stable, process-lifetime string for diagnostics. */
const char *bcwebmux_status_name(bcwebmux_status status);

#ifdef __cplusplus
}
#endif

#endif /* BCWEBMUX_H */
