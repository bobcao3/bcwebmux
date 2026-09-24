// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

// HTTP surface for authentication: the login and enrollment pages, the
// sign-in endpoints, session cookies, and the guard that keeps the terminal
// behind a signed-in session.

import (
	"bytes"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// authAssetCSP is the content security policy for the authentication pages.
// Unlike the application assets they load no WebAssembly and open no sockets.
const authAssetCSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

// authRoutes are the fixed, publicly reachable authentication assets. Their
// URLs are user visible and deliberately independent of the file names.
var authRoutes = map[string]string{
	"/login":       "auth/login.html",
	"/login.js":    "auth/login.js",
	"/login.css":   "auth/login.css",
	"/webauthn.js": "auth/webauthn.js",
}

// authScope binds one request Host to the relying party it authenticates
// against. Ports take no part in an RP ID, so one host is one RP ID.
type authScope struct {
	// origin is the configured browser origin and the ceremony origin a
	// client data JSON must carry.
	origin string
	// rpID is the WebAuthn relying party ID: the origin host, no port.
	rpID string
	// secure marks origins browsers only reach over TLS, whose cookies must
	// carry Secure even when TLS terminates at a proxy.
	secure bool
	// problem explains why this origin cannot host a ceremony (an IP literal
	// or otherwise invalid RP ID). Such a scope still guards the application
	// surface so the origin fails closed.
	problem string
}

func newAuthScopes(origins []string) map[string]authScope {
	scopes := make(map[string]authScope, len(origins))
	for _, origin := range origins {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host == "" {
			continue
		}
		scopes[authScopeKey(parsed.Host)] = scopeForOrigin(origin)
	}
	return scopes
}

func scopeForOrigin(origin string) authScope {
	scope := authScope{origin: origin}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		scope.problem = "origin is not a usable URL"
		return scope
	}
	scope.secure = parsed.Scheme == "https"
	scope.rpID = parsed.Hostname()
	if scope.rpID == "" {
		scope.problem = "origin has no host"
		return scope
	}
	if err := protocol.ValidateRPID(scope.rpID); err != nil {
		scope.problem = fmt.Sprintf("origin host %q cannot be a relying party ID (%v); use a hostname rather than an IP address", scope.rpID, err)
	}
	return scope
}

func authScopeKey(host string) string { return strings.ToLower(host) }

// Unknown hosts have no scope, so guarded routes fail closed for them.
func (s *Server) authScopeFor(r *http.Request) (authScope, bool) {
	scope, ok := s.authScopes[authScopeKey(r.Host)]
	return scope, ok
}

// serveAuthSurface handles every authentication route and reports whether the
// request belonged to the authentication surface.
func (s *Server) serveAuthSurface(w http.ResponseWriter, r *http.Request) bool {
	if rel, ok := authRoutes[r.URL.Path]; ok {
		s.assets.servePath(w, r, rel, authAssetCSP)
		return true
	}
	if !strings.HasPrefix(r.URL.Path, "/auth/") {
		return false
	}
	switch r.URL.Path {
	case "/auth/session":
		s.serveAuthStatus(w, r)
	case "/auth/login/begin":
		s.serveLoginBegin(w, r)
	case "/auth/login/finish":
		s.serveLoginFinish(w, r)
	case "/auth/totp/verify":
		s.serveTOTPVerify(w, r)
	case "/auth/logout":
		s.serveLogout(w, r)
	case "/auth/stepup/begin":
		s.serveStepUpBegin(w, r)
	case "/auth/stepup/finish":
		s.serveStepUpFinish(w, r)
	case "/auth/stepup/totp":
		s.serveStepUpTOTP(w, r)
	case "/auth/register/begin":
		s.serveRegisterBegin(w, r)
	case "/auth/register/finish":
		s.serveRegisterFinish(w, r)
	case "/auth/credentials":
		s.serveCredentialList(w, r)
	case "/auth/credentials/remove":
		s.serveCredentialRemove(w, r)
	default:
		writeJSONError(w, http.StatusNotFound, "not_found", "unknown authentication endpoint")
	}
	return true
}

