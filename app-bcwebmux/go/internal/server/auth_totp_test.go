// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// rfcSecret is the shared secret from RFC 6238 Appendix B, so the derivation
// is checked against the published vectors rather than against itself.
func rfcSecret() []byte { return []byte("12345678901234567890") }

func TestTOTPMatchesRFCTestVectors(t *testing.T) {
	factor := authTOTP{Secret: rfcSecret(), Digits: 8, Period: 30, Algorithm: "SHA1"}
	for _, vector := range []struct {
		unix int64
		code string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
	} {
		code, err := totpCode(factor, vector.unix/30)
		if err != nil {
			t.Fatal(err)
		}
		if code != vector.code {
			t.Errorf("code at %d = %s, want %s", vector.unix, code, vector.code)
		}
	}
	if _, err := totpCode(authTOTP{Secret: rfcSecret(), Digits: 6, Period: 30, Algorithm: "MD5"}, 1); err == nil {
		t.Error("unsupported algorithm was accepted")
	}
}

func TestTOTPVerifySkewReplayAndLockout(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	factor, err := newTOTPFactor("user@host", time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	enrollTOTP(t, manager, factor)
	now := time.Unix(1_700_000_000, 0)
	step := now.Unix() / int64(factor.Period)
	current, err := totpCode(factor, step)
	if err != nil {
		t.Fatal(err)
	}
	if outcome := manager.verifyTOTP(current, now); outcome != totpAccepted {
		t.Fatalf("current code outcome = %v", outcome)
	}
	// The accepted step is consumed, so the same code cannot be replayed.
	if outcome := manager.verifyTOTP(current, now.Add(5*time.Second)); outcome != totpReplayed {
		t.Fatalf("replayed code outcome = %v", outcome)
	}
	// A code from the previous step is accepted while it is still in the skew
	// window and newer than what was accepted.
	previous, err := totpCode(factor, step+1)
	if err != nil {
		t.Fatal(err)
	}
	if outcome := manager.verifyTOTP(previous, now.Add(30*time.Second)); outcome != totpAccepted {
		t.Fatalf("next step outcome = %v", outcome)
	}
	// Stale codes and malformed entries are rejected.
	stale, err := totpCode(factor, step)
	if err != nil {
		t.Fatal(err)
	}
	if outcome := manager.verifyTOTP(stale, now.Add(time.Minute)); outcome != totpRejected {
		t.Fatalf("stale code outcome = %v", outcome)
	}
	if outcome := manager.verifyTOTP("12345", now); outcome != totpRejected {
		t.Fatalf("short code outcome = %v", outcome)
	}

	// Bad codes hit the limiter, which then rejects even a good code until it
	// expires, and a later attempt is allowed again.
	rejected, locked := 0, 0
	for index := 0; index < totpFailuresBeforeLockout+2; index++ {
		switch manager.verifyTOTP("000000", now) {
		case totpRejected:
			rejected++
		case totpLocked:
			locked++
		}
	}
	if rejected == 0 || locked == 0 {
		t.Fatalf("limiter outcomes: %d rejected, %d locked", rejected, locked)
	}
	if remaining := manager.totpLockRemaining(now); remaining <= 0 {
		t.Fatal("limiter did not lock after repeated failures")
	}
	// A good code is still refused while the limiter holds.
	lockedAt := now.Add(time.Second)
	lockedCode, err := totpCode(factor, lockedAt.Unix()/int64(factor.Period))
	if err != nil {
		t.Fatal(err)
	}
	if outcome := manager.verifyTOTP(lockedCode, lockedAt); outcome != totpLocked {
		t.Fatalf("locked outcome = %v", outcome)
	}
	// Once the backoff expires the next code from the app works again.
	expired := now.Add(5 * time.Minute)
	expiredCode, err := totpCode(factor, expired.Unix()/int64(factor.Period))
	if err != nil {
		t.Fatal(err)
	}
	if outcome := manager.verifyTOTP(expiredCode, expired); outcome != totpAccepted {
		t.Fatalf("outcome after lockout expiry = %v", outcome)
	}
}

func TestTOTPRequiresConfirmationBeforeStoring(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, nil, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	factor, err := newTOTPFactor("user@host", manager.now())
	if err != nil {
		t.Fatal(err)
	}
	if _, enrolled := manager.totpFactor(); enrolled {
		t.Fatal("factor appeared before enrollment")
	}
	code, err := totpCode(factor, manager.now().Unix()/int64(factor.Period))
	if err != nil {
		t.Fatal(err)
	}
	if outcome := verifyTOTPCode(factor, code, manager.now()); outcome != totpAccepted {
		t.Fatalf("confirmation code = %v", outcome)
	}
	if outcome := verifyTOTPCode(factor, "111111", manager.now()); outcome != totpRejected {
		t.Fatalf("wrong confirmation code = %v", outcome)
	}
	enrollTOTP(t, manager, factor)
	if enrolled, ok := manager.totpFactor(); !ok || enrolled.Digits != totpDigits {
		t.Fatalf("enrolled factor = %+v, %v", enrolled, ok)
	}
	// The secret is stored once and the file records the factor.
	state, err := loadAuthState(file, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	if state.TOTP == nil || len(state.SessionSecret) != 32 || len(state.UserHandle) != 32 {
		t.Fatalf("state after enrollment = %+v", state.TOTP != nil)
	}
}

func TestTOTPLoginWorksAtAnIPLiteralOrigin(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, []string{"http://127.0.0.1:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	factor, err := newTOTPFactor("user@host", manager.now())
	if err != nil {
		t.Fatal(err)
	}
	enrollTOTP(t, manager, factor)

	// The origin is an IP literal: no security key could ever be used here.
	serving := startAuthServerFor(t, "127.0.0.1", func(cfg *Config) { cfg.AuthFile = file })
	status := map[string]any{}
	response, body := serving.do(t, http.MethodGet, "/auth/session", nil, nil)
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || status["totp"] != true || status["required"] != true {
		t.Fatalf("status at an IP origin = %d %v", response.StatusCode, status)
	}
	if status["rpId"] != nil {
		t.Fatalf("an IP origin reported a relying party: %v", status["rpId"])
	}
	// Guarded before sign-in, and the key path is refused with a reason.
	response, _ = serving.do(t, http.MethodGet, "/api/server", nil, nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated API at an IP origin = %d", response.StatusCode)
	}

	// A code from the app signs in, and the session works at that origin.
	step := serving.authNow().Unix() / int64(factor.Period)
	code, err := totpCode(factor, step)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]string{"code": code})
	if err != nil {
		t.Fatal(err)
	}
	response, body = serving.post(t, "/auth/totp/verify", payload, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("totp verify = %d (%s)", response.StatusCode, body)
	}
	cookie := cookieNamed(t, response, authSessionCookie)
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authenticated API at an IP origin = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.do(t, http.MethodGet, "/", nil, map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authenticated page at an IP origin = %d (%s)", response.StatusCode, body)
	}

	// A replayed code is refused and the session it issued stays valid until
	// the factor it was issued to is removed.
	response, body = serving.post(t, "/auth/totp/verify", payload, nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed code = %d (%s)", response.StatusCode, body)
	}
	// Enroll a security key as well, so removing the app does not simply open
	// the application again but has to revoke that session for real.
	enrollRecord(t, serving.auth, newTestAuthenticator(t), "usb key")
	if _, _, err := serving.auth.removeTOTP(); err != nil {
		t.Fatal(err)
	}
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("session after factor removal = %d (%s)", response.StatusCode, body)
	}
	// With every factor gone the application is open again by design.
	if _, err := serving.auth.removeAll(); err != nil {
		t.Fatal(err)
	}
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("reset application = %d (%s)", response.StatusCode, body)
	}
}

