# Correctness-first connection lifecycle

## Contracts and ownership

Separate four observations:

1. Transport receive progress: validated frames from the current attempt.
2. Round-trip confirmation: a matching PONG; negotiation latency is separate.
3. Application progress: replay/checkpoint completion and committed cursors.
4. Local pressure: queued bytes, processing backlog, timer lateness, and socket
   `bufferedAmount`.

Inbound output demonstrates receive progress, not necessarily bidirectional
application health. An overdue PONG is suspicion, not proof of a dead connection.
Late responses and missed observations remain visible in diagnostics; do not
invent RTT values for them or silently omit them from health reporting.

Use a small connection-attempt object, not a generic state-machine framework.
It owns its socket, generation, wire sequences, readiness settlement, timers,
probe state, cancellation token, and bounded ordered application queue.
Transport owns desired attachments and retry policy. Attachment bindings and
restore transactions belong to an attempt; cores and committed cursors outlive it.

Lifecycle:

`idle -> connecting -> negotiating -> ready <-> suspect -> retiring -> backoff`

`failed` and `disposed` are terminal. Suspension is orthogonal to these states.
Socket readiness, attachment LIVE, and controller/input readiness are distinct.

- A latency SLO miss can enter `suspect`; it does not detach an attachment, clear
  controller state, or stop working input by itself.
- Retirement follows the explicit eligibility policy below. A timeout is a
  declared availability/resource decision with possible false positives, never
  proof of network death; latency telemetry has no authority to retire a socket.
- Retirement is idempotent. Old callbacks and async transactions cannot mutate a
  successor, commit a core, send ACK/input, or report a current failure.
- Validate framing and sequence once on arrival. Handle safe connection PING and
  PONG controls there, outside asynchronous application work. Application frames
  remain ordered; receiving bytes does not authorize an application ACK.
- A user's ensure-ready operation survives transient attempts until cancellation,
  fatal failure, or its own operation deadline. An initial transient attempt must
  not permanently poison controller startup.
- Ordinary recovery is status/diagnostic data. Operation failures have one caller;
  fatal incompatibility/protocol failures have one reporting owner and stop
  automatic retries. UI connection status comes from lifecycle, not error banners.
- Visibility/online events are hints, not proof. Hiding, freezing, or a significant
  scheduling gap invalidates short-term timing assumptions. Resume revalidates
  with a fresh observation window, not a backlog of expired failure callbacks.

## Retirement, recovery, and admission policy

### Authority and operating profile

Each endpoint has one connection owner that authorizes retirement: the browser
attempt supervisor and the Go server socket transport owner respectively. Only
the browser supervisor creates replacement connections; the server does not dial
replacements for clients. Native protocol validation can declare protocol
termination or queue overflow, but missing application-heartbeat responses must
not independently retire a Go-managed transport. Network I/O deadlines enforce
the transport owner's policy, not a second competing detector.

The browser uses validated application PING/PONG for round-trip confirmation.
The Go transport uses RFC WebSocket control Ping/Pong for peer reachability, so
normal browser main-thread suspension is not itself a server heartbeat failure.
Application heartbeat responses remain protocol/responsiveness observations;
neither RFC Pong nor application PONG establishes attachment or controller
readiness. Existing protocol validation, wire ordering and compatibility still
apply; transport observations do not bypass native validation.

A deployment profile supplies a probe interval; connection, HELLO, control-queue,
response and terminal-drain windows; a scheduling-gap tolerance; and retry backoff.
All intervals/windows/tolerances are finite and positive; backoff has a finite
positive floor and ceiling. These are independent availability/resource budgets,
not multiples of the
latest successful RTT or the eight-RTT benchmark. Concrete values and the measured
supported load/delay envelope must be recorded with implementation validation;
this document fixes their semantics, not benchmark-selected numerical tuning.

### Eligibility and renewal

Only one liveness probe is outstanding per endpoint/attempt. Server RFC probes
and compatibility application probes have separate state; a response in one
channel cannot renew the other. Browser probing starts after validated WELCOME;
server transport probing starts after WebSocket upgrade. A successful transport
probe does not extend an unfinished HELLO window. After each completed probe,
schedule the next within the profile interval; ordinary traffic does not suppress
probing. The liveness probe has two phases:

1. **Pending submission:** from creation until handoff to the transport write API.
   Failure to hand off within the control-queue window retires once with a
   `local-control-stall` outcome. Other traffic or queue activity does not restart
   this window.
