package server

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/gorilla/websocket"
)

const (
	websocketTick      = 8 * time.Millisecond
	websocketWriteWait = 5 * time.Second
)

// One conservative, RTT-independent operating profile. The native ABI keeps
// engine-wide serialization; none of these budgets authorize freeing live work.
type socketProfile struct {
	hello, probeInterval, response, control, write, terminalDrain, schedulingGap, queueStall time.Duration
	inboundBytes, outboundBytes                                                              int
}

var defaultSocketProfile = socketProfile{
	hello: 10 * time.Second, probeInterval: 5 * time.Second,
	response: 15 * time.Second, control: 5 * time.Second, write: websocketWriteWait,
	terminalDrain: 2 * time.Second, schedulingGap: 2 * time.Second, queueStall: 5 * time.Second,
	inboundBytes: 4 * native.MaxFrameLength, outboundBytes: 4 * native.MaxFrameLength,
}

// Interface allows deterministic blocked-I/O tests without kernel buffer timing.
type socketNetwork interface {
	ReadMessage() (int, []byte, error)
	WriteMessage(int, []byte) error
	WriteControl(int, []byte, time.Time) error
	SetWriteDeadline(time.Time) error
	SetPongHandler(func(string) error)
	SetPingHandler(func(string) error)
	SetCloseHandler(func(int, string) error)
	Close() error
}

type socketConn struct {
	id               uint64
	logger           *slog.Logger
	remote           string
	created          time.Time
	ws               socketNetwork
	native           native.Socket
	open             func() (native.Socket, error)
	profile          socketProfile
	in, out          *socketMailbox
	controls         chan socketControl
	observations     chan probeObservation
	ready            atomic.Bool
	terminal         atomic.Bool
	terminalDeadline atomic.Pointer[time.Time]
	probeGeneration  atomic.Uint64
	inMessages       atomic.Uint64
	inBytes          atomic.Uint64
	outMessages      atomic.Uint64
	outBytes         atomic.Uint64
	peerClose        atomic.Pointer[socketControl]
	peerClosing      chan struct{}

	stopOnce sync.Once
	closed   chan struct{}
	outcome  string // written before closed; read only after closed/join
}

var silentSocketLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

