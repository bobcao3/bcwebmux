package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/gorilla/websocket"
)

type testWireFrame struct {
	kind int
	data []byte
}
type testSocketNetwork struct {
	input      chan testWireFrame
	writes     chan testWireFrame
	started    chan testWireFrame
	parsed     chan int
	closed     chan struct{}
	once       sync.Once
	gate       chan struct{}
	ping, pong func(string) error
	peerClose  func(int, string) error
}

func newTestSocketNetwork() *testSocketNetwork {
	return &testSocketNetwork{input: make(chan testWireFrame, 32), writes: make(chan testWireFrame, 64), started: make(chan testWireFrame, 64), parsed: make(chan int, 64), closed: make(chan struct{})}
}
func (w *testSocketNetwork) ReadMessage() (int, []byte, error) {
	for {
		select {
		case <-w.closed:
			return 0, nil, errors.New("closed")
		case frame := <-w.input:
			var err error
			switch frame.kind {
			case websocket.PingMessage:
				err = w.ping(string(frame.data))
			case websocket.PongMessage:
				err = w.pong(string(frame.data))
			case websocket.CloseMessage:
				err = w.peerClose(1000, "")
				if err == nil {
					err = &websocket.CloseError{Code: 1000}
				}
			default:
				return frame.kind, frame.data, nil
			}
			w.parsed <- frame.kind
			if err != nil {
				return 0, nil, err
			}
		}
	}
}
func (w *testSocketNetwork) WriteMessage(kind int, data []byte) error {
	frame := testWireFrame{kind, append([]byte(nil), data...)}
	w.started <- frame
	if w.gate != nil {
		select {
		case <-w.gate:
		case <-w.closed:
			return errors.New("closed")
		}
	}
	select {
	case <-w.closed:
		return errors.New("closed")
	default:
	}
	w.writes <- frame
	return nil
}
func (w *testSocketNetwork) WriteControl(kind int, data []byte, _ time.Time) error {
	select {
	case <-w.closed:
		return errors.New("closed")
	default:
	}
	w.writes <- testWireFrame{kind, append([]byte(nil), data...)}
	return nil
}
func (*testSocketNetwork) SetWriteDeadline(time.Time) error            { return nil }
func (w *testSocketNetwork) SetPingHandler(f func(string) error)       { w.ping = f }
func (w *testSocketNetwork) SetPongHandler(f func(string) error)       { w.pong = f }
func (w *testSocketNetwork) SetCloseHandler(f func(int, string) error) { w.peerClose = f }
func (w *testSocketNetwork) Close() error                              { w.once.Do(func() { close(w.closed) }); return nil }

// Every method asserts the ABI's no-overlap rule, including disposal.
type testNativeSocket struct {
	receive    func([]byte) error
	tick       func() error
	queue      [][]byte // accessed only by native owner
	active     atomic.Bool
	overlapped atomic.Bool
	closes     atomic.Int32
	receives   atomic.Int32
	drains     atomic.Int32
}

func (s *testNativeSocket) enter() func() {
	if s.active.Swap(true) {
		s.overlapped.Store(true)
	}
	return func() { s.active.Store(false) }
}
func (s *testNativeSocket) Receive(data []byte) error {
	defer s.enter()()
	s.receives.Add(1)
	if s.receive != nil {
		return s.receive(data)
	}
	return nil
}
func (s *testNativeSocket) Tick() error {
	defer s.enter()()
	if s.tick != nil {
		return s.tick()
	}
	return native.ErrNotReady
}
func (s *testNativeSocket) Drain() ([]byte, bool, error) {
	defer s.enter()()
	s.drains.Add(1)
	if len(s.queue) == 0 {
		return nil, false, nil
	}
	data := s.queue[0]
	s.queue = s.queue[1:]
	return data, true, nil
}
func (s *testNativeSocket) Close() error {
	defer s.enter()()
	s.closes.Add(1)
	return nil
}
func awaitSocket[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("socket test event timed out")
		var zero T
		return zero
	}
}
func launchTestSocket(t *testing.T, wire *testSocketNetwork, endpoint *testNativeSocket, profile socketProfile) (*socketConn, <-chan struct{}) {
	t.Helper()
	conn := &socketConn{ws: wire, native: endpoint, closed: make(chan struct{}), profile: profile}
	done := make(chan struct{})
	go func() { conn.run(context.Background()); close(done) }()
	t.Cleanup(func() { conn.closeNetwork(); awaitSocket(t, done) })
	return conn, done
}
func assertSocketDisposed(t *testing.T, c *socketConn, s *testNativeSocket) {
	t.Helper()
	if s.closes.Load() != 1 || s.overlapped.Load() {
		t.Fatalf("native closes=%d overlap=%v", s.closes.Load(), s.overlapped.Load())
	}
	if c.in.bytes != 0 || c.out.bytes != 0 {
		t.Fatalf("queued bytes after join: in=%d out=%d", c.in.bytes, c.out.bytes)
	}
}
func nextWireKind(t *testing.T, wire *testSocketNetwork, kind int) testWireFrame {
	t.Helper()
	for {
		frame := awaitSocket(t, wire.writes)
		if frame.kind == kind {
			return frame
		}
	}
}

