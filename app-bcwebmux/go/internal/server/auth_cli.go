// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

package server

// CLI surface for authentication: `auth totp` enrolls the authenticator app
// over the terminal, `auth list` shows the factors, and `auth remove` revokes
// them. Security keys are enrolled from the browser, where the key itself is:
// a FIDO2 ceremony needs the device in the operator's hand, not on the host.

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// RunAuth executes one `bcwebmux-server auth ...` subcommand.
func RunAuth(program string, args []string, logger *slog.Logger) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: %s auth totp|list|remove [options]", program)
	}
	subcommand, rest := args[0], args[1:]
	switch subcommand {
	case "totp":
		return runAuthTOTP(rest, logger)
	case "list":
		return runAuthList(rest, logger)
	case "remove":
		return runAuthRemove(rest, logger)
	case "help", "-h", "--help":
		fmt.Print(Usage(program))
		return nil
	default:
		return fmt.Errorf("unknown auth subcommand %q; expected totp, list, or remove", subcommand)
	}
}

// Everything happens over the terminal, and nothing is stored until a code
// from the new secret proves the app was set up correctly.
func runAuthTOTP(args []string, logger *slog.Logger) error {
	rotate := false
	showQR := true
	account := ""
	forwarded := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--account":
			if index+1 >= len(args) {
				return errors.New("--account requires a label")
			}
			index++
			account = args[index]
		case strings.HasPrefix(arg, "--account="):
			account = strings.TrimPrefix(arg, "--account=")
		case arg == "--rotate":
			rotate = true
		case strings.HasPrefix(arg, "--rotate="):
			value, err := strconv.ParseBool(strings.TrimPrefix(arg, "--rotate="))
			if err != nil {
				return fmt.Errorf("invalid --rotate value %q", strings.TrimPrefix(arg, "--rotate="))
			}
			rotate = value
		case arg == "--no-qr":
			showQR = false
		case strings.HasPrefix(arg, "--no-qr="):
			value, err := strconv.ParseBool(strings.TrimPrefix(arg, "--no-qr="))
			if err != nil {
				return fmt.Errorf("invalid --no-qr value %q", strings.TrimPrefix(arg, "--no-qr="))
			}
			showQR = !value
		default:
			forwarded = append(forwarded, arg)
		}
	}
	cfg, help, err := parseConfig(forwarded, false)
	if err != nil {
		return err
	}
	if help {
		fmt.Print(Usage("bcwebmux-server"))
		return nil
	}
	manager, err := newAuthManager(cfg.AuthFile, authSessionTTLDefault, nil, logger)
	if err != nil {
		return err
	}
	if _, enrolled := manager.totpFactor(); enrolled && !rotate {
		return errors.New("an authenticator app is already enrolled; rotate it with --rotate (the old secret stops working)")
	}
	if strings.TrimSpace(account) == "" {
		account = fmt.Sprintf("%s@%s", currentUser(), hostName())
	}
	account = normalizeCredentialName(account)
	factor, err := newTOTPFactor(account, manager.now())
	if err != nil {
		return err
	}
	uri := otpauthURI(authIssuer, account, factor)
	fmt.Printf("Enrolling an authenticator app (TOTP) for bcwebmux.\n")
	fmt.Printf("Authentication state: %s\n\n", cfg.AuthFile)
	if showQR {
		if err := writeTerminalQR(os.Stdout, uri); err != nil {
			return err
		}
	}
	fmt.Printf("\n  account  %s\n", account)
	fmt.Printf("  secret   %s\n", totpSecret(factor.Secret))
	fmt.Printf("  uri      %s\n\n", uri)
	if showQR {
		fmt.Printf("Scan the code with Google Authenticator, 1Password, Aegis, or any TOTP app,\n")
	} else {
		fmt.Printf("Add the account to a TOTP app, by scanning the uri or typing the secret.\n")
	}
	fmt.Printf("or type the secret in by hand. The code is %d digits and rotates every %ds.\n\n", factor.Digits, factor.Period)
	code, err := readConfirmationCode(os.Stdin)
	if err != nil {
		return err
	}
	if _, err := manager.enrollTOTP(factor, code, manager.now()); err != nil {
		if errors.Is(err, errTOTPUnconfirmed) {
			return errors.New("that code did not match the new secret; nothing was changed")
		}
		return err
	}
	fmt.Printf("Enrolled. Every address this server answers on now requires a code from that app.\n")
	fmt.Printf("Keep the secret safe: without it and without shell access there is no way in.\n")
	fmt.Printf("Add security keys from Settings → SECURITY in the browser, one per device.\n")
	fmt.Printf("Remove it with: bcwebmux-server auth remove --totp\n")
	return nil
}

