// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// credentialRecord builds the credential record an authenticator would leave
// behind, for tests that need enrolled state without a ceremony.
func (a *testAuthenticator) credentialRecord() webauthn.Credential {
	return webauthn.Credential{
		ID:                a.credID,
		PublicKey:         a.coseKey(),
		AttestationType:   "none",
		AttestationFormat: "none",
		Transport:         []protocol.AuthenticatorTransport{protocol.USB},
		Flags:             webauthn.NewCredentialFlags(0x05),
		Authenticator:     webauthn.Authenticator{AAGUID: a.aaguid, SignCount: 1},
	}
}

// enrollRecord stores one credential directly, without a ceremony.
func enrollRecord(t *testing.T, manager *authManager, a *testAuthenticator, name string) {
	t.Helper()
	if _, err := manager.ensureIdentity(); err != nil {
		t.Fatal(err)
	}
	record := a.credentialRecord()
	if _, err := manager.addCredential("localhost", name, &record); err != nil {
		t.Fatal(err)
	}
}

// flipTokenPayload keeps the signature but changes the payload, which must not
// verify without the signing key.
func flipTokenPayload(token string) string {
	payload, signature, _ := strings.Cut(token, ".")
	if payload == "" {
		return signature
	}
	flipped := []byte(payload)
	flipped[len(flipped)-1] ^= 1
	return string(flipped) + "." + signature
}

// testAuthenticator is a software FIDO2 authenticator: it creates an ES256
// credential and signs CTAP2 registrations and assertions the way a security
// key would, so the server-side ceremony can be tested end to end.
type testAuthenticator struct {
	t         *testing.T
	key       *ecdsa.PrivateKey
	credID    []byte
	aaguid    []byte
	signCount uint32
	// u2fOnly authenticators return no user verification flag.
	noUserVerification bool
	// unpromptedCredProps models Firefox, which reports a discoverable
	// credential's properties after a registration that never asked for them.
	unpromptedCredProps bool
}

// clientExtensionResults is what the browser hands back for a ceremony.
func (a *testAuthenticator) clientExtensionResults() map[string]any {
	if !a.unpromptedCredProps {
		return map[string]any{}
	}
	return map[string]any{"credProps": map[string]any{"rk": true}}
}

func newTestAuthenticator(t *testing.T) *testAuthenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credentialID := make([]byte, 32)
	if _, err := rand.Read(credentialID); err != nil {
		t.Fatal(err)
	}
	aaguid := make([]byte, 16)
	if _, err := rand.Read(aaguid); err != nil {
		t.Fatal(err)
	}
	return &testAuthenticator{t: t, key: key, credID: credentialID, aaguid: aaguid, signCount: 0}
}

func pad32(value *big.Int) []byte {
	result := make([]byte, 32)
	value.FillBytes(result)
	return result
}

// coseKey encodes the credential public key as CTAP2 canonical CBOR.
func (a *testAuthenticator) coseKey() []byte {
	a.t.Helper()
	options := cbor.CoreDetEncOptions()
	encoder, err := options.EncMode()
	if err != nil {
		a.t.Fatal(err)
	}
	encoded, err := encoder.Marshal(map[int64]any{
		1:  int64(2),  // kty: EC2
		3:  int64(-7), // alg: ES256
		-1: int64(1),  // crv: P-256
		-2: pad32(a.key.PublicKey.X),
		-3: pad32(a.key.PublicKey.Y),
	})
	if err != nil {
		a.t.Fatal(err)
	}
	return encoded
}

func (a *testAuthenticator) authenticatorData(rpID string, flags byte, signCount uint32, attested bool) []byte {
	rpIDHash := sha256.Sum256([]byte(rpID))
	buffer := &bytes.Buffer{}
	buffer.Write(rpIDHash[:])
	buffer.WriteByte(flags)
	_ = binary.Write(buffer, binary.BigEndian, signCount)
	if attested {
		buffer.Write(a.aaguid)
		_ = binary.Write(buffer, binary.BigEndian, uint16(len(a.credID)))
		buffer.Write(a.credID)
		buffer.Write(a.coseKey())
	}
	return buffer.Bytes()
}

