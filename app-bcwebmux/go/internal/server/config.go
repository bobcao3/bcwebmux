package server

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"bcwebmux/go/internal/native"
)

const (
	DefaultHost        = "127.0.0.1"
	DefaultMaxSessions = 16
	MaxRequestBytes    = native.MaxRequestBytes
	MaxHeaderBytes     = 16 * 1024
	MaxAssetBytes      = 16 * 1024 * 1024
	ShutdownTimeout    = 5 * time.Second
)

// Config contains transport and native-engine configuration. EmbeddedAssets
// must contain a top-level web directory (as produced by //go:embed web).
type Config struct {
	Listen        []string
	Origins       []string
	Host          string
	Port          int
	WebRoot       string
	Shell         string
	Term          string
	KittyGraphics bool
	Origin        string
	MaxSessions   uint64
	TLSCert       string
	TLSKey        string
	HTTP3         bool
	Worker        string
	// AuthEnabled keeps the browser surface behind a FIDO2 login whenever
	// credentials are enrolled. AuthFile holds those credentials; whether a
	// factor is enrolled, not this flag, decides if a login is required.
	AuthEnabled    bool
	AuthFile       string
	AuthSessionTTL time.Duration
	EmbeddedAssets fs.FS
	Engine         native.Engine
	Logger         *slog.Logger
}

// ParseConfig parses the server's stable command-line interface. It does not
// bind a socket or start the native engine.
func ParseConfig(args []string) (Config, bool, error) {
	return parseConfig(args, true)
}

// parseConfig parses the same interface. Validation of listeners is skipped
// for the authentication subcommands, which only need the state file location
// and must keep working when this machine's addresses changed.
func parseConfig(args []string, validateListeners bool) (Config, bool, error) {
	// Port stays -1 until the listeners or origins name one.
	cfg := Config{Port: -1, MaxSessions: DefaultMaxSessions, Term: "xterm-ghostty", KittyGraphics: true, AuthEnabled: true}
	flags := flag.NewFlagSet("bcwebmux-server", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.WebRoot, "web-root", "", "asset directory")
	flags.StringVar(&cfg.Shell, "shell", "", "shell")
	flags.StringVar(&cfg.Term, "term", cfg.Term, "TERM for session shells")
	flags.BoolVar(&cfg.KittyGraphics, "kitty-graphics", cfg.KittyGraphics, "advertise Kitty graphics to session shells")
	flags.BoolVar(&cfg.AuthEnabled, "auth", cfg.AuthEnabled, "require a FIDO2 security key login once credentials are enrolled")
	flags.StringVar(&cfg.AuthFile, "auth-file", "", "FIDO2 authentication state file")
	flags.DurationVar(&cfg.AuthSessionTTL, "auth-session-ttl", 0, "browser login session lifetime (default 168h)")
	var origins, listens []string
	var configPath string
	flags.StringVar(&configPath, "config", "", "TOML config file")
	flags.Func("listen", "repeatable bind HOST[:PORT] | IP | CIDR", func(v string) error {
		if v == "" {
			return errors.New("empty listen")
		}
		listens = append(listens, v)
		return nil
	})
	flags.Func("origin", "repeatable exact allowed origin", func(v string) error {
		if v == "" {
			return errors.New("empty origin")
		}
		origins = append(origins, v)
		return nil
	})
	flags.Uint64Var(&cfg.MaxSessions, "max-sessions", cfg.MaxSessions, "maximum live sessions")
	flags.StringVar(&cfg.TLSCert, "tls-cert", "", "TLS certificate")
	flags.StringVar(&cfg.TLSKey, "tls-key", "", "TLS key")
	flags.BoolVar(&cfg.HTTP3, "http3", false, "enable HTTP/3 alongside HTTPS (requires TLS)")
	flags.StringVar(&cfg.Worker, "worker", "", "worker executable")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return cfg, true, nil
		}
		return Config{}, false, err
	}
	if flags.NArg() != 0 {
		return Config{}, false, fmt.Errorf("unexpected positional argument %q", flags.Arg(0))
	}
	var emptyOption string
	flags.Visit(func(f *flag.Flag) {
		if f.Name != "listen" && f.Name != "origin" && f.Value.String() == "" {
			emptyOption = f.Name
		}
	})
	if emptyOption != "" {
		return Config{}, false, fmt.Errorf("--%s requires a non-empty argument", emptyOption)
	}
	cli := cfg
	if err := loadConfig(&cfg, configPath); err != nil {
		return Config{}, false, err
	}
	flags.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "web-root":
			cfg.WebRoot = cli.WebRoot
		case "shell":
			cfg.Shell = cli.Shell
		case "term":
			cfg.Term = cli.Term
		case "kitty-graphics":
			cfg.KittyGraphics = cli.KittyGraphics
		case "auth":
			cfg.AuthEnabled = cli.AuthEnabled
		case "auth-file":
			cfg.AuthFile = cli.AuthFile
		case "auth-session-ttl":
			cfg.AuthSessionTTL = cli.AuthSessionTTL
		case "max-sessions":
			cfg.MaxSessions = cli.MaxSessions
		case "tls-cert":
			cfg.TLSCert = cli.TLSCert
		case "tls-key":
			cfg.TLSKey = cli.TLSKey
		case "http3":
			cfg.HTTP3 = cli.HTTP3
		case "worker":
			cfg.Worker = cli.Worker
		}
	})
	if len(listens) > 0 {
		cfg.Listen = listens
	}
	if len(origins) > 0 {
		cfg.Origin = origins[0]
		cfg.Origins = origins[1:]
	}
	// The bind port is the one --listen names, else the browser-facing port the
	// origins name, else the default.
	if len(cfg.Listen) > 0 {
		hosts, port, err := listenTargets(cfg.Listen)
		if err != nil {
			return Config{}, false, err
		}
		cfg.Listen = hosts
		if port >= 0 {
			cfg.Port = port
		}
	}
	if cfg.Port < 0 {
		port, ok, err := originPort(cfg.origins())
		if err != nil {
			return Config{}, false, err
		}
		if !ok {
			return Config{}, false, errors.New("no port: pass --listen HOST:PORT or an origin with a port")
		}
		cfg.Port = port
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return Config{}, false, fmt.Errorf("invalid port %d", cfg.Port)
	}
	if cfg.MaxSessions == 0 || cfg.MaxSessions > uint64(^uint32(0)) {
		return Config{}, false, fmt.Errorf("invalid max sessions %d", cfg.MaxSessions)
	}
	if cfg.Term == "" || len(cfg.Term) > 256 || strings.ContainsAny(cfg.Term, "\x00\r\n= \t") {
		return Config{}, false, fmt.Errorf("invalid term %q", cfg.Term)
	}
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return Config{}, false, errors.New("--tls-cert and --tls-key must be supplied together")
	}
	if cfg.HTTP3 && cfg.TLSCert == "" {
		return Config{}, false, errors.New("--http3 requires TLS")
	}
	if validateListeners {
		if err := validateBindings(cfg); err != nil {
			return Config{}, false, err
		}
	}
	if cfg.Shell == "" {
		cfg.Shell = os.Getenv("SHELL")
		if cfg.Shell == "" {
			cfg.Shell = "/bin/sh"
		}
	}
	if cfg.AuthSessionTTL < 0 {
		return Config{}, false, fmt.Errorf("invalid session lifetime %s", cfg.AuthSessionTTL)
	}
	if cfg.AuthFile == "" {
		cfg.AuthFile = defaultAuthFile()
	}
	return cfg, false, nil
}