// Reachable without a session, so it never returns credential identifiers or
// secrets.
func (s *Server) serveAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	status := map[string]any{
		"authenticated": false,
		"required":      false,
		"enrolled":      0,
		"totp":          false,
		"rpId":          nil,
		"stepUp":        false,
		"disabled":      s.auth == nil,
		"origin":        false,
	}
	if s.auth == nil {
		status["authenticated"] = true
		status["reason"] = "authentication is disabled by configuration"
		writeAuthJSON(w, status)
		return
	}
	totp, keys := s.auth.factors()
	status["totp"] = totp
	status["required"] = totp || keys > 0
	// An unknown or unusable origin only rules out the security key path; the
	// authenticator app works at every address the server answers on.
	scope, known := s.authScopeFor(r)
	scoped := 0
	if known {
		scoped, _ = s.auth.credentialCount(scope.rpID)
		status["origin"] = scope.problem == ""
		status["secure"] = scope.secure
		status["enrolled"] = scoped
		if scope.problem == "" {
			status["rpId"] = scope.rpID
		}
	}
	status["stepUp"] = s.stepUpValid(r, scope)
	_, authenticated := s.sessionFor(r, scope)
	switch {
	case !totp && keys == 0:
		// Nothing is enrolled, so the application is open by design and the
		// login page sends the browser straight back to it.
		status["authenticated"] = true
		status["reason"] = "no authenticator app or security key is enrolled; run bcwebmux-server auth totp"
	case authenticated:
		status["authenticated"] = true
	case totp:
		// The code form is the answer here, whatever the origin is.
	case scope.problem != "":
		status["reason"] = scope.problem
	case !known:
		status["reason"] = "this address is not a configured origin, so only the authenticator app can sign in here"
	case scoped == 0:
		status["reason"] = "no security key is enrolled for this origin; sign in with the authenticator app and add one in Settings → SECURITY"
	}
	writeAuthJSON(w, status)
}

type authSession struct {
	factor string
	keyID  []byte
}

// An authenticator-app session works at every address, including IP literals;
// a security key session is bound to the relying party it was issued for.
func (s *Server) sessionFor(r *http.Request, scope authScope) (authSession, bool) {
	if s.auth == nil {
		return authSession{}, false
	}
	cookie, err := r.Cookie(authSessionCookie)
	if err != nil {
		return authSession{}, false
	}
	token, ok := s.auth.verifyToken(authTokenSession, cookie.Value)
	if !ok {
		return authSession{}, false
	}
	switch token.Factor {
	case authFactorTOTP:
		if totp, _ := s.auth.factors(); totp {
			return authSession{factor: authFactorTOTP}, true
		}
	case authFactorKey:
		if scope.problem != "" || scope.rpID == "" || token.RPID != scope.rpID {
			return authSession{}, false
		}
		credentialID, ok := token.credentialID()
		if !ok {
			return authSession{}, false
		}
		if _, found := s.auth.lookup(scope.rpID, credentialID); !found {
			return authSession{}, false
		}
		return authSession{factor: authFactorKey, keyID: credentialID}, true
	}
	return authSession{}, false
}

func (s *Server) stepUpValid(r *http.Request, scope authScope) bool {
	if s.auth == nil {
		return false
	}
	cookie, err := r.Cookie(authStepUpCookie)
	if err != nil {
		return false
	}
	token, ok := s.auth.verifyToken(authTokenStepUp, cookie.Value)
	if !ok {
		return false
	}
	if token.Factor == authFactorTOTP {
		// The authenticator app verifies at every address and is not bound to
		// a relying party, so its step-up needs no credential to re-check.
		return true
	}
	if token.RPID != scope.rpID {
		return false
	}
	credentialID, ok := token.credentialID()
	if !ok {
		return false
	}
	_, found := s.auth.lookup(scope.rpID, credentialID)
	return found
}

