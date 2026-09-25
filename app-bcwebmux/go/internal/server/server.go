package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

type Server struct {
	engine     native.Engine
	assets     *assetServer
	listeners  []net.Listener
	udps       []net.PacketConn
	h3s        []*http3.Server
	origins    map[string]bool
	authScopes map[string]authScope
	listener   net.Listener
	http       *http.Server
	h3         *http3.Server
	udp        net.PacketConn
	origin     string
	tls        bool
	logger     *slog.Logger
	nextConn   atomic.Uint64
	// auth is nil when authentication is disabled by configuration.
	auth *authManager
	// tlsLeaf is the served certificate, used to report origins it cannot
	// cover. It is nil when TLS is terminated elsewhere.
	tlsLeaf *x509.Certificate

	mu           sync.Mutex
	closing      bool
	ws           map[*socketConn]struct{}
	requests     sync.WaitGroup
	closeOnce    sync.Once
	shutdownDone chan struct{}
	shutdownErr  error
}

// New validates transport configuration, loads TLS credentials, and binds the
// listener. The native engine is borrowed from cfg and is not closed on a
// constructor error; ownership transfers to Server when New succeeds.
func New(cfg Config) (*Server, error) {
	if cfg.Engine == nil {
		return nil, errors.New("native engine is required")
	}
	if cfg.Host == "" && len(cfg.Listen) == 0 && len(cfg.origins()) == 0 {
		cfg.Host = DefaultHost
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return nil, fmt.Errorf("invalid port %d", cfg.Port)
	}
	tlsEnabled := cfg.TLSCert != "" || cfg.TLSKey != ""
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return nil, errors.New("TLS certificate and key must be supplied together")
	}
	if cfg.HTTP3 && !tlsEnabled {
		return nil, errors.New("--http3 requires TLS")
	}
	if err := validateBindings(cfg); err != nil {
		return nil, err
	}
	hosts, err := cfg.resolveListeners()
	if err != nil {
		return nil, err
	}
	if len(cfg.origins()) == 0 {
		for _, host := range hosts {
			if !HostIsLoopback(host) {
				return nil, fmt.Errorf("--origin is required for non-loopback %s (browser-facing scheme://host[:port])", host)
			}
		}
	}
	assets, err := newAssetServer(cfg.EmbeddedAssets, cfg.WebRoot)
	if err != nil {
		return nil, err
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	var listeners []net.Listener
	var udps []net.PacketConn
	success := false
	defer func() {
		if !success {
			for _, l := range listeners {
				_ = l.Close()
			}
			for _, u := range udps {
				_ = u.Close()
			}
		}
	}()
	port := cfg.Port
	for _, host := range hosts {
		listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			return nil, fmt.Errorf("listen %s: %w", host, err)
		}
		listeners = append(listeners, listener)
		if port == 0 {
			port = listener.Addr().(*net.TCPAddr).Port
		}
		if cfg.HTTP3 {
			udp, err := net.ListenPacket("udp", listener.Addr().String())
			if err != nil {
				return nil, fmt.Errorf("listen HTTP/3 %s: %w", host, err)
			}
			udps = append(udps, udp)
		}
	}
	listener := listeners[0]
	actualPort := port
	origins := cfg.origins()
	if len(origins) == 0 {
		for _, host := range hosts {
			origins = append(origins, OriginFor(host, port, tlsEnabled))
		}
		// Preserve the legacy hostname origin (notably localhost).
		for _, host := range cfg.listenSpecs() {
			if !strings.Contains(host, "/") {
				origins = append(origins, OriginFor(host, port, tlsEnabled))
			}
		}
	}
	origin := origins[0]
	if cfg.Origin == "" && len(cfg.Listen) == 0 && len(cfg.Origins) == 0 {
		origin = OriginFor(cfg.Host, port, tlsEnabled)
	}

	auth, err := newAuthManagerFor(cfg, origins)
	if err != nil {
		return nil, err
	}

	httpServer := &http.Server{
		Handler:           nil, // filled below after Server exists
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    MaxHeaderBytes,
	}
	result := &Server{
		engine: cfg.Engine, assets: assets, listener: listener,
		http: httpServer, origin: origin, tls: tlsEnabled,
		listeners: listeners, udps: udps, origins: make(map[string]bool),
		logger: cfg.Logger,
		ws:     make(map[*socketConn]struct{}), shutdownDone: make(chan struct{}),
		auth: auth, authScopes: newAuthScopes(origins),
	}
	for _, origin := range origins {
		result.origins[origin] = true
	}
	httpServer.Handler = result
	if tlsEnabled {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			_ = listener.Close()
			return nil, fmt.Errorf("load TLS certificate: %w", err)
		}
		// The leaf is kept for origin checks: an origin the certificate does
		// not cover is a certificate error in the browser before it is an
		// authentication problem.
		if parsed, err := x509.ParseCertificate(cert.Certificate[0]); err == nil {
			result.tlsLeaf = parsed
		}
		httpServer.TLSConfig = &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{cert},
			NextProtos:   []string{"h2", "http/1.1"},
		}
	}
	if cfg.HTTP3 {
		for _, udp := range udps {
			quicTLS := httpServer.TLSConfig.Clone()
			quicTLS.MinVersion = tls.VersionTLS13
			h3 := &http3.Server{Port: actualPort, Handler: result, TLSConfig: quicTLS, QUICConfig: &quic.Config{Allow0RTT: false}, MaxHeaderBytes: MaxHeaderBytes, IdleTimeout: 60 * time.Second}
			result.h3s = append(result.h3s, h3)
			if result.h3 == nil {
				result.h3 = h3
				result.udp = udp
			}
		}
	}
	success = true
	return result, nil
}

