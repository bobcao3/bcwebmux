package server

import (
	"reflect"
	"strings"
	"testing"
)

func TestOriginListenerSpecs(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  Config
		want []string
	}{
		{"default", Config{}, []string{DefaultHost}},
		{"origins", Config{Origins: []string{"https://localhost:3443", "https://[::1]:3443", "http://localhost:8080"}}, []string{"localhost", "::1"}},
		{"legacy origin", Config{Origin: "https://localhost:3443"}, []string{"localhost"}},
		{"host override", Config{Host: "127.0.0.1", Origin: "https://proxy.example"}, []string{"127.0.0.1"}},
		{"listen override", Config{Listen: []string{"127.0.0.0/8"}, Host: "localhost", Origin: "https://proxy.example"}, []string{"127.0.0.0/8"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.listenSpecs(); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestOriginListenerResolution(t *testing.T) {
	cfg := Config{Origins: []string{"https://localhost:3443", "https://127.0.0.1:3443"}}
	hosts, err := cfg.resolveListeners()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, host := range hosts {
		if !HostIsLoopback(host) || seen[host] {
			t.Fatalf("unexpected or duplicate host %q", host)
		}
		seen[host] = true
	}
	if !seen["127.0.0.1"] {
		t.Fatalf("missing local IPv4: %v", hosts)
	}
	for _, origin := range []string{"http://192.0.2.255", "http://0.0.0.0", "http://[::]"} {
		_, err := (Config{Origins: []string{"http://localhost", origin}}).resolveListeners()
		if err == nil || !strings.Contains(err.Error(), "no assigned local address") {
			t.Fatalf("%s: %v", origin, err)
		}
	}
	hosts, err = (Config{Host: "127.0.0.1", Origin: "https://proxy.invalid"}).resolveListeners()
	if err != nil || !reflect.DeepEqual(hosts, []string{"127.0.0.1"}) {
		t.Fatalf("explicit override: %v %v", hosts, err)
	}
}

func TestParseOriginDerivedListeners(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg, _, err := ParseConfig([]string{"--origin=http://localhost:8080"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "" || !reflect.DeepEqual(cfg.listenSpecs(), []string{"localhost"}) {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	cfg, _, err = ParseConfig([]string{"--origin=http://proxy.invalid", "--host=127.0.0.1"})
	if err != nil || cfg.Host != "127.0.0.1" {
		t.Fatalf("override: %+v %v", cfg, err)
	}
}
