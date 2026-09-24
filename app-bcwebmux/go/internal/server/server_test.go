package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"io/fs"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/gorilla/websocket"
)

type fakeEngine struct {
	mu       sync.Mutex
	requests []native.RESTRequest
	closed   bool
	response func(native.RESTRequest) native.RESTResponse
}

func (e *fakeEngine) REST(request native.RESTRequest) (native.RESTResponse, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return native.RESTResponse{}, native.ErrClosed
	}
	e.requests = append(e.requests, request)
	if e.response != nil {
		return e.response(request), nil
	}
	return native.RESTResponse{Status: http.StatusOK, ContentType: "application/json; charset=utf-8", Body: []byte(`{"ok":true}`)}, nil
}

func (e *fakeEngine) OpenSocket() (native.Socket, error) {
	return nil, errors.New("fake socket unused")
}

func (e *fakeEngine) Close() error {
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
	return nil
}

func testAssets() fs.FS {
	return fstest.MapFS{
		"web/index.html":       &fstest.MapFile{Data: []byte("<html><body>test</body></html>")},
		"web/app.js":           &fstest.MapFile{Data: []byte("console.log('test')")},
		"web/auth/login.html":  &fstest.MapFile{Data: []byte("<html><body>sign in with a security key</body></html>")},
		"web/auth/login.js":    &fstest.MapFile{Data: []byte("export {};")},
		"web/auth/login.css":   &fstest.MapFile{Data: []byte("body {}")},
		"web/auth/webauthn.js": &fstest.MapFile{Data: []byte("export {};")},
	}
}

func startTestServer(t *testing.T, cfg Config) (*Server, <-chan error) {
	t.Helper()
	if cfg.EmbeddedAssets == nil {
		cfg.EmbeddedAssets = testAssets()
	}
	if cfg.Engine == nil {
		cfg.Engine = &fakeEngine{}
	}
	instance, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	errCh := make(chan error, 1)
	go func() { errCh <- instance.Serve() }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := instance.Shutdown(ctx); err != nil {
			t.Errorf("server shutdown: %v", err)
		}
		select {
		case err := <-errCh:
			if err != nil {
				t.Errorf("server serve: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("server did not stop")
		}
	})
	return instance, errCh
}

