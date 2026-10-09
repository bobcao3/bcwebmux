# 50 reader questions

Use these questions as audit lenses and as writing targets. They overlap on
purpose: overlap reveals which fact needs one authoritative home. Adapt names
and paths to the repository under audit; keep the count and the coverage.

Each question carries its intended home — the document and section a reader
should reach without skipping unrelated material. When no home exists, that
absence is the finding.

## A. Orientation — what is this?

1. What is this project in one sentence I can repeat to a colleague? — home:
   root README, first screen.
2. Is it an application, a library, or both — and which one do I need? — home:
   root README, component split.
3. What does it do that a plain browser terminal or xterm.js does not? — home:
   root README; the persistence, reconnect, and multi-client claim must be
   concrete, not implied.
4. What are the moving parts, and which ones talk to which? — home: root README
   prose; the build graph itself lives in the build files.
5. Which components are third-party and which are first-party? — home:
   `THIRD_PARTY_NOTICES` plus one summary sentence; pins live in
   `build.zig.zon`, `go.mod`, and `package.json`.
6. What is the license, and what must I ship when redistributing? — home: root
   README license section linking the notices file.
7. What is the project's stability status and which areas are experimental?
   — home: root or component README.

## B. Build and deploy

8. What must I install before the first build? — home: application README get
   started; exact pins live in the build manifests.
9. What is the shortest path from a fresh checkout to a served terminal? — home:
   application README quickstart.
10. How do I run it locally without authentication, and what does that expose?
    — home: application README, authentication section.
11. How do I configure listen addresses, ports, and origins? — home:
    application README server configuration; defaults live in the flag
    definitions.
12. How do I enable TLS, and what must I provide? — home: same section, with an
    explicit pointer from the quickstart.
13. How do I enable HTTP/3, and what are its requirements? — home: server
    configuration.
14. Where do configuration files live, in what order are they read, and what
    overrides what? — home: server configuration precedence contract; the
    parser is the authority on key names.
15. Which configuration keys exist, with types and defaults? — home: the code,
    `--help`, and the example config; the docs point to them instead of
    copying them.
16. Where does persistent state live, and with what permissions? — home:
    authentication storage section; paths and modes from code.
17. What happens to running sessions when I restart or upgrade the server?
    — home: application README or a continuity summary; this is a contract
    statement, not a code fact.
18. How do I make it reachable from a phone, and what does the PWA require?
    — home: application README get started.

## C. Security

19. How do I make sure no unauthenticated user reaches a shell? — home:
    application README authentication summary; full contract in
    `docs/authentication.md`.
20. How do I enroll the baseline authenticator app? — home: CLI quickstart in
    the README; the CLI defines its own flags.
21. When can I use a WebAuthn security key, and when is it impossible? — home:
    authentication design, origin-bound section.
22. How are sign-in codes protected against replay and brute force? — home:
    authentication design, sign-in section.
23. How do I revoke one device or all access, and when does it take effect?
    — home: authentication design, reset section.
24. What is in scope for the threat model, and what is deliberately not
    attempted? — home: authentication design, threat model near the top.
25. What happens when auth state is missing, deleted, or corrupt? — home:
    authentication design, storage; fail-closed behavior is a contract.

## D. Embed and use the terminal

26. What is the minimal code to put a terminal in my own page? — home: terminal
    package README integration section.
27. What must my application provide, and what does the package provide? — home:
    package README build-and-consume section.
28. How do I connect the terminal to my own shell or transport? — home:
    package README integration example; callback lifetime rules are contracts.
29. How do I build and pack the package from this checkout? — home: package
    README.
30. Which JavaScript, WASM, and font assets must ship together? — home: package
    README; the preparation script is the authority on asset layout.
31. How is this different from xterm.js, and can I migrate without changing
    code? — home: package README; an explicit differences list.
32. Can I run more than one terminal on one page, and how? — home: package
    README multiple-terminal section.
33. How do fonts behave: bundled faces, fallbacks, emoji, CJK? — home: package
    README text paths section.
34. Where is a runnable example, and what does it demonstrate? — home: root
    README linking a maintained example file.

## E. Develop and contribute

35. Where in the tree do I change a given behavior? — home: root README change
    map.
36. How do I build everything and run the full test suite? — home: application
    README development section, one canonical command list.
37. Which tests need a GPU, Chromium, or extra fonts, and what if I lack them?
    — home: development section next to the commands.
38. How do I regenerate visual goldens without destroying signal? — home:
    development section; procedures reference the test scripts.
39. What compatibility rules apply when I change terminal semantics? — home:
    graphics or protocol doc; digest update procedure as a contract.
40. What is the contribution process: branches, review, CI, style? — home:
    `CONTRIBUTING.md`; its absence is a finding.
41. How do I add a docs topic and keep the index accurate? — home: docs index,
    storage conventions.
42. What are the known limitations and non-goals? — home: one limitations
    section per topic doc.

## F. Behavior and design

43. What happens to my session when the network drops or the phone sleeps?
    — home: continuity summary near the top of the connection lifecycle doc,
    plus one README sentence.
44. Can two browsers attach to one session, and who owns resize and input?
    — home: connection lifecycle.
45. How does reconnect avoid duplicated output or replayed input? — home:
    connection lifecycle.
46. What happens under overload: slow client, bursty producer, full queues?
    — home: connection lifecycle pressure section, with the user-visible
    outcome stated first.
47. What does the client and server compatibility check protect against, and
    what happens on mismatch? — home: application README core design.
48. How are images stored, limited, and rendered? — home: graphics topic doc.
49. How is the glyph atlas sized and shared between terminals? — home: glyph
    cache topic doc.
50. What is fail-open versus fail-closed behavior for auth, parsing, and
    protocol errors? — home: authentication and connection lifecycle docs.

## Using the list

- Trace one question at a time from the entry point a real reader would use;
  record the path, the first answer location, and the skip cost.
- When two questions are answered by the same passage, the passage is probably
  misplaced unless the questions share an audience.
- When a question has no home, decide whether to answer it or declare it out of
  scope. Silence is a finding either way.
