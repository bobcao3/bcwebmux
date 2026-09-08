//go:build cgo

package native

/*
#cgo CFLAGS: -I${SRCDIR}/../../../include
#cgo LDFLAGS: -lm
#include "bcwebmux.h"
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"sync"
	"unsafe"
)

const abiVersion = C.BCWMUX_ABI_VERSION

// cgoEngine serializes every native call. The prototype ABI deliberately does
// not promise that an engine is safe for concurrent calls, and sockets retain a
// pointer to their parent engine until they close.
type cgoEngine struct {
	mu  sync.Mutex
	ptr *C.bcwebmux_engine
}

type cgoSocket struct {
	engine *cgoEngine
	ptr    *C.bcwebmux_socket
}

func OpenEngine(config EngineConfig) (Engine, error) {
	worker := []byte(config.Worker)
	shell := []byte(config.Shell)
	origin := []byte(config.ExpectedOrigin)
	workerPtr := C.CBytes(worker)
	defer C.free(workerPtr)
	shellPtr := C.CBytes(shell)
	defer C.free(shellPtr)
	originPtr := C.CBytes(origin)
	defer C.free(originPtr)
	if config.MaxSessions > uint64(^uint32(0)) {
		return nil, fmt.Errorf("max sessions exceeds uint32 range")
	}
	// These fields must point to C memory; passing a Go struct containing
	// unpinned Go pointers to C would violate cgo rules.
	var nativeConfig C.bcwebmux_engine_config
	nativeConfig.abi_version = abiVersion
	nativeConfig.worker_path = (*C.uint8_t)(workerPtr)
	nativeConfig.worker_path_len = C.size_t(len(worker))
	nativeConfig.shell = (*C.uint8_t)(shellPtr)
	nativeConfig.shell_len = C.size_t(len(shell))
	// Origin is checked in the Go transport; the native check is defense in depth.
	nativeConfig.expected_origin = (*C.uint8_t)(originPtr)
	nativeConfig.expected_origin_len = C.size_t(len(origin))
	nativeConfig.max_live_sessions = C.uint32_t(config.MaxSessions)
	var ptr *C.bcwebmux_engine
	status := C.bcwebmux_engine_open(&nativeConfig, &ptr)
	if status != C.BCWMUX_OK {
		return nil, statusError("engine_open", status)
	}
	if ptr == nil {
		return nil, fmt.Errorf("engine_open returned a nil engine")
	}
	return &cgoEngine{ptr: ptr}, nil
}

func (e *cgoEngine) REST(request RESTRequest) (RESTResponse, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ptr == nil {
		return RESTResponse{}, ErrClosed
	}
	method := []byte(request.Method)
	target := []byte(request.Target)
	origin := []byte(request.Origin)
	contentType := []byte(request.ContentType)
	idempotency := []byte(request.IdempotencyKey)
	methodPtr := C.CBytes(method)
	defer C.free(methodPtr)
	targetPtr := C.CBytes(target)
	defer C.free(targetPtr)
	originPtr := C.CBytes(origin)
	defer C.free(originPtr)
	contentTypePtr := C.CBytes(contentType)
	defer C.free(contentTypePtr)
	idempotencyPtr := C.CBytes(idempotency)
	defer C.free(idempotencyPtr)
	bodyPtr := C.CBytes(request.Body)
	defer C.free(bodyPtr)
	var nativeRequest C.bcwebmux_http_request_input
	nativeRequest.method, nativeRequest.method_len = (*C.uint8_t)(methodPtr), C.size_t(len(method))
	nativeRequest.target, nativeRequest.target_len = (*C.uint8_t)(targetPtr), C.size_t(len(target))
	nativeRequest.origin, nativeRequest.origin_len = (*C.uint8_t)(originPtr), C.size_t(len(origin))
	nativeRequest.content_type, nativeRequest.content_type_len = (*C.uint8_t)(contentTypePtr), C.size_t(len(contentType))
	nativeRequest.idempotency_key, nativeRequest.idempotency_key_len = (*C.uint8_t)(idempotencyPtr), C.size_t(len(idempotency))
	nativeRequest.body, nativeRequest.body_len = (*C.uint8_t)(bodyPtr), C.size_t(len(request.Body))
	var nativeResponse C.bcwebmux_http_response
	defer C.bcwebmux_http_response_free(&nativeResponse)
	status := C.bcwebmux_http_request(e.ptr, &nativeRequest, &nativeResponse)
	if status != C.BCWMUX_OK {
		return RESTResponse{}, statusError("http_request", status)
	}
	body, err := copyCBytes(nativeResponse.body, nativeResponse.body_len, MaxResponseBytes)
	if err != nil {
		return RESTResponse{}, err
	}
	content, err := copyCBytes((*C.uint8_t)(unsafe.Pointer(nativeResponse.content_type)), nativeResponse.content_type_len, 1024)
	if err != nil {
		return RESTResponse{}, err
	}
	location, err := copyCBytes((*C.uint8_t)(unsafe.Pointer(nativeResponse.location)), nativeResponse.location_len, 4096)
	if err != nil {
		return RESTResponse{}, err
	}
	return RESTResponse{Status: int(nativeResponse.status), Replayed: nativeResponse.replayed != 0, Body: body, ContentType: string(content), Location: string(location)}, nil
}

func (e *cgoEngine) OpenSocket() (Socket, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ptr == nil {
		return nil, ErrClosed
	}
	opts := C.bcwebmux_socket_options{abi_version: abiVersion, max_queue_bytes: 0, max_message_bytes: MaxFrameLength}
	var ptr *C.bcwebmux_socket
	status := C.bcwebmux_socket_open(e.ptr, &opts, &ptr)
	if status != C.BCWMUX_OK {
		return nil, statusError("socket_open", status)
	}
	if ptr == nil {
		return nil, fmt.Errorf("socket_open returned a nil socket")
	}
	// The Go RFC Ping/Pong supervisor is the sole liveness owner. Keep native
	// framing/application heartbeat observations, not a competing fatal timer.
	if status := C.bcwebmux_socket_set_transport_managed(ptr, 1); status != C.BCWMUX_OK {
		C.bcwebmux_socket_close(ptr)
		return nil, statusError("socket_set_transport_managed", status)
	}
	return &cgoSocket{engine: e, ptr: ptr}, nil
}

func (e *cgoEngine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ptr == nil {
		return nil
	}
	ptr := e.ptr
	closeStatus := C.bcwebmux_engine_close(ptr)
	if closeStatus != C.BCWMUX_OK {
		return statusError("engine_close", closeStatus)
	}
	e.ptr = nil
	return nil
}

func (s *cgoSocket) Receive(binary []byte) error {
	s.engine.mu.Lock()
	defer s.engine.mu.Unlock()
	if s.ptr == nil {
		return ErrClosed
	}
	if s.engine.ptr == nil {
		return ErrClosed
	}
	status := C.bcwebmux_socket_receive_binary(s.ptr, (*C.uint8_t)(unsafe.Pointer(unsafe.SliceData(binary))), C.size_t(len(binary)))
	return socketStatus("socket_receive_binary", status)
}

func (s *cgoSocket) Tick() error {
	s.engine.mu.Lock()
	defer s.engine.mu.Unlock()
	if s.ptr == nil {
		return ErrClosed
	}
	if s.engine.ptr == nil {
		return ErrClosed
	}
	return socketStatus("socket_tick", C.bcwebmux_socket_tick(s.ptr))
}

func (s *cgoSocket) Drain() ([]byte, bool, error) {
	s.engine.mu.Lock()
	defer s.engine.mu.Unlock()
	if s.ptr == nil {
		return nil, false, ErrClosed
	}
	if s.engine.ptr == nil {
		return nil, false, ErrClosed
	}
	var nativeMessage C.bcwebmux_message
	status := C.bcwebmux_socket_drain(s.ptr, &nativeMessage)
	if status == C.BCWMUX_WOULD_BLOCK {
		return nil, false, nil
	}
	if status != C.BCWMUX_OK {
		return nil, false, socketStatus("socket_drain", status)
	}
	defer C.bcwebmux_message_free(&nativeMessage)
	message, err := copyCBytes(nativeMessage.data, nativeMessage.len, MaxFrameLength)
	if err != nil {
		return nil, false, err
	}
	return message, true, nil
}

func (s *cgoSocket) Close() error {
	s.engine.mu.Lock()
	defer s.engine.mu.Unlock()
	if s.ptr == nil {
		return nil
	}
	ptr := s.ptr
	closeStatus := C.bcwebmux_socket_close(ptr)
	if closeStatus != C.BCWMUX_OK {
		return statusError("socket_close", closeStatus)
	}
	s.ptr = nil
	return nil
}

func copyCBytes(ptr *C.uint8_t, length C.size_t, max int) ([]byte, error) {
	if uint64(length) > uint64(max) {
		return nil, fmt.Errorf("native response exceeds %d bytes", max)
	}
	if length == 0 {
		return nil, nil
	}
	if ptr == nil {
		return nil, fmt.Errorf("native response has nil data pointer")
	}
	return C.GoBytes(unsafe.Pointer(ptr), C.int(length)), nil
}

func statusError(operation string, status C.bcwebmux_status) error {
	name := C.bcwebmux_status_name(status)
	if name == nil {
		return fmt.Errorf("%s failed with native status %d", operation, uint32(status))
	}
	return fmt.Errorf("%s failed: %s", operation, C.GoString(name))
}

func socketStatus(operation string, status C.bcwebmux_status) error {
	switch status {
	case C.BCWMUX_OK:
		return nil
	case C.BCWMUX_CLOSED, C.BCWMUX_SHUTTING_DOWN:
		return ErrClosed
	case C.BCWMUX_NOT_READY:
		return ErrNotReady
	case C.BCWMUX_QUEUE_OVERFLOW:
		return ErrQueueFull
	case C.BCWMUX_PROTOCOL_ERROR:
		return fmt.Errorf("%s: %w", operation, ErrProtocol)
	default:
		return statusError(operation, status)
	}
}
