// Package native is the narrow Go-facing boundary for the native bcwebmux
// session engine. The cgo implementation is deliberately hidden from the HTTP
// and WebSocket transport.
package native

import "errors"

const (
	Protocol         = "bcw.sessions"
	MaxPayloadLength = 1024 * 1024
	MaxFrameLength   = 64 + MaxPayloadLength
	MaxRequestBytes  = 4096
	MaxResponseBytes = 64 * 1024
)

var (
	ErrClosed    = errors.New("native bcwebmux object is closed")
	ErrQueueFull = errors.New("native bcwebmux output queue is full")
	ErrNotReady  = errors.New("native bcwebmux socket negotiation is pending")
	ErrProtocol  = errors.New("native bcwebmux protocol terminated")
)

// EngineConfig is copied by the native wrapper before OpenEngine returns.
type EngineConfig struct {
	Shell  string
	Worker string
	// ExpectedOrigin is copied into the native engine for same-origin validation;
	// the Go transport still enforces the check before calling native REST/WebSocket paths.
	ExpectedOrigin string
	MaxSessions    uint64
}

// RESTRequest is a bounded request passed to the native management plane.
type RESTRequest struct {
	Method         string
	Target         string
	Origin         string
	ContentType    string
	IdempotencyKey string
	Body           []byte
}

// RESTResponse owns Go copies of native data that remain valid after the call returns.
type RESTResponse struct {
	Status int
	// Replayed reports the native idempotency replay bit.
	Replayed    bool
	ContentType string
	Location    string
	Body        []byte
}

// Socket is a native application-protocol endpoint. Receive, Tick, Drain and
// Close must not overlap for one socket. The server enforces that invariant.
type Socket interface {
	Receive(binary []byte) error
	Tick() error
	// Drain returns one complete WebSocket binary message. ok is false when the
	// bounded native output queue is empty. ErrProtocol from Receive/Tick stops
	// production but leaves ordered terminal output drainable until Close.
	Drain() (message []byte, ok bool, err error)
	Close() error
}

// Engine owns all sessions and must outlive every Socket opened from it.
type Engine interface {
	REST(RESTRequest) (RESTResponse, error)
	// OpenSocket opts into externally managed transport liveness: missing native
	// application PONGs cannot independently retire a Go-managed connection.
	OpenSocket() (Socket, error)
	Close() error
}