2. **Awaiting response:** from successful handoff until a fully validated matching
   PONG. Expiry of the response window retires once as `response-unavailable`.
   Browser `send()` success is only local acceptance, not physical transmission;
   this window necessarily includes browser buffering, TCP and peer processing.
   Observed pressure accompanies the outcome; it does not justify calling the
   network dead.

A latency objective can enter `suspect` earlier, without detaching records or
withdrawing otherwise valid input authority. A matching response, including a
late response before retirement, completes the probe and clears that suspicion;
the next probe follows the profile's paced cadence. It does not create an RTT-sized
hard deadline. Unmatched or pre-suspension responses cannot renew the current
probe. Other inbound frames and committed application work update their separate
progress observations but do not substitute for round-trip confirmation or reset
a missing-PONG window. Thus one-way traffic cannot postpone recovery indefinitely.

Connection and HELLO each have their own full profile window, beginning at socket
creation and WebSocket open respectively. Neither borrows the established
connection's latency estimator. A stalled phase is retryable unavailability, not
a fatal protocol error. Connection-fatal protocol outcomes instead follow the
terminal-outcome rules below and stop automatic retry.

Known suspension, or a timer callback delayed beyond the profile's scheduling-gap
tolerance, invalidates elapsed time as failure evidence. Do not execute a backlog
of retirements. On actual resume, invalidate the old probe and grant one fresh
submission/response opportunity (or a fresh window for the current negotiation
phase). Suspended/old probes do not seed RTT estimates. Repeated `online` or
visibility hints while already active do not keep extending the window. A valid
fatal outcome or actual socket closure is still honored; memory/admission limits
never pause. Recovery timing assumes execution resumes and a fresh observation
window can run without another invalidating scheduling gap.

### Pressure, retry, and continuity

Apply backpressure before exceeding byte/credit limits: stop granting unavailable
receive credit and reject input that cannot be admitted. Do not queue it for
replay. Reserve bounded capacity for connection controls before assigning send
sequence numbers; this cannot overtake bytes already submitted to WebSocket/TCP.
An application replay/digest backlog alone does not retire the connection; its
operation can stall or fail independently while connection controls remain
schedulable. Conversely, application progress does not renew a missing probe.
A control-submission stall or sustained response absence still follows the two
finite windows above, including when output continues in the other direction.

Explicit socket close/I/O failure, phase expiry and local control stall produce
one retryable retirement unless a fatal outcome is already recorded. Retire once,
release application work, retain committed cores/cursors, and schedule bounded
backoff subject to admission below. Reset backoff only after readiness and a
subsequent regular round-trip confirmation, not on WELCOME, arbitrary traffic or
status changes. A user's operation deadline/cancellation settles that operation;
it does not by itself close a shared healthy connection. Disposal cancels all
retry admission.

Within a profile's supported execution/queue/response envelope, SLO misses alone
cause no disconnect. Outside that envelope, availability policy can still retire
a connection whose underlying network is functional; report that tradeoff and its
observations, not a claim of perfect detection. A silent stale flow eventually
retires after an uninterrupted eligible phase window. Eventual fresh-shell
recovery additionally requires retry admission, a path/server accepting a new
attempt, and successful protocol/attachment restoration. The baseline does not
promise unconditional eight-RTT recovery; retain the strict test and its failures.

### Logical retirement versus physical closure

For one browser transport supervisor, admit at most two unreleased WebSocket
objects total: one incumbent plus either a hedge or an older closing generation.
Any future candidate consumes the same budget; it is not an additional allowance.
This bounds this supervisor's admission, not independently opened tabs or browser
and kernel internals. Reserve a slot before constructing a WebSocket. Release it
only on constructor failure before a socket exists or observed WebSocket closure
(`close` event / CLOSED state), never merely on logical retirement, an elapsed
close timeout, or `bufferedAmount === 0`. Release accounting exactly once.
Observable WebSocket closure releases admission; it is not a guarantee that every
underlying browser/kernel resource has already been reclaimed.

Retirement cancels application commits, timers and queued work, requests socket
closure, and leaves only the minimal accounting needed for the unreleased socket.
Do not retain canceled restore buffers or application queues merely to wait for
physical closure. A retired socket's closure callback may release its accounting
slot, but cannot send, commit application state, report a current failure, or
change a successor's authority.