// requireSession guards the application surface. It fails closed: any enrolled
// factor protects every origin, so an address without a security key of its
// own still needs a sign-in.
func (s *Server) requireSession(w http.ResponseWriter, r *http.Request) bool {
	if s.auth == nil {
		return true
	}
	totp, keys := s.auth.factors()
	if !totp && keys == 0 {
		return true
	}
	scope, _ := s.authScopeFor(r)
	if _, ok := s.sessionFor(r, scope); ok {
		s.renewSession(w, r, scope)
		return true
	}
	if r.URL.Path == "/ws" {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSONError(w, http.StatusUnauthorized, "unauthenticated", "sign in to continue")
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/login", http.StatusFound)
	return false
}

// renewSession re-issues a session cookie once it has passed half its
// lifetime, so an actively used session does not expire mid-use while an idle
// one still ages out.
func (s *Server) renewSession(w http.ResponseWriter, r *http.Request, scope authScope) {
	cookie, err := r.Cookie(authSessionCookie)
	if err != nil {
		return
	}
	token, ok := s.auth.verifyToken(authTokenSession, cookie.Value)
	if !ok {
		return
	}
	if s.auth.now().Unix()-token.Issued < int64((s.auth.ttl / 2).Seconds()) {
		return
	}
	value := ""
	if token.Factor == authFactorTOTP {
		value, err = s.auth.issueTOTPToken()
	} else {
		credentialID, ok := token.credentialID()
		if !ok {
			return
		}
		value, err = s.auth.issueKeyToken(authTokenSession, token.RPID, credentialID)
	}
	if err != nil {
		return
	}
	http.SetCookie(w, authCookie(authSessionCookie, value, s.auth.ttl, scope.secure))
}

func (s *Server) serveLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.authScopeFor(r)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "unknown_origin", "this address is not a configured origin")
		return
	}
	if scope.problem != "" {
		writeJSONError(w, http.StatusConflict, "unsupported_origin", scope.problem)
		return
	}
	if scoped, _ := s.auth.credentialCount(scope.rpID); scoped == 0 {
		writeJSONError(w, http.StatusConflict, "not_enrolled",
			"no security key is enrolled for this origin; sign in with the authenticator app and add one in Settings → SECURITY")
		return
	}
	instance, err := s.auth.webauthnFor(scope.rpID)
	if err != nil {
		s.authInternal(w, "relying party configuration", err)
		return
	}
	assertion, session, err := instance.BeginLogin(s.auth.user(scope.rpID),
		webauthn.WithLoginRelyingPartyID(scope.rpID),
		webauthn.WithLoginOrigin(scope.origin),
		webauthn.WithUserVerification(protocol.VerificationPreferred),
	)
	if err != nil {
		s.authInternal(w, "begin login", err)
		return
	}
	if err := s.auth.beginChallenge(authKindLogin, scope.rpID, "", session); err != nil {
		s.authInternal(w, "store login ceremony", err)
		return
	}
	writeAuthJSON(w, assertion)
}

func (s *Server) serveLoginFinish(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.authScopeFor(r)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "unknown_origin", "this address is not a configured origin")
		return
	}
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
	if err != nil {
		s.authFailure(w, r, "parse login response", err)
		return
	}
	pending, ok := s.auth.takeChallenge(authKindLogin, scope.rpID, parsed.Response.CollectedClientData.Challenge)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "no_ceremony", "no login ceremony is pending for this origin")
		return
	}
	instance, err := s.auth.webauthnFor(scope.rpID)
	if err != nil {
		s.authInternal(w, "relying party configuration", err)
		return
	}
	credential, err := instance.ValidateLogin(s.auth.user(scope.rpID), pending.session, parsed)
	if err != nil {
		s.authFailure(w, r, "validate login", err)
		return
	}
	if err := s.auth.recordUse(scope.rpID, credential); err != nil {
		s.authInternal(w, "record credential use", err)
		return
	}
	value, err := s.auth.issueKeyToken(authTokenSession, scope.rpID, credential.ID)
	if err != nil {
		s.authInternal(w, "issue session", err)
		return
	}
	http.SetCookie(w, authCookie(authSessionCookie, value, s.auth.ttl, scope.secure))
	http.SetCookie(w, authCookie(authStepUpCookie, "", 0, scope.secure))
	name := s.auth.credentialName(scope.rpID, credential.ID)
	s.logger.Info("security key login succeeded", "credential", name, "origin", scope.origin, "remote", r.RemoteAddr)
	writeAuthJSON(w, map[string]any{"authenticated": true, "credential": name})
}

