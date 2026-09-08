//go:build cgo

package native

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"sync"
	"testing"
)

const terminalABI = "bcwebmux-ghostty-f4f9991-snapshot-8m-continuation-1m-glyph-cell-partitions-pty-zstd-stream"

// TestNativeEngineABI exercises the actual cgo ownership boundary without
// spawning a shell. /bin/true is only used as the worker path; the test does
// not create a session, so no worker process is needed.
func TestNativeEngineABI(t *testing.T) {
	engine, err := OpenEngine(EngineConfig{Worker: "/bin/true", Shell: "/bin/sh", MaxSessions: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := engine.Close(); err != nil {
			t.Errorf("engine close: %v", err)
		}
	}()

	response, err := engine.REST(RESTRequest{Method: "GET", Target: "/api/server"})
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != 200 || len(response.Body) == 0 {
		t.Fatalf("REST response = status %d, body %d bytes", response.Status, len(response.Body))
	}

	socket, err := engine.OpenSocket()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := socket.Close(); err != nil {
			t.Errorf("socket close: %v", err)
		}
	}()
	if err := socket.Tick(); !errors.Is(err, ErrNotReady) {
		t.Fatalf("pending socket tick error = %v", err)
	}
	if _, ok, err := socket.Drain(); err != nil || ok {
		t.Fatalf("pending socket drain = ok %v, err %v", ok, err)
	}
	if err := socket.Receive(helloFrame()); err != nil {
		t.Fatal(err)
	}
	message, ok, err := socket.Drain()
	if err != nil {
		t.Fatal(err)
	}
	if !ok || len(message) < 64 || message[4] != 2 { // WELCOME
		t.Fatalf("WELCOME message = ok %v, %d bytes, type %d", ok, len(message), messageType(message))
	}

	if err := engine.Close(); err == nil {
		t.Error("engine close with open socket returned nil")
	}
	if response, err := engine.REST(RESTRequest{Method: "GET", Target: "/api/server"}); err != nil || response.Status != 200 {
		t.Errorf("REST after failed close = status %d, err %v", response.Status, err)
	}

	var waitGroup sync.WaitGroup
	for worker := 0; worker < 2; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			if response, err := engine.REST(RESTRequest{Method: "GET", Target: "/api/server"}); err != nil || response.Status != 200 {
				t.Errorf("concurrent REST = status %d, err %v", response.Status, err)
			}
			if err := socket.Tick(); err != nil {
				t.Errorf("concurrent socket tick: %v", err)
			}
		}()
	}
	waitGroup.Wait()

	if err := socket.Close(); err != nil {
		t.Errorf("socket close: %v", err)
	}
	if err := socket.Close(); err != nil {
		t.Errorf("second socket close: %v", err)
	}
	if err := socket.Receive(nil); !errors.Is(err, ErrClosed) {
		t.Errorf("closed socket receive error = %v", err)
	}
	if err := socket.Tick(); !errors.Is(err, ErrClosed) {
		t.Errorf("closed socket tick error = %v", err)
	}
	_, _, err = socket.Drain()
	if !errors.Is(err, ErrClosed) {
		t.Errorf("closed socket drain error = %v", err)
	}

	if err := engine.Close(); err != nil {
		t.Errorf("engine close: %v", err)
	}
	if err := engine.Close(); err != nil {
		t.Errorf("second engine close: %v", err)
	}
	if _, err := engine.REST(RESTRequest{Method: "GET", Target: "/api/server"}); !errors.Is(err, ErrClosed) {
		t.Errorf("closed engine REST error = %v", err)
	}
	if _, err := engine.OpenSocket(); !errors.Is(err, ErrClosed) {
		t.Errorf("closed engine open socket error = %v", err)
	}
}

func helloFrame() []byte {
	const headerLength = 64
	const payloadLength = 56
	frame := make([]byte, headerLength+payloadLength)
	binary.LittleEndian.PutUint32(frame[0:], 0x53574342)
	frame[4] = 1 // HELLO
	binary.LittleEndian.PutUint16(frame[6:], headerLength)
	binary.LittleEndian.PutUint32(frame[8:], payloadLength)
	binary.LittleEndian.PutUint64(frame[16:], 1)
	binary.LittleEndian.PutUint64(frame[24:], 1)
	for index := 0; index < 16; index++ {
		frame[64+index] = byte(index + 1)
	}
	digest := sha256.Sum256([]byte(terminalABI))
	copy(frame[80:112], digest[:])
	binary.LittleEndian.PutUint32(frame[112:], 32*1024*1024)
	binary.LittleEndian.PutUint32(frame[116:], MaxFrameLength)
	return frame
}

func messageType(message []byte) byte {
	if len(message) <= 4 {
		return 0
	}
	return message[4]
}

func TestNativeProtocolTerminationLeavesOrderedOutputDrainable(t *testing.T) {
	engine, err := OpenEngine(EngineConfig{Worker: "/bin/true", Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	socket, err := engine.OpenSocket()
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	if err := socket.Receive(helloFrame()); err != nil {
		t.Fatal(err)
	}
	// Leave WELCOME queued, then force a fatal ERROR behind it.
	if err := socket.Receive([]byte{0}); !errors.Is(err, ErrProtocol) {
		t.Fatalf("terminal receive: %v", err)
	}
	if err := socket.Tick(); !errors.Is(err, ErrClosed) {
		t.Fatalf("production after termination: %v", err)
	}
	if err := socket.Receive(helloFrame()); !errors.Is(err, ErrClosed) {
		t.Fatalf("receive after termination: %v", err)
	}
	for i, kind := range []byte{2, 3} {
		message, ok, err := socket.Drain()
		if err != nil || !ok || messageType(message) != kind {
			t.Fatalf("drain %d: ok=%v type=%d err=%v", i, ok, messageType(message), err)
		}
		if seq := binary.LittleEndian.Uint64(message[16:]); seq != uint64(i+1) {
			t.Fatalf("drain sequence %d", seq)
		}
	}
	if _, _, err := socket.Drain(); !errors.Is(err, ErrClosed) {
		t.Fatalf("exhausted terminal queue: %v", err)
	}
	if err := engine.Close(); err == nil {
		t.Fatal("terminal handle must still retain engine")
	}
	if err := socket.Close(); err != nil {
		t.Fatal(err)
	}
	if err := socket.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeABIMismatchErrorIsDrainable(t *testing.T) {
	engine, err := OpenEngine(EngineConfig{Worker: "/bin/true", Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	socket, err := engine.OpenSocket()
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	hello := helloFrame()
	hello[80] ^= 1
	if err := socket.Receive(hello); !errors.Is(err, ErrProtocol) {
		t.Fatalf("ABI mismatch: %v", err)
	}
	message, ok, err := socket.Drain()
	if err != nil || !ok || messageType(message) != 3 {
		t.Fatalf("fatal ERROR: ok=%v type=%d err=%v", ok, messageType(message), err)
	}
}
