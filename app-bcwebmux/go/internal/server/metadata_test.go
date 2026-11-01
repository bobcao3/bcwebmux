// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"bcwebmux/go/internal/native"
)

func metadataHTTP(t *testing.T, base, method, body string) (int, layoutResponse) {
	t.Helper()
	req, err := http.NewRequest(method, base+"/api/session-layout", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", base)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result layoutResponse
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, result
}

func TestMetadataRestartAndReconciliation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "metadata.json")
	var mu sync.Mutex
	sessions := `{"sessions":[{"id":"a"},{"id":"b"},{"id":"c"}]}`
	engine := func() *fakeEngine {
		return &fakeEngine{response: func(native.RESTRequest) native.RESTResponse {
			mu.Lock()
			defer mu.Unlock()
			return native.RESTResponse{Status: 200, Body: []byte(sessions)}
		}}
	}
	cfg := Config{Host: "127.0.0.1", Port: 0, Engine: engine(), MetadataFile: path}
	first, _ := startTestServer(t, cfg)
	status, seeded := metadataHTTP(t, first.Origin(), "POST", `{"seed":["c",["a","b"]]}`)
	if status != 200 || seeded.Revision != 1 {
		t.Fatalf("seed: %d %+v", status, seeded)
	}
	contender := cfg
	contender.Engine = engine()
	contender.EmbeddedAssets = testAssets()
	if other, err := New(contender); err == nil {
		_ = other.Shutdown(context.Background())
		t.Fatal("second frontend acquired the same metadata file")
	}
	mu.Lock()
	sessions = `{}`
	mu.Unlock()
	status, _ = metadataHTTP(t, first.Origin(), "GET", "")
	if status != http.StatusInternalServerError {
		t.Fatalf("malformed session list: %d", status)
	}
	mu.Lock()
	sessions = `{"sessions":[{"id":"a"},{"id":"b"},{"id":"c"}]}`
	mu.Unlock()
	status, intact := metadataHTTP(t, first.Origin(), "GET", "")
	if status != 200 || !reflect.DeepEqual(intact, seeded) {
		t.Fatalf("malformed list changed metadata: %d %+v", status, intact)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private metadata file: %v %v", info, err)
	}
	if err := first.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	sessions = `{"sessions":[{"id":"b"},{"id":"c"},{"id":"d"}]}`
	mu.Unlock()
	cfg.Engine = engine()
	second, _ := startTestServer(t, cfg)
	status, got := metadataHTTP(t, second.Origin(), "GET", "")
	want := []layoutGroup{{Members: []string{"c"}}, {Members: []string{"b"}}, {Members: []string{"d"}}}
	if status != 200 || !reflect.DeepEqual(got.Layout, want) || got.Revision != 2 || got.Epoch == seeded.Epoch {
		t.Fatalf("restart: %d %+v", status, got)
	}
	status, seededAgain := metadataHTTP(t, second.Origin(), "POST", `{"seed":["d","c","b"]}`)
	if status != 200 || !reflect.DeepEqual(seededAgain.Layout, want) || seededAgain.Revision != got.Revision {
		t.Fatalf("reseed: %d %+v", status, seededAgain)
	}
	if err := second.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	cfg.Engine = engine()
	third, _ := startTestServer(t, cfg)
	status, got = metadataHTTP(t, third.Origin(), "GET", "")
	if status != 200 || !reflect.DeepEqual(got.Layout, want) || got.Revision != 2 {
		t.Fatalf("persisted reconciliation: %d %+v", status, got)
	}
}

