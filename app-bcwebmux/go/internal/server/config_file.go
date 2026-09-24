package server

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// loadConfig reads exactly one file; discovery never masks an unreadable file.
func loadConfig(cfg *Config, explicit string) error {
	paths := []string{explicit}
	if explicit == "" {
		paths = nil
		home := os.Getenv("HOME")
		base, standard := os.LookupEnv("XDG_CONFIG_HOME")
		if !standard {
			base = os.Getenv("XDG_HOME")
		}
		if base == "" && home != "" {
			base = filepath.Join(home, ".config")
		}
		if base != "" {
			paths = append(paths, filepath.Join(base, "bcwebmux", "config.toml"))
		}
		if home != "" {
			paths = append(paths, filepath.Join(home, ".bcwebmux.toml"))
		}
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) && explicit == "" {
			continue
		}
		if err != nil {
			return fmt.Errorf("config %s: %w", path, err)
		}
		var file struct {
			Host           *string  `toml:"host"`
			Listen         []string `toml:"listen"`
			Port           *int     `toml:"port"`
			WebRoot        *string  `toml:"web-root"`
			Shell          *string  `toml:"shell"`
			Term           *string  `toml:"term"`
			KittyGraphics  *bool    `toml:"kitty-graphics"`
			Origin         *string  `toml:"origin"`
			Origins        []string `toml:"origins"`
			MaxSessions    *uint64  `toml:"max-sessions"`
			TLSCert        *string  `toml:"tls-cert"`
			TLSKey         *string  `toml:"tls-key"`
			HTTP3          *bool    `toml:"http3"`
			Worker         *string  `toml:"worker"`
			Auth           *bool    `toml:"auth"`
			AuthFile       *string  `toml:"auth-file"`
			AuthSessionTTL *string  `toml:"auth-session-ttl"`
		}
		meta, err := toml.Decode(string(data), &file)
		if err != nil {
			return fmt.Errorf("config %s: %w", path, err)
		}
		if unknown := meta.Undecoded(); len(unknown) != 0 {
			return fmt.Errorf("config %s: unknown keys %v", path, unknown)
		}
		if file.Host != nil {
			if err := ValidateHost(*file.Host); err != nil {
				return fmt.Errorf("config %s: %w", path, err)
			}
			cfg.Host = *file.Host
		}
		if file.Listen != nil {
			if len(file.Listen) == 0 {
				return fmt.Errorf("config %s: listen must not be empty", path)
			}
			cfg.Listen = file.Listen
		}
		if file.Port != nil {
			cfg.Port = *file.Port
		}
		if file.WebRoot != nil {
			cfg.WebRoot = *file.WebRoot
		}
		if file.Shell != nil {
			cfg.Shell = *file.Shell
		}
		if file.Term != nil {
			cfg.Term = *file.Term
		}
		if file.KittyGraphics != nil {
			cfg.KittyGraphics = *file.KittyGraphics
		}
		if file.Origin != nil {
			cfg.Origin = *file.Origin
		}
		cfg.Origins = file.Origins
		if file.MaxSessions != nil {
			cfg.MaxSessions = *file.MaxSessions
		}
		if file.TLSCert != nil {
			cfg.TLSCert = *file.TLSCert
		}
		if file.TLSKey != nil {
			cfg.TLSKey = *file.TLSKey
		}
		if file.HTTP3 != nil {
			cfg.HTTP3 = *file.HTTP3
		}
		if file.Worker != nil {
			cfg.Worker = *file.Worker
		}
		if file.Auth != nil {
			cfg.AuthEnabled = *file.Auth
		}
		if file.AuthFile != nil {
			if *file.AuthFile == "" {
				return fmt.Errorf("config %s: auth-file must not be empty", path)
			}
			cfg.AuthFile = *file.AuthFile
		}
		if file.AuthSessionTTL != nil {
			ttl, err := time.ParseDuration(*file.AuthSessionTTL)
			if err != nil || ttl < 0 {
				return fmt.Errorf("config %s: invalid auth-session-ttl %q", path, *file.AuthSessionTTL)
			}
			cfg.AuthSessionTTL = ttl
		}
		return nil
	}
	return nil
}

