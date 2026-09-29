package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateFileServiceURL(t *testing.T) {
	valid := []string{
		"https://{host}:7443{path}?v",
		"https://files.example.com/files",
		"https://files.example.com/dav{path}?v",
		"http://127.0.0.1:3923",
		"https://box{path}",
		"https://box/{path}",
		"https://box:7443/?file={path}&v=1",
		"https://user:secret@box:7443{path}",
		"https://box/{path}#page=2",
	}
	for _, url := range valid {
		if err := validateFileServiceURL(url); err != nil {
			t.Errorf("validateFileServiceURL(%q) = %v", url, err)
		}
	}
	invalid := []string{
		"",
		"ftp://box/{path}",
		"box:7443{path}",
		"https://{path}evil.invalid/",
		"https://{path}.evil.invalid/",
		"https://{path}@evil.invalid/",
		"http://{path}",
		"https://box{path}{path}",
		"https://{host}{host}{path}",
		"https://box/{path}/{unknown}",
		"https://box/{pathname}",
		"https://box/{path}#{host}",
		"https://box\\evil/{path}",
		"https://box/{path}\n?v",
		"https://box/" + strings.Repeat("x", maxFileServiceURL),
	}
	for _, url := range invalid {
		if err := validateFileServiceURL(url); err == nil {
			t.Errorf("validateFileServiceURL(%q) accepted", url)
		}
	}
}

func TestValidateFileService(t *testing.T) {
	if err := validateFileService("", ""); err != nil {
		t.Fatalf("unconfigured: %v", err)
	}
	if err := validateFileService("https://box:7443{path}?v", "/"); err != nil {
		t.Fatalf("root prefix: %v", err)
	}
	if err := validateFileService("https://box:7443{path}?v", "/srv/files"); err != nil {
		t.Fatalf("nested prefix: %v", err)
	}
	for _, pair := range [][2]string{
		{"https://box", ""},
		{"", "/srv/files"},
		{"https://box", "srv/files"},
		{"https://box", "/srv/files/"},
		{"https://box", "/srv/../files"},
		{"https://box", "/srv\x00/files"},
		{"https://{path}evil.invalid/", "/"},
	} {
		if err := validateFileService(pair[0], pair[1]); err == nil {
			t.Errorf("validateFileService(%q, %q) accepted", pair[0], pair[1])
		}
	}
}

func TestFileServiceConfigSources(t *testing.T) {
	home, xdg := configHome(t)
	parse := func(args ...string) Config {
		t.Helper()
		config, help, err := ParseConfig(args)
		if err != nil || help {
			t.Fatalf("parse(%q): %v help=%v", args, err, help)
		}
		return config
	}
	const template = "https://{host}:7443{path}?v"

	if config := parse("--listen=127.0.0.1:8105", "--file-service-url="+template, "--file-service-prefix=/"); config.FileServiceURL != template || config.FileServicePrefix != "/" {
		t.Fatal(config)
	}
	// The CLI overrides the file, and a bad value is fatal either way.
	path := filepath.Join(xdg, "bcwebmux", "config.toml")
	putConfig(t, path, "listen = [\"127.0.0.1:8105\"]\nfile-service-url = 'https://files.example.com/dav{path}?v'\nfile-service-prefix = '/srv/files'\n")
	if config := parse(); config.FileServiceURL != "https://files.example.com/dav{path}?v" || config.FileServicePrefix != "/srv/files" {
		t.Fatal(config)
	}
	if config := parse("--listen=127.0.0.1:8105", "--file-service-url="+template, "--file-service-prefix=/"); config.FileServiceURL != template || config.FileServicePrefix != "/" {
		t.Fatal(config)
	}
	putConfig(t, filepath.Join(home, ".bcwebmux.toml"), "listen = [\"127.0.0.1:8106\"]\nfile-service-url = 'https://{path}evil.invalid/'\nfile-service-prefix = '/'\n")
	if _, _, err := ParseConfig([]string{"--config", filepath.Join(home, ".bcwebmux.toml")}); err == nil {
		t.Fatal("authority-absorbing template accepted")
	}
	putConfig(t, filepath.Join(home, ".bcwebmux.toml"), "listen = [\"127.0.0.1:8106\"]\nfile-service-url = 'https://box:7443{path}'\n")
	if _, _, err := ParseConfig([]string{"--config", filepath.Join(home, ".bcwebmux.toml")}); err == nil {
		t.Fatal("URL without a prefix accepted")
	}
	// /dev/null keeps the discovered files above out of these two runs.
	if _, _, err := ParseConfig([]string{"--config", "/dev/null", "--listen=127.0.0.1:8105", "--file-service-prefix=/srv"}); err == nil {
		t.Fatal("prefix without a URL accepted")
	}
	if _, _, err := ParseConfig([]string{"--config", "/dev/null", "--listen=127.0.0.1:8105", "--file-service-url="}); err == nil {
		t.Fatal("empty URL accepted")
	}
}

func TestClientConfigEndpoint(t *testing.T) {
	instance, _ := startTestServer(t, Config{
		Host:              "127.0.0.1",
		Port:              0,
		FileServiceURL:    "https://{host}:7443{path}?v",
		FileServicePrefix: "/",
	})
	client := &http.Client{Timeout: 2 * time.Second}
	base := "http://" + instance.Addr().String()

	response, err := client.Get(base + "/api/client-config")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("content type %q", contentType)
	}
	var payload struct {
		FileService fileServiceDefaults `json:"fileService"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.FileService.URL != "https://{host}:7443{path}?v" || payload.FileService.LocalPrefix != "/" {
		t.Fatal(payload)
	}
	// The endpoint is read-only and never proxied to the native core.
	request, err := http.NewRequest(http.MethodPost, base+"/api/client-config", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	posted, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer posted.Body.Close()
	if posted.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status %d", posted.StatusCode)
	}
}

func TestClientConfigWithoutFileService(t *testing.T) {
	engine := &fakeEngine{}
	instance, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0, Engine: engine})
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://" + instance.Addr().String() + "/api/client-config")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload) != 0 {
		t.Fatalf("unconfigured payload %v", payload)
	}
	if len(engine.requests) != 0 {
		t.Fatalf("native engine saw %v", engine.requests)
	}
}
