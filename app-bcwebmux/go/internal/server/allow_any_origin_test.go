package server

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
	"github.com/coder/websocket"
)

func TestAllowAnyOriginTransport(t *testing.T) {
	home, _ := configHome(t)
	file := filepath.Join(home, "permissive.toml")
	putConfig(t, file, "allow-any-origin = true\nauth = false\n")
	for _, mode := range []struct {
		name string
		args []string
		any  bool
	}{
		{"default strict", []string{"--listen=127.0.0.1:0", "--origin=https://configured.example", "--auth=false"}, false},
		{"CLI permissive wildcard", []string{"--listen=0.0.0.0:0", "--allow-any-origin", "--auth=false"}, true},
		{"TOML permissive", []string{"--config", file, "--listen=127.0.0.1:0"}, true},
		{"CLI false restores strict", []string{"--config", file, "--listen=127.0.0.1:0", "--origin=https://configured.example", "--allow-any-origin=false"}, false},
	} {
		t.Run(mode.name, func(t *testing.T) {
			cfg, help, err := ParseConfig(mode.args)
			if err != nil || help {
				t.Fatalf("parse: help=%t, error=%v", help, err)
			}
			cfg.MetadataFile = filepath.Join(t.TempDir(), "metadata.json")
			instance, _ := startTestServer(t, cfg)
			_, port, err := net.SplitHostPort(instance.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			address := net.JoinHostPort("127.0.0.1", port)
			client := &http.Client{Timeout: 2 * time.Second}
			defer client.CloseIdleConnections()
			for _, origin := range []struct {
				name   string
				values []string
			}{
				{"configured", []string{"https://configured.example"}},
				{"foreign", []string{"https://forwarder.example:9443"}},
				{"missing", nil},
				{"opaque", []string{"null"}},
				{"multiple", []string{"https://configured.example", "https://forwarder.example:9443"}},
			} {
				t.Run(origin.name, func(t *testing.T) {
					allowed := mode.any || origin.name == "configured"
					request, err := http.NewRequest(http.MethodPost, "http://"+address+"/api/example", strings.NewReader("{}"))
					if err != nil {
						t.Fatal(err)
					}
					request.Header["Origin"] = origin.values
					response, err := client.Do(request)
					if err != nil {
						t.Fatal(err)
					}
					response.Body.Close()
					want := http.StatusForbidden
					if allowed {
						want = http.StatusOK
					}
					if response.StatusCode != want {
						t.Errorf("POST status = %d, want %d", response.StatusCode, want)
					}

					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					defer cancel()
					conn, response, err := websocket.Dial(ctx, "ws://"+address+"/ws", &websocket.DialOptions{
						Subprotocols: []string{native.Protocol},
						HTTPHeader:   http.Header{"Origin": origin.values},
					})
					if conn != nil {
						defer conn.CloseNow()
					}
					if allowed {
						if err != nil {
							t.Fatalf("WebSocket upgrade: %v", err)
						}
						if response.StatusCode != http.StatusSwitchingProtocols || conn.Subprotocol() != native.Protocol {
							t.Fatalf("WebSocket status/protocol = %d/%q", response.StatusCode, conn.Subprotocol())
						}
					} else if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
						t.Fatalf("WebSocket rejection = %v, error=%v", response, err)
					}
				})
			}
			if mode.any {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				conn, response, err := websocket.Dial(ctx, "ws://"+address+"/ws", &websocket.DialOptions{Subprotocols: []string{"wrong-protocol"}})
				if conn != nil {
					conn.CloseNow()
				}
				if err == nil || response == nil || response.StatusCode != http.StatusBadRequest {
					t.Fatalf("permissive mode bypassed subprotocol guard: %v, error=%v", response, err)
				}
			}
		})
	}
}

func TestAllowAnyOriginRequiresExplicitAuthDisable(t *testing.T) {
	home, _ := configHome(t)
	file := filepath.Join(home, "permissive.toml")
	putConfig(t, file, "allow-any-origin = true\n")
	for _, test := range []struct {
		name string
		args []string
	}{
		{"CLI with default auth", []string{"--listen=127.0.0.1:0", "--allow-any-origin"}},
		{"TOML with default auth", []string{"--listen=127.0.0.1:0", "--config", file}},
		{"explicit auth", []string{"--listen=127.0.0.1:0", "--allow-any-origin", "--auth=true"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := ParseConfig(test.args); err == nil || !strings.Contains(err.Error(), "requires --auth=false") {
				t.Fatalf("authentication conflict error = %v", err)
			}
		})
	}
	instance, err := New(Config{Host: "127.0.0.1", Engine: &fakeEngine{}, EmbeddedAssets: testAssets(), AuthEnabled: true, AllowAnyOrigin: true})
	if instance != nil {
		defer instance.Shutdown(context.Background())
	}
	if err == nil || !strings.Contains(err.Error(), "requires --auth=false") {
		t.Fatalf("constructor authentication conflict error = %v", err)
	}
	putConfig(t, file, "allow-any-origin = true\nauth = false\n")
	if _, _, err := ParseConfig([]string{"--listen=0.0.0.0:0", "--config", file, "--allow-any-origin=false"}); err == nil || !strings.Contains(err.Error(), "--origin") {
		t.Fatalf("strict wildcard binding error = %v", err)
	}
}