func (s *Server) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.ProtoMajor != 1 {
		s.logger.Warn("websocket upgrade rejected", "reason", "http-version", "remote", r.RemoteAddr, "protocol", r.Proto)
		http.Error(w, "WebSocket requires HTTP/1.1", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodGet {
		s.logger.Warn("websocket upgrade rejected", "reason", "method", "remote", r.RemoteAddr, "method", r.Method)
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.validOrigin(r) {
		s.logger.Warn("websocket upgrade rejected", "reason", "origin", "remote", r.RemoteAddr, "origin", r.Header.Get("Origin"))
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !slices.Contains(websocket.Subprotocols(r), native.Protocol) {
		s.logger.Warn("websocket upgrade rejected", "reason", "subprotocol", "remote", r.RemoteAddr)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	upgrader := websocket.Upgrader{
		ReadBufferSize:    32 * 1024,
		WriteBufferSize:   32 * 1024,
		Subprotocols:      []string{native.Protocol},
		EnableCompression: false,
		HandshakeTimeout:  websocketWriteWait,
		CheckOrigin:       func(req *http.Request) bool { return s.validOrigin(req) },
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("websocket upgrade failed", "remote", r.RemoteAddr, "error", err)
		return
	}
	conn.SetReadLimit(native.MaxFrameLength)

	id := s.nextConn.Add(1)
	logger := s.logger.With("component", "websocket", "connection_id", id)
	state := &socketConn{id: id, logger: logger, remote: r.RemoteAddr, created: time.Now(), ws: conn, open: s.engine.OpenSocket, closed: make(chan struct{})}
	logger.Info("websocket accepted", "remote", r.RemoteAddr, "user_agent", r.UserAgent(), "origin", r.Header.Get("Origin"))
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		state.closeNetwork()
		return
	}
	s.ws[state] = struct{}{}
	s.mu.Unlock()
	defer s.removeSocket(state)
	state.run(r.Context())
}

func (s *Server) removeSocket(conn *socketConn) {
	conn.closeNetwork()
	// run joins the sole native owner, which alone disposes its handle.
	s.mu.Lock()
	delete(s.ws, conn)
	s.mu.Unlock()
}

func (c *socketConn) run(ctx context.Context) {
	if c.profile == (socketProfile{}) {
		c.profile = defaultSocketProfile
	}
	c.in = newSocketMailbox(c.profile.inboundBytes)
	c.out = newSocketMailbox(c.profile.outboundBytes)
	c.controls = make(chan socketControl, 32) // reserved, at most 125 bytes each
	c.observations = make(chan probeObservation, 64)
	c.peerClosing = make(chan struct{})
	c.ws.SetPingHandler(func(data string) error {
		return c.queueControl(socketControl{opcode: websocket.PongMessage, payload: []byte(data), created: time.Now()})
	})
	c.ws.SetPongHandler(func(data string) error {
		if len(data) == 8 {
			c.observe(probeObservation{nonce: binary.BigEndian.Uint64([]byte(data)), at: time.Now()})
		}
		return nil
	})
	c.ws.SetCloseHandler(func(code int, text string) error {
		// RFC 6455 5.5.1: reply to Close, allowing only an already in-flight
		// message to finish. The sole writer discards other application data.
		control := &socketControl{opcode: websocket.CloseMessage, payload: websocket.FormatCloseMessage(code, text), created: time.Now()}
		if c.peerClose.CompareAndSwap(nil, control) {
			c.log().Info("websocket peer close received", "code", code, "reason", text)
			close(c.peerClosing)
		}
		return nil
	})
	var users sync.WaitGroup
	for _, work := range []func(){c.readLoop, c.writeLoop, c.nativeLoop} {
		users.Add(1)
		go func(work func()) { defer users.Done(); work() }(work)
	}
	policy := newSocketPolicy(time.Now(), c.profile)
	observe := func(observation probeObservation) {
		responses, unmatched := policy.responses, policy.unmatched
		policy.observe(observation)
		if policy.responses != responses {
			c.log().Debug("websocket heartbeat response", "nonce", observation.nonce, "response_ms", policy.lastResponse.Milliseconds())
		} else if policy.unmatched != unmatched {
			c.log().Debug("websocket unmatched heartbeat response", "nonce", observation.nonce)
		}
	}
	defer func() {
		c.closeNetwork()
		// Snapshot pressure before waiting for potentially slow live native work.
		c.log().Info("websocket observations",
			"outcome", c.outcome, "duration_ms", time.Since(c.created).Milliseconds(),
			"in_frames_received", c.inMessages.Load(), "in_application_bytes", c.inBytes.Load(),
			"out_frames_generated", c.outMessages.Load(), "out_application_bytes", c.outBytes.Load(),
			"in_queued_bytes", c.in.queuedBytes(), "out_queued_bytes", c.out.queuedBytes(),
			"heartbeat_responses", policy.responses, "heartbeat_late", policy.late,
			"heartbeat_unmatched", policy.unmatched, "scheduling_gaps", policy.gaps,
			"heartbeat_missed", policy.missed, "last_response_ms", policy.lastResponse.Milliseconds())
		users.Wait()
		c.in.discard()
		c.out.discard()
	}()
	ticker := time.NewTicker(websocketTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.retire("request-canceled")
			return
		case <-c.closed:
			return
		case observation := <-c.observations:
			observe(observation)
		case <-ticker.C:
			now := time.Now() // NOT the ticker's old scheduled timestamp
			if peer := c.peerClose.Load(); peer != nil {
				if !now.Before(peer.created.Add(c.profile.control)) {
					c.retire("peer-close-expired")
					return
				}
				continue
			}
			if c.terminal.Load() {
				if !now.Before(*c.terminalDeadline.Load()) {
					c.retire("terminal-drain-expired")
					return
				}
				continue
			}
			// Honor observations already received before considering retirement;
			// select's random choice must not turn timer-before-Pong into failure.
			for count := len(c.observations); count > 0; count-- {
				observe(<-c.observations)
			}
			previousGaps, previousMissed := policy.gaps, policy.missed
			gapDuration := now.Sub(policy.lastRun)
			nonce, outcome := policy.advance(now, c.ready.Load())
			if policy.gaps != previousGaps {
				c.log().Warn("websocket supervisor scheduling gap", "gap_ms", gapDuration.Milliseconds(), "heartbeat_was_pending", policy.missed != previousMissed)
			}
			if outcome != "" {
				c.retire(outcome)
				return
			}
			if nonce != 0 {
				c.log().Debug("websocket heartbeat probe scheduled", "nonce", nonce)
				c.probeGeneration.Store(nonce)
				payload := make([]byte, 8)
				binary.BigEndian.PutUint64(payload, nonce)
				if c.queueControl(socketControl{opcode: websocket.PingMessage, payload: payload, nonce: nonce, created: now}) != nil {
					return
				}
			}
		}
	}
}

type socketPacket struct {
	payload  []byte
	terminal bool
}

func (c *socketConn) log() *slog.Logger {
	if c.logger != nil {
		return c.logger
	}
	return silentSocketLogger
}

func frameTypeName(value byte) string {
	names := [...]string{"", "hello", "welcome", "error", "session_changed", "attach", "attach_begin", "detach", "checkpoint_begin", "checkpoint_chunk", "checkpoint_end", "event_batch", "live_barrier", "ack", "credit", "resync_required", "claim_control", "lease_changed", "input", "input_ack", "resize_request", "canonical_resize", "exited", "ping", "pong"}
	if int(value) < len(names) {
		return names[value]
	}
	return "unknown"
}

func (c *socketConn) logFrame(direction string, data []byte) {
	if direction == "in" {
		c.inMessages.Add(1)
		c.inBytes.Add(uint64(len(data)))
	} else {
		c.outMessages.Add(1)
		c.outBytes.Add(uint64(len(data)))
	}
	if len(data) < 64 || binary.LittleEndian.Uint32(data[0:4]) != 0x53574342 {
		c.log().Debug("websocket application frame", "direction", direction, "bytes", len(data), "valid_header", false)
		return
	}
	frameType := data[4]
	args := []any{
		"direction", direction, "frame_type", frameTypeName(frameType), "bytes", len(data),
		"sequence", binary.LittleEndian.Uint64(data[16:24]),
		"request_id", binary.LittleEndian.Uint64(data[24:32]),
		"attachment_id", binary.LittleEndian.Uint64(data[32:40]),
		"attachment_epoch", binary.LittleEndian.Uint64(data[40:48]),
	}
	if session := data[48:64]; !allZero(session) {
		args = append(args, "session_id", hex.EncodeToString(session))
	}
	if (frameType == 20 || frameType == 21) && len(data) >= 88 {
		geometry := data[80:88]
		stage := "queued"
		if frameType == 20 {
			stage = "requested"
		} else {
			args = append(args, "operation_id", binary.LittleEndian.Uint64(data[72:80]))
		}
		args = append(args,
			"cols", binary.LittleEndian.Uint16(geometry[0:2]),
			"rows", binary.LittleEndian.Uint16(geometry[2:4]),
			"cell_width_px", binary.LittleEndian.Uint16(geometry[4:6]),
			"cell_height_px", binary.LittleEndian.Uint16(geometry[6:8]),
			"sigwinch_stage", stage)
		c.log().Info("terminal resize lifecycle", args...)
		return
	}
	c.log().Debug("websocket application frame", args...)
}

func allZero(data []byte) bool {
	for _, value := range data {
		if value != 0 {
			return false
		}
	}
	return true
}

// Byte accounting includes the in-flight consumer, plus a bounded count so tiny
// frames cannot exhaust metadata. Enqueue never waits while owning native work.
type socketMailbox struct {
	mu           sync.Mutex
	bytes, limit int
	items        chan socketPacket
	progress     chan struct{}
}

func newSocketMailbox(limit int) *socketMailbox {
	return &socketMailbox{limit: limit, items: make(chan socketPacket, 256), progress: make(chan struct{}, 1)}
}
func (q *socketMailbox) offer(packet socketPacket) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(packet.payload) > q.limit-q.bytes {
		return false
	}
	select {
	case q.items <- packet:
		q.bytes += len(packet.payload)
		return true
	default:
		return false
	}
}
func (q *socketMailbox) release(packet socketPacket) {
	q.mu.Lock()
	q.bytes -= len(packet.payload)
	q.mu.Unlock()
	select {
	case q.progress <- struct{}{}:
	default:
	}
}
func (q *socketMailbox) discard() {
	for {
		select {
		case packet := <-q.items:
			q.release(packet)
		default:
			return
		}
	}
}

func (q *socketMailbox) queuedBytes() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes
}

