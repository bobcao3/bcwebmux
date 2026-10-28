// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"bcwebmux/go/internal/native"
)

type sessionLayout struct {
	mu       sync.Mutex
	epoch    string
	revision uint64
	entries  [][]string
	changed  chan struct{}
	path     string
	unlock   func()
}

type layoutResponse struct {
	Epoch    string     `json:"epoch"`
	Revision uint64     `json:"revision"`
	Layout   [][]string `json:"layout"`
}

type layoutRequest struct {
	Source   string            `json:"source"`
	Target   string            `json:"target"`
	Position string            `json:"position"`
	Seed     []json.RawMessage `json:"seed"`
}

func newSessionLayout(path string) (*sessionLayout, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	unlock, err := lockMetadata(path)
	if err != nil {
		return nil, fmt.Errorf("lock session metadata %s: %w", path, err)
	}
	state, err := readLayoutState(path)
	if err != nil {
		unlock()
		return nil, fmt.Errorf("load session metadata %s: %w", path, err)
	}
	return &sessionLayout{epoch: hex.EncodeToString(id[:]), revision: state.Revision, entries: state.Layout, changed: make(chan struct{}), path: path, unlock: unlock}, nil
}

func (l *sessionLayout) snapshot() layoutResponse {
	entries := make([][]string, len(l.entries))
	for i, entry := range l.entries {
		entries[i] = append([]string(nil), entry...)
	}
	return layoutResponse{Epoch: l.epoch, Revision: l.revision, Layout: entries}
}

func (l *sessionLayout) publish(entries [][]string) error {
	if l.revision == math.MaxUint64 {
		return fmt.Errorf("session layout revision exhausted")
	}
	next := l.revision + 1
	committed, err := writeLayoutState(l.path, layoutState{Version: metadataVersion, Revision: next, Layout: entries})
	if !committed {
		return err
	}
	l.entries = entries
	l.revision = next
	close(l.changed)
	l.changed = make(chan struct{})
	return err
}

func (s *Server) layoutSessionIDs() ([]string, error) {
	response, err := s.engine.REST(native.RESTRequest{Method: http.MethodGet, Target: "/api/sessions"})
	if err != nil {
		return nil, err
	}
	var list struct {
		Sessions *[]struct {
			ID string `json:"id"`
		} `json:"sessions"`
	}
	if response.Status != http.StatusOK || json.Unmarshal(response.Body, &list) != nil || list.Sessions == nil || len(*list.Sessions) > 64 {
		return nil, io.ErrUnexpectedEOF
	}
	ids := make([]string, 0, len(*list.Sessions))
	seen := make(map[string]bool, len(*list.Sessions))
	for _, session := range *list.Sessions {
		if session.ID == "" || seen[session.ID] {
			return nil, io.ErrUnexpectedEOF
		}
		seen[session.ID] = true
		ids = append(ids, session.ID)
	}
	return ids, nil
}

func equalSessionLayout(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !slices.Equal(a[i], b[i]) {
			return false
		}
	}
	return true
}

