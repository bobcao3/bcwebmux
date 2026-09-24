package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/quic-go/quic-go/http3"
)

func tlsTestConfig(t *testing.T) (Config, *tls.Config) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certPath, certPEM, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), 0600); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(certPEM)
	return Config{Host: "127.0.0.1", Port: 0, TLSCert: certPath, TLSKey: keyPath, HTTP3: true, EmbeddedAssets: testAssets(), Engine: &fakeEngine{}}, &tls.Config{RootCAs: roots}
}

func TestHTTP3Flag(t *testing.T) {
	if _, _, err := ParseConfig([]string{"--config", "/dev/null", "--http3"}); err == nil {
		t.Fatal("HTTP3 without TLS accepted")
	}
	cfg, _, err := ParseConfig([]string{"--config", "/dev/null", "--http3", "--tls-cert", "cert", "--tls-key", "key"})
	if err != nil || !cfg.HTTP3 {
		t.Fatalf("config: %+v %v", cfg, err)
	}
	if _, err := New(Config{HTTP3: true, Engine: &fakeEngine{}}); err == nil {
		t.Fatal("New accepted HTTP3 without TLS")
	}
}

func TestHTTP3RequestsAndAdvertisement(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(enabled), func(t *testing.T) {
			cfg, clientTLS := tlsTestConfig(t)
			cfg.HTTP3 = enabled
			s, _ := startTestServer(t, cfg)
			tcp := &http.Transport{TLSClientConfig: clientTLS, ForceAttemptHTTP2: true}
			defer tcp.CloseIdleConnections()
			client := &http.Client{Transport: tcp, Timeout: 3 * time.Second}
			response, err := client.Get(s.Origin() + "/")
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.ProtoMajor != 2 {
				t.Fatalf("TCP protocol %s", response.Proto)
			}
			alt := response.Header.Get("Alt-Svc")
			if enabled && !strings.Contains(alt, `h3=":`+strconv.Itoa(s.Addr().(*net.TCPAddr).Port)+`"`) {
				t.Fatalf("Alt-Svc %q", alt)
			}
			if !enabled && alt != "" {
				t.Fatalf("disabled Alt-Svc %q", alt)
			}
			plain := httptest.NewRecorder()
			s.ServeHTTP(plain, httptest.NewRequest("GET", "http://localhost/", nil))
			if plain.Header().Get("Alt-Svc") != "" {
				t.Fatal("advertised on plaintext")
			}
			if !enabled {
				return
			}
			quic := &http3.Transport{TLSClientConfig: clientTLS}
			defer quic.Close()
			client.Transport = quic
			for _, path := range []string{"/", "/api/server", "/ws"} {
				response, err = client.Get(s.Origin() + path)
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				if response.ProtoMajor != 3 || response.TLS == nil || response.TLS.Version != tls.VersionTLS13 {
					t.Fatalf("not QUIC TLS1.3: %+v", response)
				}
				want := http.StatusOK
				if path == "/ws" {
					want = http.StatusBadRequest
				}
				if response.StatusCode != want {
					t.Fatalf("%s: %d %s", path, response.StatusCode, body)
				}
				if path == "/" && !strings.Contains(string(body), "<html>") {
					t.Fatalf("asset %q", body)
				}
				if path == "/api/server" && string(body) != `{"ok":true}` {
					t.Fatalf("API %q", body)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := s.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := client.Get(s.Origin() + "/"); err == nil {
				t.Fatal("QUIC survived shutdown")
			}
		})
	}
}

func TestHTTP3UDPCollisionAndShutdownBeforeServe(t *testing.T) {
	cfg, _ := tlsTestConfig(t)
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	cfg.Port = udp.LocalAddr().(*net.UDPAddr).Port
	if _, err := New(cfg); err == nil {
		t.Fatal("UDP collision accepted")
	}
	tcp, err := net.Listen("tcp", udp.LocalAddr().String())
	if err != nil {
		t.Fatalf("TCP leaked: %v", err)
	}
	tcp.Close()
	engine := cfg.Engine.(*fakeEngine)
	if engine.closed {
		t.Fatal("borrowed engine closed on startup error")
	}
	cfg.Port = 0
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	addr := s.Addr().String()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Serve(); err != nil {
		t.Fatal(err)
	}
	udp2, err := net.ListenPacket("udp", addr)
	if err != nil {
		t.Fatalf("UDP leaked: %v", err)
	}
	udp2.Close()
	if !engine.closed {
		t.Fatal("engine not closed")
	}
}

func TestHTTP3ShutdownWaitsForNativeHandler(t *testing.T) {
	cfg, clientTLS := tlsTestConfig(t)
	entered, release := make(chan struct{}), make(chan struct{})
	engine := cfg.Engine.(*fakeEngine)
	engine.response = func(native.RESTRequest) native.RESTResponse {
		close(entered)
		<-release
		return native.RESTResponse{Status: http.StatusOK}
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- s.Serve() }()
	transport := &http3.Transport{TLSClientConfig: clientTLS}
	defer transport.Close()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		response, _ := client.Get(s.Origin() + "/api/server")
		if response != nil {
			response.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("handler not entered")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err = s.Shutdown(ctx)
	cancel()
	if err != context.DeadlineExceeded {
		close(release)
		t.Fatalf("shutdown should wait for native handler: %v", err)
	}
	select {
	case <-s.shutdownDone:
		close(release)
		t.Fatal("engine teardown before handler exit")
	default:
	}
	close(release)
	ctx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("Serve did not stop")
	}
	<-requestDone
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if !engine.closed {
		t.Fatal("engine not torn down")
	}
}

func TestHTTP3ServeFailureReturns(t *testing.T) {
	cfg, _ := tlsTestConfig(t)
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Serve() }()
	// An unexpected UDP failure must wake main instead of leaving only TCP alive.
	s.udp.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Error("UDP failure hidden")
		}
	case <-time.After(2 * time.Second):
		t.Error("UDP failure did not reach owner")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestHTTP3BodyReadDeadline(t *testing.T) {
	cfg, clientTLS := tlsTestConfig(t)
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s.http.ReadTimeout = 50 * time.Millisecond
	serveDone := make(chan error, 1)
	go func() { serveDone <- s.Serve() }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-serveDone; err != nil {
			t.Fatal(err)
		}
	}()
	transport := &http3.Transport{TLSClientConfig: clientTLS}
	defer transport.Close()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	request, err := http.NewRequest("POST", s.Origin()+"/api/sessions", reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", s.Origin())
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: %d", response.StatusCode)
	}
}