func (c *socketConn) stopped() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

func (c *socketConn) readLoop() {
	for !c.stopped() {
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			if c.stopped() || c.peerClose.Load() != nil {
				return
			}
			c.log().Warn("websocket read failed", "error", err)
			c.retire("read-failure")
			return
		}
		if kind != websocket.BinaryMessage || len(data) < 1 || len(data) > native.MaxFrameLength {
			c.log().Warn("websocket message rejected", "opcode", kind, "bytes", len(data))
			c.retire("websocket-protocol")
			return
		}
		if c.peerClose.Load() != nil {
			return
		}
		if c.terminal.Load() {
			continue
		} // explicitly terminated; no more admission
		c.logFrame("in", data)
		if !c.in.offer(socketPacket{payload: data}) {
			c.retire("inbound-overload")
			return
		}
	}
}

// The ONLY caller of native Receive/Tick/Drain/Close. Network reader/writer and
// supervisor never acquire the engine lock. Disposal cannot race live cgo work.
func (c *socketConn) nativeLoop() {
	if c.native == nil {
		if c.productionStopped() {
			return
		}
		var err error
		c.native, err = c.open()
		if err != nil {
			c.log().Error("websocket native endpoint open failed", "error", err)
			c.retire("native-open-failure")
			return
		}
	}
	defer func() {
		if err := c.native.Close(); err != nil {
			c.log().Error("websocket native disposal failed", "error", err)
		}
	}()
	ticker := time.NewTicker(websocketTick)
	defer ticker.Stop()
	for !c.productionStopped() {
		var err error
		select {
		case <-c.closed:
			return
		case packet := <-c.in.items:
			if c.productionStopped() {
				c.in.release(packet)
				return
			}
			err = c.native.Receive(packet.payload)
			c.in.release(packet)
			if err == nil {
				if c.ready.CompareAndSwap(false, true) {
					c.log().Info("websocket application protocol ready", "negotiation_ms", time.Since(c.created).Milliseconds())
				}
			} // first successful Receive validates HELLO
		case <-ticker.C:
			if c.productionStopped() {
				return
			}
			err = c.native.Tick()
			if errors.Is(err, native.ErrNotReady) {
				continue
			}
		}
		if c.productionStopped() {
			return
		}
		if err != nil {
			if !errors.Is(err, native.ErrProtocol) {
				c.log().Error("websocket native processing failed", "error", err)
				c.retire("native-resource-failure")
				return
			}
			deadline := time.Now().Add(c.profile.terminalDrain)
			c.terminalDeadline.Store(&deadline)
			c.terminal.Store(true)
			c.log().Warn("websocket native protocol terminated; attempting ordered completion", "error", err)
			if c.drain(true) {
				c.enqueueOutput(socketPacket{terminal: true}, true)
			}
			return // no new Receive/Tick after terminal result, even on drain failure
		}
		if !c.drain(false) {
			return
		}
	}
}

