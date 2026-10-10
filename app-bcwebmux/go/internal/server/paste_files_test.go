package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPasteFileUpload(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	instance, _ := startTestServer(t, Config{Host: "127.0.0.1", Port: 0})
	base := "http://" + instance.Addr().String() + "/api/paste-files"
	client := &http.Client{}
	prepare := func(contentType string) (string, string) {
		t.Helper()
		response, err := client.Get(base + "?type=" + contentType)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var payload struct {
			Name string `json:"name"`
			Path string `json:"path"`
		}
		if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&payload) != nil {
			t.Fatalf("prepare failed: %d", response.StatusCode)
		}
		if _, err := os.Stat(payload.Path); !os.IsNotExist(err) {
			t.Fatalf("preview created a file: %v", err)
		}
		return payload.Name, payload.Path
	}
	upload := func(name, origin string, body io.Reader) *http.Response {
		t.Helper()
		request, err := http.NewRequest(http.MethodPost, base+"?name="+name, body)
		if err != nil {
			t.Fatal(err)
		}
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { response.Body.Close() })
		return response
	}
	for _, variant := range []struct {
		mime, extension string
		content         []byte
	}{
		{"image/png", ".png", []byte("\x89PNG\r\n\x1a\n\x00\x01\xfe\xff")},
		{"image/jpeg", ".jpg", []byte("\xff\xd8\xff\xe0\x00\x10binary\x00")},
		{"application/octet-stream", ".bin", []byte("attachment\x00\xff")},
	} {
		name, path := prepare(variant.mime)
		if filepath.Ext(path) != variant.extension || filepath.Dir(path) != os.TempDir() {
			t.Fatalf("unexpected path %q", path)
		}
		response := upload(name, instance.Origin(), bytes.NewReader(variant.content))
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("upload status %d", response.StatusCode)
		}
		var result struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil || result.Path != path {
			t.Fatalf("upload changed the preview path: %q, %v", result.Path, err)
		}
		content, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(content, variant.content) {
			t.Fatalf("file content %x: %v", content, err)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("file permissions: %v, %v", info, err)
		}
		if response := upload(name, instance.Origin(), strings.NewReader("replacement")); response.StatusCode != http.StatusConflict {
			t.Fatalf("overwrite status %d", response.StatusCode)
		}
		content, _ = os.ReadFile(path)
		if !bytes.Equal(content, variant.content) {
			t.Fatal("duplicate upload overwrote the file")
		}
	}
	name, path := prepare("image/png")
	for _, origin := range []string{"", "http://evil.invalid"} {
		if response := upload(name, origin, strings.NewReader("denied")); response.StatusCode != http.StatusForbidden {
			t.Fatalf("origin %q status %d", origin, response.StatusCode)
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("rejected request created a file")
	}
	if response := upload("../escaped.png", instance.Origin(), strings.NewReader("denied")); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("traversal status %d", response.StatusCode)
	}
	if response := upload(name, instance.Origin(), strings.NewReader("")); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty upload status %d", response.StatusCode)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("empty upload left a file")
	}
	// The reader forces an unknown Content-Length so the streaming limit must reject the upload.
	body := struct{ io.Reader }{bytes.NewReader(bytes.Repeat([]byte{0xff}, maxPasteFileBytes+1))}
	if response := upload(name, instance.Origin(), body); response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized streaming upload status %d", response.StatusCode)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("oversized upload left a partial file")
	}
}
