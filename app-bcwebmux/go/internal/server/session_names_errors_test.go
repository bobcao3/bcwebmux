// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
package server

import (
	"bytes"
	"testing"

	"bcwebmux/go/internal/native"
)

func TestSessionErrorsPassThroughUnchanged(t *testing.T) {
	req := native.RESTRequest{Method: "POST", Target: "/api/sessions", Origin: "https://test", ContentType: "text/plain", IdempotencyKey: "original", Body: []byte("not-json")}
	want := native.RESTResponse{Status: 422, ContentType: "text/plain", Location: "/x", Body: []byte("daemon error\n")}
	engine := &fakeEngine{response: func(got native.RESTRequest) native.RESTResponse {
		if got.Method != req.Method || got.Target != req.Target || got.Origin != req.Origin || got.ContentType != req.ContentType || got.IdempotencyKey != req.IdempotencyKey || !bytes.Equal(got.Body, req.Body) {
			t.Fatalf("request changed: %+v", got)
		}
		return want
	}}
	n, _ := newSessionNames("")
	s := &Server{engine: engine, names: n}
	got, err := s.sessionNamesREST(req, req.Target)
	if err != nil || got.Status != want.Status || got.ContentType != want.ContentType || got.Location != want.Location || !bytes.Equal(got.Body, want.Body) {
		t.Fatalf("response changed: %+v %v", got, err)
	}
}