func (c *socketConn) drain(terminal bool) bool {
	for count := 0; terminal || count < 256; count++ {
		if c.productionStopped() {
			return false
		}
		message, ok, err := c.native.Drain()
		if errors.Is(err, native.ErrClosed) && terminal {
			return true
		}
		if err != nil {
			c.log().Error("websocket native drain failed", "error", err)
			c.retire("native-drain-failure")
			return false
		}
		if !ok {
			return true
		}
		c.logFrame("out", message)
		if len(message) < 1 || len(message) > native.MaxFrameLength {
			c.retire("native-output-invalid")
			return false
		}
		if !c.enqueueOutput(socketPacket{payload: message}, terminal) {
			return false
		}
	}
	return true
}

// productionStopped does not close network I/O: a peer Close still needs its reply.
func (c *socketConn) productionStopped() bool { return c.stopped() || c.peerClose.Load() != nil }

func (c *socketConn) enqueueOutput(packet socketPacket, terminal bool) bool {
	// One staged max-frame copy; Drain has released its native lock before waiting.
	// Progress cannot restart this frame's independent admission window.
	deadline, outcome := time.Now().Add(c.profile.queueStall), "outbound-queue-stall"
	if terminal {
		deadline, outcome = *c.terminalDeadline.Load(), "terminal-drain-expired"
	}
	if len(packet.payload) > c.out.limit {
		c.retire("outbound-overload")
		return false
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	for !c.productionStopped() {
		if !time.Now().Before(deadline) {
			c.retire(outcome)
			return false
		}
		if c.out.offer(packet) {
			return true
		}
		select {
		case <-c.closed:
			return false
		case <-c.peerClosing:
			return false
		case <-timer.C:
			c.retire(outcome)
			return false
		case <-c.out.progress:
		}
	}
	return false
}

type socketControl struct {
	opcode  int
	payload []byte
	nonce   uint64
	created time.Time
}
type probeObservation struct {
	nonce     uint64
	at        time.Time
	submitted bool
}

func (c *socketConn) observe(observation probeObservation) {
	select {
	case c.observations <- observation:
	default:
		c.retire("control-observation-overload")
	}
}
func (c *socketConn) queueControl(control socketControl) error {
	if c.stopped() {
		return native.ErrClosed
	}
	select {
	case c.controls <- control:
		return nil
	default:
		c.retire("control-overload")
		return native.ErrQueueFull
	}
}

func (c *socketConn) writeLoop() {
	for !c.stopped() {
		if peer := c.peerClose.Load(); peer != nil {
			if err := c.ws.WriteControl(websocket.CloseMessage, peer.payload, peer.created.Add(c.profile.control)); err != nil {
				c.retire("close-write-failure")
			} else {
				c.retire("peer-close")
			}
			return
		}
		// RFC controls have reserved bounded capacity and no application sequence.
		select {
		case control := <-c.controls:
			if !c.writeControl(control) {
				return
			}
			continue
		default:
		}
		select {
		case <-c.closed:
			return
		case <-c.peerClosing:
			continue
		case control := <-c.controls:
			if !c.writeControl(control) {
				return
			}
		case packet := <-c.out.items:
			if c.peerClose.Load() != nil {
				c.out.release(packet)
				continue
			}
			if c.stopped() {
				c.out.release(packet)
				return
			}
			deadline := time.Now().Add(c.profile.write)
			if c.terminal.Load() {
				end := *c.terminalDeadline.Load()
				if end.Before(deadline) {
					deadline = end
				}
			}
			var err error
			if !time.Now().Before(deadline) {
				c.out.release(packet)
				c.retire("terminal-drain-expired")
				return
			}
			if packet.terminal {
				// Gorilla itself also marks RFC protocol-error Close as
				// ErrCloseSent before releasing its write lock. That protects
				// the reader's mandatory protocol-error response path too.
				err = c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseProtocolError, "native protocol terminated"), deadline)
			} else if err = c.ws.SetWriteDeadline(deadline); err == nil {
				err = c.ws.WriteMessage(websocket.BinaryMessage, packet.payload)
			}
			c.out.release(packet)
			if err != nil {
				c.log().Warn("websocket write failed", "error", err, "terminal", packet.terminal)
				c.retire("write-failure")
				return
			}
			if packet.terminal {
				c.retire("terminal-completed")
				return
			} // never data after Close
		}
	}
}

