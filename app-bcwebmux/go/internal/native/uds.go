package native

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const (
	udsMaxMessage = MaxFrameLength
	udsTimeout    = 5 * time.Second
	udsREST       = 1
	udsOpen       = 2
	udsReceive    = 3
	udsTick       = 4
	udsDrain      = 5
	udsClose      = 6
)

type udsEngine struct {
	path   string
	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}
}

type udsSocket struct {
	engine *udsEngine
	mu     sync.Mutex
	conn   net.Conn
}

// OpenRemoteEngine connects to an independently managed session daemon. Closing
// the engine closes its frontend connections, not the daemon or its sessions.
func OpenRemoteEngine(path string) (Engine, error) {
	e := &udsEngine{path: path, conns: make(map[net.Conn]struct{})}
	conn, err := e.dial()
	if err != nil {
		return nil, err
	}
	e.release(conn)
	return e, nil
}

func (e *udsEngine) dial() (net.Conn, error) {
	e.mu.Lock()
	closed := e.closed
	e.mu.Unlock()
	if closed {
		return nil, ErrClosed
	}
	conn, err := (&net.Dialer{Timeout: udsTimeout}).Dial("unix", e.path)
	if err != nil {
		return nil, fmt.Errorf("dial session daemon: %w", err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		conn.Close()
		return nil, ErrClosed
	}
	e.conns[conn] = struct{}{}
	return conn, nil
}

func (e *udsEngine) release(conn net.Conn) {
	e.mu.Lock()
	delete(e.conns, conn)
	e.mu.Unlock()
	conn.Close()
}

func (e *udsEngine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil
	}
	e.closed = true
	for conn := range e.conns {
		conn.Close()
		delete(e.conns, conn)
	}
	return nil
}

func udsCall(conn net.Conn, op byte, payload []byte) (uint32, []byte, error) {
	if len(payload) > udsMaxMessage {
		return 0, nil, fmt.Errorf("request too large: %d", len(payload))
	}
	if err := conn.SetDeadline(time.Now().Add(udsTimeout)); err != nil {
		return 0, nil, fmt.Errorf("daemon deadline: %w: %v", ErrClosed, err)
	}
	var header [8]byte
	header[0] = op
	binary.BigEndian.PutUint32(header[1:5], uint32(len(payload)))
	if err := udsWrite(conn, header[:5]); err != nil {
		return 0, nil, err
	}
	if err := udsWrite(conn, payload); err != nil {
		return 0, nil, err
	}
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return 0, nil, fmt.Errorf("daemon response: %w: %v", ErrClosed, err)
	}
	status := binary.BigEndian.Uint32(header[:4])
	n := binary.BigEndian.Uint32(header[4:])
	if n > udsMaxMessage {
		return 0, nil, fmt.Errorf("daemon response too large: %d: %w", n, ErrProtocol)
	}
	body := make([]byte, int(n))
	if _, err := io.ReadFull(conn, body); err != nil {
		return 0, nil, fmt.Errorf("daemon response body: %w: %v", ErrClosed, err)
	}
	return status, body, nil
}

func udsWrite(conn net.Conn, data []byte) error {
	for len(data) > 0 {
		n, err := conn.Write(data)
		if err != nil {
			return fmt.Errorf("daemon request: %w: %v", ErrClosed, err)
		}
		if n == 0 {
			return fmt.Errorf("daemon request: %w", ErrClosed)
		}
		data = data[n:]
	}
	return nil
}

func udsStatus(op string, status uint32) error {
	switch status {
	case 0:
		return nil
	case 3, 8:
		return ErrClosed
	case 5:
		return fmt.Errorf("%s: %w", op, ErrProtocol)
	case 6:
		return ErrQueueFull
	case 7:
		return ErrNotReady
	case 1:
		return fmt.Errorf("%s failed: invalid_argument", op)
	case 2:
		return fmt.Errorf("%s failed: out_of_memory", op)
	case 4:
		return fmt.Errorf("%s failed: busy", op)
	case 9:
		return fmt.Errorf("%s failed: internal", op)
	case 10:
		return fmt.Errorf("%s failed: too_large", op)
	case 11:
		return fmt.Errorf("%s failed: not_found", op)
	case 12:
		return fmt.Errorf("%s failed: would_block", op)
	default:
		return fmt.Errorf("%s failed with native status %d", op, status)
	}
}

