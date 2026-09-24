// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

// TOTP (RFC 6238) is the baseline factor because it has no origin scoping: it
// signs in at every address the server answers on, IP literals included, where
// a WebAuthn security key cannot be used at all.

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base32"
	"errors"
	"fmt"
	"hash"
	"net/url"
	"strings"
	"time"
)

const (
	// totpSecretBytes is the RFC 4226 recommendation for a new shared secret.
	totpSecretBytes   = 20
	totpDigits        = 6
	totpPeriodSeconds = 30
	totpAlgorithm     = "SHA1"
	// totpSkewSteps accepts the neighbouring steps, which is the clock drift a
	// phone and a server are allowed.
	totpSkewSteps = 1
	// Six digits over a three-step window are brute forceable without a
	// limiter, so this threshold is load bearing.
	totpFailuresBeforeLockout = 5
	totpLockoutBase           = 30 * time.Second
	totpLockoutMax            = 15 * time.Minute
	// totpFailureWindow forgets old failures so today's typo does not count
	// against tomorrow's sign-in.
	totpFailureWindow = time.Hour
)

type authTOTP struct {
	Secret    []byte    `json:"secret"`
	Digits    int       `json:"digits"`
	Period    int       `json:"period"`
	Algorithm string    `json:"algorithm"`
	Name      string    `json:"name,omitempty"`
	Enrolled  time.Time `json:"enrolledAt"`
	LastUsed  time.Time `json:"lastUsedAt,omitempty"`
	// LastStep makes a code single use: accepting a step twice would let a
	// sniffed code be replayed inside its own window.
	LastStep int64 `json:"lastStep"`
}

type totpOutcome int

const (
	totpAccepted totpOutcome = iota
	totpRejected
	totpReplayed
	totpLocked
	totpUnenrolled
	totpBroken
)

// validateAuthTOTP rejects a factor the verifier could not accept later.
func validateAuthTOTP(factor *authTOTP) error {
	switch {
	case factor == nil:
		return nil
	case len(factor.Secret) < 10:
		return errors.New("totp secret is too short")
	case factor.Digits < 6 || factor.Digits > 8:
		return fmt.Errorf("totp digits %d is out of range", factor.Digits)
	case factor.Period < 5 || factor.Period > 300:
		return fmt.Errorf("totp period %d is out of range", factor.Period)
	case algorithmHash(factor.Algorithm) == nil:
		return fmt.Errorf("totp algorithm %q is unsupported", factor.Algorithm)
	}
	return nil
}

func algorithmHash(name string) func() hash.Hash {
	switch strings.ToUpper(name) {
	case "SHA1", "":
		return sha1.New
	case "SHA256":
		return sha256.New
	case "SHA512":
		return sha512.New
	}
	return nil
}

func totpCode(factor authTOTP, step int64) (string, error) {
	newHash := algorithmHash(factor.Algorithm)
	if newHash == nil {
		return "", fmt.Errorf("totp algorithm %q is unsupported", factor.Algorithm)
	}
	counter := make([]byte, 8)
	for index := 7; index >= 0; index-- {
		counter[index] = byte(step)
		step >>= 8
	}
	mac := hmac.New(newHash, factor.Secret)
	mac.Write(counter)
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 0x0f
	truncated := int64(digest[offset]&0x7f)<<24 |
		int64(digest[offset+1])<<16 |
		int64(digest[offset+2])<<8 |
		int64(digest[offset+3])
	modulus := int64(1)
	for index := 0; index < factor.Digits; index++ {
		modulus *= 10
	}
	return fmt.Sprintf("%0*d", factor.Digits, truncated%modulus), nil
}

// verifyTOTP is the only door a code gets in through, and it consumes the time
// step under the file lock, so a replay loses even against a second server.
func (m *authManager) verifyTOTP(code string, now time.Time) totpOutcome {
	trimmed := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' {
			return -1
		}
		return r
	}, strings.TrimSpace(code))

	m.mu.Lock()
	defer m.mu.Unlock()
	factor := m.state.TOTP
	if factor == nil {
		return totpUnenrolled
	}
	if now.Before(m.totpLockedUntil) {
		return totpLocked
	}
	if !m.totpLastFailure.IsZero() && now.Sub(m.totpLastFailure) > totpFailureWindow {
		m.totpFailures = 0
	}
	if len(trimmed) != factor.Digits {
		m.recordTOTPFailure(now)
		return totpRejected
	}
	step := now.Unix() / int64(factor.Period)
	matched := int64(-1)
	for delta := int64(-totpSkewSteps); delta <= totpSkewSteps; delta++ {
		expected, err := totpCode(*factor, step+delta)
		if err != nil {
			return totpBroken
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(trimmed)) == 1 {
			matched = step + delta
			break
		}
	}
	if matched < 0 {
		m.recordTOTPFailure(now)
		return totpRejected
	}
	if matched <= factor.LastStep {
		// A correct code for an already accepted step: either a retry from a
		// clock that has not advanced, or a replay. Never accept it.
		return totpReplayed
	}
	err := m.updateLocked(func(state *authState) (bool, error) {
		if state.TOTP == nil {
			return false, nil
		}
		if matched <= state.TOTP.LastStep {
			return false, errTOTPReplayed
		}
		state.TOTP.LastStep = matched
		state.TOTP.LastUsed = now.UTC()
		return true, nil
	})
	if errors.Is(err, errTOTPReplayed) {
		return totpReplayed
	}
	if err != nil {
		return totpBroken
	}
	m.totpFailures, m.totpLockedUntil, m.totpLastFailure = 0, time.Time{}, time.Time{}
	return totpAccepted
}