func TestHTTPAssetsOriginAndBounds(t *testing.T) {
	engine := &fakeEngine{response: func(request native.RESTRequest) native.RESTResponse {
		return native.RESTResponse{
			Status:      http.StatusOK,
			ContentType: "application/json; charset=utf-8",
			Body:        []byte(`{"protocol":"bcw.sessions"}`),
		}
	}}
	instance, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0, Engine: engine})
	client := &http.Client{Timeout: 2 * time.Second}
	base := "http://" + instance.Addr().String()

	response, err := client.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d", response.StatusCode)
	}
	etag := response.Header.Get("ETag")
	if !strings.HasPrefix(etag, `"`) {
		t.Fatalf("bad ETag %q", etag)
	}
	if response.Header.Get("Content-Security-Policy") == "" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("asset security headers missing")
	}
	_ = response.Body.Close()

	request, _ := http.NewRequest(http.MethodGet, base+"/", nil)
	request.Header.Set("If-None-Match", etag)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotModified {
		t.Fatalf("conditional asset status = %d", response.StatusCode)
	}
	_ = response.Body.Close()

	for _, target := range []string{"/%2e%2e/app.js", "/../app.js", "/web/../../app.js"} {
		response, err = client.Get(base + target)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("path %q status = %d, want 404", target, response.StatusCode)
		}
		_ = response.Body.Close()
	}

	body := strings.NewReader(`{"profile":"shell"}`)
	request, _ = http.NewRequest(http.MethodPost, base+"/api/sessions", body)
	request.Header.Set("Content-Type", "application/json")
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("missing origin status = %d", response.StatusCode)
	}
	_ = response.Body.Close()

	request, _ = http.NewRequest(http.MethodPost, base+"/api/sessions", strings.NewReader(strings.Repeat("x", MaxRequestBytes+1)))
	request.Header.Set("Origin", instance.Origin())
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request status = %d", response.StatusCode)
	}
	_ = response.Body.Close()

	request, err = http.NewRequest(http.MethodPost, base+"/api/sessions", strings.NewReader(strings.Repeat("x", MaxRequestBytes+1)))
	if err != nil {
		t.Fatal(err)
	}
	request.ContentLength = -1
	request.Header.Set("Origin", instance.Origin())
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked oversized request status = %d", response.StatusCode)
	}
	_ = response.Body.Close()

	request, _ = http.NewRequest(http.MethodGet, base+"/api/server", nil)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Idempotency-Replayed") != "false" {
		t.Fatalf("API response status/header = %d/%q", response.StatusCode, response.Header.Get("Idempotency-Replayed"))
	}
	_ = response.Body.Close()

	const asset = "console.log('test')"
	for _, source := range []string{"embedded", "disk"} {
		t.Run(source, func(t *testing.T) {
			cfg := Config{}
			if source == "disk" {
				cfg.WebRoot = t.TempDir()
				if err := os.WriteFile(filepath.Join(cfg.WebRoot, "app.js"), []byte(asset), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			instance, _ := startTestServer(t, cfg)
			base := "http://" + instance.Addr().String()
			response, err := client.Get(base + "/app.js")
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			if err != nil {
				_ = response.Body.Close()
				t.Fatal(err)
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			if string(body) != asset {
				t.Fatalf("asset body = %q", body)
			}
			etag := response.Header.Get("ETag")

			for _, requestTest := range []struct {
				name        string
				method      string
				header      string
				value       string
				status      int
				body        string
				checkLength bool
			}{
				{name: "HEAD", method: http.MethodHead, status: http.StatusOK, checkLength: true},
				{name: "If-None-Match", method: http.MethodGet, header: "If-None-Match", value: "W/" + etag, status: http.StatusNotModified},
				{name: "If-Match", method: http.MethodGet, header: "If-Match", value: `"not-current"`, status: http.StatusPreconditionFailed},
				{name: "Range", method: http.MethodGet, header: "Range", value: "bytes=0-6", status: http.StatusPartialContent, body: "console"},
				{name: "unsatisfiable range", method: http.MethodGet, header: "Range", value: "bytes=999-", status: http.StatusRequestedRangeNotSatisfiable, body: "invalid range: failed to overlap\n"},
			} {
				t.Run(requestTest.name, func(t *testing.T) {
					request, err := http.NewRequest(requestTest.method, base+"/app.js", nil)
					if err != nil {
						t.Fatal(err)
					}
					if requestTest.header != "" {
						request.Header.Set(requestTest.header, requestTest.value)
					}
					response, err := client.Do(request)
					if err != nil {
						t.Fatal(err)
					}
					body, err := io.ReadAll(response.Body)
					if err != nil {
						_ = response.Body.Close()
						t.Fatal(err)
					}
					if err := response.Body.Close(); err != nil {
						t.Fatal(err)
					}
					if response.StatusCode != requestTest.status {
						t.Errorf("status = %d, want %d", response.StatusCode, requestTest.status)
					}
					if string(body) != requestTest.body {
						t.Errorf("body = %q, want %q", body, requestTest.body)
					}
					if requestTest.checkLength && response.ContentLength != int64(len(asset)) {
						t.Errorf("Content-Length = %d, want %d", response.ContentLength, len(asset))
					}
				})
			}
		})
	}
}

func TestOriginPolicy(t *testing.T) {
	engine := &fakeEngine{}
	_, err := New(Config{Host: "0.0.0.0", Port: 0, Engine: engine, EmbeddedAssets: testAssets()})
	if err == nil || !strings.Contains(err.Error(), "--origin") {
		t.Fatalf("remote bind without origin error = %v", err)
	}

	for _, test := range []struct {
		origin string
		tls    bool
		valid  bool
	}{
		{"http://localhost:8080", false, true},
		{"https://terminal.example", false, true},
		{"https://terminal.example", true, true},
		{"http://terminal.example", true, false},
		{"file://terminal.example", false, false},
		{"https://terminal.example/path", false, false},
	} {
		err := ValidateOrigin(test.origin, test.tls)
		if (err == nil) != test.valid {
			t.Errorf("ValidateOrigin(%q, tls=%t) error = %v, valid = %t", test.origin, test.tls, err, test.valid)
		}
	}
}

func TestWebSocketPathRequiresExactOriginAndProtocol(t *testing.T) {
	instance, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0, Engine: &fakeEngine{}})
	url := "ws://" + instance.Addr().String() + "/ws"
	for _, test := range []struct {
		name     string
		origin   string
		protocol string
	}{
		{"wrong origin", "http://evil.invalid", native.Protocol},
		{"missing protocol", instance.Origin(), "other"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dialer := websocket.Dialer{Subprotocols: []string{test.protocol}, HandshakeTimeout: time.Second}
			header := http.Header{"Origin": []string{test.origin}}
			conn, response, err := dialer.Dial(url, header)
			if err == nil {
				_ = conn.Close()
				t.Fatal("unsupported WebSocket handshake succeeded")
			}
			if response == nil || (response.StatusCode != http.StatusForbidden && response.StatusCode != http.StatusBadRequest) {
				t.Fatalf("handshake response = %#v, err = %v", response, err)
			}
		})
	}
}

// writeTestCertificate writes a self-signed certificate for the given DNS
// names, which is enough to ask which origins it can cover.
func writeTestCertificate(t *testing.T, dir string, dnsNames ...string) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: dnsNames[0]},
		DNSNames:     dnsNames,
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certPath, keyPath
}

// A certificate that does not name an origin leaves the browser on a
// certificate error page, where WebAuthn fails with a security error instead of
// prompting for a key. That is a certificate problem wearing an authentication
// costume, so startup must name the origins at fault.
func TestTLSWarningsNameOriginsOutsideTheCertificate(t *testing.T) {
	directory := t.TempDir()
	certPath, keyPath := writeTestCertificate(t, directory, "terminal.example", "localhost")
	instance, err := New(Config{
		Host: "127.0.0.1", Port: 0,
		Origins:        []string{"https://localhost:8443", "https://terminal.example:8443", "https://bobcao3arch.local:8443"},
		TLSCert:        certPath,
		TLSKey:         keyPath,
		AuthEnabled:    true,
		AuthFile:       filepath.Join(directory, "auth.json"),
		EmbeddedAssets: testAssets(),
		Engine:         &fakeEngine{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = instance.Shutdown(ctx)
	})
	warnings := instance.TLSWarnings()
	if len(warnings) != 1 || !strings.Contains(warnings[0], "https://bobcao3arch.local:8443") {
		t.Fatalf("TLS warnings = %v", warnings)
	}
}

// Without TLS in this process the certificate is somebody else's business.
func TestTLSWarningsAreSilentWithoutACertificate(t *testing.T) {
	instance, err := New(Config{
		Host: "127.0.0.1", Port: 0, Origin: "http://localhost:8443",
		EmbeddedAssets: testAssets(), Engine: &fakeEngine{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = instance.Shutdown(ctx)
	})
	if warnings := instance.TLSWarnings(); len(warnings) != 0 {
		t.Fatalf("TLS warnings without a certificate = %v", warnings)
	}
}