func udsFields(fields ...[]byte) ([]byte, error) {
	total := 0
	for _, field := range fields {
		if len(field) > udsMaxMessage-4-total {
			return nil, fmt.Errorf("request too large")
		}
		total += 4 + len(field)
	}
	out := make([]byte, 0, total)
	for _, field := range fields {
		out = binary.BigEndian.AppendUint32(out, uint32(len(field)))
		out = append(out, field...)
	}
	return out, nil
}

func (e *udsEngine) REST(req RESTRequest) (RESTResponse, error) {
	payload, err := udsFields([]byte(req.Method), []byte(req.Target), []byte(req.Origin), []byte(req.ContentType), []byte(req.IdempotencyKey), req.Body)
	if err != nil {
		return RESTResponse{}, err
	}
	conn, err := e.dial()
	if err != nil {
		return RESTResponse{}, err
	}
	defer e.release(conn)
	status, body, err := udsCall(conn, udsREST, payload)
	if err != nil {
		return RESTResponse{}, err
	}
	if err = udsStatus("http_request", status); err != nil {
		return RESTResponse{}, err
	}
	return udsParseREST(body)
}

func udsParseREST(data []byte) (RESTResponse, error) {
	bad := func() (RESTResponse, error) {
		return RESTResponse{}, fmt.Errorf("malformed REST response: %w", ErrProtocol)
	}
	if len(data) < 3 || data[2] > 1 {
		return bad()
	}
	response := RESTResponse{Status: int(binary.BigEndian.Uint16(data[:2])), Replayed: data[2] == 1}
	data = data[3:]
	fields := make([][]byte, 3)
	limits := [...]int{1024, 4096, MaxResponseBytes}
	for i := range fields {
		if len(data) < 4 {
			return bad()
		}
		n := binary.BigEndian.Uint32(data[:4])
		data = data[4:]
		if n > uint32(limits[i]) || uint64(n) > uint64(len(data)) {
			return bad()
		}
		fields[i] = data[:int(n)]
		data = data[int(n):]
	}
	if len(data) != 0 {
		return bad()
	}
	response.ContentType = string(fields[0])
	response.Location = string(fields[1])
	response.Body = fields[2]
	return response, nil
}

func (e *udsEngine) OpenSocket() (Socket, error) {
	conn, err := e.dial()
	if err != nil {
		return nil, err
	}
	status, body, err := udsCall(conn, udsOpen, nil)
	if err == nil {
		err = udsStatus("socket_open", status)
	}
	if err == nil && len(body) != 0 {
		err = fmt.Errorf("socket_open response: %w", ErrProtocol)
	}
	if err != nil {
		e.release(conn)
		return nil, err
	}
	return &udsSocket{engine: e, conn: conn}, nil
}

func (s *udsSocket) call(op byte, payload []byte) (uint32, []byte, error) {
	if s.conn == nil {
		return 0, nil, ErrClosed
	}
	status, body, err := udsCall(s.conn, op, payload)
	if err != nil {
		s.engine.release(s.conn)
		s.conn = nil
		return 0, nil, err
	}
	return status, body, nil
}

func (s *udsSocket) Receive(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	status, body, err := s.call(udsReceive, data)
	if err != nil {
		return err
	}
	if len(body) != 0 {
		return s.badResponse()
	}
	return udsStatus("socket_receive_binary", status)
}

func (s *udsSocket) Tick() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	status, body, err := s.call(udsTick, nil)
	if err != nil {
		return err
	}
	if len(body) != 0 {
		return s.badResponse()
	}
	return udsStatus("socket_tick", status)
}

func (s *udsSocket) Drain() ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	status, body, err := s.call(udsDrain, nil)
	if err != nil {
		return nil, false, err
	}
	if status == 12 && len(body) == 0 {
		return nil, false, nil
	}
	if status != 0 {
		if len(body) != 0 {
			return nil, false, s.badResponse()
		}
		return nil, false, udsStatus("socket_drain", status)
	}
	return body, true, nil
}

func (s *udsSocket) badResponse() error {
	s.engine.release(s.conn)
	s.conn = nil
	return fmt.Errorf("malformed socket response: %w", ErrProtocol)
}

func (s *udsSocket) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return nil
	}
	conn := s.conn
	status, body, err := s.call(udsClose, nil)
	if s.conn != nil {
		s.engine.release(conn)
		s.conn = nil
	}
	if err != nil {
		return err
	}
	if len(body) != 0 {
		return fmt.Errorf("socket_close response: %w", ErrProtocol)
	}
	return udsStatus("socket_close", status)
}
