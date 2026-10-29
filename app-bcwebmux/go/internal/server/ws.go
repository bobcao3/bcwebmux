package server

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/coder/websocket"
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
// *websocket.Conn implements it. The library answers peer Pings, echoes a peer
// Close after any in-flight frame, and orders control frames with data frames.
type socketNetwork interface {
	Read(context.Context) (websocket.MessageType, []byte, error)
	Write(context.Context, websocket.MessageType, []byte) error
	Ping(context.Context) error
	Close(websocket.StatusCode, string) error
	CloseNow() error
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
	observations     chan probeObservation
	ready            atomic.Bool
	terminal         atomic.Bool
	terminalDeadline atomic.Pointer[time.Time]
	closeSent        atomic.Bool // the writer began its own Close handshake
	inMessages       atomic.Uint64
	inBytes          atomic.Uint64
	outMessages      atomic.Uint64
	outBytes         atomic.Uint64

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
	if !slices.Contains(requestedSubprotocols(r), native.Protocol) {
		s.logger.Warn("websocket upgrade rejected", "reason", "subprotocol", "remote", r.RemoteAddr)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	conn, err := acceptWebSocket(w, r)
	if err != nil {
		s.logger.Warn("websocket upgrade failed", "remote", r.RemoteAddr, "error", err)
		return
	}

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

// requestedSubprotocols lists the client's offered subprotocol tokens.
func requestedSubprotocols(r *http.Request) []string {
	var protocols []string
	for _, value := range r.Header.Values("Sec-WebSocket-Protocol") {
		for token := range strings.SplitSeq(value, ",") {
			if token = strings.TrimSpace(token); token != "" {
				protocols = append(protocols, token)
			}
		}
	}
	return protocols
}

// acceptWebSocket upgrades a request whose origin and subprotocol the caller
// already authorized, so the library's own origin rule is not applied twice.
func acceptWebSocket(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{native.Protocol},
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(native.MaxFrameLength)
	return conn, nil
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
	c.observations = make(chan probeObservation, 64)
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
				// Ping hands the frame to the library's ordered writer at once.
				observe(probeObservation{nonce: nonce, at: now, submitted: true})
				users.Add(1)
				go func() { defer users.Done(); c.ping(nonce) }()
			}
		}
	}
}

// ping runs one RFC probe: the library writes the Ping and matches its Pong.
// Only the supervisor's policy turns a missing response into retirement.
func (c *socketConn) ping(nonce uint64) {
	ctx, cancel := context.WithTimeout(context.Background(), c.profile.response)
	defer cancel()
	if c.ws.Ping(ctx) == nil {
		c.observe(probeObservation{nonce: nonce, at: time.Now()})
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
	if len(data) < 2 || data[0] < 1 || data[0] > 24 {
		c.log().Debug("websocket application frame", "direction", direction, "bytes", len(data), "valid_header", false)
		return
	}
	frameType := data[0]
	if frameType != 20 && frameType != 21 && !c.log().Enabled(context.Background(), slog.LevelDebug) {
		return
	}
	headerLength := 2
	attachmentOffset, requestOffset, sessionOffset := 0, 0, 0
	switch frameType {
	case 1, 2, 4, 23, 24:
	default:
		attachmentOffset = headerLength
		headerLength += 16
	}
	switch frameType {
	case 1, 2, 3, 5, 6, 7, 12, 16, 17, 18, 19, 20, 21:
		requestOffset = headerLength
		headerLength += 8
	}
	if frameType == 5 {
		sessionOffset = headerLength
		headerLength += 16
	}
	if len(data) < headerLength {
		c.log().Debug("websocket application frame", "direction", direction, "bytes", len(data), "valid_header", false)
		return
	}
	args := []any{
		"direction", direction, "frame_type", frameTypeName(frameType), "bytes", len(data),
	}
	if attachmentOffset != 0 {
		id := slices.Clone(data[attachmentOffset : attachmentOffset+16])
		slices.Reverse(id)
		args = append(args, "attachment_id", hex.EncodeToString(id))
	}
	if requestOffset != 0 {
		args = append(args, "request_id", binary.LittleEndian.Uint64(data[requestOffset:]))
	}
	if sessionOffset != 0 {
		args = append(args, "session_id", hex.EncodeToString(data[sessionOffset:headerLength]))
	}
	if (frameType == 20 || frameType == 21) && len(data) >= headerLength+24 {
		payload := data[headerLength:]
		geometry := payload[16:24]
		stage := "queued"
		if frameType == 20 {
			stage = "requested"
		} else {
			args = append(args, "operation_id", binary.LittleEndian.Uint64(payload[8:16]))
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
		kind, data, err := c.ws.Read(context.Background())
		if err != nil {
			// After its own Close the writer reports the outcome, echoed or not.
			if c.stopped() || c.closeSent.Load() {
				return
			}
			var peer websocket.CloseError
			if errors.As(err, &peer) {
				// RFC 6455 5.5.1: the library already echoed it after any in-flight frame.
				c.log().Info("websocket peer close received", "code", int(peer.Code), "reason", peer.Reason)
				c.retire("peer-close")
				return
			}
			c.log().Warn("websocket read failed", "error", err)
			c.retire("read-failure")
			return
		}
		if kind != websocket.MessageBinary || len(data) < 1 || len(data) > native.MaxFrameLength {
			c.log().Warn("websocket message rejected", "opcode", kind, "bytes", len(data))
			c.retire("websocket-protocol")
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
		if c.stopped() {
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
	for !c.stopped() {
		var err error
		select {
		case <-c.closed:
			return
		case packet := <-c.in.items:
			if c.stopped() {
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
			if c.stopped() {
				return
			}
			err = c.native.Tick()
			if errors.Is(err, native.ErrNotReady) {
				continue
			}
		}
		if c.stopped() {
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
		if c.stopped() {
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
	for !c.stopped() {
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
		case <-timer.C:
			c.retire(outcome)
			return false
		case <-c.out.progress:
		}
	}
	return false
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

func (c *socketConn) writeLoop() {
	for !c.stopped() {
		select {
		case <-c.closed:
			return
		case packet := <-c.out.items:
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
			if !time.Now().Before(deadline) {
				c.out.release(packet)
				c.retire("terminal-drain-expired")
				return
			}
			if packet.terminal {
				c.out.release(packet)
				// The library marks the Close sent before releasing its write
				// lock, so no data can follow it, then awaits the echo (bounded).
				c.closeSent.Store(true)
				if err := c.ws.Close(websocket.StatusProtocolError, "native protocol terminated"); err != nil && !c.stopped() {
					c.log().Warn("websocket close handshake incomplete", "error", err)
					c.retire("close-handshake-incomplete")
					return
				}
				c.retire("terminal-completed")
				return
			}
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			err := c.ws.Write(ctx, websocket.MessageBinary, packet.payload)
			cancel()
			c.out.release(packet)
			if err != nil {
				// A connection already closed by a peer Close, read failure or
				// retirement is reported by whichever path closed it.
				if c.stopped() || errors.Is(err, net.ErrClosed) {
					return
				}
				c.log().Warn("websocket write failed", "error", err)
				c.retire("write-failure")
				return
			}
		}
	}
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
		_ = c.ws.CloseNow()
		c.log().Info("websocket retired", "outcome", outcome, "duration_ms", time.Since(c.created).Milliseconds(), "ready", c.ready.Load(), "remote", c.remote)
	})
}