func TestSocketReaderControlsIndependentOfNativeAndJoinedDisposal(t *testing.T) {
	wire := newTestSocketNetwork()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	endpoint := &testNativeSocket{receive: func([]byte) error { close(entered); <-release; return nil }}
	conn, done := launchTestSocket(t, wire, endpoint, socketProfile{})
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("hello")}
	awaitSocket(t, entered)
	wire.input <- testWireFrame{websocket.PingMessage, []byte("peer probe")}
	if got := string(nextWireKind(t, wire, websocket.PongMessage).data); got != "peer probe" {
		t.Fatal(got)
	}
	conn.closeNetwork()
	if endpoint.closes.Load() != 0 {
		t.Fatal("freed a live native call")
	}
	select {
	case <-done:
		t.Fatal("run returned before native join")
	default:
	}
	once.Do(func() { close(release) })
	awaitSocket(t, done)
	assertSocketDisposed(t, conn, endpoint)
}

func TestSocketBlockedWriterDoesNotBlockNativeInputOrReader(t *testing.T) {
	wire := newTestSocketNetwork()
	wire.gate = make(chan struct{})
	received := make(chan string, 4)
	endpoint := &testNativeSocket{}
	endpoint.receive = func(data []byte) error {
		received <- string(data)
		if string(data) == "hello" {
			endpoint.queue = append(endpoint.queue, []byte("output"))
		}
		return nil
	}
	conn, done := launchTestSocket(t, wire, endpoint, socketProfile{})
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("hello")}
	awaitSocket(t, received)
	awaitSocket(t, wire.started)
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("input")}
	if got := awaitSocket(t, received); got != "input" {
		t.Fatal(got)
	}
	wire.input <- testWireFrame{websocket.PongMessage, []byte("12345678")}
	if got := awaitSocket(t, wire.parsed); got != websocket.PongMessage {
		t.Fatal(got)
	}
	conn.closeNetwork()
	awaitSocket(t, done)
	assertSocketDisposed(t, conn, endpoint)
}

func TestSocketInboundAdmissionIncludesBlockedNativeCall(t *testing.T) {
	wire := newTestSocketNetwork()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	endpoint := &testNativeSocket{receive: func([]byte) error { close(entered); <-release; return nil }}
	profile := defaultSocketProfile
	profile.inboundBytes = 1
	conn, done := launchTestSocket(t, wire, endpoint, profile)
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("a")}
	awaitSocket(t, entered)
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("b")}
	awaitSocket(t, conn.closed)
	if conn.outcome != "inbound-overload" {
		t.Fatal(conn.outcome)
	}
	if endpoint.closes.Load() != 0 || endpoint.receives.Load() != 1 {
		t.Fatal("admitted overload or freed live native work")
	}
	once.Do(func() { close(release) })
	awaitSocket(t, done)
	assertSocketDisposed(t, conn, endpoint)
}