// The code path is the one that works at every origin, IP literals included; a
// success issues the same session the security key path issues.
func (s *Server) serveTOTPVerify(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	var request struct {
		Code string `json:"code"`
	}
	if !readAuthJSON(w, r, &request) {
		return
	}
	if !s.verifyTOTPCode(w, r, request.Code) {
		return
	}
	value, err := s.auth.issueTOTPToken()
	if err != nil {
		s.authInternal(w, "issue session", err)
		return
	}
	scope, _ := s.authScopeFor(r)
	http.SetCookie(w, authCookie(authSessionCookie, value, s.auth.ttl, scope.secure))
	http.SetCookie(w, authCookie(authStepUpCookie, "", 0, scope.secure))
	s.logger.Info("authenticator app login succeeded", "origin", r.Header.Get("Origin"), "remote", r.RemoteAddr)
	writeAuthJSON(w, map[string]any{"authenticated": true, "factor": authFactorTOTP})
}

// verifyTOTPCode consumes one code through the shared limiter and writes the
// refusal itself, so sign-in and step-up cannot disagree about what a rejected
// code means or how long the next attempt must wait.
func (s *Server) verifyTOTPCode(w http.ResponseWriter, r *http.Request, code string) bool {
	now := s.auth.now()
	switch outcome := s.auth.verifyTOTP(code, now); outcome {
	case totpAccepted:
		return true
	case totpLocked:
		remaining := s.auth.totpLockRemaining(now)
		seconds := int(remaining.Seconds()) + 1
		w.Header().Set("Retry-After", fmt.Sprint(seconds))
		writeJSONError(w, http.StatusTooManyRequests, "rate_limited",
			fmt.Sprintf("too many rejected codes; try again in %ds", seconds))
		return false
	case totpUnenrolled:
		writeJSONError(w, http.StatusConflict, "not_enrolled",
			"no authenticator app is enrolled; run bcwebmux-server auth totp on the host")
		return false
	case totpReplayed:
		// A correct code for an already accepted step is either a replayed
		// code or a clock that has not advanced. Neither may sign in.
		s.logger.Warn("totp code replayed", "origin", r.Header.Get("Origin"), "remote", r.RemoteAddr)
		writeJSONError(w, http.StatusUnauthorized, "code_reused",
			"that code was already used; wait for the next one")
		return false
	case totpBroken:
		s.authInternal(w, "verify totp code", errors.New("totp verification failed"))
		return false
	default:
		s.logger.Warn("totp code rejected", "origin", r.Header.Get("Origin"), "remote", r.RemoteAddr)
		writeJSONError(w, http.StatusUnauthorized, "invalid_code", "that code is not valid")
		return false
	}
}

// Credential changes require a fresh assertion rather than just a session.
func (s *Server) serveStepUpBegin(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.authSessionReady(w, r)
	if !ok {
		return
	}
	instance, err := s.auth.webauthnFor(scope.rpID)
	if err != nil {
		s.authInternal(w, "relying party configuration", err)
		return
	}
	// Credential changes are the one place where a signature from a bare key
	// is not enough: user verification (PIN or biometric) is required, so
	// possession of an unattended key cannot enroll another one.
	assertion, session, err := instance.BeginLogin(s.auth.user(scope.rpID),
		webauthn.WithLoginRelyingPartyID(scope.rpID),
		webauthn.WithLoginOrigin(scope.origin),
		webauthn.WithUserVerification(protocol.VerificationRequired),
	)
	if err != nil {
		s.authInternal(w, "begin step-up", err)
		return
	}
	if err := s.auth.beginChallenge(authKindStepUp, scope.rpID, "", session); err != nil {
		s.authInternal(w, "store step-up ceremony", err)
		return
	}
	writeAuthJSON(w, assertion)
}