func TestTOTPRateLimitAnswersWithRetryAfter(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	factor, err := newTOTPFactor("user@host", manager.now())
	if err != nil {
		t.Fatal(err)
	}
	enrollTOTP(t, manager, factor)
	serving := startAuthServerFor(t, "localhost", func(cfg *Config) { cfg.AuthFile = file })
	body := []byte(`{"code":"000000"}`)
	for index := 0; index < totpFailuresBeforeLockout; index++ {
		response, payload := serving.post(t, "/auth/totp/verify", body, nil)
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d (%s)", index, response.StatusCode, payload)
		}
	}
	response, payload := serving.post(t, "/auth/totp/verify", body, nil)
	if response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("locked attempt = %d (%s)", response.StatusCode, payload)
	}
	if response.Header.Get("Retry-After") == "" {
		t.Fatal("rate limited response has no Retry-After")
	}
	// The security key path is untouched by the limiter, and the app reports
	// the state without leaking the secret.
	response, payload = serving.do(t, http.MethodGet, "/auth/credentials", nil, nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("credential list without a session = %d", response.StatusCode)
	}
	if strings.Contains(string(payload), "secret") {
		t.Fatalf("credential list leaked a secret: %s", payload)
	}
}

func TestTOTPStateFileRejectsBrokenFactors(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, nil, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	factor, err := newTOTPFactor("user@host", manager.now())
	if err != nil {
		t.Fatal(err)
	}
	enrollTOTP(t, manager, factor)
	original, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(state *authState){
		"unknown algorithm": func(state *authState) { state.TOTP.Algorithm = "MD5" },
		"short secret":      func(state *authState) { state.TOTP.Secret = []byte("short") },
		"bad digits":        func(state *authState) { state.TOTP.Digits = 42 },
		"bad period":        func(state *authState) { state.TOTP.Period = 1 },
	} {
		var state authState
		if err := json.Unmarshal(original, &state); err != nil {
			t.Fatal(err)
		}
		mutate(&state)
		encoded, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := newAuthManager(file, time.Hour, nil, discardLogger()); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// A file written before the authenticator app existed still loads.
	legacy, err := json.Marshal(authState{Version: authStateVersion, SessionSecret: make([]byte, 32), UserHandle: make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newAuthManager(file, time.Hour, nil, discardLogger()); err != nil {
		t.Fatalf("legacy state file rejected: %v", err)
	}
}

// enrollTOTP stores a factor the way the CLI does: a code derived from the new
// secret has to confirm it before anything is written.
func enrollTOTP(t *testing.T, manager *authManager, factor authTOTP) authTOTP {
	t.Helper()
	now := manager.now()
	code, err := totpCode(factor, now.Unix()/int64(factor.Period))
	if err != nil {
		t.Fatal(err)
	}
	stored, err := manager.enrollTOTP(factor, code, now)
	if err != nil {
		t.Fatal(err)
	}
	return stored
}