func TestSocketTerminalFIFOCompletionWaitsOutsideNativeLocks(t *testing.T) {
	wire := newTestSocketNetwork()
	wire.gate = make(chan struct{}, 3)
	terminal := make(chan struct{})
	endpoint := &testNativeSocket{}
	endpoint.receive = func(data []byte) error {
		if string(data) == "hello" {
			endpoint.queue = append(endpoint.queue, []byte("A"))
			return nil
		}
		endpoint.queue = append(endpoint.queue, []byte("B"), []byte("E"))
		close(terminal)
		return native.ErrProtocol
	}
	profile := defaultSocketProfile
	profile.outboundBytes = 1
	conn, done := launchTestSocket(t, wire, endpoint, profile)
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("hello")}
	awaitSocket(t, wire.started)
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("bad")}
	awaitSocket(t, terminal)
	// A occupies the full byte budget. B/E must wait, never overtake A or
	// terminate just because the writer has no capacity at the terminal result.
	for range 3 {
		wire.gate <- struct{}{}
	}
	var output string
	for {
		frame := awaitSocket(t, wire.writes)
		if frame.kind == websocket.CloseMessage {
			break
		}
		if frame.kind == websocket.BinaryMessage {
			output += string(frame.data)
		}
	}
	awaitSocket(t, done)
	if output != "ABE" || conn.outcome != "terminal-completed" {
		t.Fatalf("output=%q outcome=%s", output, conn.outcome)
	}
	if endpoint.receives.Load() != 2 {
		t.Fatal("fresh production after terminal outcome")
	}
	select {
	case frame := <-wire.writes:
		t.Fatalf("write after Close: %+v", frame)
	default:
	}
	assertSocketDisposed(t, conn, endpoint)
}

func TestSocketTerminalAbortDiscardsUnsendableError(t *testing.T) {
	for _, reason := range []string{"terminal-drain-expired", "forced-close"} {
		t.Run(reason, func(t *testing.T) {
			wire := newTestSocketNetwork()
			wire.gate = make(chan struct{})
			endpoint := &testNativeSocket{}
			endpoint.receive = func([]byte) error {
				endpoint.queue = append(endpoint.queue, []byte("ERROR"))
				return native.ErrProtocol
			}
			profile := defaultSocketProfile
			if reason == "terminal-drain-expired" {
				profile.terminalDrain = 40 * time.Millisecond
			}
			conn, done := launchTestSocket(t, wire, endpoint, profile)
			wire.input <- testWireFrame{websocket.BinaryMessage, []byte("bad")}
			awaitSocket(t, wire.started)
			switch reason {
			case "forced-close":
				conn.closeNetwork()
			}
			awaitSocket(t, done)
			if conn.outcome != reason {
				t.Fatal(conn.outcome)
			}
			for len(wire.writes) > 0 {
				frame := <-wire.writes
				if frame.kind == websocket.BinaryMessage || frame.kind == websocket.CloseMessage {
					t.Fatalf("sent terminal data/Close after abort: %+v", frame)
				}
			}
			assertSocketDisposed(t, conn, endpoint)
		})
	}
}

func TestSocketNativeResourceFailureDoesNotAttemptTerminalDelivery(t *testing.T) {
	wire := newTestSocketNetwork()
	endpoint := &testNativeSocket{}
	endpoint.receive = func([]byte) error {
		endpoint.queue = append(endpoint.queue, []byte("unsendable"))
		return native.ErrQueueFull
	}
	conn, done := launchTestSocket(t, wire, endpoint, socketProfile{})
	wire.input <- testWireFrame{websocket.BinaryMessage, []byte("hello")}
	awaitSocket(t, done)
	if conn.outcome != "native-resource-failure" || endpoint.drains.Load() != 0 {
		t.Fatal("resource failure attempted terminal drain")
	}
	assertSocketDisposed(t, conn, endpoint)
}

func TestWebSocketTickBeforeHello(t *testing.T) {
	wire := newTestSocketNetwork()
	ticked := make(chan struct{}, 1)
	endpoint := &testNativeSocket{tick: func() error {
		select {
		case ticked <- struct{}{}:
		default:
		}
		return native.ErrNotReady
	}}
	conn, done := launchTestSocket(t, wire, endpoint, socketProfile{})
	awaitSocket(t, ticked)
	conn.closeNetwork()
	awaitSocket(t, done)
	if endpoint.drains.Load() != 0 {
		t.Fatal("pending negotiation tick drained output")
	}
	assertSocketDisposed(t, conn, endpoint)
}