// Origin is the exact origin accepted by mutations and WebSocket upgrades.
func (s *Server) Origin() string { return s.origin }

// AuthStatus describes the authentication state for the startup log.
func (s *Server) AuthStatus() string {
	switch {
	case s.auth == nil:
		return "disabled"
	}
	totp, keys := s.auth.factors()
	if !totp && keys == 0 {
		return "open: no factor is enrolled"
	}
	factors := make([]string, 0, 2)
	if totp {
		factors = append(factors, "authenticator app")
	}
	if keys > 0 {
		factors = append(factors, fmt.Sprintf("%d security key(s)", keys))
	}
	if totp {
		// The authenticator app signs in at every address, so a per-origin
		// count would understate what is protected.
		return fmt.Sprintf("enrolled: %s, covering every origin", strings.Join(factors, " and "))
	}
	covered := 0
	for _, scope := range s.authScopes {
		if count, _ := s.auth.credentialCount(scope.rpID); count > 0 {
			covered++
		}
	}
	return fmt.Sprintf("enrolled: %s covering %d of %d origin(s)", strings.Join(factors, " and "), covered, len(s.authScopes))
}

// AuthWarnings lists origins that cannot take part in WebAuthn ceremonies,
// which makes them impossible to sign in at while any credential is enrolled.
func (s *Server) AuthWarnings() []string {
	if s.auth == nil {
		return nil
	}
	totp, keys := s.auth.factors()
	if !totp && keys == 0 {
		return nil
	}
	warnings := make([]string, 0)
	for _, origin := range s.Origins() {
		if keys == 0 {
			break
		}
		// These only affect the security key path: an enrolled authenticator
		// app signs in at every address the server answers on.
		if scope := scopeForOrigin(origin); scope.problem != "" {
			warnings = append(warnings, fmt.Sprintf("%s: %s (the authenticator app still works there)", origin, scope.problem))
		} else if scoped, _ := s.auth.credentialCount(scope.rpID); scoped == 0 {
			warnings = append(warnings, fmt.Sprintf("%s: no security key enrolled for this origin", origin))
		}
	}
	return warnings
}

// TLSWarnings names origins the served certificate cannot cover. A browser
// reaching one of those shows a certificate error, and WebAuthn on such a page
// fails with a security error instead of a key prompt, which reads as an
// authentication failure rather than the certificate problem it is.
func (s *Server) TLSWarnings() []string {
	if s.tlsLeaf == nil {
		return nil
	}
	warnings := make([]string, 0)
	for _, origin := range s.Origins() {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Hostname() == "" {
			continue
		}
		// An address that cannot hold a key at all is covered by the origin
		// warnings above; a certificate error there costs nothing extra.
		if scope := scopeForOrigin(origin); scope.problem != "" {
			continue
		}
		if err := s.tlsLeaf.VerifyHostname(parsed.Hostname()); err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: tls-cert does not cover %s, so security keys cannot be enrolled or used there (the authenticator app still works)", origin, parsed.Hostname()))
		}
	}
	return warnings
}

// Addr returns the bound address. It is useful when Port was zero.
func (s *Server) Addr() net.Addr { return s.listener.Addr() }

// Addrs returns every bound TCP address; HTTP/3 uses the same addresses and port.
func (s *Server) Addrs() []net.Addr {
	result := make([]net.Addr, 0, len(s.listeners))
	for _, listener := range s.listeners {
		result = append(result, listener.Addr())
	}
	return result
}

// Origins returns the exact browser origin allowlist.
func (s *Server) Origins() []string {
	result := make([]string, 0, len(s.origins))
	for origin := range s.origins {
		result = append(result, origin)
	}
	sort.Strings(result)
	return result
}