// A verified step-up arms credential changes for a few minutes.
func (s *Server) serveStepUpFinish(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.authSessionReady(w, r)
	if !ok {
		return
	}
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
	if err != nil {
		s.authFailure(w, r, "parse step-up response", err)
		return
	}
	pending, ok := s.auth.takeChallenge(authKindStepUp, scope.rpID, parsed.Response.CollectedClientData.Challenge)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "no_ceremony", "no step-up ceremony is pending for this origin")
		return
	}
	instance, err := s.auth.webauthnFor(scope.rpID)
	if err != nil {
		s.authInternal(w, "relying party configuration", err)
		return
	}
	credential, err := instance.ValidateLogin(s.auth.user(scope.rpID), pending.session, parsed)
	if err != nil {
		s.authFailure(w, r, "validate step-up", err)
		return
	}
	if err := s.auth.recordUse(scope.rpID, credential); err != nil {
		s.authInternal(w, "record credential use", err)
		return
	}
	value, err := s.auth.issueKeyToken(authTokenStepUp, scope.rpID, credential.ID)
	if err != nil {
		s.authInternal(w, "issue step-up token", err)
		return
	}
	http.SetCookie(w, authCookie(authStepUpCookie, value, authStepUpTTL, scope.secure))
	writeAuthJSON(w, map[string]any{"stepUp": true, "expiresIn": int(authStepUpTTL.Seconds())})
}

// A session that signed in with the authenticator app holds no key of its own,
// so a current code is what arms credential changes for it.
func (s *Server) serveStepUpTOTP(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.authSessionReady(w, r)
	if !ok {
		return
	}
	var request struct {
		Code string `json:"code"`
	}
	if !readAuthJSON(w, r, &request) {
		return
	}
	if !s.verifyTOTPCode(w, r, request.Code) {
		return
	}
	value, err := s.auth.issueTOTPStepUpToken()
	if err != nil {
		s.authInternal(w, "issue step-up token", err)
		return
	}
	http.SetCookie(w, authCookie(authStepUpCookie, value, authStepUpTTL, scope.secure))
	s.logger.Info("credential changes armed with a code", "origin", r.Header.Get("Origin"), "remote", r.RemoteAddr)
	writeAuthJSON(w, map[string]any{"stepUp": true, "factor": authFactorTOTP, "expiresIn": int(authStepUpTTL.Seconds())})
}

func (s *Server) serveRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.registerAuthorized(w, r)
	if !ok {
		return
	}
	if scope.problem != "" {
		writeJSONError(w, http.StatusConflict, "unsupported_origin", scope.problem)
		return
	}
	instance, err := s.auth.webauthnFor(scope.rpID)
	if err != nil {
		s.authInternal(w, "relying party configuration", err)
		return
	}
	user, err := s.auth.ensureIdentity()
	if err != nil {
		s.authInternal(w, "initialize account", err)
		return
	}
	creation, session, err := instance.BeginRegistration(user,
		webauthn.WithRegistrationRelyingPartyID(scope.rpID),
		webauthn.WithRegistrationOrigin(scope.origin),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			// Every key is bound to whoever can unlock it on its own device,
			// so the ceremony must verify a biometric or PIN.
			UserVerification: protocol.VerificationRequired,
		}),
	)
	if err != nil {
		s.authInternal(w, "begin registration", err)
		return
	}
	if err := s.auth.beginChallenge(authKindRegister, scope.rpID, credentialName(r), session); err != nil {
		s.authInternal(w, "store registration ceremony", err)
		return
	}
	writeAuthJSON(w, creation)
}

func (s *Server) serveRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.registerAuthorized(w, r)
	if !ok {
		return
	}
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(body)
	if err != nil {
		s.authFailure(w, r, "parse attestation response", err)
		return
	}
	pending, ok := s.auth.takeChallenge(authKindRegister, scope.rpID, parsed.Response.CollectedClientData.Challenge)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "no_ceremony", "no enrollment ceremony is pending for this origin")
		return
	}
	instance, err := s.auth.webauthnFor(scope.rpID)
	if err != nil {
		s.authInternal(w, "relying party configuration", err)
		return
	}
	user, err := s.auth.ensureIdentity()
	if err != nil {
		s.authInternal(w, "initialize account", err)
		return
	}
	credential, err := instance.CreateCredential(user, pending.session, parsed)
	if err != nil {
		s.authFailure(w, r, "validate attestation", err)
		return
	}
	entry, err := s.auth.addCredential(scope.rpID, pending.name, credential)
	if err != nil {
		if errors.Is(err, errCredentialEnrolled) {
			writeJSONError(w, http.StatusConflict, "already_enrolled", "this security key is already enrolled")
			return
		}
		s.authInternal(w, "store credential", err)
		return
	}
	s.logger.Info("security key enrolled", "credential", entry.Name, "origin", scope.origin, "remote", r.RemoteAddr)
	writeAuthJSON(w, map[string]any{"enrolled": true, "name": entry.Name, "rpId": scope.rpID})
}

