// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"strings"
	"testing"
	"time"

	"rsc.io/qr"
)

// TestTerminalQRMatchesEncodedModules reads the half-block rendering back into
// a module matrix and compares it with the encoder's own matrix. Terminal
// colours, the quiet zone, and the two-modules-per-line mapping are the parts
// that silently break a scannable code, and none of them need a QR reader to
// check.
func TestTerminalQRMatchesEncodedModules(t *testing.T) {
	const content = "otpauth://totp/bcwebmux:test@host?issuer=bcwebmux&secret=JBSWY3DPEHPK3PXP"
	code, err := qr.Encode(content, qrRecoveryLevel)
	if err != nil {
		t.Fatal(err)
	}
	var rendered strings.Builder
	if err := writeTerminalQR(&rendered, content); err != nil {
		t.Fatal(err)
	}
	size := code.Size + 2*qrQuietZone
	rows := make([][]bool, 0, size)
	for _, line := range strings.Split(strings.TrimRight(rendered.String(), "\n"), "\n") {
		if !strings.HasPrefix(line, "\x1b[30;47m") || !strings.HasSuffix(line, "\x1b[0m") {
			t.Fatalf("line is not a colour-forced QR row: %q", line)
		}
		cells := []rune(strings.TrimSuffix(strings.TrimPrefix(line, "\x1b[30;47m"), "\x1b[0m"))
		if len(cells) != size {
			t.Fatalf("row has %d cells, want %d", len(cells), size)
		}
		top := make([]bool, size)
		bottom := make([]bool, size)
		for column, cell := range cells {
			switch cell {
			case '\u2588': // full block
				top[column], bottom[column] = true, true
			case '\u2580': // upper half
				top[column], bottom[column] = true, false
			case '\u2584': // lower half
				top[column], bottom[column] = false, true
			case ' ':
				top[column], bottom[column] = false, false
			default:
				t.Fatalf("unexpected glyph %q at column %d", cell, column)
			}
		}
		rows = append(rows, top, bottom)
	}
	if len(rows) < size {
		t.Fatalf("rendered %d module rows, want %d", len(rows), size)
	}
	for row := 0; row < size; row++ {
		for column := 0; column < size; column++ {
			if rows[row][column] != qrBlack(code, column, row) {
				t.Fatalf("module (%d,%d) rendered %v, encoded %v", column, row, rows[row][column], qrBlack(code, column, row))
			}
		}
	}
	// The quiet zone must actually be light: a scanner needs it.
	for index := 0; index < qrQuietZone; index++ {
		for column := 0; column < size; column++ {
			if rows[index][column] || rows[size-1-index][column] {
				t.Fatalf("quiet zone row %d is not clear", index)
			}
		}
	}
}

func TestTOTPEnrollmentURICarriesDefaultsImplicitly(t *testing.T) {
	factor, err := newTOTPFactor("test@host", time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	uri := otpauthURI("bcwebmux", "test@host", factor)
	if !strings.HasPrefix(uri, "otpauth://totp/bcwebmux:test@host?") {
		t.Fatalf("unexpected uri %q", uri)
	}
	for _, parameter := range []string{"issuer=bcwebmux", "secret=" + totpSecret(factor.Secret)} {
		if !strings.Contains(uri, parameter) {
			t.Errorf("uri %q is missing %q", uri, parameter)
		}
	}
	for _, absent := range []string{"algorithm=", "digits=", "period="} {
		if strings.Contains(uri, absent) {
			t.Errorf("uri %q should omit the default %q", uri, absent)
		}
	}
	factor.Algorithm = "SHA256"
	factor.Digits = 8
	factor.Period = 60
	uri = otpauthURI("bcwebmux", "test@host", factor)
	for _, parameter := range []string{"algorithm=SHA256", "digits=8", "period=60"} {
		if !strings.Contains(uri, parameter) {
			t.Errorf("uri %q is missing %q", uri, parameter)
		}
	}
}
