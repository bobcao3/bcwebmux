// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
)

func TestSessionLayoutAcrossClients(t *testing.T) {
	sessions := `{"sessions":[{"id":"a"},{"id":"b"},{"id":"c"}]}`
	engine := &fakeEngine{response: func(request native.RESTRequest) native.RESTResponse {
		return native.RESTResponse{Status: http.StatusOK, Body: []byte(sessions)}
	}}
	s, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0, Engine: engine})
	base := s.Origin()
	client := &http.Client{Timeout: 5 * time.Second}
	get := func(path string) layoutResponse {
		t.Helper()
		response, err := client.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result layoutResponse
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET status: %d", response.StatusCode)
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	post := func(body, origin string) (int, layoutResponse) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodPost, base+"/api/session-layout", bytes.NewBufferString(body))
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		var result layoutResponse
		if response.StatusCode == http.StatusOK {
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatal(err)
			}
		}
		return response.StatusCode, result
	}
	status, seeded := post(`{"seed":["c",["a","b"]]}`, base)
	if status != 200 || seeded.Revision != 1 || seeded.Epoch == "" {
		t.Fatalf("seed: %d %+v", status, seeded)
	}
	first := get("/api/session-layout")
	if first.Revision != seeded.Revision {
		t.Fatalf("initial: %+v", first)
	}
	status, unchanged := post(`{"seed":["a","b","c"]}`, base)
	if status != 200 || unchanged.Revision != seeded.Revision {
		t.Fatalf("second seed overwrote layout: %+v", unchanged)
	}
	type waitResult struct {
		value layoutResponse
		err   error
	}
	waiting := make(chan waitResult, 1)
	go func() {
		response, err := client.Get(base + "/api/session-layout?after=1&epoch=" + seeded.Epoch)
		if err != nil {
			waiting <- waitResult{err: err}
			return
		}
		defer response.Body.Close()
		var value layoutResponse
		err = json.NewDecoder(response.Body).Decode(&value)
		waiting <- waitResult{value, err}
	}()
	status, moved := post(`{"source":"a","target":"c","position":"before"}`, base)
	if status != 200 || moved.Revision != 2 {
		t.Fatalf("move: %d %+v", status, moved)
	}
	var observed layoutResponse
	select {
	case result := <-waiting:
		if result.err != nil {
			t.Fatal(result.err)
		}
		observed = result.value
	case <-time.After(3 * time.Second):
		t.Fatal("other client was not notified")
	}
	want := `[["a"],["c"],["b"]]`
	got, _ := json.Marshal(observed.Layout)
	if string(got) != want {
		t.Fatalf("layout = %s, want %s", got, want)
	}
	status, _ = post(`{"source":"a","target":"b","position":"group"}`, "https://elsewhere.invalid")
	if status != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d", status)
	}
	status, _ = post(`{"source":"missing","target":"b","position":"group"}`, base)
	if status != http.StatusConflict {
		t.Fatalf("missing session status = %d", status)
	}
	status, grouped := post(`{"source":"a","target":"b","position":"group"}`, base)
	got, _ = json.Marshal(grouped.Layout)
	if status != 200 || string(got) != `[["c"],["b","a"]]` {
		t.Fatalf("group: %d %s", status, got)
	}
	engine.mu.Lock()
	sessions = `{"sessions":[{"id":"b"},{"id":"c"},{"id":"d"}]}`
	engine.mu.Unlock()
	reconciled := get("/api/session-layout")
	got, _ = json.Marshal(reconciled.Layout)
	if reconciled.Revision != grouped.Revision+1 || string(got) != `[["c"],["b"],["d"]]` {
		t.Fatalf("session changes: %+v %s", reconciled, got)
	}
}

func TestSessionLayoutDefaultOrder(t *testing.T) {
	engine := &fakeEngine{response: func(native.RESTRequest) native.RESTResponse {
		return native.RESTResponse{Status: http.StatusOK, Body: []byte(`{"sessions":[{"id":"c"},{"id":"a"},{"id":"b"}]}`)}
	}}
	s, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0, Engine: engine})
	response, err := http.Get(s.Origin() + "/api/session-layout")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var layout layoutResponse
	if err := json.NewDecoder(response.Body).Decode(&layout); err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(layout.Layout)
	if response.StatusCode != http.StatusOK || layout.Revision != 1 || string(got) != `[["c"],["a"],["b"]]` {
		t.Fatalf("default layout: %d %+v %s", response.StatusCode, layout, got)
	}
}
