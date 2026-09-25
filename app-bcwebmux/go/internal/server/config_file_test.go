package server

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func configHome(t *testing.T) (string, string) {
	t.Helper()
	home, xdg := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", xdg)
	t.Setenv("XDG_HOME", t.TempDir())
	return home, xdg
}
func putConfig(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestConfigDiscoveryAndOverrides(t *testing.T) {
	home, xdg := configHome(t)
	parse := func(args ...string) Config {
		t.Helper()
		c, help, err := ParseConfig(args)
		if err != nil || help {
			t.Fatalf("parse: %v help=%v", err, help)
		}
		return c
	}
	if _, _, err := ParseConfig(nil); err == nil {
		t.Fatal("parse accepted a run with no port")
	}
	putConfig(t, filepath.Join(home, ".bcwebmux.toml"), "listen = [\"127.0.0.1:8101\"]\n")
	if c := parse(); c.Port != 8101 || c.Term != "xterm-ghostty" || !c.KittyGraphics {
		t.Fatal(c)
	}
	path := filepath.Join(xdg, "bcwebmux", "config.toml")
	putConfig(t, path, `listen = ["127.0.0.1:8102", "127.0.0.2:8102"]
origins = ["https://one.example", "https://two.example"]
http3 = true
tls-cert = "cert"
tls-key = "key"
max-sessions = 19
term = "xterm-256color"
kitty-graphics = false
`)
	if c := parse(); c.Port != 8102 || !c.HTTP3 || len(c.Listen) != 2 || len(c.Origins) != 2 || c.Term != "xterm-256color" || c.KittyGraphics {
		t.Fatal(c)
	}
	c := parse("--http3=false", "--listen=127.0.0.3:8103", "--listen=127.0.0.4:8103", "--origin=https://cli.example", "--term=screen-256color", "--kitty-graphics=true")
	if c.Port != 8103 || c.HTTP3 || c.Term != "screen-256color" || !c.KittyGraphics || !reflect.DeepEqual(c.Listen, []string{"127.0.0.3", "127.0.0.4"}) || !reflect.DeepEqual(c.origins(), []string{"https://cli.example"}) {
		t.Fatal(c)
	}
	putConfig(t, path, "host = \"127.0.0.5\"\norigins = [\"http://127.0.0.5:8104\"]\n")
	if c := parse(); c.Host != "127.0.0.5" || len(c.Listen) != 0 || c.Port != 8104 {
		t.Fatal(c)
	}
	if c := parse("--config", filepath.Join(home, ".bcwebmux.toml")); c.Port != 8101 {
		t.Fatal(c)
	}
	if _, _, err := ParseConfig([]string{"--config", filepath.Join(home, "missing")}); err == nil {
		t.Fatal("missing explicit accepted")
	}
	putConfig(t, path, "bad = [")
	if _, help, err := ParseConfig([]string{"--help"}); err != nil || !help {
		t.Fatalf("help: %v", err)
	}
	if _, help, err := ParseConfig([]string{"--config", path, "--help"}); err != nil || !help {
		t.Fatalf("help with config: %v", err)
	}
	for _, body := range []string{"bad = [", "unknown = true", "listen = 'x'", "listen = ['127.0.0.1']", "listen = ['127.0.0.1:70000']", "listen = ['127.0.0.1:8080', '127.0.0.2:8081']", "listen = []", "listen = ['100.64.0.0/10:8443']", "origins = ['*']", "origins = ['']"} {
		putConfig(t, path, body)
		if _, _, err := ParseConfig(nil); err == nil {
			t.Errorf("accepted %q", body)
		}
	}
}
func TestConfigXDGHomeFallback(t *testing.T) {
	home, xdg := configHome(t)
	putConfig(t, filepath.Join(home, ".bcwebmux.toml"), "listen = [\"127.0.0.1:8101\"]")
	alternate := os.Getenv("XDG_HOME")
	putConfig(t, filepath.Join(alternate, "bcwebmux", "config.toml"), "listen = [\"127.0.0.1:8102\"]")
	c, _, err := ParseConfig(nil)
	if err != nil || c.Port != 8101 {
		t.Fatalf("standard must win: %+v %v", c, err)
	}
	_ = os.Unsetenv("XDG_CONFIG_HOME")
	c, _, err = ParseConfig(nil)
	if err != nil || c.Port != 8102 {
		t.Fatalf("fallback: %+v %v", c, err)
	}
	t.Setenv("XDG_HOME", "")
	putConfig(t, filepath.Join(home, ".config", "bcwebmux", "config.toml"), "listen = [\"127.0.0.1:8103\"]")
	c, _, err = ParseConfig(nil)
	if err != nil || c.Port != 8103 {
		t.Fatalf("home config: %+v %v (%s)", c, err, xdg)
	}
}
func TestListenRangeResolution(t *testing.T) {
	hosts, err := resolveListeners([]string{"127.0.0.1", "127.0.0.0/8", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, host := range hosts {
		if seen[host] || !HostIsLoopback(host) {
			t.Fatalf("bad hosts: %v", hosts)
		}
		seen[host] = true
	}
	if !seen["127.0.0.1"] {
		t.Fatal(hosts)
	}
	if _, err := resolveListeners([]string{"192.0.2.255/32"}); err == nil || !strings.Contains(err.Error(), "no assigned local addresses") {
		t.Fatalf("unmatched: %v", err)
	}
}