// The listed credentials are the set the browser may manage from here; the
// authenticator app is reported alongside them but is managed on the host.
func (s *Server) serveCredentialList(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "auth_disabled", "authentication is disabled by configuration")
		return
	}
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	scope, ok := s.authSessionReady(w, r)
	if !ok {
		return
	}
	session, _ := s.sessionFor(r, scope)
	current := session.keyID
	credentials := s.auth.credentialsFor(scope.rpID)
	list := make([]map[string]any, 0, len(credentials))
	for _, credential := range credentials {
		transports := make([]string, 0, len(credential.Credential.Transport))
		for _, transport := range credential.Credential.Transport {
			transports = append(transports, string(transport))
		}
		entry := map[string]any{
			"id":          base64.RawURLEncoding.EncodeToString(credential.Credential.ID),
			"name":        credential.Name,
			"rpId":        credential.RPID,
			"createdAt":   credential.CreatedAt.UTC().Format(time.RFC3339),
			"transports":  transports,
			"current":     subtle.ConstantTimeCompare(current, credential.Credential.ID) == 1,
		}
		if !credential.LastUsedAt.IsZero() {
			entry["lastUsedAt"] = credential.LastUsedAt.UTC().Format(time.RFC3339)
		}
		list = append(list, entry)
	}
	_, total := s.auth.credentialCount(scope.rpID)
	response := map[string]any{"rpId": scope.rpID, "enrolled": total, "credentials": list, "stepUp": s.stepUpValid(r, scope)}
	if factor, ok := s.auth.totpFactor(); ok {
		entry := map[string]any{
			"name":       factor.Name,
			"enrolledAt": factor.Enrolled.UTC().Format(time.RFC3339),
			"digits":     factor.Digits,
			"period":     factor.Period,
		}
		if !factor.LastUsed.IsZero() {
			entry["lastUsedAt"] = factor.LastUsed.UTC().Format(time.RFC3339)
		}
		response["totp"] = entry
	}
	writeAuthJSON(w, response)
}

func (s *Server) serveCredentialRemove(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, ok := s.authSessionReady(w, r)
	if !ok {
		return
	}
	if !s.stepUpValid(r, scope) {
		writeJSONError(w, http.StatusForbidden, "step_up_required", "verify a security key again before changing credentials")
		return
	}
	var request struct {
		ID string `json:"id"`
	}
	if !readAuthJSON(w, r, &request) {
		return
	}
	id, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(request.ID))
	if err != nil || len(id) == 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid_id", "credential identifier is not valid")
		return
	}
	entry, found := s.auth.lookup(scope.rpID, id)
	if !found {
		writeJSONError(w, http.StatusNotFound, "not_found", "no such credential is enrolled for this origin")
		return
	}
	removed, found, err := s.auth.removeCredential(entry.Credential.ID)
	if err != nil {
		s.authInternal(w, "remove credential", err)
		return
	}
	if !found {
		writeJSONError(w, http.StatusNotFound, "not_found", "no such credential is enrolled for this origin")
		return
	}
	s.logger.Info("security key removed", "credential", removed.Name, "origin", scope.origin, "remote", r.RemoteAddr)
	writeAuthJSON(w, map[string]any{"removed": true, "name": removed.Name})
}

func (s *Server) serveLogout(w http.ResponseWriter, r *http.Request) {
	if !s.authMutationReady(w, r) {
		return
	}
	scope, _ := s.authScopeFor(r)
	http.SetCookie(w, authCookie(authSessionCookie, "", 0, scope.secure))
	http.SetCookie(w, authCookie(authStepUpCookie, "", 0, scope.secure))
	w.WriteHeader(http.StatusNoContent)
}

