// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

import (
	"fmt"
	"io"
	"strings"

	"rsc.io/qr"
)

const (
	// qrQuietZone is the four-module margin ISO/IEC 18004 requires; a camera
	// aimed at a screen needs all of it.
	qrQuietZone = 4
	// qrRecoveryLevel trades a little density for the margin a scanner needs
	// when it photographs a screen at an angle.
	qrRecoveryLevel = qr.M
)

// writeTerminalQR draws one QR module per column and two per line, which is
// what makes the modules square in a terminal cell at all. The document is
// expected to stay inside eighty columns: enrollment labels are capped for it.
func writeTerminalQR(out io.Writer, content string) error {
	code, err := qr.Encode(content, qrRecoveryLevel)
	if err != nil {
		return fmt.Errorf("encode enrollment QR: %w", err)
	}
	size := code.Size + 2*qrQuietZone
	var line strings.Builder
	for row := 0; row < size; row += 2 {
		line.Reset()
		line.WriteString("\x1b[30;47m")
		for column := 0; column < size; column++ {
			line.WriteString(halfBlock(
				qrBlack(code, column, row),
				qrBlack(code, column, row+1),
			))
		}
		line.WriteString("\x1b[0m")
		if _, err := fmt.Fprintln(out, line.String()); err != nil {
			return err
		}
	}
	return nil
}

// halfBlock maps two stacked modules onto one glyph. Its halves are drawn in
// the foreground colour, so the caller's forced black-on-white decides which
// module is black, not the terminal's theme.
func halfBlock(top, bottom bool) string {
	switch {
	case top && bottom:
		return "\u2588" // full block
	case top:
		return "\u2580" // upper half
	case bottom:
		return "\u2584" // lower half
	default:
		return " "
	}
}

func qrBlack(code *qr.Code, column, row int) bool {
	return code.Black(column-qrQuietZone, row-qrQuietZone)
}
