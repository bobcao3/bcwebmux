// SPDX-License-Identifier: MIT
const std = @import("std");
const manifest = @import("session_manifest.zig");
const worker = @import("session_worker.zig");
const c = @cImport({
    @cDefine("_XOPEN_SOURCE", "600");
    @cDefine("_FORTIFY_SOURCE", "0");
    @cInclude("fcntl.h");
    @cInclude("poll.h");
    @cInclude("pty.h");
    @cInclude("pwd.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

const packet_capacity = worker.packet_capacity;
pub fn validTerm(term: []const u8) bool {
    if (term.len == 0 or term.len > 256) return false;
    for (term) |byte| {
        if (byte <= ' ' or byte == 127 or byte == '=' or byte == 0) return false;
    }
    return true;
}

fn resolveHome(allocator: std.mem.Allocator) ![:0]const u8 {
    const env_home = c.getenv("HOME");
    const path = if (env_home != null and env_home[0] != 0)
        std.mem.span(env_home)
    else blk: {
        const entry = c.getpwuid(c.getuid()) orelse return error.HomeDirectoryUnavailable;
        if (entry.*.pw_dir == null or entry.*.pw_dir[0] == 0) return error.HomeDirectoryUnavailable;
        break :blk std.mem.span(entry.*.pw_dir);
    };
    // Relative HOME would still depend on the server's launch directory.
    if (!std.fs.path.isAbsolute(path)) return error.InvalidHomeDirectory;
    return allocator.dupeZ(u8, path);
}

// Unix seqpacket send/recv retain MSG_NOSIGNAL/DONTWAIT/TRUNC absent from
// std.Io's IP-only message API.
const output_coalescing_interval_ms = 1;
var worker_terminate_signal: std.atomic.Value(bool) = .init(false);
var interrupted_packet: [packet_capacity]u8 = undefined;
var interrupted_packet_len: usize = 0;
// The single worker loop owns this slot; the signal handler only touches the atomic flag.

fn workerTerminateSignalHandler(_: std.posix.SIG) callconv(.c) void {
    worker_terminate_signal.store(true, .release);
}

pub fn run(io: std.Io, shell: [:0]const u8, term: [:0]const u8, kitty_graphics: bool, cols: u16, rows: u16, limits: manifest.Limits) !void {
    if (shell.len == 0 or std.mem.indexOfScalar(u8, shell, 0) != null or !validTerm(term)) return error.InvalidArgument;
    // Resolve NSS/passwd data and own the path before fork. Never change the
    // worker's cwd: only the terminal child should start in the user's home.
    const home = try resolveHome(std.heap.page_allocator);
    defer std.heap.page_allocator.free(home);
    worker_terminate_signal.store(false, .release);
    interrupted_packet_len = 0;
    const signal_action: std.posix.Sigaction = .{
        .handler = .{ .handler = workerTerminateSignalHandler },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    var previous_action: std.posix.Sigaction = undefined;
    std.posix.sigaction(.USR1, &signal_action, &previous_action);
    defer std.posix.sigaction(.USR1, &previous_action, null);
    const channel = std.posix.STDIN_FILENO;
    var master: c_int = -1;
    var size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
    size.ws_col = cols;
    size.ws_row = rows;
    const pid = c.forkpty(&master, null, null, &size);
    if (pid < 0) return error.ForkPtyFailed;
    if (pid == 0) {
        // std.process.replace is forbidden after fork; retain execvp/_exit here.
        if (c.chdir(home.ptr) != 0) {
            const message = "bcwebmux: cannot change to home directory: ";
            _ = c.write(std.posix.STDERR_FILENO, message.ptr, message.len);
            _ = c.write(std.posix.STDERR_FILENO, home.ptr, home.len);
            _ = c.write(std.posix.STDERR_FILENO, "\n", 1);
            c._exit(126);
        }
        _ = c.setenv("TERM", term.ptr, 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        _ = c.setenv("TERM_PROGRAM", "bcwebmux", 1);
        // A nonzero synthetic window ID enables Kitty graphics clients which
        // gate their protocol support on this variable rather than probing.
        if (kitty_graphics) {
            _ = c.setenv("KITTY_WINDOW_ID", "1", 1);
        } else {
            _ = c.unsetenv("KITTY_WINDOW_ID");
        }
        var argv = [_:null]?[*:0]const u8{ shell.ptr, "-l" };
        _ = c.execvp(shell.ptr, @ptrCast(&argv));
        c._exit(127);
    }
    var child_reaped = false;
    var child_status: c_int = 0;
    defer {
        if (!child_reaped) {
            _ = c.kill(-pid, c.SIGHUP);
            _ = c.kill(-pid, c.SIGTERM);
            _ = c.kill(-pid, c.SIGKILL);
            // Direct pid SIGKILL covers the pre-setsid forkpty race.
            _ = c.kill(pid, c.SIGKILL);
            // Retain waitpid for raw wait status and WNOHANG handling.
            while (true) {
                const waited = c.waitpid(pid, &child_status, 0);
                if (waited == pid) {
                    child_reaped = true;
                    break;
                }
                if (waited < 0 and std.c.errno(waited) == .INTR) continue;
                break;
            }
        }
    }
    const master_file: std.Io.File = .{ .handle = master, .flags = .{ .nonblocking = true } };
    defer master_file.close(io);
    const master_flags = c.fcntl(master, c.F_GETFL);
    if (master_flags < 0 or c.fcntl(master, c.F_SETFL, master_flags | c.O_NONBLOCK) < 0)
        return error.PtyConfigurationFailed;
    // std.Io has no PTY setup/readiness multiplexer; raw forkpty/ioctl/fcntl/poll
    // remain here while ordinary PTY read/write/close use File.

    // Signal handler and PTY cleanup are installed before the parent may signal termination.
    const ready_packet = [_]u8{@intFromEnum(worker.Kind.ready)};
    if (!sendPacket(channel, &ready_packet)) return error.WorkerReadyFailed;

    var termination_started_ms: ?i64 = null;
    var packet: [packet_capacity]u8 = undefined;
    worker_loop: while (true) {
        if (worker_terminate_signal.swap(false, .acq_rel) and termination_started_ms == null) {
            _ = c.kill(-pid, c.SIGHUP);
            _ = c.kill(-pid, c.SIGTERM);
            termination_started_ms = std.Io.Clock.awake.now(io).toMilliseconds();
        }
        var drained_for_resize = false;
        // Once terminating, defer draining until the child is reaped so continuous
        // output cannot starve the grace deadline.
        var descriptors = [_]c.struct_pollfd{
            .{ .fd = if (termination_started_ms == null) channel else -1, .events = c.POLLIN, .revents = 0 },
            .{ .fd = if (termination_started_ms == null) master else -1, .events = c.POLLIN, .revents = 0 },
        };
        const timeout: c_int = if (termination_started_ms != null) 100 else 500;
        const poll_result = c.poll(&descriptors, descriptors.len, timeout);
        if (poll_result < 0) {
            if (std.c.errno(poll_result) == .INTR) continue;
            return error.PollFailed;
        }

        if ((descriptors[0].revents & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
            const count = c.recv(channel, &packet, packet.len, c.MSG_DONTWAIT | c.MSG_TRUNC);
            if (count == -1 and (std.c.errno(count) == .INTR or std.c.errno(count) == .AGAIN)) continue;
            if (count <= 0) {
                if (termination_started_ms == null) {
                    _ = c.kill(-pid, c.SIGHUP);
                    _ = c.kill(-pid, c.SIGTERM);
                    termination_started_ms = std.Io.Clock.awake.now(io).toMilliseconds();
                }
            } else {
                if (count > packet.len) return error.InvalidWorkerPacket;
                const data = packet[0..@intCast(count)];
                const kind = worker.decodeKind(data[0]) orelse continue;
                switch (kind) {
                    .input => {
                        if (!writeAll(io, channel, master_file, data[1..])) {
                            if (worker_terminate_signal.load(.acquire)) continue :worker_loop;
                            return;
                        }
                    },
                    .resize => if (data.len == 17) {
                        var resize_payload: [16]u8 = undefined;
                        std.mem.copyForwards(u8, &resize_payload, data[1..17]);
                        if (!drainAvailableOutput(io, channel, master_file, &packet)) {
                            if (worker_terminate_signal.load(.acquire)) continue :worker_loop;
                            return;
                        }
                        drained_for_resize = true;
                        var next_size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
                        next_size.ws_col = std.mem.readInt(u16, resize_payload[8..10], .little);
                        next_size.ws_row = std.mem.readInt(u16, resize_payload[10..12], .little);
                        const status: u8 = if (next_size.ws_col != 0 and next_size.ws_row != 0 and c.ioctl(master, c.TIOCSWINSZ, &next_size) == 0) 0 else 1;
                        var acknowledgement: [18]u8 = undefined;
                        acknowledgement[0] = @intFromEnum(worker.Kind.resize_applied);
                        std.mem.copyForwards(u8, acknowledgement[1..17], &resize_payload);
                        acknowledgement[17] = status;
                        if (!sendPacket(channel, &acknowledgement)) {
                            if (worker_terminate_signal.load(.acquire)) continue :worker_loop;
                            return;
                        }
                    },
                    .terminate => if (termination_started_ms == null) {
                        _ = c.kill(-pid, c.SIGHUP);
                        _ = c.kill(-pid, c.SIGTERM);
                        termination_started_ms = std.Io.Clock.awake.now(io).toMilliseconds();
                    },
                    else => {},
                }
            }
        }

        if (termination_started_ms == null and !drained_for_resize and (descriptors[1].revents & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
            if (!drainAvailableOutput(io, channel, master_file, &packet)) {
                if (worker_terminate_signal.load(.acquire)) continue :worker_loop;
                return;
            }
        }

        const waited = c.waitpid(pid, &child_status, c.WNOHANG);
        if (waited == pid) {
            child_reaped = true;
            // Stop remaining writers before final drain.
            _ = c.kill(-pid, c.SIGHUP);
            _ = c.kill(-pid, c.SIGTERM);
            _ = c.kill(-pid, c.SIGKILL);
            // Cleanup cannot be interrupted by redundant termination requests.
            const ignore_action: std.posix.Sigaction = .{
                .handler = .{ .handler = std.posix.SIG.IGN },
                .mask = std.posix.sigemptyset(),
                .flags = 0,
            };
            std.posix.sigaction(.USR1, &ignore_action, null);
            worker_terminate_signal.store(false, .release);
            // Replay the interrupted packet before remaining PTY bytes, preserving output/resize acknowledgement order.
            if (interrupted_packet_len != 0) {
                if (!sendPacket(channel, interrupted_packet[0..interrupted_packet_len])) return;
                interrupted_packet_len = 0;
            }
            _ = drainAvailableOutput(io, channel, master_file, &packet);
            drainChannel(channel, &packet);
            var exit_packet: [5]u8 = undefined;
            exit_packet[0] = @intFromEnum(worker.Kind.exited);
            std.mem.writeInt(i32, exit_packet[1..5], child_status, .little);
            _ = sendPacket(channel, &exit_packet);
            return;
        }
        if (termination_started_ms) |started_ms| {
            if (std.Io.Clock.awake.now(io).toMilliseconds() - started_ms >= limits.termination_grace_ms)
                _ = c.kill(-pid, c.SIGKILL);
        }
    }
}

fn sendPacket(fd: c_int, packet: []const u8) bool {
    while (true) {
        const result = c.send(fd, packet.ptr, packet.len, c.MSG_NOSIGNAL | c.MSG_DONTWAIT);
        if (result == @as(isize, @intCast(packet.len))) return true;
        if (worker_terminate_signal.load(.acquire)) {
            std.debug.assert(interrupted_packet_len == 0);
            @memcpy(interrupted_packet[0..packet.len], packet);
            interrupted_packet_len = packet.len;
            return false;
        }
        if (result == -1 and std.c.errno(result) == .INTR) continue;
        if (result == -1 and std.c.errno(result) == .AGAIN) {
            var wait = [_]c.struct_pollfd{.{ .fd = fd, .events = c.POLLOUT, .revents = 0 }};
            const waited = c.poll(&wait, wait.len, 100);
            if (waited < 0) {
                if (std.c.errno(waited) == .INTR) continue;
                return false;
            }
            if ((wait[0].revents & (c.POLLHUP | c.POLLERR | c.POLLNVAL)) != 0) return false;
            continue;
        }
        std.log.err("worker packet send failed: result={d}, expected packet length={d}, errno={t}", .{ result, packet.len, std.c.errno(result) });
        return false;
    }
}

fn writeAll(io: std.Io, channel: c_int, master: std.Io.File, bytes: []const u8) bool {
    var output_packet: [packet_capacity]u8 = undefined;
    var remaining = bytes;
    while (remaining.len != 0) {
        if (worker_terminate_signal.load(.acquire)) return false;
        const count = master.writeStreaming(io, &.{}, &.{remaining}, 1) catch |err| switch (err) {
            error.WouldBlock => {
                // Drain output while waiting for PTY input room to avoid
                // bidirectional backpressure deadlock.
                var wait = [_]c.struct_pollfd{
                    .{ .fd = master.handle, .events = c.POLLIN | c.POLLOUT, .revents = 0 },
                    .{ .fd = channel, .events = 0, .revents = 0 },
                };
                const waited = c.poll(&wait, wait.len, 100);
                if (waited < 0) {
                    if (std.c.errno(waited) == .INTR) continue;
                    return false;
                }
                if ((wait[1].revents & (c.POLLHUP | c.POLLERR | c.POLLNVAL)) != 0) return false;
                if ((wait[0].revents & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0 and
                    !drainAvailableOutput(io, channel, master, &output_packet)) return false;
                continue;
            },
            else => return false,
        };
        if (count == 0) return false;
        remaining = remaining[@intCast(count)..];
    }
    return true;
}

fn drainAvailableOutput(io: std.Io, channel: c_int, master: std.Io.File, packet: *[packet_capacity]u8) bool {
    var length: usize = 0;
    var waited_for_output = false;
    read_loop: while (true) {
        if (worker_terminate_signal.load(.acquire)) {
            if (length != 0) {
                packet[0] = @intFromEnum(worker.Kind.output);
                _ = sendPacket(channel, packet[0 .. length + 1]);
            }
            return false;
        }
        const count = master.readStreaming(io, &.{packet[1 + length ..]}) catch |err| switch (err) {
            error.WouldBlock => {
                if (length == 0) return true;
                if (!waited_for_output) {
                    waited_for_output = true;
                    var wait = [_]c.struct_pollfd{.{ .fd = master.handle, .events = c.POLLIN, .revents = 0 }};
                    while (true) {
                        const waited = c.poll(&wait, wait.len, output_coalescing_interval_ms);
                        if (waited < 0 and std.c.errno(waited) == .INTR) {
                            if (worker_terminate_signal.load(.acquire)) continue :read_loop;
                            continue;
                        }
                        if (waited > 0) continue :read_loop;
                        break;
                    }
                }
                packet[0] = @intFromEnum(worker.Kind.output);
                if (!sendPacket(channel, packet[0 .. length + 1])) return false;
                return true;
            },
            error.EndOfStream => 0,
            error.InputOutput => 0, // Normal Linux PTY EOF.
            else => return false,
        };
        if (count > 0) {
            length += @intCast(count);
            if (length == packet.len - 1) {
                packet[0] = @intFromEnum(worker.Kind.output);
                if (!sendPacket(channel, packet[0 .. length + 1])) return false;
                length = 0;
                waited_for_output = false;
            }
            continue :read_loop;
        } else {
            if (length != 0) {
                packet[0] = @intFromEnum(worker.Kind.output);
                if (!sendPacket(channel, packet[0 .. length + 1])) return false;
            }
            return true;
        }
    }
}

fn drainChannel(channel: c_int, packet: *[packet_capacity]u8) void {
    while (true) {
        const count = c.recv(channel, packet, packet.len, c.MSG_DONTWAIT);
        if (count > 0) continue;
        if (count == -1 and std.c.errno(count) == .INTR) continue;
        return;
    }
}
