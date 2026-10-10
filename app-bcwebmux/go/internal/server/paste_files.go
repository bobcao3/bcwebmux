package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

const maxPasteFileBytes = 20 << 20

var pasteFileName = regexp.MustCompile(`^bcwebmux-paste-[0-9a-f]{32}\.(png|jpg|gif|webp|bmp|tiff|avif|svg|bin)$`)

func (s *Server) servePasteFile(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		extension := map[string]string{
			"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
			"image/webp": "webp", "image/bmp": "bmp", "image/tiff": "tiff",
			"image/avif": "avif", "image/svg+xml": "svg",
		}[r.URL.Query().Get("type")]
		if extension == "" {
			extension = "bin"
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal", "could not prepare a temporary path")
			return
		}
		name := "bcwebmux-paste-" + hex.EncodeToString(random[:]) + "." + extension
		writeJSON(w, http.StatusOK, map[string]any{
			"path": filepath.Join(os.TempDir(), name), "name": name, "maxBytes": maxPasteFileBytes,
		})
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
	name := r.URL.Query().Get("name")
	if !pasteFileName.MatchString(name) {
		writeJSONError(w, http.StatusBadRequest, "invalid_path", "invalid temporary file name")
		return
	}
	if r.ContentLength > maxPasteFileBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "file exceeds 20 MiB")
		return
	}
	path := filepath.Join(os.TempDir(), name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			writeJSONError(w, http.StatusConflict, "file_exists", "temporary path already exists; paste again for a new path")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "internal", "could not create temporary file")
		}
		return
	}
	complete := false
	defer func() {
		file.Close()
		if !complete {
			os.Remove(path)
		}
	}()
	r.Body = http.MaxBytesReader(w, r.Body, maxPasteFileBytes)
	n, err := io.Copy(file, r.Body)
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large", "file exceeds 20 MiB")
		} else {
			writeJSONError(w, http.StatusBadRequest, "invalid_body", "file upload failed")
		}
		return
	}
	if n == 0 {
		writeJSONError(w, http.StatusBadRequest, "empty_file", "clipboard file is empty")
		return
	}
	if err := file.Close(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal", "could not finish temporary file")
		return
	}
	complete = true
	writeJSON(w, http.StatusCreated, map[string]string{"path": path})
}