func (s *Server) serveSessionLayout(w http.ResponseWriter, r *http.Request) {
	l := s.layout
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		l.mu.Lock()
		ids, err := s.layoutSessionIDs()
		if err != nil {
			l.mu.Unlock()
			writeJSONError(w, http.StatusInternalServerError, "internal", "session list unavailable")
			return
		}
		next := reconcileSessionLayout(l.entries, ids)
		if !equalSessionLayout(l.entries, next) {
			if err := l.publish(next); err != nil {
				l.mu.Unlock()
				writeJSONError(w, http.StatusInternalServerError, "internal", "session layout storage unavailable")
				return
			}
		}
		after, err := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		if err == nil && after == l.revision && r.URL.Query().Get("epoch") == l.epoch {
			changed := l.changed
			l.mu.Unlock()
			timer := time.NewTimer(20 * time.Second)
			defer timer.Stop()
			select {
			case <-changed:
			case <-timer.C:
			case <-r.Context().Done():
				return
			}
			l.mu.Lock()
			ids, err := s.layoutSessionIDs()
			if err != nil {
				l.mu.Unlock()
				writeJSONError(w, http.StatusInternalServerError, "internal", "session list unavailable")
				return
			}
			next := reconcileSessionLayout(l.entries, ids)
			if !equalSessionLayout(l.entries, next) {
				if err := l.publish(next); err != nil {
					l.mu.Unlock()
					writeJSONError(w, http.StatusInternalServerError, "internal", "session layout storage unavailable")
					return
				}
			}
		}
		result := l.snapshot()
		l.mu.Unlock()
		_ = json.NewEncoder(w).Encode(result)
		return
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.validOrigin(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "same-origin request required")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxRequestBytes))
	if err != nil {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
		return
	}
	var request layoutRequest
	if err := json.Unmarshal(body, &request); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_body", "invalid layout request")
		return
	}
	l.mu.Lock()
	ids, err := s.layoutSessionIDs()
	if err != nil {
		l.mu.Unlock()
		writeJSONError(w, http.StatusInternalServerError, "internal", "session list unavailable")
		return
	}
	var next [][]string
	if request.Seed != nil {
		if l.revision != 0 {
			result := l.snapshot()
			l.mu.Unlock()
			_ = json.NewEncoder(w).Encode(result)
			return
		}
		if len(request.Seed) > 64 {
			l.mu.Unlock()
			writeJSONError(w, http.StatusBadRequest, "invalid_layout", "invalid session layout")
			return
		}
		seed := make([][]string, 0, len(request.Seed))
		for _, value := range request.Seed {
			var members []string
			var single string
			if json.Unmarshal(value, &single) == nil {
				members = []string{single}
			} else if json.Unmarshal(value, &members) != nil || len(members) > 64 {
				l.mu.Unlock()
				writeJSONError(w, http.StatusBadRequest, "invalid_layout", "invalid session layout")
				return
			}
			seed = append(seed, members)
		}
		next = reconcileSessionLayout(seed, ids)
	} else {
		valid := map[string]bool{}
		for _, id := range ids {
			valid[id] = true
		}
		if !valid[request.Source] || !valid[request.Target] || request.Source == request.Target || (request.Position != "before" && request.Position != "after" && request.Position != "group" && request.Position != "outside-after") {
			l.mu.Unlock()
			writeJSONError(w, http.StatusConflict, "invalid_move", "sessions changed; try again")
			return
		}
		next = moveSessionLayout(reconcileSessionLayout(l.entries, ids), request.Source, request.Target, request.Position)
	}
	if err := l.publish(next); err != nil {
		l.mu.Unlock()
		writeJSONError(w, http.StatusInternalServerError, "internal", "session layout storage unavailable")
		return
	}
	result := l.snapshot()
	l.mu.Unlock()
	_ = json.NewEncoder(w).Encode(result)
}

func reconcileSessionLayout(entries [][]string, ids []string) [][]string {
	remaining := make(map[string]bool, len(ids))
	for _, id := range ids {
		remaining[id] = true
	}
	result := make([][]string, 0, len(ids))
	for _, entry := range entries {
		members := []string{}
		for _, id := range entry {
			if remaining[id] {
				members = append(members, id)
				delete(remaining, id)
			}
		}
		if len(members) > 0 {
			result = append(result, members)
		}
	}
	for _, id := range ids {
		if remaining[id] {
			result = append(result, []string{id})
			delete(remaining, id)
		}
	}
	return result
}

func moveSessionLayout(entries [][]string, source, target, position string) [][]string {
	sameGroup := false
	for i, entry := range entries {
		for j, id := range entry {
			if id != source {
				continue
			}
			if len(entry) > 2 {
				for _, member := range entry {
					if member == target {
						sameGroup = true
					}
				}
			}
			entry = append(entry[:j], entry[j+1:]...)
			if len(entry) == 0 {
				entries = append(entries[:i], entries[i+1:]...)
			} else {
				entries[i] = entry
			}
			goto removed
		}
	}
removed:
	for i, entry := range entries {
		for j, id := range entry {
			if id != target {
				continue
			}
			if position == "group" {
				entries[i] = append(entry, source)
				return entries
			}
			if len(entry) > 1 && (position == "before" || position == "after") && (sameGroup || (position == "before" && j > 0) || (position == "after" && j < len(entry)-1)) {
				if position == "after" {
					j++
				}
				entry = append(entry, "")
				copy(entry[j+1:], entry[j:])
				entry[j] = source
				entries[i] = entry
				return entries
			}
			if position == "after" || position == "outside-after" {
				i++
			}
			entries = append(entries, nil)
			copy(entries[i+1:], entries[i:])
			entries[i] = []string{source}
			return entries
		}
	}
	return entries
}