func clientDataJSON(ceremony, challenge, origin string) []byte {
	encoded, err := json.Marshal(map[string]any{
		"type": ceremony, "challenge": challenge, "origin": origin, "crossOrigin": false,
	})
	if err != nil {
		panic(err)
	}
	return encoded
}

func b64(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }

// register answers a registration ceremony with a "none" attestation.
func (a *testAuthenticator) register(challenge, origin, rpID string, signCount uint32) []byte {
	a.t.Helper()
	flags := byte(0x41) // UP | AT
	if !a.noUserVerification {
		flags |= 0x04 // UV
	}
	authData := a.authenticatorData(rpID, flags, signCount, true)
	attestation, err := cbor.Marshal(struct {
		Format    string         `cbor:"fmt"`
		Statement map[string]any `cbor:"attStmt"`
		AuthData  []byte         `cbor:"authData"`
	}{Format: "none", Statement: map[string]any{}, AuthData: authData})
	if err != nil {
		a.t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"id": b64(a.credID), "rawId": b64(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":     b64(clientDataJSON("webauthn.create", challenge, origin)),
			"attestationObject":  b64(attestation),
			"authenticatorData":  b64(authData),
			"publicKey":          b64(a.coseKey()),
			"publicKeyAlgorithm": -7,
			"transports":         []string{"usb"},
		},
		"clientExtensionResults": a.clientExtensionResults(),
	})
	if err != nil {
		a.t.Fatal(err)
	}
	a.signCount = signCount
	return body
}

// assert signs an assertion over authenticator data and the client data hash.
func (a *testAuthenticator) assert(challenge, origin, rpID string, signCount uint32) []byte {
	a.t.Helper()
	flags := byte(0x01) // UP
	if !a.noUserVerification {
		flags |= 0x04 // UV
	}
	authData := a.authenticatorData(rpID, flags, signCount, false)
	clientData := clientDataJSON("webauthn.get", challenge, origin)
	clientHash := sha256.Sum256(clientData)
	digest := sha256.Sum256(append(append([]byte{}, authData...), clientHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		a.t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"id": b64(a.credID), "rawId": b64(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"authenticatorData": b64(authData),
			"signature":         b64(signature),
		},
		"clientExtensionResults": a.clientExtensionResults(),
	})
	if err != nil {
		a.t.Fatal(err)
	}
	a.signCount = signCount
	return body
}