// authIssuer is the label authenticator apps show for this service.
const authIssuer = "bcwebmux"

func readConfirmationCode(in io.Reader) (string, error) {
	fmt.Printf("Enter the current %d-digit code to confirm: ", totpDigits)
	reader := bufio.NewReader(in)
	line, err := reader.ReadString('\n')
	code := strings.TrimSpace(line)
	if code == "" {
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return "", errors.New("no code was entered; nothing was changed")
	}
	return code, nil
}

func currentUser() string {
	if user := os.Getenv("USER"); user != "" {
		return user
	}
	if user := os.Getenv("LOGNAME"); user != "" {
		return user
	}
	return "user"
}

func hostName() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return "host"
}

// runAuthList prints the enrolled credentials.
func runAuthList(args []string, logger *slog.Logger) error {
	cfg, help, err := parseConfig(args, false)
	if err != nil {
		return err
	}
	if help {
		fmt.Print(Usage("bcwebmux-server"))
		return nil
	}
	state, err := loadAuthState(cfg.AuthFile, logger)
	if err != nil {
		return err
	}
	if len(state.Credentials) == 0 && state.TOTP == nil {
		fmt.Printf("No authenticator app or security key is enrolled in %s.\nThe service does not require a login until one is enrolled.\n", cfg.AuthFile)
		fmt.Printf("Enroll the baseline factor with: bcwebmux-server auth totp\n")
		return nil
	}
	factors := len(state.Credentials)
	if state.TOTP != nil {
		factors++
	}
	fmt.Printf("%d factor(s) in %s:\n\n", factors, cfg.AuthFile)
	if state.TOTP != nil {
		lastUsed := "never"
		if !state.TOTP.LastUsed.IsZero() {
			lastUsed = state.TOTP.LastUsed.UTC().Format(time.RFC3339)
		}
		fmt.Printf("  %-32s  TOTP\n", state.TOTP.Name)
		fmt.Printf("    enrolled    %s (cli)\n", state.TOTP.Enrolled.UTC().Format(time.RFC3339))
		fmt.Printf("    last used   %s\n", lastUsed)
		fmt.Printf("    digits      %d every %ds, %s\n", state.TOTP.Digits, state.TOTP.Period, strings.ToUpper(state.TOTP.Algorithm))
	}
	credentials := append([]authCredential(nil), state.Credentials...)
	sort.SliceStable(credentials, func(i, j int) bool {
		if credentials[i].RPID != credentials[j].RPID {
			return credentials[i].RPID < credentials[j].RPID
		}
		return credentials[i].CreatedAt.Before(credentials[j].CreatedAt)
	})
	for _, credential := range credentials {
		lastUsed := "never"
		if !credential.LastUsedAt.IsZero() {
			lastUsed = credential.LastUsedAt.UTC().Format(time.RFC3339)
		}
		fmt.Printf("  %-32s  %s\n", credential.Name, credential.RPID)
		fmt.Printf("    id          %s\n", encodeToken(credential.Credential.ID))
		fmt.Printf("    enrolled    %s (browser)\n", credential.CreatedAt.UTC().Format(time.RFC3339))
		fmt.Printf("    last used   %s\n", lastUsed)
		if len(credential.Credential.Transport) > 0 {
			transports := make([]string, 0, len(credential.Credential.Transport))
			for _, transport := range credential.Credential.Transport {
				transports = append(transports, string(transport))
			}
			fmt.Printf("    transports  %s\n", strings.Join(transports, ","))
		}
	}
	fmt.Printf("\nRemove a key with: bcwebmux-server auth remove --id <id>\n")
	fmt.Printf("Remove the authenticator app with: bcwebmux-server auth remove --totp\n")
	fmt.Printf("Remove every factor with: bcwebmux-server auth remove --all\n")
	return nil
}