func TestSocketProfileAndPhaseDeadlines(t *testing.T) {
	profile := defaultSocketProfile
	for _, d := range []time.Duration{profile.hello, profile.probeInterval, profile.response, profile.control, profile.write, profile.terminalDrain, profile.schedulingGap, profile.queueStall} {
		if d <= 0 {
			t.Fatal("nonpositive profile budget")
		}
	}
	now := time.Unix(1000, 0)
	t.Run("submission has independent finite window", func(t *testing.T) {
		p := newSocketPolicy(now, profile)
		nonce, outcome := p.advance(now, true)
		if nonce == 0 || outcome != "" {
			t.Fatal("missing probe")
		}
		for i := 1; i < 5; i++ {
			if _, outcome := p.advance(now.Add(time.Duration(i)*time.Second), true); outcome != "" {
				t.Fatal(outcome)
			}
		}
		if _, outcome := p.advance(now.Add(5*time.Second), true); outcome != "local-control-stall" {
			t.Fatal(outcome)
		}
	})
	t.Run("response never borrows RTT or ordinary traffic", func(t *testing.T) {
		p := newSocketPolicy(now, profile)
		nonce, _ := p.advance(now, true)
		p.observe(probeObservation{nonce: nonce, at: now, submitted: true})
		for i := 1; i < 15; i++ {
			p.observe(probeObservation{nonce: nonce + 1, at: now.Add(time.Duration(i) * time.Second)})
			if _, outcome := p.advance(now.Add(time.Duration(i)*time.Second), true); outcome != "" {
				t.Fatal(outcome)
			}
		}
		if _, outcome := p.advance(now.Add(15*time.Second), true); outcome != "response-unavailable" {
			t.Fatal(outcome)
		}
	})
	t.Run("late matching pong and paced next probe", func(t *testing.T) {
		p := newSocketPolicy(now, profile)
		nonce, _ := p.advance(now, true)
		p.observe(probeObservation{nonce: nonce, at: now, submitted: true})
		for i := 1; i <= 14; i++ {
			p.advance(now.Add(time.Duration(i)*time.Second), true)
		}
		p.observe(probeObservation{nonce: nonce, at: now.Add(14 * time.Second)})
		for i := 15; i < 19; i++ {
			if next, outcome := p.advance(now.Add(time.Duration(i)*time.Second), true); next != 0 || outcome != "" {
				t.Fatalf("unpaced probe: %d %s", next, outcome)
			}
		}
		if next, outcome := p.advance(now.Add(19*time.Second), true); next != nonce+1 || outcome != "" {
			t.Fatalf("next probe: %d %s", next, outcome)
		}
	})
	t.Run("RFC pong cannot extend HELLO", func(t *testing.T) {
		p := newSocketPolicy(now, profile)
		for i := 0; i <= 10; i++ {
			at := now.Add(time.Duration(i) * time.Second)
			nonce, outcome := p.advance(at, false)
			if i == 10 {
				if outcome != "hello-unavailable" {
					t.Fatal(outcome)
				}
				return
			}
			if outcome != "" {
				t.Fatal(outcome)
			}
			if nonce != 0 {
				p.observe(probeObservation{nonce: nonce, at: at, submitted: true})
				p.observe(probeObservation{nonce: nonce, at: at})
			}
		}
	})
	t.Run("scheduling gap invalidates old response and negotiation windows", func(t *testing.T) {
		p := newSocketPolicy(now, profile)
		old, _ := p.advance(now, false)
		p.observe(probeObservation{nonce: old, at: now, submitted: true})
		resume := now.Add(time.Minute)
		fresh, outcome := p.advance(resume, false)
		if fresh == old || fresh == 0 || outcome != "" || !p.helloDeadline.Equal(resume.Add(profile.hello)) {
			t.Fatalf("resume: %+v", p)
		}
		p.observe(probeObservation{nonce: old, at: resume})
		if !p.pending || !p.submitted.IsZero() {
			t.Fatal("old PONG renewed fresh probe")
		}
	})
}