func TestMetadataWriteFailureAndConcurrentMoves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metadata.json")
	sessions := `{"sessions":[{"id":"a"},{"id":"b"},{"id":"c"}]}`
	engine := &fakeEngine{response: func(native.RESTRequest) native.RESTResponse {
		return native.RESTResponse{Status: 200, Body: []byte(sessions)}
	}}
	s, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0, Engine: engine, MetadataFile: path})
	base := s.Origin()
	status, before := metadataHTTP(t, base, "POST", `{"seed":["a","b","c"]}`)
	if status != 200 {
		t.Fatal(status)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	status, _ = metadataHTTP(t, base, "POST", `{"source":"a","target":"c","position":"group"}`)
	if status != 500 {
		t.Fatalf("failed write status %d", status)
	}
	status, after := metadataHTTP(t, base, "GET", "")
	if status != 200 || !reflect.DeepEqual(after, before) {
		t.Fatalf("failed write changed state: %+v", after)
	}
	engine.mu.Lock()
	sessions = `{"sessions":[{"id":"a"},{"id":"c"}]}`
	engine.mu.Unlock()
	status, _ = metadataHTTP(t, base, "GET", "")
	if status != http.StatusInternalServerError {
		t.Fatalf("failed reconciliation write status %d", status)
	}
	engine.mu.Lock()
	sessions = `{"sessions":[{"id":"a"},{"id":"b"},{"id":"c"}]}`
	engine.mu.Unlock()
	status, after = metadataHTTP(t, base, "GET", "")
	if status != 200 || !reflect.DeepEqual(after, before) {
		t.Fatalf("failed reconciliation changed state: %+v", after)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, saved, 0600); err != nil {
		t.Fatal(err)
	}
	const count = 12
	results := make(chan string, count)
	for i := 0; i < count; i++ {
		go func() {
			req, _ := http.NewRequest("POST", base+"/api/session-layout", bytes.NewBufferString(`{"source":"a","target":"c","position":"group"}`))
			req.Header.Set("Origin", base)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				results <- err.Error()
				return
			}
			defer resp.Body.Close()
			var out layoutResponse
			if resp.StatusCode != 200 {
				results <- fmt.Sprintf("status %d", resp.StatusCode)
				return
			}
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				results <- err.Error()
				return
			}
			results <- fmt.Sprint(out.Revision)
		}()
	}
	revisions := map[string]bool{}
	for i := 0; i < count; i++ {
		value := <-results
		if revisions[value] {
			t.Fatalf("duplicate revision %s", value)
		}
		revisions[value] = true
	}
	for i := 2; i <= count+1; i++ {
		if !revisions[fmt.Sprint(i)] {
			t.Fatalf("missing revision %d: %v", i, revisions)
		}
	}
	status, final := metadataHTTP(t, base, "GET", "")
	if status != 200 || final.Revision != count+1 {
		t.Fatalf("final: %+v", final)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var persisted layoutState
	if err := json.Unmarshal(data, &persisted); err != nil || persisted.Revision != final.Revision || !reflect.DeepEqual(persisted.Layout, final.Layout) {
		t.Fatalf("persisted: %+v %v", persisted, err)
	}
}

func TestMetadataGroupNamePersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metadata.json")
	engine := func() *fakeEngine {
		return &fakeEngine{response: func(native.RESTRequest) native.RESTResponse {
			return native.RESTResponse{Status: http.StatusOK, Body: []byte(`{"sessions":[{"id":"a"},{"id":"b"}]}`)}
		}}
	}
	cfg := Config{Host: "127.0.0.1", Port: 0, Engine: engine(), MetadataFile: path}
	first, _ := startTestServer(t, cfg)
	base := first.Origin()
	if status, _ := metadataHTTP(t, base, "POST", `{"seed":["a","b"]}`); status != 200 {
		t.Fatalf("seed status %d", status)
	}
	if status, _ := metadataHTTP(t, base, "POST", `{"source":"a","target":"b","position":"group"}`); status != 200 {
		t.Fatalf("group status %d", status)
	}
	status, named := metadataHTTP(t, base, "POST", `{"group":"b","name":"  Work  "}`)
	got, _ := json.Marshal(named.Layout)
	if status != 200 || string(got) != `[{"name":"Work","members":["b","a"]}]` {
		t.Fatalf("rename: %d %s", status, got)
	}
	if err := first.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	cfg.Engine = engine()
	second, _ := startTestServer(t, cfg)
	status, restored := metadataHTTP(t, second.Origin(), "GET", "")
	got, _ = json.Marshal(restored.Layout)
	if status != 200 || restored.Revision != named.Revision || string(got) != `[{"name":"Work","members":["b","a"]}]` {
		t.Fatalf("restart: %d %+v %s", status, restored, got)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var persisted layoutState
	if err := json.Unmarshal(data, &persisted); err != nil || persisted.Version != metadataVersion || !reflect.DeepEqual(persisted.Layout, restored.Layout) {
		t.Fatalf("persisted: %+v %v", persisted, err)
	}
}

func TestMetadataConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg, _, err := ParseConfig([]string{"--listen", "127.0.0.1:8080"})
	if err != nil || cfg.MetadataFile != filepath.Join(dir, "bcwebmux", "metadata.json") {
		t.Fatalf("default: %+v %v", cfg, err)
	}
	file := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(file, []byte("metadata-file = 'toml-state'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, _, err = ParseConfig([]string{"--listen", "127.0.0.1:8080", "--config", file})
	if err != nil || cfg.MetadataFile != "toml-state" {
		t.Fatalf("toml: %+v %v", cfg, err)
	}
	cfg, _, err = ParseConfig([]string{"--listen", "127.0.0.1:8080", "--config", file, "--metadata-file", "cli-state"})
	if err != nil || cfg.MetadataFile != "cli-state" {
		t.Fatalf("cli: %+v %v", cfg, err)
	}
}
