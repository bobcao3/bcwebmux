package native

import (
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestUDSStalledDaemonTimesOut(t *testing.T) {
	path := udsTestServer(t, func(conn net.Conn) {
		if _, _, err := udsReadRequest(conn); err == nil {
			io.Copy(io.Discard, conn)
		}
	})
	e, err := OpenRemoteEngine(path)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	start := time.Now()
	_, err = e.REST(RESTRequest{Method: "GET", Target: "/"})
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("stalled daemon: %v", err)
	}
	if elapsed := time.Since(start); elapsed > udsTimeout+2*time.Second {
		t.Fatalf("deadline took %v", elapsed)
	}
}
