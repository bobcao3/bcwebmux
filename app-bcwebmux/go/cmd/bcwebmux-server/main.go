package main

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"bcwebmux/go/internal/native"
	"bcwebmux/go/internal/server"
)

// zig build stages the generated web asset tree here.
// Keep the directory in the source tree so development and tests always have
// a valid embedded filesystem.
//
//go:embed web
var embeddedAssets embed.FS

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	slog.SetDefault(logger)
	if len(os.Args) > 1 && os.Args[1] == "auth" {
		if err := server.RunAuth(os.Args[0], os.Args[2:], logger); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", os.Args[0], err)
			os.Exit(1)
		}
		return
	}
	cfg, help, err := server.ParseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v (see %s --help)\n", os.Args[0], err, os.Args[0])
		os.Exit(2)
	}
	if help {
		fmt.Print(server.Usage(os.Args[0]))
		return
	}
	if cfg.Worker == "" {
		executable, err := os.Executable()
		if err != nil {
			executable = os.Args[0]
		}
		cfg.Worker = filepath.Join(filepath.Dir(executable), "bcwebmux-worker")
	}
	expectedOrigin := cfg.Origin
	if expectedOrigin == "" && cfg.Port != 0 &&
		server.HostIsLoopback(cfg.Host) {
		expectedOrigin = server.OriginFor(cfg.Host, cfg.Port, cfg.TLSCert != "")
	}
	engine, err := native.OpenEngine(native.EngineConfig{
		Shell:                cfg.Shell,
		Term:                 cfg.Term,
		DisableKittyGraphics: !cfg.KittyGraphics,
		Worker:               cfg.Worker,
		MaxSessions:          cfg.MaxSessions,
		ExpectedOrigin:       expectedOrigin,
	})
	if err != nil {
		logger.Error("native engine initialization failed", "error", err)
		os.Exit(1)
	}
	cfg.Engine = engine
	cfg.Logger = logger
	cfg.EmbeddedAssets = embeddedAssets
	instance, err := server.New(cfg)
	if err != nil {
		_ = engine.Close()
		logger.Error("server initialization failed", "error", err)
		os.Exit(1)
	}
	logger.Info("server listening", "addresses", instance.Addrs(), "origins", instance.Origins(), "http3", cfg.HTTP3)
	logger.Info("authentication", "state", instance.AuthStatus(), "file", cfg.AuthFile)
	for _, warning := range instance.AuthWarnings() {
		logger.Warn("authentication origin unusable", "detail", warning)
	}
	for _, warning := range instance.TLSWarnings() {
		logger.Warn("origin outside the certificate", "detail", warning)
	}
	if !cfg.AuthEnabled {
		logger.Warn("authentication is disabled; the terminal is reachable without a sign-in")
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- instance.Serve() }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	shutdown := func() error {
		ctx, cancel := context.WithTimeout(context.Background(), server.ShutdownTimeout)
		defer cancel()
		return instance.Shutdown(ctx)
	}
	select {
	case err := <-serveErr:
		if err != nil {
			logger.Error("server stopped", "error", err)
		}
		if err := shutdown(); err != nil {
			logger.Error("server shutdown failed", "error", err)
		}
	case sig := <-signals:
		logger.Info("shutdown signal received", "signal", sig.String())
		if err := shutdown(); err != nil {
			logger.Error("server shutdown failed", "error", err)
		}
		if err := <-serveErr; err != nil {
			logger.Error("server stopped", "error", err)
		}
	}
}
