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
	"strings"
	"sync"
	"time"

	"bcwebmux/go/internal/native"
)

type sessionLayout struct {
	mu       sync.Mutex
	epoch    string
	revision uint64
	entries  []layoutGroup
	changed  chan struct{}
	path     string
	unlock   func()
}

const maxGroupName = 80

// layoutGroup is a run of adjacent sessions. Unnamed groups keep the legacy
// JSON shape (an array of session IDs) so older clients can still read them;
// named groups serialize as {"name":...,"members":[...]}.
type layoutGroup struct {
	Name    string   `json:"name,omitempty"`
	Members []string `json:"members,omitempty"`
}

func (g layoutGroup) MarshalJSON() ([]byte, error) {
	if g.Name == "" {
		return json.Marshal(g.Members)
	}
	return json.Marshal(struct {
		Name    string   `json:"name"`
		Members []string `json:"members"`
	}{g.Name, g.Members})
}

func (g *layoutGroup) UnmarshalJSON(data []byte) error {
	var single string
	if err := json.Unmarshal(data, &single); err == nil {
		*g = layoutGroup{Members: []string{single}}
		return nil
	}
	var members []string
	if err := json.Unmarshal(data, &members); err == nil {
		*g = layoutGroup{Members: members}
		return nil
	}
	var group struct {
		Name    *string   `json:"name"`
		Members *[]string `json:"members"`
	}
	if err := json.Unmarshal(data, &group); err != nil || group.Members == nil {
		return fmt.Errorf("invalid session layout group")
	}
	g.Members = *group.Members
	if group.Name != nil {
		g.Name = *group.Name
	}
	return nil
}

func validLayoutGroup(g layoutGroup) bool {
	if len(g.Members) == 0 || len(g.Members) > 64 || len(g.Name) > maxGroupName {
		return false
	}
	for _, id := range g.Members {
		if id == "" {
			return false
		}
	}
	return true
}

type layoutResponse struct {
	Epoch    string        `json:"epoch"`
	Revision uint64        `json:"revision"`
	Layout   []layoutGroup `json:"layout"`
}

type layoutRequest struct {
	Source   string            `json:"source"`
	Target   string            `json:"target"`
	Position string            `json:"position"`
	Seed     []json.RawMessage `json:"seed"`
	Group    string            `json:"group"`
	Name     *string           `json:"name"`
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
	entries := make([]layoutGroup, len(l.entries))
	for i, entry := range l.entries {
		entries[i] = layoutGroup{Name: entry.Name, Members: append([]string(nil), entry.Members...)}
	}
	return layoutResponse{Epoch: l.epoch, Revision: l.revision, Layout: entries}
}

func (l *sessionLayout) publish(entries []layoutGroup) error {
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

func equalSessionLayout(a, b []layoutGroup) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name || !slices.Equal(a[i].Members, b[i].Members) {
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
	var next []layoutGroup
	if request.Group != "" {
		if request.Name == nil || request.Seed != nil || request.Source != "" || request.Target != "" || request.Position != "" {
			l.mu.Unlock()
			writeJSONError(w, http.StatusBadRequest, "invalid_body", "invalid layout request")
			return
		}
		name := strings.TrimSpace(*request.Name)
		if len(name) > maxGroupName {
			l.mu.Unlock()
			writeJSONError(w, http.StatusBadRequest, "invalid_layout", "invalid session layout")
			return
		}
		var renamed bool
		next, renamed = renameLayoutGroup(reconcileSessionLayout(l.entries, ids), request.Group, name)
		if !renamed {
			l.mu.Unlock()
			writeJSONError(w, http.StatusConflict, "invalid_group", "sessions changed; try again")
			return
		}
	} else if request.Seed != nil {
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
		seed := make([]layoutGroup, 0, len(request.Seed))
		for _, value := range request.Seed {
			var group layoutGroup
			if err := json.Unmarshal(value, &group); err != nil {
				l.mu.Unlock()
				writeJSONError(w, http.StatusBadRequest, "invalid_layout", "invalid session layout")
				return
			}
			group.Name = strings.TrimSpace(group.Name)
			if !validLayoutGroup(group) {
				l.mu.Unlock()
				writeJSONError(w, http.StatusBadRequest, "invalid_layout", "invalid session layout")
				return
			}
			seed = append(seed, group)
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

func reconcileSessionLayout(entries []layoutGroup, ids []string) []layoutGroup {
	remaining := make(map[string]bool, len(ids))
	for _, id := range ids {
		remaining[id] = true
	}
	result := make([]layoutGroup, 0, len(ids))
	for _, entry := range entries {
		members := []string{}
		for _, id := range entry.Members {
			if remaining[id] {
				members = append(members, id)
				delete(remaining, id)
			}
		}
		if len(members) == 1 {
			result = append(result, layoutGroup{Members: members})
		} else if len(members) > 1 {
			result = append(result, layoutGroup{Name: entry.Name, Members: members})
		}
	}
	for _, id := range ids {
		if remaining[id] {
			result = append(result, layoutGroup{Members: []string{id}})
			delete(remaining, id)
		}
	}
	return result
}

func renameLayoutGroup(entries []layoutGroup, anchor, name string) ([]layoutGroup, bool) {
	for i, entry := range entries {
		if len(entry.Members) < 2 || !slices.Contains(entry.Members, anchor) {
			continue
		}
		entries[i] = layoutGroup{Name: name, Members: append([]string(nil), entry.Members...)}
		return entries, true
	}
	return entries, false
}

func moveSessionLayout(entries []layoutGroup, source, target, position string) []layoutGroup {
	sameGroup := false
	for i, entry := range entries {
		for j, id := range entry.Members {
			if id != source {
				continue
			}
			if len(entry.Members) > 2 {
				for _, member := range entry.Members {
					if member == target {
						sameGroup = true
					}
				}
			}
			members := append([]string(nil), entry.Members[:j]...)
			members = append(members, entry.Members[j+1:]...)
			if len(members) == 0 {
				entries = append(entries[:i], entries[i+1:]...)
			} else if len(members) == 1 {
				entries[i] = layoutGroup{Members: members}
			} else {
				entries[i] = layoutGroup{Name: entry.Name, Members: members}
			}
			goto removed
		}
	}
removed:
	for i, entry := range entries {
		for j, id := range entry.Members {
			if id != target {
				continue
			}
			if position == "group" {
				if len(entry.Members) > 1 {
					entry.Members = append(entry.Members, source)
					entries[i] = entry
				} else {
					entries[i] = layoutGroup{Members: []string{entry.Members[0], source}}
				}
				return entries
			}
			if len(entry.Members) > 1 && (position == "before" || position == "after") && (sameGroup || (position == "before" && j > 0) || (position == "after" && j < len(entry.Members)-1)) {
				if position == "after" {
					j++
				}
				entry.Members = append(entry.Members, "")
				copy(entry.Members[j+1:], entry.Members[j:])
				entry.Members[j] = source
				entries[i] = entry
				return entries
			}
			if position == "after" || position == "outside-after" {
				i++
			}
			entries = append(entries, layoutGroup{})
			copy(entries[i+1:], entries[i:])
			entries[i] = layoutGroup{Members: []string{source}}
			return entries
		}
	}
	return entries
}
