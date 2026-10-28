// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const metadataVersion = 1

func lockMetadata(path string) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("metadata is already in use or cannot be locked: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

type layoutState struct {
	Version  int        `json:"version"`
	Revision uint64     `json:"revision"`
	Layout   [][]string `json:"layout"`
}

func readLayoutState(path string) (layoutState, error) {
	var state layoutState
	if path == "" {
		return state, nil
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxRequestBytes+1))
	if err != nil {
		return state, err
	}
	if len(data) > MaxRequestBytes {
		return state, fmt.Errorf("metadata file too large")
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if state.Version != metadataVersion || state.Revision == 0 || len(state.Layout) > 64 {
		return state, fmt.Errorf("invalid or unsupported metadata")
	}
	for _, group := range state.Layout {
		if len(group) == 0 || len(group) > 64 {
			return state, fmt.Errorf("invalid metadata layout")
		}
	}
	return state, nil
}

func writeLayoutState(path string, state layoutState) (bool, error) {
	data, err := json.Marshal(state)
	if err != nil {
		return false, err
	}
	if len(data) > MaxRequestBytes {
		return false, fmt.Errorf("metadata file too large")
	}
	return writeMetadata(path, state)
}

func writeMetadata(path string, state any) (bool, error) {
	data, err := json.Marshal(state)
	if err != nil {
		return false, err
	}
	if len(data) > 1024*1024 {
		return false, fmt.Errorf("metadata file too large")
	}
	if path == "" {
		return true, nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, err
	}
	f, err := os.CreateTemp(dir, ".metadata-*")
	if err != nil {
		return false, err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return false, err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return false, err
	}
	if err = f.Close(); err != nil {
		return false, err
	}
	if err = os.Rename(name, path); err != nil {
		return false, err
	}
	d, err := os.Open(dir)
	if err != nil {
		return true, err
	}
	err = d.Sync()
	if closeErr := d.Close(); err == nil {
		err = closeErr
	}
	return true, err
}
