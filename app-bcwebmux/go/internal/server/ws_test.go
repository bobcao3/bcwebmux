package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/coder/websocket"
)

// Wire frame kinds the fake records; the library's MessageType covers only data.
type testWireKind int

const (
	wireBinary testWireKind = iota + 1
	wireText
	wirePing
	wirePong
	wireClose
)

type testWireFrame struct {
	kind testWireKind
	data []byte
}

// testSocketNetwork emulates the library contract: Read answers a Ping and
// echoes a peer Close itself, and Ping waits for its matching Pong.
type testSocketNetwork struct {
	input   chan testWireFrame
	writes  chan testWireFrame
	started chan testWireFrame
	parsed  chan testWireKind
	closed  chan struct{}
	once    sync.Once
	gate    chan struct{}
	pings   atomic.Int64
	mu      sync.Mutex
	pongs   map[string]chan struct{}
}

func newTestSocketNetwork() *testSocketNetwork {
	return &testSocketNetwork{input: make(chan testWireFrame, 32), writes: make(chan testWireFrame, 256), started: make(chan testWireFrame, 64), parsed: make(chan testWireKind, 256), closed: make(chan struct{}), pongs: map[string]chan struct{}{}}
}
func closePayload(code websocket.StatusCode, reason string) []byte {
	payload := binary.BigEndian.AppendUint16(nil, uint16(code))
	return append(payload, reason...)
}
func (w *testSocketNetwork) Read(context.Context) (websocket.MessageType, []byte, error) {
	for {
		select {
		case <-w.closed:
			return 0, nil, net.ErrClosed
		case frame := <-w.input:
			switch frame.kind {
			case wireBinary:
				return websocket.MessageBinary, frame.data, nil
			case wireText:
				return websocket.MessageText, frame.data, nil
			case wirePing:
				w.writes <- testWireFrame{wirePong, frame.data}
			case wirePong:
				w.mu.Lock()
				if pong := w.pongs[string(frame.data)]; pong != nil {
					delete(w.pongs, string(frame.data))
					close(pong)
				}
				w.mu.Unlock()
			case wireClose:
				w.writes <- testWireFrame{wireClose, closePayload(websocket.StatusNormalClosure, "")}
				_ = w.CloseNow()
				w.parsed <- frame.kind
				return 0, nil, fmt.Errorf("received close frame: %w", websocket.CloseError{Code: websocket.StatusNormalClosure})
			}
			w.parsed <- frame.kind
		}
	}
}
func (w *testSocketNetwork) Write(_ context.Context, kind websocket.MessageType, data []byte) error {
	frame := testWireFrame{wireBinary, append([]byte(nil), data...)}
	if kind == websocket.MessageText {
		frame.kind = wireText
	}
	w.started <- frame
	if w.gate != nil {
		select {
		case <-w.gate:
		case <-w.closed:
			return net.ErrClosed
		}
	}
	select {
	case <-w.closed:
		return net.ErrClosed
	default:
	}
	w.writes <- frame
	return nil
}
func (w *testSocketNetwork) Ping(ctx context.Context) error {
	payload := strconv.FormatInt(w.pings.Add(1), 10)
	pong := make(chan struct{})
	w.mu.Lock()
	w.pongs[payload] = pong
	w.mu.Unlock()
	select {
	case <-w.closed:
		return net.ErrClosed
	default:
	}
	w.writes <- testWireFrame{wirePing, []byte(payload)}
	select {
	case <-pong:
		return nil
	case <-w.closed:
		return net.ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (w *testSocketNetwork) Close(code websocket.StatusCode, reason string) error {
	select {
	case <-w.closed:
		return net.ErrClosed
	default:
	}
	w.writes <- testWireFrame{wireClose, closePayload(code, reason)}
	return w.CloseNow()
}
func (w *testSocketNetwork) CloseNow() error { w.once.Do(func() { close(w.closed) }); return nil }

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
func nextWireKind(t *testing.T, wire *testSocketNetwork, kind testWireKind) testWireFrame {
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
	wire.input <- testWireFrame{wireBinary, []byte("hello")}
	awaitSocket(t, entered)
	wire.input <- testWireFrame{wirePing, []byte("peer probe")}
	if got := string(nextWireKind(t, wire, wirePong).data); got != "peer probe" {
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
	wire.input <- testWireFrame{wireBinary, []byte("hello")}
	awaitSocket(t, received)
	awaitSocket(t, wire.started)
	wire.input <- testWireFrame{wireBinary, []byte("input")}
	if got := awaitSocket(t, received); got != "input" {
		t.Fatal(got)
	}
	wire.input <- testWireFrame{wirePong, []byte("12345678")}
	if got := awaitSocket(t, wire.parsed); got != wirePong {
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
	wire.input <- testWireFrame{wireBinary, []byte("a")}
	awaitSocket(t, entered)
	wire.input <- testWireFrame{wireBinary, []byte("b")}
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
	wire.input <- testWireFrame{wireBinary, []byte("hello")}
	awaitSocket(t, wire.started)
	wire.input <- testWireFrame{wireBinary, []byte("bad")}
	awaitSocket(t, terminal)
	// A occupies the full byte budget. B/E must wait, never overtake A or
	// terminate just because the writer has no capacity at the terminal result.
	for range 3 {
		wire.gate <- struct{}{}
	}
	var output string
	for {
		frame := awaitSocket(t, wire.writes)
		if frame.kind == wireClose {
			break
		}
		if frame.kind == wireBinary {
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
			wire.input <- testWireFrame{wireBinary, []byte("bad")}
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
				if frame.kind == wireBinary || frame.kind == wireClose {
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
	wire.input <- testWireFrame{wireBinary, []byte("hello")}
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
			c := &socketConn{ws: wire, closed: make(chan struct{}), out: newSocketMailbox(1), profile: profile}
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

func TestSocketPeerCloseStopsProductionAndNeverSendsDataAfterEcho(t *testing.T) {
	wire := newTestSocketNetwork()
	wire.gate = make(chan struct{}, 1)
	endpoint := &testNativeSocket{}
	endpoint.receive = func([]byte) error {
		endpoint.queue = append(endpoint.queue, []byte("in-flight"), []byte("discard"))
		return nil
	}
	profile := defaultSocketProfile
	// The in-flight write consumes all capacity. Peer Close must also wake the
	// native owner waiting to admit its one staged next frame.
	profile.outboundBytes = len("in-flight")
	c, done := launchTestSocket(t, wire, endpoint, profile)
	wire.input <- testWireFrame{wireBinary, []byte("hello")}
	awaitSocket(t, wire.started)
	wire.input <- testWireFrame{wireClose, nil}
	awaitSocket(t, done)
	if c.outcome != "peer-close" {
		t.Fatal(c.outcome)
	}
	closes, sawClose := 0, false
	for len(wire.writes) > 0 {
		frame := <-wire.writes
		if sawClose && frame.kind == wireBinary {
			t.Fatal("data after the Close echo")
		}
		if frame.kind == wireClose {
			sawClose = true
			closes++
			if !bytes.Equal(frame.data, closePayload(websocket.StatusNormalClosure, "")) {
				t.Fatal("Close code not echoed")
			}
		}
	}
	if closes != 1 {
		t.Fatalf("closes=%d", closes)
	}
	assertSocketDisposed(t, c, endpoint)
}

// Also proves an accepted socket outlives the HTTP server's request deadlines.
// net/http clears them at hijack today; Hijacker's contract does not promise it.
func TestSocketPeerCloseRealWebSocketHandshake(t *testing.T) {
	done := make(chan struct{})
	endpoint := &testNativeSocket{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		wire, err := acceptWebSocket(w, r)
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
	server.Config.ReadTimeout = 50 * time.Millisecond
	server.Config.WriteTimeout = 50 * time.Millisecond
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{Subprotocols: []string{native.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	time.Sleep(200 * time.Millisecond) // well past both request deadlines
	if err := client.Close(websocket.StatusNormalClosure, "done"); err != nil {
		t.Fatalf("expected orderly echo, not 1006: %v", err)
	}
	awaitSocket(t, done)
	if endpoint.closes.Load() != 1 || endpoint.overlapped.Load() {
		t.Fatal("native ownership failed during close handshake")
	}
}

func TestSocketHeartbeatUsesLibraryPing(t *testing.T) {
	for _, answered := range []bool{true, false} {
		t.Run(map[bool]string{true: "answered", false: "unanswered"}[answered], func(t *testing.T) {
			wire := newTestSocketNetwork()
			endpoint := &testNativeSocket{}
			profile := defaultSocketProfile
			profile.probeInterval = 10 * time.Millisecond
			profile.response = 60 * time.Millisecond
			conn, done := launchTestSocket(t, wire, endpoint, profile)
			window := time.After(5 * profile.response)
			pings := 0
		wait:
			for {
				select {
				case frame := <-wire.writes:
					if frame.kind == wirePing {
						pings++
						if answered {
							wire.input <- testWireFrame{wirePong, frame.data}
						}
					}
				case <-done:
					if answered || conn.outcome != "response-unavailable" {
						t.Fatalf("outcome=%s pings=%d", conn.outcome, pings)
					}
					break wait
				case <-window:
					if !answered {
						t.Fatal("unanswered heartbeat never retired")
					}
					if pings < 3 {
						t.Fatalf("paced probes stopped after %d", pings)
					}
					break wait
				}
			}
			conn.closeNetwork()
			awaitSocket(t, done)
			assertSocketDisposed(t, conn, endpoint)
		})
	}
}

func TestResizeTelemetryIsStructuredAndCorrelated(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})).With("connection_id", 17)
	conn := &socketConn{logger: logger}
	frame := make([]byte, 26+24)
	frame[0] = 20
	binary.LittleEndian.PutUint64(frame[2:10], 11)
	frame[17] = 0xaa
	binary.LittleEndian.PutUint64(frame[18:26], 9)
	geometry := frame[26+16:]
	binary.LittleEndian.PutUint16(geometry[0:2], 120)
	binary.LittleEndian.PutUint16(geometry[2:4], 40)
	binary.LittleEndian.PutUint16(geometry[4:6], 9)
	binary.LittleEndian.PutUint16(geometry[6:8], 18)
	conn.logFrame("in", frame)

	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	for field, expected := range map[string]any{
		"msg": "terminal resize lifecycle", "connection_id": float64(17),
		"frame_type": "resize_request", "sigwinch_stage": "requested",
		"attachment_id": "aa00000000000000000000000000000b", "request_id": float64(9),
		"cols": float64(120), "rows": float64(40),
	} {
		if event[field] != expected {
			t.Errorf("%s=%v, want %v", field, event[field], expected)
		}
	}
}

func TestFrameTelemetryBoundsUntrustedHeaders(t *testing.T) {
	for _, test := range []struct {
		opcode byte
		length int
	}{{20, 0}, {20, 1}, {255, 2}, {11, 17}, {20, 25}, {5, 41}} {
		frame := make([]byte, test.length)
		if len(frame) > 0 {
			frame[0] = test.opcode
		}
		var output bytes.Buffer
		conn := &socketConn{logger: slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))}
		conn.logFrame("in", frame)
		var event map[string]any
		if err := json.Unmarshal(output.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event["valid_header"] != false || conn.inBytes.Load() != uint64(len(frame)) {
			t.Fatalf("truncated header %x: event=%v bytes=%d", frame, event, conn.inBytes.Load())
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