// authTestServer runs a server with authentication state in a temp directory.
type authTestServer struct {
	*Server
	base   string
	host   string
	origin string
	client *http.Client
	engine *fakeEngine
	file   string
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func startAuthServer(t *testing.T, mutate func(*Config)) *authTestServer {
	t.Helper()
	return startAuthServerFor(t, "localhost", mutate)
}

// startAuthServerFor runs a server whose configured origin uses the given
// host, so tests can drive IP-literal addresses where a security key can never
// work but the authenticator app can.
func startAuthServerFor(t *testing.T, hostName string, mutate func(*Config)) *authTestServer {
	t.Helper()
	directory := t.TempDir()
	port := freeTCPPort(t)
	file := filepath.Join(directory, "auth.json")
	cfg := Config{
		Host: "127.0.0.1", Port: port,
		Origin:      fmt.Sprintf("http://%s:%d", hostName, port),
		AuthEnabled: true,
		AuthFile:    file,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	if cfg.EmbeddedAssets == nil {
		cfg.EmbeddedAssets = testAssets()
	}
	engine := &fakeEngine{}
	cfg.Engine = engine
	instance, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- instance.Serve() }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := instance.Shutdown(ctx); err != nil {
			t.Errorf("server shutdown: %v", err)
		}
		select {
		case err := <-serveErr:
			if err != nil {
				t.Errorf("server serve: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("server did not stop")
		}
	})
	return &authTestServer{
		Server: instance,
		base:   fmt.Sprintf("http://127.0.0.1:%d", port),
		host:   fmt.Sprintf("%s:%d", hostName, port),
		origin: fmt.Sprintf("http://%s:%d", hostName, port),
		file:   file,
		client: &http.Client{
			Timeout:       5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		engine: engine,
	}
}

// authNow exposes the server's clock so tests can derive codes for it.
func (s *authTestServer) authNow() time.Time { return s.auth.now() }

// do performs a request with the configured host and returns the response and
// its body.
func (s *authTestServer) do(t *testing.T, method, path string, body []byte, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, s.base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Host = s.host
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if isMutation(method) {
		request.Header.Set("Origin", s.origin)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := s.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	return response, data
}

func (s *authTestServer) post(t *testing.T, path string, body []byte, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	return s.do(t, http.MethodPost, path, body, headers)
}

func challengeOf(t *testing.T, body []byte) string {
	t.Helper()
	var options struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(body, &options); err != nil {
		t.Fatalf("decode options: %v (%s)", err, body)
	}
	if options.PublicKey.Challenge == "" {
		t.Fatalf("no challenge in options %s", body)
	}
	return options.PublicKey.Challenge
}

func cookieNamed(t *testing.T, response *http.Response, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Cookies() {
		if cookie.Name == name && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatalf("no %s cookie in %v", name, response.Header)
	return nil
}

// totpTestTime pins the authentication clock so a test derives codes for
// known time steps instead of racing the wall clock.
var totpTestTime = time.Unix(1_700_000_000, 0)

// bootstrapTOTP stores the baseline factor the way `bcwebmux-server auth totp`
// does: a code derived from the new secret confirms it before anything lands on
// disk. This is the only step that still needs the host.
func bootstrapTOTP(t *testing.T, file string, at time.Time) authTOTP {
	t.Helper()
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	manager.now = func() time.Time { return at }
	factor, err := newTOTPFactor("user@host", at)
	if err != nil {
		t.Fatal(err)
	}
	return enrollTOTP(t, manager, factor)
}

// pinAuthClock fixes the authentication clock of a running test server.
func pinAuthClock(s *authTestServer, at time.Time) { s.auth.now = func() time.Time { return at } }

// codeAt derives the code for the time step that contains at.
func codeAt(t *testing.T, factor authTOTP, at time.Time) string {
	t.Helper()
	code, err := totpCode(factor, at.Unix()/int64(factor.Period))
	if err != nil {
		t.Fatal(err)
	}
	return code
}

// signInWithCode signs in through the code path, which is the one that works
// at every address, and returns the session cookie.
func signInWithCode(t *testing.T, s *authTestServer, factor authTOTP, at time.Time) *http.Cookie {
	t.Helper()
	response, body := s.post(t, "/auth/totp/verify", []byte(`{"code":"`+codeAt(t, factor, at)+`"}`), nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("code sign-in = %d (%s)", response.StatusCode, body)
	}
	return cookieNamed(t, response, authSessionCookie)
}

// armWithCode arms credential changes from a code-issued session. It uses the
// step after at: the verifier accepts that as drift, and the sign-in at at
// already consumed its own step.
func armWithCode(t *testing.T, s *authTestServer, factor authTOTP, at time.Time, session *http.Cookie) map[string]string {
	t.Helper()
	next := at.Add(time.Duration(factor.Period) * time.Second)
	response, body := s.post(t, "/auth/stepup/totp", []byte(`{"code":"`+codeAt(t, factor, next)+`"}`),
		map[string]string{"Cookie": session.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("code step-up = %d (%s)", response.StatusCode, body)
	}
	stepUp := cookieNamed(t, response, authStepUpCookie)
	return map[string]string{"Cookie": session.String() + "; " + stepUp.Name + "=" + stepUp.Value}
}

// enrollKey drives one registration ceremony with an already armed session.
func enrollKey(t *testing.T, s *authTestServer, authenticator *testAuthenticator, name string, headers map[string]string) {
	t.Helper()
	path := "/auth/register/begin"
	if name != "" {
		path += "?name=" + url.QueryEscape(name)
	}
	response, body := s.post(t, path, []byte("{}"), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("register begin status = %d (%s)", response.StatusCode, body)
	}
	response, body = s.post(t, "/auth/register/finish", authenticator.register(challengeOf(t, body), s.origin, "localhost", 1), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("register finish status = %d (%s)", response.StatusCode, body)
	}
}

// ceremony drives one assertion ceremony and returns the finish response.
func ceremony(t *testing.T, s *authTestServer, authenticator *testAuthenticator, beginPath string, finishPath string, count uint32, headers map[string]string) *http.Response {
	t.Helper()
	response, body := s.post(t, beginPath, []byte("{}"), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("%s status = %d (%s)", beginPath, response.StatusCode, body)
	}
	challenge := challengeOf(t, body)
	response, body = s.post(t, finishPath, authenticator.assert(challenge, s.origin, "localhost", count), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("%s status = %d (%s)", finishPath, response.StatusCode, body)
	}
	return response
}

// login drives a full assertion ceremony and returns the session cookie.
func login(t *testing.T, s *authTestServer, authenticator *testAuthenticator, count uint32) *http.Cookie {
	t.Helper()
	return cookieNamed(t, ceremony(t, s, authenticator, "/auth/login/begin", "/auth/login/finish", count, nil), authSessionCookie)
}

func TestAuthStateFileIsCreatedUnderAMissingDirectory(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "nested", "state", "auth.json")
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, newTestAuthenticator(t), "fresh key")
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("state file missing after first enrollment: %v", err)
	}
	if info, err := os.Stat(filepath.Dir(file)); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("state directory = %v, %v", info.Mode().Perm(), err)
	}
}

func TestAuthRemovalWinsOverAnInFlightLogin(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)
	serving, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, serving, authenticator, "usb key")
	// A second manager stands in for `auth remove --all` running next to a
	// service that still holds the credential in memory.
	removing, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := removing.removeAll(); err != nil {
		t.Fatal(err)
	}
	// The in-flight login must not write its stale snapshot back over the reset.
	record := authenticator.credentialRecord()
	record.Authenticator.SignCount = 5
	if err := serving.recordUse("localhost", &record); err == nil {
		t.Fatal("recordUse accepted a credential that was removed")
	}
	state, err := loadAuthState(file, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Credentials) != 0 || len(state.SessionSecret) != 0 {
		t.Fatalf("removed credential was written back: %d credential(s), secret %d bytes", len(state.Credentials), len(state.SessionSecret))
	}
}