// Serve runs until the listener fails or Shutdown is called.
// The owner must call Shutdown to release the native engine.
func (s *Server) Serve() error {
	normalize := func(err error) error {
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		s.mu.Lock()
		closing := s.closing
		s.mu.Unlock()
		if closing && errors.Is(err, net.ErrClosed) {
			return nil
		}
		return err
	}
	results := make(chan error, len(s.listeners)+len(s.h3s))
	for _, listener := range s.listeners {
		go func() {
			var err error
			if s.tls {
				err = s.http.ServeTLS(listener, "", "")
			} else {
				err = s.http.Serve(listener)
			}
			results <- normalize(err)
		}()
	}
	for i, h3 := range s.h3s {
		go func() { results <- normalize(h3.Serve(s.udps[i])) }()
	}
	// The owner shuts down every transport after the first failure.
	return <-results
}

// Shutdown closes network peers immediately, then releases the engine after all
// admitted handlers exit. A deadline stops waiting, not the eventual cleanup.
func (s *Server) Shutdown(ctx context.Context) error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closing = true
		for conn := range s.ws {
			conn.closeNetwork()
		}
		s.mu.Unlock()
		go func() {
			// net/http must mark itself shutting down before the listener is closed;
			// otherwise Serve reports spurious accept errors. Explicitly closing the
			// listener still handles Shutdown before Serve.
			_ = s.http.Close()
			for _, listener := range s.listeners {
				_ = listener.Close()
			}
			for _, h3 := range s.h3s {
				_ = h3.Close()
			}
			for _, udp := range s.udps {
				_ = udp.Close()
			}
			s.requests.Wait()
			s.shutdownErr = s.engine.Close()
			close(s.shutdownDone)
		}()
	})
	select {
	case <-s.shutdownDone:
		return s.shutdownErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.ProtoMajor == 3 {
		// net/http.Server deadlines do not apply to QUIC streams.
		controller := http.NewResponseController(w)
		now := time.Now()
		_ = controller.SetReadDeadline(now.Add(s.http.ReadTimeout))
		_ = controller.SetWriteDeadline(now.Add(s.http.WriteTimeout))
	}
	if s.h3 != nil && r.TLS != nil {
		if err := s.h3.SetQUICHeaders(w.Header()); err != nil {
			// TCP can accept before Serve has registered the QUIC listener.
			w.Header().Set("Alt-Svc", fmt.Sprintf(`h3=":%d"; ma=2592000`, s.h3.Port))
		}
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	s.requests.Add(1)
	s.mu.Unlock()
	defer s.requests.Done()
	if s.serveAuthSurface(w, r) {
		return
	}
	if !s.requireSession(w, r) {
		return
	}
	if r.URL.Path == "/ws" {
		s.serveWebSocket(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.serveREST(w, r)
		return
	}
	s.assets.serve(w, r)
}

func (s *Server) serveREST(w http.ResponseWriter, r *http.Request) {
	if isMutation(r.Method) && !s.validOrigin(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "same-origin request required")
		return
	}
	if r.Method != http.MethodGet && !isMutation(r.Method) {
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	var body []byte
	if isMutation(r.Method) {
		if r.ContentLength > MaxRequestBytes {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
			return
		}
		var err error
		r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBytes)
		body, err = io.ReadAll(r.Body)
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
				return
			}
			writeJSONError(w, http.StatusBadRequest, "invalid_body", "request body could not be read")
			return
		}
	}
	response, err := s.engine.REST(native.RESTRequest{
		Method: r.Method, Target: r.URL.RequestURI(), Origin: r.Header.Get("Origin"),
		ContentType: r.Header.Get("Content-Type"), IdempotencyKey: r.Header.Get("Idempotency-Key"), Body: body,
	})
	if err != nil {
		s.logger.Error("native REST request failed", "error", err, "method", r.Method, "path", r.URL.Path)
		writeJSONError(w, http.StatusInternalServerError, "internal", "session operation failed")
		return
	}
	writeNativeResponse(w, r, response)
}

func writeNativeResponse(w http.ResponseWriter, r *http.Request, response native.RESTResponse) {
	status := response.Status
	if status < 100 || status > 599 {
		status = http.StatusInternalServerError
	}
	if response.ContentType != "" {
		w.Header().Set("Content-Type", response.ContentType)
	}
	if response.Location != "" {
		w.Header().Set("Location", response.Location)
	}
	if status != http.StatusNoContent && w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-store")
	}
	if w.Header().Get("Content-Security-Policy") == "" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	}
	if w.Header().Get("X-Content-Type-Options") == "" {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	if w.Header().Get("Referrer-Policy") == "" {
		w.Header().Set("Referrer-Policy", "no-referrer")
	}
	if status != http.StatusNoContent && w.Header().Get("Idempotency-Replayed") == "" {
		w.Header().Set("Idempotency-Replayed", strconv.FormatBool(response.Replayed))
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead && status != http.StatusNoContent {
		_, _ = w.Write(response.Body)
	}
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (s *Server) validOrigin(r *http.Request) bool {
	values := r.Header.Values("Origin")
	return len(values) == 1 && s.origins[values[0]]
}

func isMutation(method string) bool {
	return method == http.MethodPost || method == http.MethodPatch || method == http.MethodDelete
}