// Every POST checks this: authentication must be available and the request
// must come from an allowed origin.
func (s *Server) authMutationReady(w http.ResponseWriter, r *http.Request) bool {
	if s.auth == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "auth_disabled", "authentication is disabled by configuration")
		return false
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return false
	}
	if !s.validOrigin(r) {
		// Report the headers that made the browser request fail before reading
		// (or consuming) a one-time code. Never log the request body.
		s.logger.Warn("authentication origin rejected", "host", r.Host, "origins", r.Header.Values("Origin"), "fetch_site", r.Header.Get("Sec-Fetch-Site"), "fetch_mode", r.Header.Get("Sec-Fetch-Mode"), "remote", r.RemoteAddr, "path", r.URL.Path)
		writeJSONError(w, http.StatusForbidden, "forbidden", "same-origin request required")
		return false
	}
	return true
}

func (s *Server) authSessionReady(w http.ResponseWriter, r *http.Request) (authScope, bool) {
	scope, ok := s.authScopeFor(r)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "unknown_origin", "this address is not a configured origin")
		return authScope{}, false
	}
	if _, ok := s.sessionFor(r, scope); !ok {
		writeJSONError(w, http.StatusUnauthorized, "unauthenticated", "sign in to continue")
		return authScope{}, false
	}
	return scope, true
}

func (s *Server) registerAuthorized(w http.ResponseWriter, r *http.Request) (authScope, bool) {
	scope, ok := s.authScopeFor(r)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "unknown_origin", "this address is not a configured origin")
		return authScope{}, false
	}
	if _, ok := s.sessionFor(r, scope); !ok {
		writeJSONError(w, http.StatusUnauthorized, "unauthenticated", "sign in to continue")
		return authScope{}, false
	}
	if !s.stepUpValid(r, scope) {
		writeJSONError(w, http.StatusForbidden, "step_up_required", "verify a factor again before changing security keys")
		return authScope{}, false
	}
	return scope, true
}

func (s *Server) authFailure(w http.ResponseWriter, r *http.Request, action string, err error) {
	s.logger.Warn("security key ceremony rejected", "action", action, "origin", r.Header.Get("Origin"), "remote", r.RemoteAddr, "error", err)
	writeJSONError(w, http.StatusUnauthorized, "authentication_failed", "security key verification failed")
}

func (s *Server) authInternal(w http.ResponseWriter, action string, err error) {
	s.logger.Error("authentication failed", "action", action, "error", err)
	writeJSONError(w, http.StatusInternalServerError, "internal", "authentication is unavailable")
}

// Secure comes from the configured origin scheme rather than the local
// connection, so a TLS-terminating proxy still produces Secure cookies.
func authCookie(name, value string, ttl time.Duration, secure bool) *http.Cookie {
	cookie := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     authCookiePath,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	}
	if ttl > 0 && value != "" {
		cookie.MaxAge = int(ttl.Seconds())
		cookie.Expires = time.Now().Add(ttl)
	} else {
		cookie.MaxAge = -1
	}
	return cookie
}

func readAuthBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.ContentLength > authMaxBodyBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
		return nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, authMaxBodyBytes))
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
			return nil, false
		}
		writeJSONError(w, http.StatusBadRequest, "invalid_body", "request body could not be read")
		return nil, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid_body", "request body is required")
		return nil, false
	}
	return body, true
}

func readAuthJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	body, ok := readAuthBody(w, r)
	if !ok {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_body", "request body is not valid JSON")
		return false
	}
	return true
}

func writeAuthJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_ = json.NewEncoder(w).Encode(value)
}

// credentialName is the operator's label for the key being enrolled, given in
// the query string.
func credentialName(r *http.Request) string {
	return normalizeCredentialName(r.URL.Query().Get("name"))
}

// Strips control characters so a label is safe in a terminal, a log line, and
// JSON alike; the length cap is also what keeps the enrolment QR inside eighty
// columns.
func normalizeCredentialName(name string) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if len(cleaned) > 64 {
		cleaned = strings.ToValidUTF8(cleaned[:64], "")
	}
	if cleaned == "" {
		return "security key"
	}
	return cleaned
}

func (m *authManager) credentialName(rpID string, id []byte) string {
	if entry, ok := m.lookup(rpID, id); ok {
		return entry.Name
	}
	return "security key"
}