func TestAuthSignatureCounterNeverRollsBack(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, authenticator, "usb key")
	for _, count := range []uint32{4, 2} {
		record := authenticator.credentialRecord()
		record.Authenticator.SignCount = count
		record.Authenticator.CloneWarning = count == 2
		if err := manager.recordUse("localhost", &record); err != nil {
			t.Fatal(err)
		}
	}
	stored, ok := manager.lookup("localhost", authenticator.credID)
	if !ok {
		t.Fatal("credential missing")
	}
	if stored.Credential.Authenticator.SignCount != 4 {
		t.Fatalf("stored counter = %d, want 4", stored.Credential.Authenticator.SignCount)
	}
	if !stored.Credential.Authenticator.CloneWarning {
		t.Fatal("clone warning was not kept")
	}
	if stored.LastUsedAt.IsZero() {
		t.Fatal("last use was not recorded")
	}
}

func TestAuthStepUpRequiresUserVerification(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, authenticator, "touch only key")
	serving := startAuthServer(t, func(cfg *Config) { cfg.AuthFile = file })

	// A key that cannot verify the user can still sign in.
	authenticator.noUserVerification = true
	cookie := login(t, serving, authenticator, 2)
	response, body := serving.post(t, "/auth/register/begin", []byte("{}"), map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("registration without step-up = %d (%s)", response.StatusCode, body)
	}
	// ...but it cannot arm credential changes, which require user verification.
	response, body = serving.post(t, "/auth/stepup/begin", []byte("{}"), map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("step-up begin = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.post(t, "/auth/stepup/finish",
		authenticator.assert(challengeOf(t, body), serving.origin, "localhost", 3), map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("step-up without user verification = %d (%s)", response.StatusCode, body)
	}

	// The same key with user verification enrolled the second credential.
	authenticator.noUserVerification = false
	stepUp := cookieNamed(t, ceremony(t, serving, authenticator, "/auth/stepup/begin", "/auth/stepup/finish", 3,
		map[string]string{"Cookie": cookie.String()}), authStepUpCookie)
	headers := map[string]string{"Cookie": cookie.String() + "; " + stepUp.Name + "=" + stepUp.Value}
	enrollKey(t, serving, newTestAuthenticator(t), "", headers)
}

