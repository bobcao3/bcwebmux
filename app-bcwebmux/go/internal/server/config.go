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
	"strconv"
	"strings"
	"time"

	"bcwebmux/go/internal/native"
)

const (
	DefaultHost        = "127.0.0.1"
	DefaultPort        = 8080
	DefaultMaxSessions = 16
	MaxRequestBytes    = native.MaxRequestBytes
	MaxHeaderBytes     = 16 * 1024
	MaxAssetBytes      = 16 * 1024 * 1024
	ShutdownTimeout    = 5 * time.Second
)

// Config contains transport and native-engine configuration. EmbeddedAssets
// must contain a top-level web directory (as produced by //go:embed web).
type Config struct {
	Listen         []string
	Origins        []string
	Host           string
	Port           int
	WebRoot        string
	Shell          string
	Term           string
	KittyGraphics  bool
	Origin         string
	MaxSessions    uint64
	TLSCert        string
	TLSKey         string
	HTTP3          bool
	Worker         string
	EmbeddedAssets fs.FS
	Engine         native.Engine
	Logger         *slog.Logger
}

// ParseConfig parses the server's stable command-line interface. It does not
// bind a socket or start the native engine.
func ParseConfig(args []string) (Config, bool, error) {
	cfg := Config{Port: DefaultPort, MaxSessions: DefaultMaxSessions, Term: "xterm-ghostty", KittyGraphics: true}
	flags := flag.NewFlagSet("bcwebmux-server", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.Host, "host", cfg.Host, "bind host")
	flags.IntVar(&cfg.Port, "port", cfg.Port, "bind port")
	flags.StringVar(&cfg.WebRoot, "web-root", "", "asset directory")
	flags.StringVar(&cfg.Shell, "shell", "", "shell")
	flags.StringVar(&cfg.Term, "term", cfg.Term, "TERM for session shells")
	flags.BoolVar(&cfg.KittyGraphics, "kitty-graphics", cfg.KittyGraphics, "advertise Kitty graphics to session shells")
	var origins, listens []string
	var configPath string
	flags.StringVar(&configPath, "config", "", "TOML config file")
	flags.Func("listen", "repeatable bind host/IP/CIDR", func(v string) error {
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
		case "host":
			cfg.Host = cli.Host
			cfg.Listen = nil
		case "port":
			cfg.Port = cli.Port
		case "web-root":
			cfg.WebRoot = cli.WebRoot
		case "shell":
			cfg.Shell = cli.Shell
		case "term":
			cfg.Term = cli.Term
		case "kitty-graphics":
			cfg.KittyGraphics = cli.KittyGraphics
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
	if err := validateBindings(cfg); err != nil {
		return Config{}, false, err
	}
	if cfg.Shell == "" {
		cfg.Shell = os.Getenv("SHELL")
		if cfg.Shell == "" {
			cfg.Shell = "/bin/sh"
		}
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

func Usage(program string) string {
	return fmt.Sprintf("usage: %s [options]\n  --config FILE (otherwise XDG/HOME discovery)\n  --listen HOST/IP/CIDR (repeatable; defaults to origin hostnames when host/listen omitted)\n  --host HOST (legacy single listener)\n  --port PORT\n  --web-root DIR\n  --shell SHELL\n  --term TERM (default xterm-ghostty)\n  --kitty-graphics[=false] (advertise Kitty graphics; default true)\n  --origin ORIGIN (repeatable exact allowlist)\n  --max-sessions N\n  --tls-cert FILE\n  --tls-key FILE\n  --http3\n  --worker FILE\n", program)
}
