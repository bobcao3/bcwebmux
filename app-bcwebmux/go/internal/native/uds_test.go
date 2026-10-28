package native

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func udsTestServer(t *testing.T, handler func(net.Conn)) string {
	t.Helper()
	dir, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dir.Close() })
	path := filepath.Join("/proc/self/fd", strconv.FormatUint(uint64(dir.Fd()), 10), "daemon.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() { defer wg.Done(); defer conn.Close(); handler(conn) }()
		}
	}()
	t.Cleanup(func() { listener.Close(); <-stopped; wg.Wait() })
	return path
}

func udsReadRequest(conn net.Conn) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(conn, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:])
	if n > udsMaxMessage {
		return 0, nil, fmt.Errorf("oversize request")
	}
	body := make([]byte, n)
	_, err := io.ReadFull(conn, body)
	return h[0], body, err
}

func udsRespond(conn net.Conn, status uint32, body []byte) error {
	var h [8]byte
	binary.BigEndian.PutUint32(h[:4], status)
	binary.BigEndian.PutUint32(h[4:], uint32(len(body)))
	_, err := conn.Write(append(h[:], body...))
	return err
}

func TestUDSProtocolAndLifecycle(t *testing.T) {
	errs := make(chan error, 10)
	path := udsTestServer(t, func(conn net.Conn) {
		for {
			op, body, err := udsReadRequest(conn)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					errs <- err
				}
				return
			}
			switch op {
			case 1:
				want := []byte("\x00\x00\x00\x04POST\x00\x00\x00\x04/x?q\x00\x00\x00\x01o\x00\x00\x00\x01c\x00\x00\x00\x01k\x00\x00\x00\x03\x00\xffa")
				if !bytes.Equal(body, want) {
					errs <- fmt.Errorf("REST request %x, want %x", body, want)
				}
				udsRespond(conn, 0, []byte("\x00\xc9\x01\x00\x00\x00\x04text\x00\x00\x00\x02/y\x00\x00\x00\x02\x00z"))
			case 2, 4, 6:
				if len(body) != 0 {
					errs <- fmt.Errorf("op %d unexpected payload", op)
				}
				udsRespond(conn, 0, nil)
				if op == 6 {
					return
				}
			case 3:
				if !bytes.Equal(body, []byte{0, 255, 1}) {
					errs <- fmt.Errorf("receive payload %x", body)
				}
				udsRespond(conn, 5, nil)
			case 5:
				udsRespond(conn, 0, []byte{4, 0, 5})
				// The next drain is empty.
				op, _, err = udsReadRequest(conn)
				if err != nil || op != 5 {
					errs <- fmt.Errorf("second drain: %d %v", op, err)
					return
				}
				udsRespond(conn, 12, nil)
			default:
				errs <- fmt.Errorf("unexpected op %d", op)
				return
			}
		}
	})
	e, err := OpenRemoteEngine(path)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	r, err := e.REST(RESTRequest{Method: "POST", Target: "/x?q", Origin: "o", ContentType: "c", IdempotencyKey: "k", Body: []byte{0, 255, 'a'}})
	if err != nil || r.Status != 201 || !r.Replayed || r.ContentType != "text" || r.Location != "/y" || !bytes.Equal(r.Body, []byte{0, 'z'}) {
		t.Fatalf("REST: %+v, %v", r, err)
	}
	s, err := e.OpenSocket()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Receive([]byte{0, 255, 1}); !errors.Is(err, ErrProtocol) {
		t.Fatalf("receive: %v", err)
	}
	msg, ok, err := s.Drain()
	if err != nil || !ok || !bytes.Equal(msg, []byte{4, 0, 5}) {
		t.Fatalf("drain: %x %v %v", msg, ok, err)
	}
	_, ok, err = s.Drain()
	if err != nil || ok {
		t.Fatalf("empty drain: %v %v", ok, err)
	}
	if err = s.Tick(); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if err = s.Tick(); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed tick: %v", err)
	}
	if err = e.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = e.OpenSocket(); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed engine: %v", err)
	}
	select {
	case err := <-errs:
		t.Fatal(err)
	default:
	}
}

func TestUDSMalformedAndDisconnect(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply []byte
		want  error
	}{
		{"oversize", []byte{0, 0, 0, 0, 0, 16, 0, 65}, ErrProtocol},
		{"truncated", []byte{0, 0, 0, 0, 0, 0, 0, 3, 1}, ErrClosed},
		{"bad-rest", []byte{0, 0, 0, 0, 0, 0, 0, 3, 0, 200, 2}, ErrProtocol},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := udsTestServer(t, func(conn net.Conn) {
				if op, _, err := udsReadRequest(conn); err == nil && op == 1 {
					conn.Write(tc.reply)
				}
			})
			e, err := OpenRemoteEngine(path)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			_, err = e.REST(RESTRequest{Method: "GET", Target: "/"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestUDSEngineCloseInterruptsSocket(t *testing.T) {
	started := make(chan struct{})
	path := udsTestServer(t, func(conn net.Conn) {
		op, _, err := udsReadRequest(conn)
		if err != nil {
			return
		}
		if op != 2 {
			return
		}
		udsRespond(conn, 0, nil)
		if _, _, err = udsReadRequest(conn); err == nil {
			close(started)
			io.Copy(io.Discard, conn)
		}
	})
	e, err := OpenRemoteEngine(path)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	s, err := e.OpenSocket()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Tick() }()
	<-started
	if err = e.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("tick: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not interrupt socket")
	}
	if err = s.Tick(); !errors.Is(err, ErrClosed) {
		t.Fatalf("subsequent tick: %v", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
}