func (c *socketConn) writeControl(control socketControl) bool {
	if c.stopped() {
		return false
	}
	if c.peerClose.Load() != nil {
		return true
	}
	if control.nonce != 0 && (control.nonce != c.probeGeneration.Load() || c.terminal.Load()) {
		return true
	}
	deadline := control.created.Add(c.profile.control)
	if !time.Now().Before(deadline) {
		// Only the supervisor may expire its probe: it first detects its own
		// scheduling gap. Do not let a resumed writer fire an obsolete window.
		if control.nonce != 0 {
			return true
		}
		c.retire("local-control-stall")
		return false
	}
	if control.nonce != 0 {
		c.observe(probeObservation{nonce: control.nonce, at: time.Now(), submitted: true})
	}
	if c.stopped() {
		return false
	}
	if err := c.ws.WriteControl(control.opcode, control.payload, deadline); err != nil {
		c.log().Warn("websocket control write failed", "error", err, "opcode", control.opcode, "nonce", control.nonce)
		c.retire("control-write-failure")
		return false
	}
	return true
}

// Pure policy clock for deterministic deadline/scheduling-gap tests. A Pong
// cannot renew HELLO, and arbitrary traffic never resets either probe phase.
type socketPolicy struct {
	profile                                               socketProfile
	lastRun, helloDeadline, nextProbe, created, submitted time.Time
	nonce                                                 uint64
	pending                                               bool
	responses, late, unmatched, gaps, missed              uint64
	lastResponse                                          time.Duration
}

