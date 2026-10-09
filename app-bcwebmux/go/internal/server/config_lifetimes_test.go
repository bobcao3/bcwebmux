package server

import (
	"testing"
	"time"
)

func TestSessionMaximumAgeCoversTheSessionLifetime(t *testing.T) {
	// Discovery must not pick up the developer's own configuration file.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if _, _, err := ParseConfig([]string{"--origin=http://localhost:8080", "--auth-session-ttl=48h", "--auth-session-max-age=24h"}); err == nil {
		t.Fatal("a maximum age shorter than the session lifetime was accepted")
	}
	if _, _, err := ParseConfig([]string{"--origin=http://localhost:8080", "--auth-session-ttl=900h"}); err == nil {
		t.Fatal("a session lifetime longer than the default maximum age was accepted")
	}
	cfg, _, err := ParseConfig([]string{"--origin=http://localhost:8080", "--auth-session-max-age=2160h"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthSessionMaxAge != 2160*time.Hour {
		t.Fatalf("auth-session-max-age = %s", cfg.AuthSessionMaxAge)
	}
}
