package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// A local file service (webdav, nginx, Copyparty, tmf, ...) can serve part of
// this machine over HTTP, which is what makes a terminal's file:// links
// openable at all. The browser does the resolving (web/FileServiceLinks.js);
// the server only publishes the machine-local configuration, so one setting
// covers every client, including the ones that cannot be reached to be
// configured by hand.
//
// The service URL is a template: {host} is the hostname the application is
// being used on and {path} is the served path, so
// `https://{host}:7443{path}?v` follows the address bar. It is checked here to
// fail loudly on a typo, and checked again in the browser, which is the
// authority on the address a link resolves to.

const (
	fileServiceHostToken = "{host}"
	fileServicePathToken = "{path}"
	maxFileServiceURL    = 2048
	// A path value that names no real destination, used to prove that the token
	// cannot reach the authority.
	fileServiceHostilePath = "/evil.invalid/"
)

// fileServiceDefaults is what GET /api/client-config publishes.
type fileServiceDefaults struct {
	URL         string `json:"url"`
	LocalPrefix string `json:"localPrefix"`
}

// validateFileService checks one configured local file service. Both halves are
// required together: a URL without a prefix could not decide which links it
// serves, and a prefix without a URL serves nothing.
func validateFileService(serviceURL, localPrefix string) error {
	if serviceURL == "" && localPrefix == "" {
		return nil
	}
	if serviceURL == "" || localPrefix == "" {
		return errors.New("file-service-url and file-service-prefix must be set together")
	}
	if err := validateFileServiceURL(serviceURL); err != nil {
		return err
	}
	if !strings.HasPrefix(localPrefix, "/") || localPrefix != path.Clean(localPrefix) || strings.ContainsRune(localPrefix, 0) {
		return fmt.Errorf("invalid file-service-prefix %q: use an absolute, slash-normalized path such as /srv/files or /", localPrefix)
	}
	return nil
}

// validateFileServiceURL mirrors the browser's template rules. The browser is
// the authority on what a link resolves to; this side exists so a mistyped
// template is a startup error instead of a link that goes nowhere.
func validateFileServiceURL(serviceURL string) error {
	if len(serviceURL) > maxFileServiceURL {
		return fmt.Errorf("file-service-url is longer than %d bytes", maxFileServiceURL)
	}
	for _, r := range serviceURL {
		if r < 0x20 || r == 0x7f || r == '\\' {
			return fmt.Errorf("invalid file-service-url %q", serviceURL)
		}
	}
	if strings.Count(serviceURL, fileServiceHostToken) > 1 || strings.Count(serviceURL, fileServicePathToken) > 1 {
		return fmt.Errorf("file-service-url %q repeats a token", serviceURL)
	}
	bare := strings.NewReplacer(fileServiceHostToken, "", fileServicePathToken, "").Replace(serviceURL)
	if strings.ContainsAny(bare, "{}") {
		return fmt.Errorf("file-service-url %q uses an unknown token", serviceURL)
	}
	if fragment := strings.Index(serviceURL, "#"); fragment >= 0 {
		for _, token := range []string{fileServiceHostToken, fileServicePathToken} {
			if index := strings.Index(serviceURL, token); index > fragment {
				return fmt.Errorf("file-service-url %q puts %s in the fragment", serviceURL, token)
			}
		}
	}
	// The template must name an http(s) host on its own, and the served path may
	// not be part of deciding which host that is.
	probe, err := url.Parse(fillFileService(serviceURL, "terminal.invalid", "/"))
	if err != nil || (probe.Scheme != "http" && probe.Scheme != "https") || probe.Hostname() == "" {
		return fmt.Errorf("file-service-url %q does not name an http(s) host", serviceURL)
	}
	if index := strings.Index(serviceURL, fileServicePathToken); index >= 0 {
		head, err := url.Parse(fillFileService(serviceURL[:index], "terminal.invalid", ""))
		if err != nil || head.Hostname() == "" {
			return fmt.Errorf("file-service-url %q lets {path} stand in the host", serviceURL)
		}
	}
	hostile, err := url.Parse(fillFileService(serviceURL, "terminal.invalid", fileServiceHostilePath))
	if err != nil || hostile.Host != probe.Host {
		return fmt.Errorf("file-service-url %q lets {path} move the host", serviceURL)
	}
	return nil
}

// fillFileService substitutes the tokens the way a link will. A path is not
// doubled when the template already ends in a slash.
func fillFileService(serviceURL, host, served string) string {
	if index := strings.Index(serviceURL, fileServicePathToken); index > 0 && serviceURL[index-1] == '/' && strings.HasPrefix(served, "/") {
		served = served[1:]
	}
	return strings.NewReplacer(fileServiceHostToken, host, fileServicePathToken, served).Replace(serviceURL)
}

// serveClientConfig publishes the machine-local defaults the browser cannot
// guess. A browser that configured its own file service in Settings → LINKS
// keeps it; this seeds the ones that did not.
func (s *Server) serveClientConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	payload := map[string]any{}
	if s.fileService.URL != "" {
		payload["fileService"] = s.fileService
	}
	writeJSON(w, http.StatusOK, payload)
}
