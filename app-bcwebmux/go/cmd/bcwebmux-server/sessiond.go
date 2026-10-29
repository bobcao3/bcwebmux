package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"bcwebmux/go/internal/native"
)

func connectSessionDaemon(socket string, logger *slog.Logger) (native.Engine, error) {
	engine, err := native.OpenRemoteEngine(socket)
	if err == nil {
		return engine, nil
	}
	if !errors.Is(err, syscall.ENOENT) && !errors.Is(err, syscall.ECONNREFUSED) {
		return nil, err
	}
	executable, pathErr := os.Executable()
	if pathErr != nil {
		return nil, fmt.Errorf("locate sibling session daemon: %w", pathErr)
	}
	binary := filepath.Join(filepath.Dir(executable), "bcwebmux-sessiond")
	if _, statErr := os.Stat(binary); statErr != nil {
		return nil, fmt.Errorf("%w; cannot autostart %s: %v", err, binary, statErr)
	}
	if mkdirErr := os.Mkdir(filepath.Dir(socket), 0700); mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
		return nil, fmt.Errorf("create session socket directory: %w", mkdirErr)
	}
	cmd := exec.Command(binary, "--socket", socket)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("autostart %s: %w", binary, err)
	}
	// Nil standard streams use /dev/null, so the daemon owns no frontend pipes.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	var exitErr error
	for {
		engine, err = native.OpenRemoteEngine(socket)
		if err == nil {
			logger.Info("session daemon available after autostart", "binary", binary, "socket", socket, "spawned_pid", cmd.Process.Pid)
			return engine, nil
		}
		select {
		case exitErr = <-exited:
			// Another frontend may have won the daemon's exclusive socket lock.
			exited = nil
		case <-tick.C:
		case <-deadline.C:
			if exited != nil {
				_ = cmd.Process.Kill()
				exitErr = <-exited
			}
			return nil, fmt.Errorf("autostart %s did not make %s available: %w (daemon exit: %v)", binary, socket, err, exitErr)
		}
	}
}
