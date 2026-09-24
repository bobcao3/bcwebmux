package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const (
	assetCacheControl = "public, no-cache, must-revalidate"
	assetCSP          = "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'"
)

type assetServer struct {
	embedded fs.FS
	root     string
}

func newAssetServer(embedded fs.FS, root string) (*assetServer, error) {
	if embedded == nil {
		return nil, errors.New("embedded asset filesystem is required")
	}
	var absolute string
	if root != "" {
		var err error
		absolute, err = filepath.Abs(root)
		if err != nil {
			return nil, fmt.Errorf("resolve web root: %w", err)
		}
		info, err := os.Stat(absolute)
		if err != nil {
			return nil, fmt.Errorf("stat web root: %w", err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("web root is not a directory")
		}
	}
	return &assetServer{embedded: embedded, root: absolute}, nil
}

func (a *assetServer) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		a.writeAssetError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rel, ok := safeAssetPath(r.URL)
	if !ok {
		a.writeAssetError(w, http.StatusNotFound, "not found")
		return
	}
	if a.root != "" {
		if a.serveDisk(w, r, rel) {
			return
		}
	}
	data, err := fs.ReadFile(a.embedded, path.Join("web", rel))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			a.writeAssetError(w, http.StatusNotFound, "not found")
			return
		}
		a.writeAssetError(w, http.StatusInternalServerError, "asset read failed")
		return
	}
	if len(data) > MaxAssetBytes {
		a.writeAssetError(w, http.StatusInternalServerError, "asset too large")
		return
	}
	a.writeAsset(w, r, rel, data)
}

// serveDisk returns false only when a missing file permits embedded fallback.
func (a *assetServer) serveDisk(w http.ResponseWriter, r *http.Request, rel string) bool {
	file, err := os.OpenInRoot(a.root, filepath.FromSlash(rel))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false
		}
		a.writeAssetError(w, http.StatusNotFound, "not found")
		return true
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > MaxAssetBytes {
		a.writeAssetError(w, http.StatusNotFound, "not found")
		return true
	}
	digest, err := hashFile(file, info.Size())
	if err != nil {
		a.writeAssetError(w, http.StatusInternalServerError, "asset read failed")
		return true
	}
	etag := etagFor(digest)
	a.setAssetHeaders(w, contentType(rel), etag)
	// Use a zero modtime so the content digest, rather than timestamps, is the validator.
	http.ServeContent(w, r, rel, time.Time{}, io.NewSectionReader(file, 0, info.Size()))
	return true
}

func hashFile(file *os.File, size int64) ([32]byte, error) {
	h := sha256.New()
	if _, err := io.CopyN(h, file, size); err != nil {
		return [32]byte{}, err
	}
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest, nil
}

func (a *assetServer) writeAsset(w http.ResponseWriter, r *http.Request, rel string, data []byte) {
	digest := sha256.Sum256(data)
	etag := etagFor(digest)
	a.setAssetHeaders(w, contentType(rel), etag)
	http.ServeContent(w, r, rel, time.Time{}, bytes.NewReader(data))
}

func (a *assetServer) setAssetHeaders(w http.ResponseWriter, mime, etag string) {
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", assetCacheControl)
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Security-Policy", assetCSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (a *assetServer) writeAssetError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Security-Policy", assetCSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.Error(w, message, status)
}

func safeAssetPath(u *url.URL) (string, bool) {
	if u == nil || u.Path == "" || strings.IndexByte(u.Path, 0) >= 0 ||
		strings.IndexByte(u.Path, '\\') >= 0 || strings.Contains(strings.ToLower(u.RawPath), "%5c") {
		return "", false
	}
	if u.Path == "/" {
		return "index.html", true
	}
	if !strings.HasPrefix(u.Path, "/") {
		return "", false
	}
	// URL.Path is decoded by net/http. Check RawPath as well so encoded dot
	// segments cannot be normalized into an allowed path accidentally.
	for _, candidate := range []string{u.Path, u.RawPath} {
		if candidate == "" {
			continue
		}
		for _, segment := range strings.Split(strings.TrimPrefix(candidate, "/"), "/") {
			if segment == ".." || strings.EqualFold(segment, "%2e%2e") {
				return "", false
			}
		}
	}
	clean := path.Clean(u.Path)
	if clean == "." || !strings.HasPrefix(clean, "/") || clean == "/" || strings.HasPrefix(clean, "/../") || clean == "/.." {
		return "", false
	}
	rel := strings.TrimPrefix(clean, "/")
	if rel == "" || rel == "." || !fs.ValidPath(rel) {
		return "", false
	}
	return rel, true
}

func etagFor(digest [32]byte) string { return `"` + hex.EncodeToString(digest[:]) + `"` }

func contentType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".wasm":
		return "application/wasm"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".txt":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}