At capacity, do not create another socket. Keep any current useful connection;
otherwise retain the viewport and expose a single resource-wait status. Resume
admission when closure is observed and backoff permits it, provided work is still
desired and no fatal/disposed state forbids retry. A close event cannot bypass
those checks. Waiting for physical closure can therefore delay recovery beyond
all retry targets. If the browser never releases a slot, automatic recovery is
not promised; expose that condition rather than forge release or accumulate more
sockets. Notification and explicit user retry must not bypass the cap. Browser
close is best effort, not a script-controlled hard abort.

## Server scheduling

Keep native-engine serialization until the ABI explicitly supports concurrency.
Give each socket one FIFO binary writer outside native-operation locks. Transfer
owned output into a byte-bounded queue; do not wait for queue space under a native
lock. Bound native publication/replay work as well as downstream queue memory.
Backpressure and overload are explicit outcomes, not evidence of network death.

RFC control reception belongs to the network reader, independently of native
dispatch; it must not acquire an engine/native-operation lock. Dispatch application
messages through bounded admission to the serialized native owner, preserving
order. If further input cannot be retained within those bounds, select an explicit
overload outcome rather than silently dropping sequenced messages or blocking
control reception indefinitely. Outbound writer isolation alone is insufficient
if the reader still waits synchronously on native work.

Do not reorder encoded application PONGs ahead of output: native send sequence
numbers have already been assigned. Control prioritization, if needed, belongs
before sequence assignment and still cannot overtake bytes queued in TCP.

Heartbeat probes have explicit outstanding-probe state. A valid late response
must not become a protocol violation merely because another probe was sent.
Transport-level reachability and application responsiveness are separate concerns;
WebSocket control frames alone cannot establish terminal/application readiness.
Shutdown interrupts blocked I/O, joins users, and only then disposes native state.

## Terminal outcomes across closure

### Sender: producer termination is not network closure

The server connection owner distinguishes normal production, terminal completion
and forced abort. On native protocol termination, stop admitting application
commands/ticks that would produce more output. The ABI may still expose ordered
queued messages, including a fatal application ERROR. While WebSocket data
transmission remains permitted, give this finite terminal output a best-effort
FIFO completion opportunity under one overall terminal-drain window; do not
restart that window for every message. Native and writer byte limits still apply.
When the writer lacks capacity, wait for progress outside native locks rather
than allocate an unbounded staging queue.

After eligible output is exhausted, initiate protocol closure. A peer/protocol
close that forbids further data, I/O failure, exhausted drain window, resource
failure, or forced shutdown instead selects abort: interrupt I/O and discard
unsendable queued output with a recorded outcome. Abort wins over completion;
send no application data after Close and no more native production after
termination. The existing joins-before-free ownership contract still applies on
both paths.

This is not a requirement to flush every shutdown backlog or a guarantee the peer
received the fatal message. Application ERROR is binary application data, not an
RFC control frame. Failed delivery leaves the client only the evidence it actually
observed; do not infer permanent incompatibility from an unexplained disconnect.

### Receiver: terminal evidence precedes retry authorization

Before a current attempt's message callback returns, classify any connection-fatal
ERROR that can be fully validated against its framing, sequence, payload, scope
and connection context. Validation and terminal classification do not wait behind
unrelated asynchronous core creation, digest or replay work. Preserve that outcome
for the attempt's existing retry/reporting owner before retirement can authorize
another attempt. Once recorded, a later ordinary Close, timeout or cancellation
cannot downgrade it to a retryable failure. Report it once and stop automatic
retry.

Preserving an outcome does not apply pending terminal events, advance a cursor,
send ACK/input, or revive canceled work. Do not fast-path every ERROR
indiscriminately: nonfatal or attachment/operation-dependent effects retain their
required ordering and validation. A malformed message follows the protocol-error
policy; it does not gain authority from an unvalidated peer-declared fatal flag
or diagnostic. Callbacks that were already stale when dispatched cannot establish
a new outcome for a successor. Connection readiness, cancellation and error
promises settle through their existing single owners, not another banner-emitting
error path.

The guarantee covers fully validated fatal information actually dispatched to the
current callback. It does not cover bytes received internally by the browser but
never dispatched, nor require further application sends during protocol closing.
If restore is pending when valid fatal ERROR arrives and Close follows, canceling
restore must preserve the fatal classification while still fencing every canceled
application effect.

## Hedged roaming

