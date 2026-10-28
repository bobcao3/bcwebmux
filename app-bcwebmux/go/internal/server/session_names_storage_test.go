// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
package server

import (
	"os"
	"path/filepath"
	"testing"

	"bcwebmux/go/internal/native"
)

func TestSessionNameSaveFailurePreservesMemory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state")
	n, err := newSessionNames(path)
	if err != nil {
		t.Fatal(err)
	}
	old := nameEntry{"server", "one", "gen", "old"}
	if err = n.set(old); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(path + ".names"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path+".names", 0700); err != nil {
		t.Fatal(err)
	}
	e := &fakeEngine{response: func(r native.RESTRequest) native.RESTResponse {
		if r.Target == "/api/server" {
			return native.RESTResponse{Status: 200, Body: []byte(`{"serverInstance":"server"}`)}
		}
		return native.RESTResponse{Status: 200, Body: []byte(`{"id":"one","generation":"gen","name":"new","revision":18446744073709551615}`)}
	}}
	s := &Server{engine: e, names: n}
	req := native.RESTRequest{Method: "PATCH", Target: "/api/sessions/one", Body: []byte(`{"name":"new"}`)}
	if _, err = s.sessionNamesREST(req, req.Target); err == nil {
		t.Fatal("expected storage failure")
	}
	got, ok := n.lookup("server", "one", "gen")
	if !ok || got != "old" {
		t.Fatalf("changed authoritative name: %q", got)
	}
	if err = os.Remove(path + ".names"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.sessionNamesREST(req, req.Target); err != nil {
		t.Fatal(err)
	}
	reloaded, err := newSessionNames(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := reloaded.lookup("server", "one", "gen"); got != "new" {
		t.Fatalf("retry not saved: %q", got)
	}
}

func TestSessionNameReconcileFailurePreservesMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state")
	n, err := newSessionNames(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = n.set(nameEntry{"server", "one", "gen", "old"}); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(path + ".names"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path+".names", 0700); err != nil {
		t.Fatal(err)
	}
	if err = n.reconcile("server", []byte(`{"sessions":[]}`)); err == nil {
		t.Fatal("expected storage failure")
	}
	if got, ok := n.lookup("server", "one", "gen"); !ok || got != "old" {
		t.Fatalf("cleanup corrupted name: %q", got)
	}
}
