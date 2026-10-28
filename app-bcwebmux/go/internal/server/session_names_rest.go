// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"bcwebmux/go/internal/native"
)

func (s *Server) sessionNamesREST(req native.RESTRequest, path string) (native.RESTResponse, error) {
	n := s.names
	n.mu.Lock()
	defer n.mu.Unlock()

	response, err := s.engine.REST(req)
	if err != nil || response.Status < 200 || response.Status >= 300 {
		return response, err
	}
	list := path == "/api/sessions" && req.Method == http.MethodGet && response.Status == http.StatusOK
	create := path == "/api/sessions" && req.Method == http.MethodPost && response.Status == http.StatusCreated
	suffix := strings.TrimPrefix(path, "/api/sessions/")
	single := strings.HasPrefix(path, "/api/sessions/") && !strings.Contains(suffix, "/")
	rename := single && req.Method == http.MethodPatch && response.Status == http.StatusOK
	get := single && req.Method == http.MethodGet && response.Status == http.StatusOK
	terminate := req.Method == http.MethodPost && strings.HasSuffix(path, "/terminate") && response.Status == http.StatusAccepted
	deleted := single && req.Method == http.MethodDelete && response.Status == http.StatusNoContent
	if !list && !create && !rename && !get && !terminate && !deleted {
		return response, nil
	}
	instance, err := serverInstance(s.engine)
	if err != nil {
		if deleted {
			if s.logger != nil {
				s.logger.Error("session name cleanup failed", "error", err)
			}
			return response, nil
		}
		return native.RESTResponse{}, err
	}
	if create || rename {
		id, gen, _, err := metadataFields(response.Body)
		if err != nil {
			return native.RESTResponse{}, err
		}
		_, exists := n.lookup(instance, id, gen)
		if rename || !exists {
			var input struct {
				Name *string `json:"name"`
			}
			if err := json.Unmarshal(req.Body, &input); err != nil {
				return native.RESTResponse{}, fmt.Errorf("read accepted name: %w", err)
			}
			name := ""
			if input.Name != nil {
				name = *input.Name
			}
			if err := n.set(nameEntry{instance, id, gen, name}); err != nil {
				return native.RESTResponse{}, err
			}
		}
	}
	if list {
		if err := n.reconcile(instance, response.Body); err != nil {
			return native.RESTResponse{}, err
		}
	}
	if deleted && len(n.state.Names) > 0 {
		current, err := s.engine.REST(native.RESTRequest{Method: http.MethodGet, Target: "/api/sessions"})
		if err == nil && current.Status == http.StatusOK {
			err = n.reconcile(instance, current.Body)
		} else if err == nil {
			err = fmt.Errorf("cannot inspect sessions: status %d", current.Status)
		}
		if err != nil && s.logger != nil {
			s.logger.Error("session name cleanup failed", "error", err)
		}
	}
	if !deleted {
		response.Body, err = n.overlay(response.Body, instance, list)
	}
	return response, err
}