func TestSocketMailboxBoundsInFlightBytesAndFrameCount(t *testing.T) {
	q := newSocketMailbox(2)
	if !q.offer(socketPacket{payload: []byte("ab")}) {
		t.Fatal("initial offer")
	}
	packet := <-q.items
	if q.offer(socketPacket{payload: []byte("c")}) {
		t.Fatal("in-flight bytes were not counted")
	}
	q.release(packet)
	if !q.offer(socketPacket{payload: []byte("c")}) {
		t.Fatal("capacity not released")
	}
	q.discard()
	q = newSocketMailbox(1024)
	for range 256 {
		if !q.offer(socketPacket{payload: []byte("a")}) {
			t.Fatal("early frame limit")
		}
	}
	if q.offer(socketPacket{payload: []byte("b")}) {
		t.Fatal("missing frame-count bound")
	}
}

func TestSocketNormalQueueBackpressure(t *testing.T) {
	for _, stalled := range []bool{false, true} {
		t.Run(map[bool]string{false: "transient-full", true: "bounded-stall"}[stalled], func(t *testing.T) {
			wire := newTestSocketNetwork()
			profile := defaultSocketProfile
			if stalled {
				profile.queueStall = 40 * time.Millisecond
			}
			c := &socketConn{ws: wire, closed: make(chan struct{}), peerClosing: make(chan struct{}), out: newSocketMailbox(1), profile: profile}
			defer c.closeNetwork()
			// Unbuffered progress provides a deterministic rendezvous proving
			// the producer reached its full-queue wait, rather than racing it.
			c.out.progress = make(chan struct{})
			c.out.offer(socketPacket{payload: []byte("A")})
			done := make(chan bool, 1)
			go func() { done <- c.enqueueOutput(socketPacket{payload: []byte("B")}, false) }()
			select {
			case c.out.progress <- struct{}{}:
			case <-time.After(time.Second):
				t.Fatal("never waited for capacity")
			}
			if stalled {
				if awaitSocket(t, done) || c.outcome != "outbound-queue-stall" {
					t.Fatal("unbounded or incorrect queue-stall outcome")
				}
				return
			}
			if c.stopped() {
				t.Fatal("transient fullness retired connection")
			}
			first := <-c.out.items
			if string(first.payload) != "A" {
				t.Fatal("FIFO changed")
			}
			c.out.release(first)
			var admitted bool
			select {
			case c.out.progress <- struct{}{}:
				admitted = awaitSocket(t, done)
			case admitted = <-done:
			}
			if !admitted || c.stopped() || string((<-c.out.items).payload) != "B" {
				t.Fatal("writer progress did not preserve session/FIFO")
			}
		})
	}
}

func TestSocketPeerCloseReplyDropsQueuedData(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(map[bool]string{false: "reply", true: "deadline-abort"}[blocked], func(t *testing.T) {
			wire := newTestSocketNetwork()
			wire.gate = make(chan struct{}, 1)
			endpoint := &testNativeSocket{}
			endpoint.receive = func([]byte) error {
				endpoint.queue = append(endpoint.queue, []byte("in-flight"), []byte("discard"))
				return nil
			}
			profile := defaultSocketProfile
			// The in-flight write consumes all capacity. Peer Close must also
			// wake the native owner waiting to admit its one staged next frame.
			profile.outboundBytes = len("in-flight")
			if blocked {
				profile.control = 40 * time.Millisecond
			}
			c, done := launchTestSocket(t, wire, endpoint, profile)
			wire.input <- testWireFrame{websocket.BinaryMessage, []byte("hello")}
			awaitSocket(t, wire.started)
			wire.input <- testWireFrame{websocket.CloseMessage, nil}
			awaitSocket(t, wire.parsed)
			if !blocked {
				wire.gate <- struct{}{}
			}
			awaitSocket(t, done)
			if blocked {
				if c.outcome != "peer-close-expired" {
					t.Fatal(c.outcome)
				}
			} else {
				if c.outcome != "peer-close" {
					t.Fatal(c.outcome)
				}
				var data string
				closes := 0
				sawClose := false
				for len(wire.writes) > 0 {
					frame := <-wire.writes
					if sawClose {
						t.Fatal("write after Close")
					}
					if frame.kind == websocket.BinaryMessage {
						data += string(frame.data)
					}
					if frame.kind == websocket.CloseMessage {
						sawClose = true
						closes++
						if string(frame.data) != string(websocket.FormatCloseMessage(1000, "")) {
							t.Fatal("Close code not echoed")
						}
					}
				}
				if closes != 1 || data != "in-flight" {
					t.Fatalf("closes=%d data=%q", closes, data)
				}
			}
			assertSocketDisposed(t, c, endpoint)
		})
	}
}