func (cfg Config) origins() []string {
	result := append([]string(nil), cfg.Origins...)
	if cfg.Origin != "" {
		result = append([]string{cfg.Origin}, result...)
	}
	return result
}

func (cfg Config) listenSpecs() []string {
	if len(cfg.Listen) > 0 {
		return cfg.Listen
	}
	if cfg.Host != "" {
		return []string{cfg.Host}
	}
	seen := map[string]bool{}
	var result []string
	for _, origin := range cfg.origins() {
		parsed, err := url.Parse(origin)
		if err != nil {
			continue
		}
		host := parsed.Hostname()
		if host != "" && !seen[host] {
			seen[host] = true
			result = append(result, host)
		}
	}
	if len(result) == 0 {
		return []string{DefaultHost}
	}
	return result
}

func (cfg Config) resolveListeners() ([]string, error) {
	if len(cfg.Listen) > 0 || cfg.Host != "" || len(cfg.origins()) == 0 {
		result, err := resolveListeners(cfg.listenSpecs())
		if err != nil {
			return nil, err
		}
		return result, nil
	}
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	assigned := map[string]bool{}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && !ip.IsUnspecified() {
			assigned[ip.String()] = true
		}
	}
	var result []string
	seen := map[string]bool{}
	for _, spec := range cfg.listenSpecs() {
		resolved, err := resolveListeners([]string{spec})
		if err != nil {
			return nil, err
		}
		matched := false
		for _, address := range resolved {
			ip := net.ParseIP(address)
			if ip == nil || ip.IsUnspecified() || !assigned[ip.String()] {
				continue
			}
			matched = true
			if !seen[ip.String()] {
				seen[ip.String()] = true
				result = append(result, ip.String())
			}
		}
		if !matched {
			return nil, fmt.Errorf("listen host %q has no assigned local address", spec)
		}
	}
	return result, nil
}

func validateBindings(cfg Config) error {
	for _, origin := range cfg.origins() {
		if origin == "" {
			return fmt.Errorf("origin must not be empty")
		}
		if err := ValidateOrigin(origin, cfg.TLSCert != ""); err != nil {
			return err
		}
	}
	for _, host := range cfg.listenSpecs() {
		loopback := HostIsLoopback(host)
		if strings.Contains(host, "/") {
			ip, network, err := net.ParseCIDR(host)
			if err != nil {
				return fmt.Errorf("invalid listen range %q: %w", host, err)
			}
			ones, bits := network.Mask.Size()
			loopback = ip.IsLoopback() && ((bits == 32 && ones >= 8) || (bits == 128 && ones == 128))
		} else if err := ValidateHost(host); err != nil {
			return err
		}
		if !loopback && len(cfg.origins()) == 0 {
			return fmt.Errorf("--origin is required when binding a non-loopback host or range")
		}
	}
	return nil
}

// resolveListeners takes a startup snapshot. Ranges never become wildcard binds.
func resolveListeners(specs []string) ([]string, error) {
	var result []string
	var addresses []net.Addr
	seen := map[string]bool{}
	add := func(host string) {
		if !seen[host] {
			seen[host] = true
			result = append(result, host)
		}
	}
	for _, spec := range specs {
		if strings.Contains(spec, "/") {
			_, network, err := net.ParseCIDR(spec)
			if err != nil {
				return nil, err
			}
			if addresses == nil {
				addresses, err = net.InterfaceAddrs()
				if err != nil {
					return nil, err
				}
			}
			matched := false
			for _, address := range addresses {
				ip, _, err := net.ParseCIDR(address.String())
				if err == nil && network.Contains(ip) {
					add(ip.String())
					matched = true
				}
			}
			if !matched {
				return nil, fmt.Errorf("listen range %q matches no assigned local addresses", spec)
			}
		} else if ip := net.ParseIP(spec); ip != nil {
			add(ip.String())
		} else {
			addresses, err := net.LookupHost(spec)
			if err != nil {
				return nil, fmt.Errorf("listen host %q: %w", spec, err)
			}
			for _, address := range addresses {
				add(address)
			}
		}
	}
	return result, nil
}