func TestAuthStateFileIsSecuredAndReloaded(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	authenticator := newTestAuthenticator(t)
	enrollRecord(t, manager, authenticator, "usb key")
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %v, want 0600", info.Mode().Perm())
	}
	reloaded, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	if _, total := reloaded.credentialCount(""); total != 1 {
		t.Fatalf("reloaded credential count = %d, want 1", total)
	}
	if session, err := reloaded.issueKeyToken(authTokenSession, "localhost", authenticator.credID); err != nil || session == "" {
		t.Fatalf("issue session after reload = %q, %v", session, err)
	}

	// A state file from a future schema must not be decoded as the current one.
	if err := os.WriteFile(file, []byte(`{"version":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newAuthManager(file, time.Hour, nil, discardLogger()); err == nil {
		t.Fatal("unsupported state version was accepted")
	}

	// Deleting the file while a server runs resets authentication.
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	reloaded.now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, total := reloaded.credentialCount(""); total != 0 {
		t.Fatalf("credential count after reset = %d, want 0", total)
	}
	if _, ok := reloaded.verifyToken(authTokenSession, "payload.signature"); ok {
		t.Fatal("token verified after the state file was removed")
	}
}

func TestAuthSessionsAreSignedAndScoped(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	authenticator := newTestAuthenticator(t)
	enrollRecord(t, manager, authenticator, "usb key")
	token, err := manager.issueKeyToken(authTokenSession, "localhost", authenticator.credID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, ok := manager.verifyToken(authTokenSession, token)
	if !ok {
		t.Fatal("issued token did not verify")
	}
	if credentialID, ok := parsed.credentialID(); !ok || !bytes.Equal(credentialID, authenticator.credID) {
		t.Fatalf("token credential = %x, want %x", credentialID, authenticator.credID)
	}
	for name, candidate := range map[string]string{
		"tampered payload": flipTokenPayload(token),
		"garbage":          "not-a-token",
		"empty":            "",
		"truncated":        token[:len(token)-4],
	} {
		if _, ok := manager.verifyToken(authTokenSession, candidate); ok {
			t.Errorf("%s token verified", name)
		}
	}
	// A step-up token must not be usable as a session and vice versa.
	stepUp, err := manager.issueKeyToken(authTokenStepUp, "localhost", authenticator.credID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.verifyToken(authTokenSession, stepUp); ok {
		t.Error("step-up token was accepted as a session")
	}
	if _, ok := manager.verifyToken(authTokenStepUp, token); ok {
		t.Error("session token was accepted as a step-up")
	}
	// An expired token is rejected.
	manager.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, ok := manager.verifyToken(authTokenSession, token); ok {
		t.Error("expired token verified")
	}
}

func TestAuthCodeBootstrapThenBrowserKeyEnrollment(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)

	// The host enrolls the authenticator app and nothing else: a FIDO2
	// ceremony needs the key in the operator's hand, not in this machine.
	factor := bootstrapTOTP(t, file, totpTestTime)
	serving := startAuthServer(t, func(cfg *Config) { cfg.AuthFile = file })
	pinAuthClock(serving, totpTestTime)

	// The enrolled factor closes the application.
	response, body := serving.do(t, http.MethodGet, "/", nil, nil)
	if response.StatusCode != http.StatusFound || response.Header.Get("Location") != "/login" {
		t.Fatalf("unauthenticated page = %d -> %q (%s)", response.StatusCode, response.Header.Get("Location"), body)
	}
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated API = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.do(t, http.MethodGet, "/ws", nil, nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated websocket = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.do(t, http.MethodGet, "/login", nil, nil)
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("sign in")) {
		t.Fatalf("login page = %d (%s)", response.StatusCode, body)
	}
	if policy := response.Header.Get("Referrer-Policy"); policy != "same-origin" {
		t.Fatalf("login page referrer policy = %q, want same-origin", policy)
	}
	response, body = serving.do(t, http.MethodGet, "/auth/session", nil, nil)
	var status map[string]any
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("session status: %v (%s)", err, body)
	}
	if status["authenticated"] != false || status["totp"] != true || status["enrolled"] != float64(0) {
		t.Fatalf("session status = %v", status)
	}

	// A code signs in, but the session alone may not change the key set.
	session := signInWithCode(t, serving, factor, totpTestTime)
	response, body = serving.post(t, "/auth/register/begin", []byte("{}"), map[string]string{"Cookie": session.String()})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("registration without a fresh factor = %d (%s)", response.StatusCode, body)
	}

	// A second code arms the session, and the key is enrolled from here. The
	// key reports credProps without being asked, the way Firefox does, which
	// must not cost the registration.
	authenticator.unpromptedCredProps = true
	headers := armWithCode(t, serving, factor, totpTestTime, session)
	enrollKey(t, serving, authenticator, "laptop touch id", headers)
	response, body = serving.do(t, http.MethodGet, "/auth/credentials", nil, map[string]string{"Cookie": session.String()})
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("laptop touch id")) {
		t.Fatalf("credential list = %d (%s)", response.StatusCode, body)
	}

	// The key signs in on its own, and the application answers.
	cookie := login(t, serving, authenticator, 2)
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authenticated API = %d (%s)", response.StatusCode, body)
	}
	if !bytes.Contains(body, []byte(`"ok":true`)) {
		t.Fatalf("authenticated request never reached the engine: %s", body)
	}
	// Only the cookie is required: no origin header, no bearer token.
	response, _ = serving.post(t, "/auth/logout", []byte("{}"), map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("logout status = %d", response.StatusCode)
	}
}

// A code that arms credential changes goes through the same limiter and
// single-use rules as a sign-in, so it cannot become a way around either.
func TestAuthCodeStepUpRefusesBadCodes(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	factor := bootstrapTOTP(t, file, totpTestTime)
	serving := startAuthServer(t, func(cfg *Config) { cfg.AuthFile = file })
	pinAuthClock(serving, totpTestTime)
	session := signInWithCode(t, serving, factor, totpTestTime)
	cookies := map[string]string{"Cookie": session.String()}

	response, body := serving.post(t, "/auth/stepup/totp", []byte(`{"code":"000000"}`), cookies)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong code step-up = %d (%s)", response.StatusCode, body)
	}
	// The step the sign-in used is spent, so the same code cannot arm anything.
	response, body = serving.post(t, "/auth/stepup/totp", []byte(`{"code":"`+codeAt(t, factor, totpTestTime)+`"}`), cookies)
	if response.StatusCode != http.StatusUnauthorized || !bytes.Contains(body, []byte("already used")) {
		t.Fatalf("replayed code step-up = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.post(t, "/auth/stepup/totp", []byte(`{"code":"`+codeAt(t, factor, totpTestTime.Add(30*time.Second))+`"}`), cookies)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("code step-up = %d (%s)", response.StatusCode, body)
	}

	// Without a session there is nothing to arm.
	response, body = serving.post(t, "/auth/stepup/totp", []byte(`{"code":"`+codeAt(t, factor, totpTestTime.Add(60*time.Second))+`"}`), nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("sessionless code step-up = %d (%s)", response.StatusCode, body)
	}
}

func TestAuthRejectsWrongCeremonyEvidence(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, authenticator, "usb key")
	serving := startAuthServer(t, func(cfg *Config) { cfg.AuthFile = file })

	// A different origin may not complete a ceremony begun for this one.
	response, body := serving.post(t, "/auth/login/begin", []byte("{}"), nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login begin = %d (%s)", response.StatusCode, body)
	}
	challenge := challengeOf(t, body)
	response, body = serving.post(t, "/auth/login/finish", authenticator.assert(challenge, "http://evil.example", "localhost", 2), nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cross-origin assertion = %d (%s)", response.StatusCode, body)
	}

	// The same ceremony cannot be replayed, even with a valid signature.
	response, body = serving.post(t, "/auth/login/begin", []byte("{}"), nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login begin = %d (%s)", response.StatusCode, body)
	}
	challenge = challengeOf(t, body)
	assertion := authenticator.assert(challenge, serving.origin, "localhost", 2)
	response, body = serving.post(t, "/auth/login/finish", assertion, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login finish = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.post(t, "/auth/login/finish", assertion, nil)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("replayed assertion = %d (%s)", response.StatusCode, body)
	}

	// A ceremony begun for another relying party does not complete here.
	other := newTestAuthenticator(t)
	response, body = serving.post(t, "/auth/login/begin", []byte("{}"), nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login begin = %d (%s)", response.StatusCode, body)
	}
	challenge = challengeOf(t, body)
	response, body = serving.post(t, "/auth/login/finish", other.assert(challenge, serving.origin, "localhost", 2), nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown credential assertion = %d (%s)", response.StatusCode, body)
	}

	// The mutating endpoints still require the exact configured origin.
	request, err := http.NewRequest(http.MethodPost, serving.base+"/auth/login/begin", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Host = serving.host
	request.Header.Set("Origin", "http://evil.example")
	response, err = serving.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin login begin = %d", response.StatusCode)
	}
}
func TestAuthCredentialChangesNeedFreshVerification(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, authenticator, "first key")
	serving := startAuthServer(t, func(cfg *Config) { cfg.AuthFile = file })
	cookie := login(t, serving, authenticator, 2)

	// Listing works with a session; enrolling another key does not yet.
	response, body := serving.do(t, http.MethodGet, "/auth/credentials", nil, map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("credential list = %d (%s)", response.StatusCode, body)
	}
	var listing struct {
		Credentials []struct {
			Name    string `json:"name"`
			Current bool   `json:"current"`
		} `json:"credentials"`
	}
	if err := json.Unmarshal(body, &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Credentials) != 1 || listing.Credentials[0].Name != "first key" || !listing.Credentials[0].Current {
		t.Fatalf("credential list = %s", body)
	}
	response, body = serving.post(t, "/auth/register/begin", []byte("{}"), map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("registration without step-up = %d (%s)", response.StatusCode, body)
	}

	// A fresh assertion in the same session authorizes credential changes.
	response, body = serving.post(t, "/auth/stepup/begin", []byte("{}"), nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("step-up without a session = %d (%s)", response.StatusCode, body)
	}
	session := map[string]string{"Cookie": cookie.String()}
	stepUp := cookieNamed(t, ceremony(t, serving, authenticator, "/auth/stepup/begin", "/auth/stepup/finish", 3, session), authStepUpCookie)
	headers := map[string]string{"Cookie": cookie.String() + "; " + stepUp.Name + "=" + stepUp.Value}
	second := newTestAuthenticator(t)
	response, body = serving.post(t, "/auth/register/begin?name=backup%20key", []byte("{}"), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("registration begin = %d (%s)", response.StatusCode, body)
	}
	challenge := challengeOf(t, body)
	response, body = serving.post(t, "/auth/register/finish", second.register(challenge, serving.origin, "localhost", 1), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("registration finish = %d (%s)", response.StatusCode, body)
	}

	// The new key can log in, and removing it revokes the sessions it issued.
	secondCookie := login(t, serving, second, 2)
	response, body = serving.post(t, "/auth/credentials/remove",
		[]byte(`{"id":"`+b64(second.credID)+`"}`), headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("credential remove = %d (%s)", response.StatusCode, body)
	}
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, map[string]string{"Cookie": secondCookie.String()})
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("removed credential session = %d (%s)", response.StatusCode, body)
	}
	// The first key still works.
	response, body = serving.do(t, http.MethodGet, "/api/server", nil, map[string]string{"Cookie": cookie.String()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("remaining credential session = %d (%s)", response.StatusCode, body)
	}
}
func TestAuthStateFileReloadsWhileServing(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	serving := startAuthServer(t, func(cfg *Config) { cfg.AuthFile = file })
	// Nothing enrolled: the application stays open.
	response, body := serving.do(t, http.MethodGet, "/", nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("open mode page = %d (%s)", response.StatusCode, body)
	}
	authenticator := newTestAuthenticator(t)
	manager, err := newAuthManager(file, time.Hour, []string{serving.origin}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, authenticator, "cli key")
	// The running server picks up the enrollment without a restart.
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, body = serving.do(t, http.MethodGet, "/api/server", nil, nil)
		if response.StatusCode == http.StatusUnauthorized {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("enrollment was not picked up: %d (%s)", response.StatusCode, body)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Removing the last credential reopens the application.
	if _, err := manager.removeAll(); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		response, body = serving.do(t, http.MethodGet, "/api/server", nil, nil)
		if response.StatusCode == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reset was not picked up: %d (%s)", response.StatusCode, body)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAuthRejectsUnusableOriginsAndCapsChallenges(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "auth.json")
	authenticator := newTestAuthenticator(t)
	manager, err := newAuthManager(file, time.Hour, []string{"http://localhost:8443"}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	enrollRecord(t, manager, authenticator, "cli key")
	// An IP-literal origin cannot carry a relying party ID, so it can never
	// sign in; the scope reports why instead of failing silently.
	scope := scopeForOrigin("https://192.168.1.20:8443")
	if scope.problem == "" {
		t.Fatal("IP-literal origin was accepted as a relying party")
	}
	if scope.secure != true || scope.rpID != "192.168.1.20" {
		t.Fatalf("scope = %+v", scope)
	}
	if scope := scopeForOrigin("http://localhost:8080"); scope.problem != "" || scope.rpID != "localhost" || scope.secure {
		t.Fatalf("localhost scope = %+v", scope)
	}
	// Pending ceremonies are bounded and single use.
	sessions := make([]string, 0, authChallengeLimit+8)
	for index := 0; index < authChallengeLimit+8; index++ {
		sessions = append(sessions, beginChallengeForTest(t, manager, "localhost"))
		if len(manager.challenges) > authChallengeLimit {
			t.Fatalf("challenge store grew to %d", len(manager.challenges))
		}
	}
	if len(manager.challenges) != authChallengeLimit {
		t.Fatalf("challenge store = %d, want %d", len(manager.challenges), authChallengeLimit)
	}
	if _, ok := manager.takeChallenge(authKindLogin, "localhost", sessions[0]); ok {
		t.Fatal("oldest challenge survived eviction")
	}
	newest := sessions[len(sessions)-1]
	if _, ok := manager.takeChallenge(authKindLogin, "localhost", newest); !ok {
		t.Fatal("newest challenge was evicted")
	}
	if _, ok := manager.takeChallenge(authKindLogin, "localhost", newest); ok {
		t.Fatal("challenge was accepted twice")
	}
}

// beginChallengeForTest pushes one ceremony through the manager and returns
// its challenge, mirroring what BeginLogin produces.
func beginChallengeForTest(t *testing.T, manager *authManager, rpID string) string {
	t.Helper()
	challenge, err := randomBytes(32)
	if err != nil {
		t.Fatal(err)
	}
	session := &webauthn.SessionData{
		Challenge: base64.RawURLEncoding.EncodeToString(challenge),
		UserID:    []byte("user-handle"),
		Expires:   time.Now().Add(authChallengeTTL),
	}
	if err := manager.beginChallenge(authKindLogin, rpID, "", session); err != nil {
		t.Fatal(err)
	}
	return session.Challenge
}
