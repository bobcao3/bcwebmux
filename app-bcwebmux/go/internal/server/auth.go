// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

// Authentication state for the browser frontend: the enrolled factors and the
// session signing key, in one JSON file owned by whoever runs the server. That
// file is the reset authority — anyone who can write it decides who may sign
// in, and the running server picks the change up without a restart.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	// authStateVersion is the on-disk schema version. Unknown versions are
	// rejected instead of being decoded as the current shape.
	authStateVersion = 1
	// authFileMaxBytes bounds the state file so a corrupt or hostile file
	// cannot exhaust memory during startup.
	authFileMaxBytes = 1 << 20
	// authRefreshInterval throttles state file stat calls behind request
	// handling. Changes made by the CLI surface within this interval.
	authRefreshInterval = time.Second
	// authChallengeTTL bounds how long a begun ceremony can be finished.
	authChallengeTTL = 5 * time.Minute
	// authChallengeLimit bounds pending ceremonies; the oldest is evicted.
	authChallengeLimit = 64
	// authSessionTTLDefault is the browser session lifetime when unset.
	authSessionTTLDefault = 7 * 24 * time.Hour
	// authStepUpTTL bounds how long a fresh user verification authorizes
	// credential changes from the browser.
	authStepUpTTL = 5 * time.Minute
	// authMaxBodyBytes bounds ceremony request bodies. Attestation objects are
	// a few kilobytes; this leaves room for extension outputs.
	authMaxBodyBytes = 64 * 1024

	authSessionCookie = "bcwebmux_session"
	authStepUpCookie  = "bcwebmux_stepup"
	authCookiePath    = "/"

	authTokenSession = "session"
	authTokenStepUp  = "stepup"

	authKindLogin    = "login"
	authKindStepUp   = "stepup"
	authKindRegister = "register"
)

