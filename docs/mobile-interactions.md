# Mobile text interactions

## Paste

Open the soft-key row with the keyboard icon, then tap **PASTE**. The paste
preview tries to read the clipboard. If the browser denies clipboard access,
hold inside the editable field and choose **Paste** from the native menu. Review
or edit the text, then tap **SEND TO TERMINAL**. Cancel sends nothing. Multiline
text may execute commands; bracketed paste protects input only when the terminal
application enables bracketed-paste mode.

Holding terminal output still selects output. The terminal canvas is not an
editable text box, so the output selection menu does not offer Paste.

## Audit results

The audit used Chromium browser tests with touch emulation and source
inspection. Touch emulation does not verify mobile operating-system menus or
keyboards. The touch-link test supplies the compatibility click explicitly
because Chromium's synthetic touch input did not generate a click in the audit
environment. Native tap-to-focus and link activation still need physical-device
checks.

The interaction suites passed. The full-viewport screenshot suite reported
mismatches against older theme and layout goldens; the audit did not regenerate
those goldens.

| User action                         | Current behavior and evidence                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tap the terminal                    | The click handler focuses the keyboard input and sends a mouse click when the terminal application requests mouse reports. The touch test checks click routing; physical phones must verify keyboard appearance.                                        |
| Swipe vertically or flick           | The terminal scrolls with momentum. The terminal routes scrolling to scrollback, application mouse-wheel reports, or navigation keys. The touch suite checks momentum and scrollback boundaries; GPU tests check application routing.                   |
| Stop momentum                       | A new touch cancels the previous scroll gesture. Scrollbar interaction and committed terminal input also cancel momentum.                                                                                                                               |
| Drag the scrollbar or tap the track | The scrollbar supports dragging and page-sized track taps. The browser suite checks scrollbar navigation and dragging.                                                                                                                                  |
| Hold a word                         | A stationary hold lasting 400 ms enters selection mode and selects a word. The touch suite checks Unicode words, nearby touches, whitespace, and the absence of terminal input.                                                                         |
| Adjust a selection                  | Selection mode exposes a read-only DOM text mirror for native selection handles. Tests check range synchronization and copied text; phones must verify handle dragging and the native menu.                                                             |
| Copy output                         | Native Copy exports the terminal selection as plain text and clears the selection. Copy-event tests and browser clipboard tests cover the data path.                                                                                                    |
| Enter or leave selection mode       | The selection button toggles the mode. The transport buffers live output while selection mode remains active and flushes output on exit. The touch suite checks both transitions.                                                                       |
| Tap a link                          | The terminal opens a destination-confirmation dialog. Link tests check the dialog and destination policy. The touch test exercises the click handler after touch events.                                                                                |
| Swipe across a link                 | The click handler now suppresses a click following a moved touch before checking hyperlinks. A regression test failed before the fix and passed after the fix.                                                                                          |
| Type, compose, delete, or submit    | GPU integration tests check ordinary typing, composition, Backspace, Enter, cursor movement, and hardware-modifier composition suppression. Phones must verify actual keyboard event sequences.                                                         |
| Use soft keys                       | Escape, Tab, arrows, Home/End, and Page Up/Down send terminal keys. Shift/Ctrl/Alt affect the next key or first committed character, then reset. Browser tests check Escape/Tab and Ctrl with committed input.                                          |
| Paste or edit a paste preview       | The preview is an ordinary editable textarea. Browser tests check permitted clipboard reads, denied-read native paste, multiline Unicode input, confirmation, cancellation, and delayed reads that must not overwrite edits or populate a later dialog. |
| Hide or show soft keys              | The keyboard icon toggles the row. Hiding the row clears soft modifiers. Browser tests check visibility and row sizing.                                                                                                                                 |

## Remaining limitations

- Tapping output does not reposition an application's caret. Use arrow keys or
  application-specific mouse handling. Keyboard spacebar cursor gestures cannot
  navigate the remote application's input through the empty input textarea.
- Selection mode provides the current visible snapshot. The pointer controller
  does not scroll terminal history in selection mode or extend a selection into
  offscreen history.
- The terminal input controller does not implement document-style cut,
  undo/redo, replacement ranges, or word deletion. Backward/forward deletion
  input events currently send one Backspace/Delete. A remote application may
  provide editing commands through terminal keys. The paste preview retains
  native text editing.
- The terminal disables autocorrection, automatic capitalization, and
  spellcheck. Dictation, swipe typing, emoji keyboards, and language-specific
  composition need physical-device verification.
- The terminal surface uses `touch-action: none`, so the surface does not offer
  browser pinch zoom or horizontal panning. Font-size settings provide explicit
  text resizing.
- The pointer controller tracks one touch candidate. A second finger replaces
  the first candidate; multi-touch gestures do not have a defined terminal
  contract.

## Physical-device checks

Run these checks in iOS Safari and Android Chrome, both in a browser tab and in
an installed app:

1. Deny clipboard-read permission. Open PASTE, hold the field, paste multiline
   Unicode text, edit the text, and send. Check cancellation and an empty
   clipboard.
2. Hold output, drag both selection handles across wrapped lines, and copy.
   Verify that scrolling and link taps do not accidentally select or open links.
3. Type with a language input method, accents, emoji, dictation, and swipe
   typing. Verify Backspace, Enter, and Ctrl/Alt soft modifiers without
   duplicate input.
4. Show and dismiss the keyboard, rotate the phone, and return after switching
   apps. Check that the caret, terminal controls, and paste buttons remain
   visible.
5. Flick scrollback, interrupt momentum, drag the scrollbar, and try two-finger
   touches. Check safe-area behavior and application mouse-mode scrolling.

The automated coverage lives in `app-bcwebmux/test/mouse-selection-e2e.mjs`,
`gpu-e2e.mjs`, `file-service-e2e.mjs`, and `native-clipboard.test.mjs`.
