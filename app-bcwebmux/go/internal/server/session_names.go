// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"bcwebmux/go/internal/native"
)

type nameEntry struct {
	Instance   string `json:"instance"`
	ID         string `json:"id"`
	Generation string `json:"generation"`
	Name       string `json:"name"`
}

const namesVersion = 1

type namesDisk struct {
	Version int         `json:"version"`
	Names   []nameEntry `json:"names"`
}

type sessionNames struct {
	mu    sync.Mutex
	path  string
	state namesDisk
}

func newSessionNames(path string) (*sessionNames, error) {
	n := &sessionNames{state: namesDisk{Version: namesVersion}}
	if path == "" {
		return n, nil
	}
	n.path = path + ".names"
	f, err := os.Open(n.path)
	if os.IsNotExist(err) {
		return n, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, native.MaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > native.MaxResponseBytes {
		return nil, fmt.Errorf("session names file too large")
	}
	if err = json.Unmarshal(data, &n.state); err != nil {
		return nil, err
	}
	if n.state.Version != namesVersion {
		return nil, fmt.Errorf("unsupported session names file")
	}
	seen := make(map[[3]string]bool, len(n.state.Names))
	for _, e := range n.state.Names {
		key := [3]string{e.Instance, e.ID, e.Generation}
		if e.Instance == "" || e.ID == "" || e.Generation == "" || seen[key] {
			return nil, fmt.Errorf("invalid session name metadata")
		}
		seen[key] = true
	}
	return n, nil
}

func (n *sessionNames) replace(entries []nameEntry) error {
	state := namesDisk{Version: namesVersion, Names: entries}
	committed, err := writeMetadata(n.path, state)
	if committed {
		n.state = state
	}
	if err != nil {
		return fmt.Errorf("save session names: %w", err)
	}
	return nil
}

func (n *sessionNames) lookup(instance, id, generation string) (string, bool) {
	for _, e := range n.state.Names {
		if e.Instance == instance && e.ID == id && e.Generation == generation {
			return e.Name, true
		}
	}
	return "", false
}

func (n *sessionNames) set(entry nameEntry) error {
	entries := append([]nameEntry(nil), n.state.Names...)
	for i, e := range entries {
		if e.Instance == entry.Instance && e.ID == entry.ID && e.Generation == entry.Generation {
			if e.Name == entry.Name {
				return nil
			}
			entries[i] = entry
			return n.replace(entries)
		}
	}
	return n.replace(append(entries, entry))
}

func serverInstance(engine native.Engine) (string, error) {
	r, err := engine.REST(native.RESTRequest{Method: "GET", Target: "/api/server"})
	if err != nil {
		return "", err
	}
	var v struct {
		Instance string `json:"serverInstance"`
	}
	if r.Status != 200 || json.Unmarshal(r.Body, &v) != nil || v.Instance == "" {
		return "", fmt.Errorf("server instance unavailable")
	}
	return v.Instance, nil
}

func metadataFields(body []byte) (id, gen, name string, err error) {
	var v struct {
		ID         string `json:"id"`
		Generation string `json:"generation"`
		Name       string `json:"name"`
	}
	err = json.Unmarshal(body, &v)
	if err == nil && (v.ID == "" || v.Generation == "") {
		err = fmt.Errorf("invalid session metadata")
	}
	return v.ID, v.Generation, v.Name, err
}

func (n *sessionNames) overlay(body []byte, instance string, list bool) ([]byte, error) {
	change := func(raw json.RawMessage) (json.RawMessage, error) {
		id, gen, _, err := metadataFields(raw)
		if err != nil {
			return nil, err
		}
		var m map[string]json.RawMessage
		if err = json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
		name, _ := n.lookup(instance, id, gen)
		m["name"], _ = json.Marshal(name)
		return json.Marshal(m)
	}
	if !list {
		return change(body)
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, err
	}
	var items []json.RawMessage
	if err := json.Unmarshal(obj["sessions"], &items); err != nil {
		return nil, err
	}
	for i := range items {
		var err error
		items[i], err = change(items[i])
		if err != nil {
			return nil, err
		}
	}
	obj["sessions"], _ = json.Marshal(items)
	return json.Marshal(obj)
}

func (n *sessionNames) reconcile(instance string, body []byte) error {
	var list struct {
		Sessions *[]json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(body, &list); err != nil || list.Sessions == nil {
		return fmt.Errorf("invalid session list")
	}
	live := make(map[[2]string]bool, len(*list.Sessions))
	for _, raw := range *list.Sessions {
		id, gen, _, err := metadataFields(raw)
		if err != nil {
			return err
		}
		key := [2]string{id, gen}
		if live[key] {
			return fmt.Errorf("duplicate session identity")
		}
		live[key] = true
	}
	entries := make([]nameEntry, 0, len(n.state.Names))
	for _, e := range n.state.Names {
		if e.Instance != instance || live[[2]string{e.ID, e.Generation}] {
			entries = append(entries, e)
		}
	}
	if len(entries) == len(n.state.Names) {
		return nil
	}
	return n.replace(entries)
}
