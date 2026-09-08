package server

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/gorilla/websocket"
	"github.com/quic-go/quic-go/http3"
)

func TestMultipleListenersRequestsAndShutdown(t *testing.T) {
	for _, h3 := range []bool{false, true} {
		t.Run(fmt.Sprint(h3), func(t *testing.T) {
			cfg := Config{Engine: &fakeEngine{}, EmbeddedAssets: testAssets()}
			var clientTLS *tls.Config
			if h3 {
				cfg, clientTLS = tlsTestConfig(t)
				clientTLS.ServerName = "127.0.0.1"
			}
			cfg.Listen = []string{"127.0.0.1", "127.0.0.2", "127.0.0.1"}
			cfg.Origins = []string{"https://one.example", "https://two.example"}
			s, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Shutdown(context.Background())
			if len(s.Addrs()) != 2 || s.Addr().String() != s.Addrs()[0].String() {
				t.Fatal(s.Addrs())
			}
			done := make(chan error, 1)
			go func() { done <- s.Serve() }()
			clients := []*http.Client{{Transport: &http.Transport{TLSClientConfig: clientTLS}, Timeout: 3 * time.Second}}
			scheme := "http"
			if h3 {
				scheme = "https"
				tr := &http3.Transport{TLSClientConfig: clientTLS}
				defer tr.Close()
				clients = append(clients, &http.Client{Transport: tr, Timeout: 3 * time.Second})
			}
			for _, client := range clients {
				defer client.CloseIdleConnections()
				for _, addr := range s.Addrs() {
					response, err := client.Get(scheme + "://" + addr.String() + "/")
					if err != nil {
						t.Fatal(err)
					}
					response.Body.Close()
					if response.StatusCode != http.StatusOK {
						t.Fatal(response.Status)
					}
					for _, origin := range cfg.Origins {
						req, _ := http.NewRequest(http.MethodPost, scheme+"://"+addr.String()+"/api/sessions", strings.NewReader("{}"))
						req.Header.Set("Origin", origin)
						req.Header.Set("Content-Type", "application/json")
						response, err = client.Do(req)
						if err != nil {
							t.Fatal(err)
						}
						response.Body.Close()
						if response.StatusCode != http.StatusOK {
							t.Fatalf("origin %s: %s", origin, response.Status)
						}
					}
				}
			}
			for _, values := range [][]string{{}, {"https://evil.example"}, {"https://one.example", "https://two.example"}, {"https://one.example https://two.example"}, {"null"}} {
				req := httptest.NewRequest(http.MethodPost, "http://example/api/sessions", strings.NewReader("{}"))
				req.Header["Origin"] = values
				if s.validOrigin(req) {
					t.Fatalf("accepted %v", values)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := s.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("serve stuck")
			}
			for _, addr := range s.Addrs() {
				l, err := net.Listen("tcp", addr.String())
				if err != nil {
					t.Fatalf("TCP leaked: %v", err)
				}
				l.Close()
				if h3 {
					u, err := net.ListenPacket("udp", addr.String())
					if err != nil {
						t.Fatalf("UDP leaked: %v", err)
					}
					u.Close()
				}
			}
		})
	}
}

func TestMultipleListenersAtomicRollback(t *testing.T) {
	for _, transport := range []string{"tcp", "udp"} {
		t.Run(transport, func(t *testing.T) {
			cfg, _ := tlsTestConfig(t)
			cfg.Listen = []string{"127.0.0.1", "127.0.0.2"}
			var port int
			if transport == "tcp" {
				l, err := net.Listen("tcp", "127.0.0.2:0")
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				port = l.Addr().(*net.TCPAddr).Port
			} else {
				u, err := net.ListenPacket("udp", "127.0.0.2:0")
				if err != nil {
					t.Fatal(err)
				}
				defer u.Close()
				port = u.LocalAddr().(*net.UDPAddr).Port
			}
			cfg.Port = port
			if _, err := New(cfg); err == nil {
				t.Fatal("collision accepted")
			}
			if cfg.Engine.(*fakeEngine).closed {
				t.Fatal("borrowed engine closed")
			}
			addr := net.JoinHostPort("127.0.0.1", fmt.Sprint(port))
			l, err := net.Listen("tcp", addr)
			if err != nil {
				t.Fatalf("first TCP leaked: %v", err)
			}
			l.Close()
			u, err := net.ListenPacket("udp", addr)
			if err != nil {
				t.Fatalf("first UDP leaked: %v", err)
			}
			u.Close()
			if transport == "udp" {
				l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.2", fmt.Sprint(port)))
				if err != nil {
					t.Fatalf("second TCP leaked: %v", err)
				}
				l.Close()
			}
		})
	}
}

func TestMultipleOriginsWebSocket(t *testing.T) {
	s, _ := startTestServer(t, Config{Listen: []string{"127.0.0.1", "127.0.0.2"}, Origins: []string{"https://one.example", "https://two.example"}})
	for _, addr := range s.Addrs() {
		for _, origin := range []string{"https://one.example", "https://two.example", "https://evil.example", ""} {
			dialer := websocket.Dialer{Subprotocols: []string{native.Protocol}, HandshakeTimeout: time.Second}
			conn, response, err := dialer.Dial("ws://"+addr.String()+"/ws", http.Header{"Origin": []string{origin}})
			if strings.Contains(origin, "one.") || strings.Contains(origin, "two.") {
				if err != nil {
					t.Fatal(err)
				}
				conn.Close()
			} else {
				if err == nil {
					conn.Close()
					t.Fatal("bad origin accepted")
				}
				if response == nil || response.StatusCode != http.StatusForbidden {
					t.Fatalf("response: %v, %v", response, err)
				}
			}
		}
	}
}

func TestMultipleListenersShutdownBeforeServe(t *testing.T) {
	cfg, _ := tlsTestConfig(t)
	cfg.Listen = []string{"127.0.0.1", "127.0.0.2"}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Serve(); err != nil {
		t.Fatal(err)
	}
	for _, addr := range s.Addrs() {
		l, err := net.Listen("tcp", addr.String())
		if err != nil {
			t.Fatal(err)
		}
		l.Close()
		u, err := net.ListenPacket("udp", addr.String())
		if err != nil {
			t.Fatal(err)
		}
		u.Close()
	}
}