// runAuthRemove revokes credentials. Removing the last one returns the service
// to its unauthenticated state and invalidates every issued session.
func runAuthRemove(args []string, logger *slog.Logger) error {
	var id string
	var all bool
	var totp bool
	forwarded := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--id":
			if index+1 >= len(args) {
				return errors.New("--id requires a credential identifier")
			}
			index++
			id = args[index]
		case strings.HasPrefix(arg, "--id="):
			id = strings.TrimPrefix(arg, "--id=")
		case arg == "--all":
			all = true
		case arg == "--totp":
			totp = true
		case strings.HasPrefix(arg, "--totp="):
			value := strings.TrimPrefix(arg, "--totp=")
			flag, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid --totp value %q", value)
			}
			totp = flag
		case strings.HasPrefix(arg, "--all="):
			value := strings.TrimPrefix(arg, "--all=")
			flag, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid --all value %q", value)
			}
			all = flag
		default:
			forwarded = append(forwarded, arg)
		}
	}
	if all && (id != "" || totp) {
		return errors.New("--all is mutually exclusive with --id and --totp")
	}
	if totp && id != "" {
		return errors.New("--totp and --id are mutually exclusive")
	}
	if !all && !totp && id == "" {
		return errors.New("auth remove requires --id <id>, --totp, or --all")
	}
	cfg, help, err := parseConfig(forwarded, false)
	if err != nil {
		return err
	}
	if help {
		fmt.Print(Usage("bcwebmux-server"))
		return nil
	}
	manager, err := newAuthManager(cfg.AuthFile, authSessionTTLDefault, nil, logger)
	if err != nil {
		return err
	}
	if totp {
		removed, found, err := manager.removeTOTP()
		if err != nil {
			return err
		}
		if !found {
			fmt.Printf("No authenticator app is enrolled in %s.\n", cfg.AuthFile)
			return nil
		}
		fmt.Printf("Removed the authenticator app (%s).\n", removed.Name)
		return warnIfEmpty(manager, cfg)
	}
	if all {
		removed, err := manager.removeAll()
		if err != nil {
			return err
		}
		if len(removed) == 0 {
			fmt.Printf("No security keys are enrolled in %s.\n", cfg.AuthFile)
			return nil
		}
		fmt.Printf("Removed %d security key(s): %s\n", len(removed), credentialLabel(removed))
		return warnIfEmpty(manager, cfg)
	}
	target, ok := manager.lookupAny(id)
	if !ok {
		return fmt.Errorf("no enrolled security key matches %q; run `bcwebmux-server auth list`", id)
	}
	removed, found, err := manager.removeCredential(target.Credential.ID)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("no enrolled security key matches %q", id)
	}
	fmt.Printf("Removed %s (%s).\n", removed.Name, removed.RPID)
	return warnIfEmpty(manager, cfg)
}

// Reports the unauthenticated state that removing the last factor produces.
func warnIfEmpty(manager *authManager, cfg Config) error {
	totp, keys := manager.factors()
	if totp || keys != 0 {
		return nil
	}
	fmt.Printf("No factors remain: %s was reset and the service no longer requires a login.\n", cfg.AuthFile)
	fmt.Printf("Every issued browser session is invalid. Re-enroll with: bcwebmux-server auth totp\n")
	return nil
}

// encodeToken renders opaque bytes for URLs and CLI output.
func encodeToken(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func credentialLabel(credentials []authCredential) string {
	labels := make([]string, 0, len(credentials))
	for _, credential := range credentials {
		labels = append(labels, credential.Name+" ("+credential.RPID+")")
	}
	return strings.Join(labels, ", ")
}