// ValidateHost rejects malformed bind names before they reach DNS or the
// listener. Literal IPv4/IPv6 addresses and conventional DNS names are valid.
func ValidateHost(host string) error {
	if host == "" || len(host) > 253 || strings.TrimSpace(host) != host || strings.ContainsAny(host, "/\\\x00") {
		return fmt.Errorf("invalid host %q", host)
	}
	if ip := net.ParseIP(host); ip != nil {
		return nil
	}
	if strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") || strings.Contains(host, "..") {
		return fmt.Errorf("invalid host %q", host)
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("invalid host %q", host)
		}
		for _, r := range label {
			if !(r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
				return fmt.Errorf("invalid host %q", host)
			}
		}
	}
	return nil
}

// ValidateOrigin validates an exact browser Origin value. The origin is
// intentionally not normalized: the value received in the request must match
// Config.Origin byte-for-byte.
func ValidateOrigin(origin string, tlsEnabled bool) error {
	if origin == "" {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Opaque != "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("invalid origin %q", origin)
	}
	// Origin describes the browser-facing endpoint, not necessarily this listener.
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("origin scheme must be http or https")
	}
	if tlsEnabled && u.Scheme != "https" {
		return fmt.Errorf("origin scheme must be https")
	}
	if err := ValidateHost(u.Hostname()); err != nil {
		return fmt.Errorf("invalid origin host: %w", err)
	}
	if port := u.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return fmt.Errorf("invalid origin port %q", port)
		}
	}
	return nil
}

func HostIsLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func OriginFor(host string, port int, tlsEnabled bool) string {
	scheme := "http"
	if tlsEnabled {
		scheme = "https"
	}
	return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(port))
}