// authCredential is one enrolled public key credential plus the metadata the
// server needs to scope it to a relying party and to describe it to operators.
type authCredential struct {
	// RPID is the relying party the credential was enrolled for. An origin
	// host maps to exactly one RP ID, so this is also the scope for login.
	RPID      string    `json:"rpId"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	// LastUsedAt is updated on every successful assertion.
	LastUsedAt time.Time `json:"lastUsedAt,omitempty"`
	// EnrolledInCLI is never written: keys are only enrolled from the browser
	// now. The field is decoded so state files written while `auth enroll`
	// still existed keep loading.
	EnrolledInCLI bool                `json:"enrolledInCli,omitempty"`
	Credential    webauthn.Credential `json:"credential"`
}

// authState is the whole contents of the authentication state file.
type authState struct {
	Version int `json:"version"`
	// SessionSecret signs session and step-up tokens. Rotating it (or
	// deleting the file) invalidates every issued session.
	SessionSecret []byte `json:"sessionSecret"`
	// UserHandle is the WebAuthn user handle shared by every credential.
	UserHandle  []byte `json:"userHandle"`
	UserName    string `json:"userName"`
	DisplayName string `json:"displayName"`
	// TOTP is the baseline authenticator-app factor, the only one that works
	// at every address including IP literals.
	TOTP        *authTOTP        `json:"totp,omitempty"`
	Credentials []authCredential `json:"credentials"`
}

// authChallenge is a ceremony that has begun but not finished. Session data is
// kept in memory only: a restart invalidates in-flight ceremonies rather than
// leaving replayable state on disk.
type authChallenge struct {
	kind    string
	rpID    string
	name    string
	session webauthn.SessionData
	expires time.Time
}

// errCredentialEnrolled marks a re-registration of an already enrolled key.
var errCredentialEnrolled = errors.New("this security key is already enrolled")

type authToken struct {
	Version int `json:"v"`
	// Factor is what the session was issued to: the authenticator app or one
	// security key. A session is only valid while that factor is still
	// enrolled, which is how removing a factor revokes its sessions.
	Factor  string `json:"fac"`
	RPID    string `json:"rp,omitempty"`
	CredID  string `json:"cid,omitempty"`
	Issued  int64  `json:"iat"`
	Expires int64  `json:"exp"`
}

type authManager struct {
	path    string
	ttl     time.Duration
	origins []string
	logger  *slog.Logger
	// now is replaceable so tests can advance time without sleeping.
	now func() time.Time

	mu         sync.Mutex
	state      authState
	loadedAt   time.Time
	loadedSize int64
	checkedAt  time.Time
	// unreadable records why the file could not be used last time, so a
	// running server can report it without failing every request.
	unreadable error
	challenges map[string]*authChallenge
	webauthns  map[string]*webauthn.WebAuthn

	// TOTP attempt limiter. Kept in memory: every rejected code must not touch
	// the disk, and a restart clearing the backoff costs an attacker the
	// process anyway.
	totpFailures    int
	totpLockedUntil time.Time
	totpLastFailure time.Time
}

const (
	authFactorTOTP = "totp"
	authFactorKey  = "key"
)

func newAuthManager(path string, ttl time.Duration, origins []string, logger *slog.Logger) (*authManager, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("authentication file path is required")
	}
	if ttl <= 0 {
		ttl = authSessionTTLDefault
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(nil, nil))
	}
	manager := &authManager{
		path: path, ttl: ttl, origins: append([]string(nil), origins...), logger: logger,
		now: time.Now, challenges: map[string]*authChallenge{}, webauthns: map[string]*webauthn.WebAuthn{},
	}
	state, err := loadAuthState(path, logger)
	if err != nil {
		return nil, err
	}
	manager.state = state
	manager.checkedAt = manager.now()
	if info, err := os.Stat(path); err == nil {
		manager.loadedAt, manager.loadedSize = info.ModTime(), info.Size()
	}
	return manager, nil
}

// newAuthManagerFor builds the authentication manager for one server
// configuration, or returns nil when authentication is switched off.
func newAuthManagerFor(cfg Config, origins []string) (*authManager, error) {
	if cfg.AuthFile == "" || !cfg.AuthEnabled {
		return nil, nil
	}
	ttl := cfg.AuthSessionTTL
	if ttl <= 0 {
		ttl = authSessionTTLDefault
	}
	return newAuthManager(cfg.AuthFile, ttl, origins, cfg.Logger)
}

func (m *authManager) credentialsFor(rpID string) []authCredential {
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()

	result := make([]authCredential, 0, len(m.state.Credentials))
	for _, credential := range m.state.Credentials {
		if credential.RPID == rpID {
			result = append(result, credential)
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	return result
}

func (m *authManager) credentialCount(rpID string) (scoped, total int) {
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()

	total = len(m.state.Credentials)
	for _, credential := range m.state.Credentials {
		if credential.RPID == rpID {
			scoped++
		}
	}
	return scoped, total
}

// factors reports every enrolled authentication factor: the authenticator app
// and the security keys. Any one of them protects the whole application.
func (m *authManager) factors() (totp bool, keys int) {
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state.TOTP != nil, len(m.state.Credentials)
}

func (m *authManager) lookup(rpID string, id []byte) (authCredential, bool) {
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, credential := range m.state.Credentials {
		if credential.RPID == rpID && subtle.ConstantTimeCompare(credential.Credential.ID, id) == 1 {
			return credential, true
		}
	}
	return authCredential{}, false
}

// user is the only way the WebAuthn library sees our credentials: it looks up
// assertions and registration exclusions through this interface.
func (m *authManager) user(rpID string) authUser {
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.userLocked(rpID)
}

// webauthnFor returns the relying party context for one RP ID. Origins are
// the full configured set; individual ceremonies narrow that to the origin
// they were begun at.
func (m *authManager) webauthnFor(rpID string) (*webauthn.WebAuthn, error) {
	m.mu.Lock()
	if instance := m.webauthns[rpID]; instance != nil {
		m.mu.Unlock()
		return instance, nil
	}
	m.mu.Unlock()

	instance, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "bcwebmux",
		RPOrigins:     m.origins,
		// Firefox reports credProps after a discoverable-credential
		// registration without being asked for it, and no extension output
		// feeds anything here, so an unrequested one must not fail the
		// ceremony. Everything that does matter to this server — challenge,
		// origin, relying party hash, user verification, signature — is
		// checked by the same call.
		ExtensionsUnsolicitedOutputPolicy: protocol.UnsolicitedOutputPolicyIgnore,
	})
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.webauthns[rpID] = instance
	return instance, nil
}

func (m *authManager) beginChallenge(kind, rpID, name string, session *webauthn.SessionData) error {
	if session == nil || len(session.Challenge) <= 16 {
		return errors.New("ceremony challenge is missing")
	}
	now := m.now()
	key := challengeKey(session.Challenge)

	m.mu.Lock()
	defer m.mu.Unlock()
	for key, pending := range m.challenges {
		if !now.Before(pending.expires) {
			delete(m.challenges, key)
		}
	}
	// Bound memory: evict the ceremony closest to expiry instead of refusing
	// new logins when a client abandons many ceremonies.
	for len(m.challenges) >= authChallengeLimit {
		oldest, oldestExpiry := "", time.Time{}
		for key, pending := range m.challenges {
			if oldest == "" || pending.expires.Before(oldestExpiry) {
				oldest, oldestExpiry = key, pending.expires
			}
		}
		delete(m.challenges, oldest)
	}
	m.challenges[key] = &authChallenge{kind: kind, rpID: rpID, name: name, session: *session, expires: now.Add(authChallengeTTL)}
	return nil
}

// challengeKey normalizes a base64url challenge so lookups match whether or
// not a client echoes the padding.
func challengeKey(challenge string) string { return strings.TrimRight(challenge, "=") }

// ensureIdentity creates the account identity on the first enrolment; the
// caller's write is what persists it.
func (m *authManager) ensureIdentity() (authUser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ensureIdentityLocked()
}

// ensureIdentityLocked prepares the account identity in memory. The caller
// holds the manager lock; the caller's write persists it.
func (m *authManager) ensureIdentityLocked() (authUser, error) {
	if len(m.state.SessionSecret) == 0 {
		secret, err := randomBytes(32)
		if err != nil {
			return authUser{}, err
		}
		m.state.SessionSecret = secret
	}
	if len(m.state.UserHandle) == 0 {
		handle, err := randomBytes(32)
		if err != nil {
			return authUser{}, err
		}
		m.state.UserHandle = handle
	}
	if m.state.UserName == "" {
		m.state.UserName = "bcwebmux"
	}
	if m.state.DisplayName == "" {
		m.state.DisplayName = "bcwebmux " + displayNameForHost()
	}
	return m.userLocked(""), nil
}

// userLocked builds the account view for one relying party. The caller holds
// the manager lock.
func (m *authManager) userLocked(rpID string) authUser {
	user := authUser{id: append([]byte(nil), m.state.UserHandle...), name: m.state.UserName, display: m.state.DisplayName}
	for _, credential := range m.state.Credentials {
		if rpID == "" || credential.RPID == rpID {
			user.credentials = append(user.credentials, credential.Credential)
		}
	}
	return user
}

// takeChallenge consumes a begun ceremony. Challenges are single use, so a
// replayed response cannot be verified twice.
func (m *authManager) takeChallenge(kind, rpID, challenge string) (*authChallenge, bool) {
	now := m.now()
	key := challengeKey(challenge)

	m.mu.Lock()
	defer m.mu.Unlock()
	pending := m.challenges[key]
	if pending == nil {
		return nil, false
	}
	delete(m.challenges, key)
	if pending.kind != kind || pending.rpID != rpID || !now.Before(pending.expires) {
		return nil, false
	}
	return pending, true
}

func (m *authManager) addCredential(rpID, name string, credential *webauthn.Credential) (authCredential, error) {
	entry := authCredential{
		RPID: rpID, Name: name, CreatedAt: m.now().UTC(),
		Credential: *credential,
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	err := m.updateLocked(func(state *authState) (bool, error) {
		for _, existing := range state.Credentials {
			if existing.RPID == rpID && subtle.ConstantTimeCompare(existing.Credential.ID, credential.ID) == 1 {
				return false, errCredentialEnrolled
			}
		}
		// Enrollment prepares the account identity in memory; carry it into the
		// file unless another writer already stored one.
		if len(state.SessionSecret) == 0 {
			state.SessionSecret = append([]byte(nil), m.state.SessionSecret...)
		}
		if len(state.UserHandle) == 0 {
			state.UserHandle = append([]byte(nil), m.state.UserHandle...)
		}
		if state.UserName == "" {
			state.UserName = m.state.UserName
		}
		if state.DisplayName == "" {
			state.DisplayName = m.state.DisplayName
		}
		state.Credentials = append(state.Credentials, entry)
		return true, nil
	})
	if err != nil {
		return authCredential{}, err
	}
	return entry, nil
}

// Sessions issued to a removed credential stop working immediately, because
// every request re-checks that the credential is still enrolled.
func (m *authManager) removeCredential(id []byte) (authCredential, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var removed authCredential
	found := false
	err := m.updateLocked(func(state *authState) (bool, error) {
		for index, credential := range state.Credentials {
			if subtle.ConstantTimeCompare(credential.Credential.ID, id) != 1 {
				continue
			}
			removed, found = credential, true
			remaining := make([]authCredential, 0, len(state.Credentials)-1)
			remaining = append(remaining, state.Credentials[:index]...)
			remaining = append(remaining, state.Credentials[index+1:]...)
			state.Credentials = remaining
			// Dropping the last factor resets the state file: the session
			// signing key goes with it, so every issued session dies with the
			// factor set that authorized it.
			if len(remaining) == 0 && state.TOTP == nil {
				state.SessionSecret, state.UserHandle = nil, nil
			}
			return true, nil
		}
		return false, nil
	})
	if err != nil {
		return authCredential{}, false, err
	}
	return removed, found, nil
}

// removeAll drops every factor, not just the keys, and resets the file.
func (m *authManager) removeAll() ([]authCredential, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var removed []authCredential
	err := m.updateLocked(func(state *authState) (bool, error) {
		if len(state.Credentials) == 0 {
			return false, nil
		}
		removed = state.Credentials
		state.Credentials, state.SessionSecret, state.UserHandle = nil, nil, nil
		state.TOTP = nil
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return removed, nil
}

// lookupAny finds one credential by its full identifier or an unambiguous
// identifier prefix, which is what operators copy from `auth list`.
func (m *authManager) lookupAny(id string) (authCredential, bool) {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" {
		return authCredential{}, false
	}
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()
	var match authCredential
	found := 0
	for _, credential := range m.state.Credentials {
		encoded := base64.RawURLEncoding.EncodeToString(credential.Credential.ID)
		if encoded != trimmed && !strings.HasPrefix(encoded, trimmed) {
			continue
		}
		match = credential
		found++
	}
	return match, found == 1
}

func (m *authManager) recordUse(rpID string, credential *webauthn.Credential) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	found := false
	err := m.updateLocked(func(state *authState) (bool, error) {
		for index := range state.Credentials {
			entry := &state.Credentials[index]
			if entry.RPID != rpID || subtle.ConstantTimeCompare(entry.Credential.ID, credential.ID) != 1 {
				continue
			}
			found = true
			stored := &entry.Credential
			// A credential removed between the ceremony and this write stays
			// removed: its entry is gone from the state loaded under the lock.
			if credential.Authenticator.SignCount > stored.Authenticator.SignCount {
				stored.Authenticator.SignCount = credential.Authenticator.SignCount
				stored.Authenticator.Attachment = credential.Authenticator.Attachment
				stored.Flags = credential.Flags
			}
			// The counter only ever moves forward, so two assertions racing
			// cannot roll it back; a non-advancing counter is sticky evidence.
			if credential.Authenticator.CloneWarning && !stored.Authenticator.CloneWarning {
				m.logger.Warn("security key counter did not advance; possible cloned credential",
					"credential", entry.Name, "stored", stored.Authenticator.SignCount, "received", credential.Authenticator.SignCount)
				stored.Authenticator.CloneWarning = true
			}
			if credential.Flags.UserPresent {
				stored.Flags.UserPresent = true
			}
			if credential.Flags.UserVerified {
				stored.Flags.UserVerified = true
			}
			entry.LastUsedAt = m.now().UTC()
			return true, nil
		}
		return false, nil
	})
	if err != nil {
		return err
	}
	if !found {
		return errors.New("credential disappeared during authentication")
	}
	return nil
}

// A failure here never downgrades a running server to unauthenticated: the
// last usable state is kept and the error is logged, while an intentionally
// deleted file does disable sign-ins.
func (m *authManager) refresh() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reloadLocked(false)
}

func (m *authManager) reloadLocked(force bool) {
	now := m.now()
	if !force && !m.checkedAt.IsZero() && now.Sub(m.checkedAt) < authRefreshInterval {
		return
	}
	m.checkedAt = now

	info, err := os.Stat(m.path)
	if errors.Is(err, fs.ErrNotExist) {
		if len(m.state.Credentials) > 0 {
			m.logger.Warn("authentication state file removed; login is no longer required", "path", m.path)
		}
		m.state, m.loadedAt, m.loadedSize, m.unreadable = authState{}, time.Time{}, 0, nil
		return
	}
	if err != nil {
		m.noteUnreadable(fmt.Errorf("stat authentication state: %w", err))
		return
	}
	if !m.loadedAt.IsZero() && info.ModTime().Equal(m.loadedAt) && info.Size() == m.loadedSize {
		return
	}
	state, err := loadAuthState(m.path, m.logger)
	if err != nil {
		// A half-written file is replaced atomically, so an unreadable file
		// means operator error or corruption. Keep serving the known state.
		m.noteUnreadable(err)
		return
	}
	if !info.ModTime().Equal(m.loadedAt) && !m.loadedAt.IsZero() {
		m.logger.Info("authentication state reloaded", "path", m.path, "credentials", len(state.Credentials))
	}
	m.state, m.loadedAt, m.loadedSize = state, info.ModTime(), info.Size()
	m.webauthns = map[string]*webauthn.WebAuthn{}
	if m.unreadable != nil {
		m.logger.Info("authentication state recovered", "path", m.path)
		m.unreadable = nil
	}
}

func (m *authManager) noteUnreadable(err error) {
	if m.unreadable == nil {
		m.logger.Error("authentication state unusable; keeping the last loaded credentials", "path", m.path, "error", err)
	}
	m.unreadable = err
}

// updateLocked applies one change to the state file. The caller holds the
// manager lock; this function holds the cross-process file lock for the whole
// read-modify-write, so a change made by `auth totp`, `auth remove`, or
// another process between our last read and this write is applied to the file
// as it is now instead of being overwritten by a stale in-memory snapshot.
//
// mutate returns whether the state changed. A state that did not change is
// still adopted, because the file is the authority.
func (m *authManager) updateLocked(mutate func(state *authState) (bool, error)) error {
	unlock, err := lockAuthFile(m.path)
	if err != nil {
		return err
	}
	defer unlock()

	state, err := loadAuthState(m.path, m.logger)
	if err != nil {
		return err
	}
	changed, err := mutate(&state)
	if err != nil {
		return err
	}
	if !changed {
		m.state = state
		if info, err := os.Stat(m.path); err == nil {
			m.loadedAt, m.loadedSize = info.ModTime(), info.Size()
		}
		return nil
	}
	state.Version = authStateVersion
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode authentication state: %w", err)
	}
	if err := writeAuthFile(m.path, data); err != nil {
		return err
	}
	m.state = state
	if info, err := os.Stat(m.path); err == nil {
		m.loadedAt, m.loadedSize = info.ModTime(), info.Size()
	}
	return nil
}

func loadAuthState(path string, logger *slog.Logger) (authState, error) {
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return authState{}, nil
	}
	if err != nil {
		return authState{}, fmt.Errorf("open authentication state %s: %w", path, err)
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil {
		if info.Size() > authFileMaxBytes {
			return authState{}, fmt.Errorf("authentication state %s is larger than %d bytes", path, authFileMaxBytes)
		}
		if info.Mode().Perm()&0o077 != 0 {
			logger.Warn("authentication state is readable by other users", "path", path, "mode", info.Mode().Perm().String())
		}
	}
	var state authState
	decoder := json.NewDecoder(io.LimitReader(file, authFileMaxBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		if errors.Is(err, io.EOF) {
			return authState{}, fmt.Errorf("authentication state %s is empty", path)
		}
		return authState{}, fmt.Errorf("decode authentication state %s: %w", path, err)
	}
	if state.Version != authStateVersion {
		return authState{}, fmt.Errorf("authentication state %s has unsupported version %d", path, state.Version)
	}
	if len(state.Credentials) > 0 || state.TOTP != nil {
		if len(state.SessionSecret) < 32 {
			return authState{}, fmt.Errorf("authentication state %s has no session secret", path)
		}
		if len(state.UserHandle) == 0 || len(state.UserHandle) > 64 {
			return authState{}, fmt.Errorf("authentication state %s has an invalid user handle", path)
		}
	} else {
		state.SessionSecret, state.UserHandle = nil, nil
	}
	if err := validateAuthTOTP(state.TOTP); err != nil {
		return authState{}, fmt.Errorf("authentication state %s: %w", path, err)
	}
	for index, credential := range state.Credentials {
		if credential.RPID == "" || len(credential.Credential.ID) == 0 || len(credential.Credential.PublicKey) == 0 {
			return authState{}, fmt.Errorf("authentication state %s has an incomplete credential at index %d", path, index)
		}
	}
	return state, nil
}

// writeAuthFile replaces the state file atomically with 0600 permissions.
func writeAuthFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create authentication state directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return fmt.Errorf("create authentication state: %w", err)
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("secure authentication state: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write authentication state: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync authentication state: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close authentication state: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("replace authentication state: %w", err)
	}
	if dirFile, err := os.Open(dir); err == nil {
		_ = dirFile.Sync()
		_ = dirFile.Close()
	}
	return nil
}

// lockAuthFile takes an exclusive advisory lock for the state file. Readers
// and writers in other processes serialize behind it; the lock file is a
// sibling so the state file itself is only ever replaced, never rewritten.
func lockAuthFile(path string) (func(), error) {
	// The first enrollment creates the state directory, so the lock file's
	// parent has to exist before the lock is taken.
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create authentication state directory: %w", err)
	}
	lockPath := path + ".lock"
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open authentication lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		file.Close()
		return nil, fmt.Errorf("lock authentication state: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

func randomBytes(n int) ([]byte, error) {
	buffer := make([]byte, n)
	if _, err := rand.Read(buffer); err != nil {
		return nil, fmt.Errorf("random bytes: %w", err)
	}
	return buffer, nil
}

// issueKeyToken signs a session or step-up token for one security key.
func (m *authManager) issueKeyToken(kind, rpID string, credentialID []byte) (string, error) {
	return m.issueToken(kind, authFactorKey, rpID, credentialID)
}

// issueTOTPToken signs a session for the authenticator app.
func (m *authManager) issueTOTPToken() (string, error) {
	return m.issueToken(authTokenSession, authFactorTOTP, "", nil)
}

// issueTOTPStepUpToken arms credential changes for a session that signed in
// with the authenticator app: such a session has no key of its own to assert
// against, and the code was just verified in its place.
func (m *authManager) issueTOTPStepUpToken() (string, error) {
	return m.issueToken(authTokenStepUp, authFactorTOTP, "", nil)
}

func (m *authManager) issueToken(kind, factor, rpID string, credentialID []byte) (string, error) {
	m.refresh()
	m.mu.Lock()
	secret := append([]byte(nil), m.state.SessionSecret...)
	m.mu.Unlock()

	if len(secret) == 0 {
		return "", errors.New("authentication state has no session secret")
	}
	ttl := m.ttl
	if kind == authTokenStepUp {
		ttl = authStepUpTTL
	}
	now := m.now()
	token := authToken{
		Version: 1, Factor: factor, RPID: rpID, CredID: base64.RawURLEncoding.EncodeToString(credentialID),
		Issued: now.Unix(), Expires: now.Add(ttl).Unix(),
	}
	encoded, err := json.Marshal(token)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(encoded)
	return payload + "." + signAuthToken(secret, kind, payload), nil
}

func (m *authManager) verifyToken(kind, value string) (authToken, bool) {
	// The signing key is only present while credentials are enrolled; a reset
	// therefore invalidates every token issued before it.
	m.refresh()
	m.mu.Lock()
	secret := append([]byte(nil), m.state.SessionSecret...)
	m.mu.Unlock()
	if len(secret) == 0 {
		return authToken{}, false
	}
	payload, signature, ok := strings.Cut(value, ".")
	if !ok || payload == "" || signature == "" {
		return authToken{}, false
	}
	if subtle.ConstantTimeCompare([]byte(signature), []byte(signAuthToken(secret, kind, payload))) != 1 {
		return authToken{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return authToken{}, false
	}
	var token authToken
	decoder := json.NewDecoder(strings.NewReader(string(decoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&token); err != nil {
		return authToken{}, false
	}
	if token.Version != 1 || !token.consistent() || token.Expires <= m.now().Unix() {
		return authToken{}, false
	}
	return token, true
}

// requireFactorVersion rejects tokens whose factor fields do not add up: a key
// token must name its relying party and credential, a TOTP token neither.
func (t authToken) consistent() bool {
	switch t.Factor {
	case authFactorTOTP:
		return t.RPID == "" && t.CredID == ""
	case authFactorKey:
		return t.RPID != "" && t.CredID != ""
	default:
		return false
	}
}

func (t authToken) credentialID() ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(t.CredID)
	if err != nil || len(decoded) == 0 {
		return nil, false
	}
	return decoded, true
}

func signAuthToken(secret []byte, kind, payload string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(kind))
	mac.Write([]byte{0})
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// authUser adapts the single bcwebmux account to the library's user model.
type authUser struct {
	id          []byte
	name        string
	display     string
	credentials []webauthn.Credential
}

func (u authUser) WebAuthnID() []byte                         { return u.id }
func (u authUser) WebAuthnName() string                       { return u.name }
func (u authUser) WebAuthnDisplayName() string                { return u.display }
func (u authUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

// displayNameForHost names the account after the machine, which is what a
// security key prompt shows beside the relying party name.
func displayNameForHost() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return "on " + host
	}
	return "terminal"
}
