// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"bcwebmux/go/internal/native"
)

func TestSessionNamesPersistenceAndReplay(t *testing.T) {
	name := ""
	exists := false
	metadata := func() []byte {
		b, _ := json.Marshal(map[string]any{"id": "one", "generation": "gen", "name": name, "revision": json.RawMessage("18446744073709551615")})
		return b
	}
	engine := &fakeEngine{response: func(r native.RESTRequest) native.RESTResponse {
		if r.Target == "/api/server" {
			return native.RESTResponse{Status: 200, Body: []byte(`{"serverInstance":"server"}`)}
		}
		if r.Target == "/api/sessions" && r.Method == "POST" {
			var b struct {
				Name string `json:"name"`
			}
			if err := json.Unmarshal(r.Body, &b); err != nil {
				t.Fatal(err)
			}
			if b.Name != "private" {
				t.Fatalf("daemon got user name %q", b.Name)
			}
			replayed := exists
			if !exists {
				name = b.Name
			}
			exists = true
			return native.RESTResponse{Status: 201, Location: "/api/sessions/one", Replayed: replayed, Body: metadata()}
		}
		if r.Target == "/api/sessions" && r.Method == "GET" {
			if !exists {
				return native.RESTResponse{Status: 200, Body: []byte(`{"sessions":[]}`)}
			}
			return native.RESTResponse{Status: 200, Body: append(append([]byte(`{"sessions":[`), metadata()...), []byte(`]}`)...)}
		}
		if r.Target == "/api/sessions/one" && r.Method == "GET" {
			return native.RESTResponse{Status: 200, Body: metadata()}
		}
		if r.Target == "/api/sessions/one" && r.Method == "PATCH" {
			if string(r.Body) != `{"name":"updated"}` {
				t.Fatalf("daemon got rename %s", r.Body)
			}
			name = "updated"
			return native.RESTResponse{Status: 200, Body: metadata()}
		}
		return native.RESTResponse{Status: 404}
	}}
	path := filepath.Join(t.TempDir(), "layout")
	names, err := newSessionNames(path)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{engine: engine, names: names}
	create := native.RESTRequest{Method: http.MethodPost, Target: "/api/sessions", Origin: "https://test", ContentType: "application/json", IdempotencyKey: "key", Body: []byte(`{"profile":"shell","name":"private"}`)}
	result, err := s.sessionNamesREST(create, create.Target)
	if err != nil || result.Status != 201 {
		t.Fatalf("create %d %v", result.Status, err)
	}
	assertName(t, result.Body, "private")
	if name != "private" {
		t.Fatalf("daemon got %q", name)
	}
	rename := native.RESTRequest{Method: http.MethodPatch, Target: "/api/sessions/one", Origin: create.Origin, ContentType: create.ContentType, IdempotencyKey: "rename", Body: []byte(`{"name":"updated"}`)}
	result, err = s.sessionNamesREST(rename, rename.Target)
	if err != nil || result.Status != 200 {
		t.Fatalf("rename %d %v", result.Status, err)
	}
	assertName(t, result.Body, "updated")
	names, err = newSessionNames(path)
	if err != nil {
		t.Fatal(err)
	}
	s.names = names
	result, err = s.sessionNamesREST(create, create.Target)
	if err != nil || result.Status != 201 || !result.Replayed {
		t.Fatalf("replay %d %v", result.Status, err)
	}
	assertName(t, result.Body, "updated")
	other, _ := newSessionNames(filepath.Join(t.TempDir(), "layout"))
	s.names = other
	result, err = s.sessionNamesREST(native.RESTRequest{Method: "GET", Target: "/api/sessions/one"}, "/api/sessions/one")
	if err != nil {
		t.Fatal(err)
	}
	assertName(t, result.Body, "")
}
func TestDeleteSucceedsWhenNameCleanupFails(t *testing.T) {
	n, err := newSessionNames(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	if err := n.set(nameEntry{"server", "one", "gen", "saved"}); err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{response: func(r native.RESTRequest) native.RESTResponse {
		switch r.Target {
		case "/api/server":
			return native.RESTResponse{Status: 200, Body: []byte(`{"serverInstance":"server"}`)}
		case "/api/sessions/one":
			return native.RESTResponse{Status: 204}
		default:
			return native.RESTResponse{Status: 500}
		}
	}}
	s := &Server{engine: engine, names: n}
	response, err := s.sessionNamesREST(native.RESTRequest{Method: http.MethodDelete, Target: "/api/sessions/one"}, "/api/sessions/one")
	if err != nil || response.Status != http.StatusNoContent {
		t.Fatalf("delete returned %d, %v", response.Status, err)
	}
}

func assertName(t *testing.T, body []byte, expected string) {
	t.Helper()
	var v struct {
		Name     string          `json:"name"`
		Revision json.RawMessage `json:"revision"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatal(err)
	}
	if v.Name != expected || string(v.Revision) != "18446744073709551615" {
		t.Fatalf("metadata %s", body)
	}
}