One second after a submitted heartbeat remains unanswered, start one speculative
replacement without retiring the incumbent. A candidate is HELLO-only before
promotion: no ATTACH, input, or shared
core/record mutation. The active connection remains authoritative and can recover,
canceling the candidate. WELCOME proves negotiation, not terminal usability.

Promotion is an explicit ownership cutover. Stop old input/application commits and
snapshot committed cursors before sending replacement ATTACH. Native logical-ID
handover fences the old key and transfers the lease during ATTACH, before barrier
ACK. It is not reversible merely because candidate restoration later fails.
Keep the old viewport as display fallback, not as old controller authority.
A genuinely atomic make-before-break attachment handoff would need protocol work.

Input sent without a received ACK has uncertain delivery. It may have executed.
Never automatically replay it; native bounded deduplication is not an exactly-once
contract. Keep old-key fencing, pending resize ordering, and ACK-before-input.

## Server observability

The Go server emits JSON records and assigns every accepted WebSocket a monotonic
`connection_id`. Upgrade rejection, negotiation, application-frame metadata,
heartbeat probes and responses, scheduling gaps, I/O errors, retirement, and the
final pressure/counter snapshot retain that correlation ID. Frame logs include
type, sequence, request, attachment, session, and byte counts, but never input,
terminal output, checkpoint, or error payload content.

Resize telemetry records the browser request and native queue stages with terminal
geometry. The native worker acknowledgement records the resize operation, ioctl
status, and whether `SIGWINCH` is expected. Retirement summaries retain duration,
outcome, protocol readiness, queue pressure, frame/byte counts, and heartbeat
statistics so a failed mobile resume can be reconstructed from one connection's
records.

## Acceptance gates

Correctness gates precede recovery speed:

- Healthy, delayed, bursty and asymmetric paths: no attachment teardown solely for
  an SLO miss; late PONGs observable; no error-banner or reconnect storm.
- One-way stalls: receive progress cannot impersonate round-trip confirmation
  indefinitely; resource policy remains bounded.
- Exercise full queue/response/negotiation windows, late matching responses,
  unmatched/pre-suspension responses, and unrelated traffic that must not renew
  a missing probe. Require eventual fresh-shell response under the declared
  recovery conditions separately from the unchanged eight-RTT speed result.
- With two unreleased sockets, a third must not be constructed. Neither timeout
  nor zero bufferedAmount releases admission; observable closure permits only
  the work allowed by backoff/capacity. Late closure cannot restart a fatal or
  disposed supervisor or commit retired application state.
- Delayed core creation/digest, large replay, sustained output, slow writers and
  zero credit: bounded queues, control handling schedulable, FIFO wire sequence,
  ACK only after application, and bounded shutdown.
- Block native dispatch and delay browser main-thread work while checking that
  Go RFC control processing is independent, native application-heartbeat delay
  does not independently retire the transport, and saturated input admission
  follows the explicit overload policy without silent message loss.
- Hidden negotiation, frozen execution, timer-before-message resume ordering,
  repeated visibility events: no cascade of stale failure actions.
- Transient startup recovers without duplicate reports; fatal ABI/protocol error
  stops retry and reports once. All attempt promises settle exactly once.
- Exercise protocol-eligible terminal output before Close and forced abort,
  overall drain expiry and queue pressure: preserve FIFO, bounded memory and
  joins-before-free without sending application data after Close.
- Dispatch valid connection-fatal ERROR then Close while restore is pending:
  preserve fatal classification, report once, do not retry or commit canceled
  work. Nonfatal, malformed and already-stale messages must not gain authority
  from a peer-declared fatal flag; ordinary protocol-error rules still apply.
- Retirement/disposal during asynchronous restore: no stale core commit, ACK,
  input, successor teardown, or leaked core.
- Candidate tests, if introduced, prove pre-promotion isolation and no revival of
  fenced authority following failed cutover.
- Isolated browser healthy-path soak and workload/jitter tests assert continuity,
  not merely eventual reconnection. The existing short, steady-latency fault
  matrix is insufficient as a production gate.

Record the deployment profile and supported healthy-path envelope before the
validation run; use the same profile across continuity, pressure, suspension
and fault cases. Do not redefine healthy conditions after observing failures.

Keep the original strict 8x RTT recovery test and expose failures. Do not change
its threshold to make the redesign pass. Report foreground/load assumptions,
false-positive disconnects, latency distributions, and restoration through fresh
shell response separately. A universal finite-time no-false-positive detector or
unconditional eight-RTT bound is not available over arbitrarily delayed TCP and
suspended browser execution.