func newSocketPolicy(now time.Time, profile socketProfile) socketPolicy {
	return socketPolicy{profile: profile, lastRun: now, helloDeadline: now.Add(profile.hello), nextProbe: now}
}
func (p *socketPolicy) advance(now time.Time, ready bool) (uint64, string) {
	if now.Sub(p.lastRun) > p.profile.schedulingGap {
		p.gaps++
		if p.pending {
			p.missed++
		}
		p.pending = false
		p.nextProbe = now
		if !ready {
			p.helloDeadline = now.Add(p.profile.hello)
		}
	}
	p.lastRun = now
	if !ready && !now.Before(p.helloDeadline) {
		return 0, "hello-unavailable"
	}
	if p.pending {
		if p.submitted.IsZero() {
			if !now.Before(p.created.Add(p.profile.control)) {
				p.missed++
				return 0, "local-control-stall"
			}
		} else if !now.Before(p.submitted.Add(p.profile.response)) {
			p.missed++
			return 0, "response-unavailable"
		}
		return 0, ""
	}
	if now.Before(p.nextProbe) {
		return 0, ""
	}
	p.nonce++
	p.pending = true
	p.created = now
	p.submitted = time.Time{}
	return p.nonce, ""
}
func (p *socketPolicy) observe(o probeObservation) {
	if !p.pending || o.nonce != p.nonce || o.at.Before(p.created) {
		if !o.submitted {
			p.unmatched++
		}
		return
	}
	if o.submitted {
		if p.submitted.IsZero() {
			p.submitted = o.at
		}
	} else if !p.submitted.IsZero() {
		p.responses++
		p.lastResponse = o.at.Sub(p.submitted)
		if p.lastResponse > p.profile.response {
			p.late++
		}
		p.pending = false
		p.nextProbe = o.at.Add(p.profile.probeInterval)
	}
}

// Shutdown/abort interrupt I/O without waiting for native work. run still joins
// all users; a caller deadline only stops that caller waiting, never frees cgo.
func (c *socketConn) closeNetwork() { c.retire("forced-close") }
func (c *socketConn) retire(outcome string) {
	c.stopOnce.Do(func() {
		c.outcome = outcome
		close(c.closed)
		_ = c.ws.Close()
		c.log().Info("websocket retired", "outcome", outcome, "duration_ms", time.Since(c.created).Milliseconds(), "ready", c.ready.Load(), "remote", c.remote)
	})
}