// splitListenTarget splits a HOST[:PORT] bind target, where HOST is a hostname,
// IP literal, or CIDR. IPv6 literals and ranges must be bracketed to carry a
// port. The port is -1 when the target names none.
func splitListenTarget(value string) (string, int, error) {
	if value == "" {
		return "", -1, errors.New("empty listen")
	}
	host, portText := value, ""
	switch {
	case strings.HasPrefix(value, "["):
		end := strings.LastIndex(value, "]")
		if end < 0 {
			return "", -1, fmt.Errorf("invalid listen %q", value)
		}
		host, portText = value[1:end], value[end+1:]
	case strings.Contains(value, "/"):
		if colon := strings.LastIndex(value, ":"); colon >= 0 {
			if _, err := strconv.Atoi(value[colon+1:]); err == nil {
				host, portText = value[:colon], value[colon:]
			}
		}
	case strings.Count(value, ":") == 1:
		before, after, _ := strings.Cut(value, ":")
		host, portText = before, ":"+after
	}
	if portText == "" {
		return host, -1, nil
	}
	if !strings.HasPrefix(portText, ":") {
		return "", -1, fmt.Errorf("invalid listen %q", value)
	}
	port, err := strconv.Atoi(portText[1:])
	if err != nil || port < 0 || port > 65535 {
		return "", -1, fmt.Errorf("invalid listen port in %q", value)
	}
	return host, port, nil
}

// listenTargets normalizes bind targets into bare hosts and the one port every
// target names.
func listenTargets(specs []string) ([]string, int, error) {
	hosts := make([]string, 0, len(specs))
	port := -1
	for _, spec := range specs {
		host, target, err := splitListenTarget(spec)
		if err != nil {
			return nil, -1, err
		}
		if host == "" {
			return nil, -1, fmt.Errorf("invalid listen %q", spec)
		}
		if target < 0 {
			return nil, -1, fmt.Errorf("listen %q needs a port, e.g. %s:8443", spec, spec)
		}
		if port >= 0 && port != target {
			return nil, -1, fmt.Errorf("--listen ports must agree (got %d and %d)", port, target)
		}
		port = target
		hosts = append(hosts, host)
	}
	return hosts, port, nil
}

// originPort returns the browser-facing port the origins agree on, falling back
// to the scheme default (443/80) when an origin omits it. It reports false when
// no origin is configured.
func originPort(origins []string) (int, bool, error) {
	if len(origins) == 0 {
		return 0, false, nil
	}
	port := 0
	for _, origin := range origins {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host == "" {
			return 0, false, fmt.Errorf("invalid origin %q", origin)
		}
		current := 80
		if parsed.Scheme == "https" {
			current = 443
		}
		if text := parsed.Port(); text != "" {
			current, err = strconv.Atoi(text)
			if err != nil {
				return 0, false, fmt.Errorf("invalid origin port %q", text)
			}
		}
		if port != 0 && port != current {
			return 0, false, fmt.Errorf("origins must share one port when --port is not set (got %d and %d)", port, current)
		}
		port = current
	}
	return port, true, nil
}

func Usage(program string) string {
	return fmt.Sprintf("usage: %s [options]\n"+
		"  --origin URL (repeatable; required for any non-loopback address; scheme://host[:port])\n"+
		"  --listen TARGET (optional, repeatable; overrides the bound address)\n"+
		"                  TARGET is HOST:PORT, IP:PORT, or CIDR:PORT\n"+
		"  --web-root DIR\n"+
		"  --shell SHELL\n"+
		"  --term TERM (default xterm-ghostty)\n"+
		"  --kitty-graphics[=false] (default true)\n"+
		"  --max-sessions N\n"+
		"  --tls-cert FILE\n"+
		"  --tls-key FILE\n"+
		"  --http3\n"+
		"  --worker FILE\n"+
		"  --auth[=false] (default true)\n"+
		"  --auth-file FILE (default $XDG_STATE_HOME/bcwebmux/auth.json)\n"+
		"  --auth-session-ttl DURATION (default 168h)\n"+
		"  --config FILE (otherwise XDG/HOME discovery)\n"+
		"\n"+
		"  %s auth totp [--rotate] [--no-qr] [--account LABEL] [options]\n"+
		"                                              enroll the authenticator app (baseline factor)\n"+
		"  %s auth list [options]                      list enrolled factors\n"+
		"  %s auth remove --totp|--id ID|--all [options]\n"+
		"                                              remove an enrolled factor\n",
		program, program, program, program)
}

// defaultAuthFile is the per-user authentication state file, following the
// XDG state directory so a restore or backup can treat it as machine state.
func defaultAuthFile() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			base = filepath.Join(home, ".local", "state")
		}
	}
	if base == "" {
		return ""
	}
	return filepath.Join(base, "bcwebmux", "auth.json")
}