func TestSocketPeerCloseRealWebSocketHandshake(t *testing.T) {
	done := make(chan struct{})
	endpoint := &testNativeSocket{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		upgrader := websocket.Upgrader{}
		wire, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		c := &socketConn{ws: wire, native: endpoint, closed: make(chan struct{})}
		c.run(r.Context())
		if c.outcome != "peer-close" {
			t.Errorf("outcome=%s", c.outcome)
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "done"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err = client.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != 1000 || closeErr.Text != "done" {
		t.Fatalf("expected orderly echo, not 1006: %v", err)
	}
	awaitSocket(t, done)
	if endpoint.closes.Load() != 1 || endpoint.overlapped.Load() {
		t.Fatal("native ownership failed during close handshake")
	}
}

func TestSocketWriterCannotExpireObsoleteProbeWindow(t *testing.T) {
	wire := newTestSocketNetwork()
	conn := &socketConn{ws: wire, closed: make(chan struct{}), profile: defaultSocketProfile}
	conn.probeGeneration.Store(1)
	// A stalled writer resumes before the supervisor can invalidate its old
	// timing window. The writer must not become a second liveness authority.
	if !conn.writeControl(socketControl{opcode: websocket.PingMessage, nonce: 1, payload: []byte("12345678"), created: time.Now().Add(-time.Minute)}) {
		t.Fatal("writer retired an obsolete probe")
	}
	if conn.stopped() || len(wire.writes) != 0 {
		t.Fatal("obsolete probe was sent or retired")
	}
}

func TestResizeTelemetryIsStructuredAndCorrelated(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})).With("connection_id", 17)
	conn := &socketConn{logger: logger}
	frame := make([]byte, 88)
	binary.LittleEndian.PutUint32(frame[0:4], 0x53574342)
	frame[4] = 20
	binary.LittleEndian.PutUint64(frame[16:24], 3)
	binary.LittleEndian.PutUint64(frame[24:32], 9)
	binary.LittleEndian.PutUint64(frame[32:40], 11)
	frame[48] = 0xaa
	binary.LittleEndian.PutUint16(frame[80:82], 120)
	binary.LittleEndian.PutUint16(frame[82:84], 40)
	binary.LittleEndian.PutUint16(frame[84:86], 9)
	binary.LittleEndian.PutUint16(frame[86:88], 18)
	conn.logFrame("in", frame)

	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	for field, expected := range map[string]any{
		"msg": "terminal resize lifecycle", "connection_id": float64(17),
		"frame_type": "resize_request", "sigwinch_stage": "requested",
		"cols": float64(120), "rows": float64(40),
	} {
		if event[field] != expected {
			t.Errorf("%s=%v, want %v", field, event[field], expected)
		}
	}
}

func TestSocketHelloWindowCoversBlockedNativeOpen(t *testing.T) {
	wire := newTestSocketNetwork()
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	endpoint := &testNativeSocket{}
	profile := defaultSocketProfile
	profile.hello = 40 * time.Millisecond
	conn := &socketConn{ws: wire, closed: make(chan struct{}), profile: profile, open: func() (native.Socket, error) { close(entered); <-release; return endpoint, nil }}
	go func() { conn.run(context.Background()); close(done) }()
	t.Cleanup(func() { conn.closeNetwork(); awaitSocket(t, done) })
	awaitSocket(t, entered)
	awaitSocket(t, conn.closed)
	if conn.outcome != "hello-unavailable" {
		t.Fatal(conn.outcome)
	}
	select {
	case <-done:
		t.Fatal("run returned while native open still live")
	default:
	}
	once.Do(func() { close(release) })
	awaitSocket(t, done)
	assertSocketDisposed(t, conn, endpoint)
}
