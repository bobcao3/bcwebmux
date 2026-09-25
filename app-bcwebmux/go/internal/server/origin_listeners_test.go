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
	cfg, _, err = ParseConfig([]string{"--origin=http://proxy.invalid", "--listen=127.0.0.1:8443"})
	if err != nil || !reflect.DeepEqual(cfg.Listen, []string{"127.0.0.1"}) {
		t.Fatalf("override: %+v %v", cfg, err)
	}
}

func TestBindPortSelection(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	parse := func(args ...string) Config {
		t.Helper()
		cfg, help, err := ParseConfig(args)
		if err != nil || help {
			t.Fatalf("parse %v: %v help=%v", args, err, help)
		}
		return cfg
	}
	if cfg := parse("--origin=https://host.example:3443"); cfg.Port != 3443 {
		t.Fatalf("origin port ignored: %+v", cfg)
	}
	if cfg := parse("--origin=https://host.example"); cfg.Port != 443 {
		t.Fatalf("origin scheme default ignored: %+v", cfg)
	}
	if cfg := parse("--origin=http://host.example"); cfg.Port != 80 {
		t.Fatalf("origin scheme default ignored: %+v", cfg)
	}
	if cfg := parse("--origin=https://host.example:3443", "--listen=127.0.0.1:8443"); cfg.Port != 8443 {
		t.Fatalf("--listen port did not win: %+v", cfg)
	}
	if cfg := parse("--listen=127.0.0.1:9000", "--listen=127.0.0.2:9000"); cfg.Port != 9000 {
		t.Fatalf("--listen port ignored: %+v", cfg)
	}
	if _, _, err := ParseConfig([]string{"--origin=https://a.example:1", "--origin=https://b.example:2"}); err == nil {
		t.Fatal("origins on different ports accepted")
	}
	if _, _, err := ParseConfig([]string{"--listen=127.0.0.1:1", "--listen=127.0.0.2:2"}); err == nil {
		t.Fatal("--listen ports that disagree accepted")
	}
	if _, _, err := ParseConfig([]string{"--listen=127.0.0.1"}); err == nil {
		t.Fatal("--listen without a port accepted")
	}
	if _, _, err := ParseConfig([]string{"--origin=https://host.example", "--listen=127.0.0.1:8443"}); err != nil {
		t.Fatalf("--listen with a port: %v", err)
	}
}

func TestListenTargetParsing(t *testing.T) {
	for _, tc := range []struct {
		target string
		host   string
		port   int
	}{
		{"127.0.0.1", "127.0.0.1", -1},
		{"127.0.0.1:3443", "127.0.0.1", 3443},
		{"localhost:3443", "localhost", 3443},
		{"100.64.0.0/10", "100.64.0.0/10", -1},
		{"100.64.0.0/10:3443", "100.64.0.0/10", 3443},
		{"[::1]", "::1", -1},
		{"[::1]:3443", "::1", 3443},
		{"::1", "::1", -1},
		{"[2001:db8::/32]:3443", "2001:db8::/32", 3443},
		{"2001:db8::/32", "2001:db8::/32", -1},
	} {
		host, port, err := splitListenTarget(tc.target)
		if err != nil || host != tc.host || port != tc.port {
			t.Errorf("splitListenTarget(%q) = %q, %d, %v; want %q, %d", tc.target, host, port, err, tc.host, tc.port)
		}
	}
	for _, bad := range []string{"", "127.0.0.1:", "127.0.0.1:abc", "127.0.0.1:70000", "[::1", "localhost:99999"} {
		if _, _, err := splitListenTarget(bad); err == nil {
			t.Errorf("splitListenTarget(%q) accepted", bad)
		}
	}
}