var errTOTPReplayed = errors.New("time step already used")

// errTOTPUnconfirmed marks an enrollment whose confirmation code did not match
// the secret being stored.
var errTOTPUnconfirmed = errors.New("confirmation code does not match the new secret")

// verifyTOTPCode is the enrollment check: the same derivation as a sign-in,
// without a replay marker to consume because nothing is enrolled yet.
func verifyTOTPCode(factor authTOTP, code string, now time.Time) totpOutcome {
	trimmed := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' {
			return -1
		}
		return r
	}, strings.TrimSpace(code))
	if len(trimmed) != factor.Digits {
		return totpRejected
	}
	step := now.Unix() / int64(factor.Period)
	for delta := int64(-totpSkewSteps); delta <= totpSkewSteps; delta++ {
		expected, err := totpCode(factor, step+delta)
		if err != nil {
			return totpBroken
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(trimmed)) == 1 {
			return totpAccepted
		}
	}
	return totpRejected
}

// recordTOTPFailure backs off after repeated bad codes, and the backoff is
// capped so a remote attacker cannot lock the operator out indefinitely.
func (m *authManager) recordTOTPFailure(now time.Time) {
	m.totpFailures++
	m.totpLastFailure = now
	if m.totpFailures < totpFailuresBeforeLockout {
		return
	}
	backoff := totpLockoutBase << uint(m.totpFailures-totpFailuresBeforeLockout)
	if backoff > totpLockoutMax || backoff <= 0 {
		backoff = totpLockoutMax
	}
	m.totpLockedUntil = now.Add(backoff)
	m.logger.Warn("totp code rejected repeatedly", "failures", m.totpFailures, "locked_for", backoff.String())
}

func (m *authManager) totpLockRemaining(now time.Time) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !now.Before(m.totpLockedUntil) {
		return 0
	}
	return m.totpLockedUntil.Sub(now)
}

func (m *authManager) totpFactor() (authTOTP, bool) {
	m.refresh()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.TOTP == nil {
		return authTOTP{}, false
	}
	return *m.state.TOTP, true
}

// enrollTOTP stores a factor only after a code derived from that very secret
// has been checked here: a mistyped secret or a misread QR would otherwise
// lock the operator out of the service.
func (m *authManager) enrollTOTP(factor authTOTP, code string, now time.Time) (authTOTP, error) {
	if err := validateAuthTOTP(&factor); err != nil {
		return authTOTP{}, err
	}
	if verifyTOTPCode(factor, code, now) != totpAccepted {
		return authTOTP{}, errTOTPUnconfirmed
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	user, err := m.ensureIdentityLocked()
	if err != nil {
		return authTOTP{}, err
	}
	err = m.updateLocked(func(state *authState) (bool, error) {
		state.TOTP = &factor
		if len(state.SessionSecret) == 0 {
			state.SessionSecret = append([]byte(nil), m.state.SessionSecret...)
		}
		if len(state.UserHandle) == 0 {
			state.UserHandle = append([]byte(nil), m.state.UserHandle...)
		}
		if state.UserName == "" {
			state.UserName = user.name
		}
		if state.DisplayName == "" {
			state.DisplayName = user.display
		}
		return true, nil
	})
	if err != nil {
		return authTOTP{}, err
	}
	m.totpFailures, m.totpLockedUntil, m.totpLastFailure = 0, time.Time{}, time.Time{}
	return factor, nil
}

// removeTOTP drops the authenticator-app factor.
func (m *authManager) removeTOTP() (authTOTP, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var removed authTOTP
	found := false
	err := m.updateLocked(func(state *authState) (bool, error) {
		if state.TOTP == nil {
			return false, nil
		}
		removed, found = *state.TOTP, true
		state.TOTP = nil
		if len(state.Credentials) == 0 {
			state.SessionSecret, state.UserHandle = nil, nil
		}
		return true, nil
	})
	if err != nil {
		return authTOTP{}, false, err
	}
	return removed, found, nil
}

// otpauthURI is the enrolment payload. Parameters every app already assumes
// are left out so the QR code stays inside eighty columns.
func otpauthURI(issuer, account string, factor authTOTP) string {
	label := url.PathEscape(issuer + ":" + account)
	query := url.Values{}
	query.Set("secret", totpSecret(factor.Secret))
	query.Set("issuer", issuer)
	if strings.ToUpper(factor.Algorithm) != totpAlgorithm {
		query.Set("algorithm", strings.ToUpper(factor.Algorithm))
	}
	if factor.Digits != totpDigits {
		query.Set("digits", fmt.Sprint(factor.Digits))
	}
	if factor.Period != totpPeriodSeconds {
		query.Set("period", fmt.Sprint(factor.Period))
	}
	return "otpauth://totp/" + label + "?" + query.Encode()
}

func totpSecret(secret []byte) string {
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
}

func newTOTPFactor(name string, now time.Time) (authTOTP, error) {
	secret, err := randomBytes(totpSecretBytes)
	if err != nil {
		return authTOTP{}, err
	}
	return authTOTP{
		Secret: secret, Digits: totpDigits, Period: totpPeriodSeconds, Algorithm: totpAlgorithm,
		Name: name, Enrolled: now.UTC(),
	}, nil
}
