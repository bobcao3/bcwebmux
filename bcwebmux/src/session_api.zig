// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Session = @import("Session.zig");
const Registry = @import("SessionRegistry.zig");
const manifest = @import("session_manifest.zig");

const CreateBody = struct {
    profile: []const u8,
    name: ?[]const u8 = null,
    geometry: ?struct {
        cols: u16,
        rows: u16,
        cellWidthPx: u16 = 8,
        cellHeightPx: u16 = 16,
    } = null,
};

const RenameBody = struct {
    name: []const u8,
};

const max_request_bytes = 4096;

pub fn serve(registry: *Registry, expected_origin: []const u8, request: anytype) !bool {
    const target = request.head.target[0 .. std.mem.indexOfScalar(u8, request.head.target, '?') orelse request.head.target.len];
    if (!std.mem.startsWith(u8, target, "/api/")) return false;
    if (isMutation(request.head.method) and !validOrigin(request, expected_origin)) {
        try respondError(request, .forbidden, "forbidden", "same-origin request required");
        return true;
    }

    if (std.mem.eql(u8, target, "/api/server")) {
        if (request.head.method != .GET) {
            try methodNotAllowed(request);
            return true;
        }
        try respondServer(registry, request);
        return true;
    }
    if (std.mem.eql(u8, target, "/api/sessions")) {
        switch (request.head.method) {
            .GET => try respondList(registry, request),
            .POST => try respondCreate(registry, request),
            else => try methodNotAllowed(request),
        }
        return true;
    }
    if (!std.mem.startsWith(u8, target, "/api/sessions/")) {
        try respondError(request, .not_found, "not_found", "API route not found");
        return true;
    }

    const suffix = target["/api/sessions/".len..];
    if (std.mem.endsWith(u8, suffix, "/terminate")) {
        if (request.head.method != .POST) {
            try methodNotAllowed(request);
            return true;
        }
        const id_text = suffix[0 .. suffix.len - "/terminate".len];
        try respondTerminate(registry, request, id_text);
        return true;
    }
    const id = Registry.parseId(suffix) orelse {
        try respondError(request, .not_found, "not_found", "session not found");
        return true;
    };
    switch (request.head.method) {
        .GET => try respondGet(registry, request, id),
        .PATCH => try respondRename(registry, request, id),
        .DELETE => try respondDelete(registry, request, id),
        else => try methodNotAllowed(request),
    }
    return true;
}

fn respondServer(registry: *Registry, request: anytype) !void {
    var output_buffer: [8192]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    var server_id_buffer: [36]u8 = undefined;
    const limits = registry.limits;
    try json.beginObject();
    try json.objectField("protocol");
    try json.write(manifest.protocol);
    try json.objectField("capabilities");
    try json.beginObject();
    try json.objectField("attachmentResume");
    try json.write(true);
    try json.endObject();
    try json.objectField("serverInstance");
    try json.write(Registry.formatId(registry.server_instance, &server_id_buffer));
    try json.objectField("principal");
    try json.write("local");
    try json.objectField("persistence");
    try json.write("memory");
    try json.objectField("liveSessionLifetime");
    try json.write("daemon");
    try json.objectField("checkpointCodec");
    try json.beginObject();
    try json.objectField("name");
    try json.write(manifest.checkpoint_codec);
    try json.objectField("ghosttyCommit");
    try json.write(manifest.ghostty_commit);
    try json.objectField("terminalAbi");
    try json.write(manifest.terminal_abi);
    try json.objectField("terminalConfig");
    try json.write(manifest.terminal_config);
    try json.endObject();
    try json.objectField("commandProfiles");
    try json.beginArray();
    try json.beginObject();
    try json.objectField("id");
    try json.write(manifest.command_profile);
    try json.objectField("label");
    try json.write("Shell");
    try json.endObject();
    try json.endArray();
    try json.objectField("limits");
    try json.beginObject();
    try writeField(&json, "maxLiveSessions", limits.max_live_sessions);
    try writeField(&json, "maxExitedSessions", limits.max_exited_sessions);
    try writeField(&json, "maxAttachmentsPerSession", limits.max_attachments_per_session);
    try writeField(&json, "maxNameBytes", limits.max_name_bytes);
    try writeField(&json, "maxRequestBytes", limits.max_request_bytes);
    try writeField(&json, "maxInputBytes", limits.max_input_bytes);
    try writeField(&json, "maxFrameBytes", limits.max_frame_bytes);
    try writeField(&json, "maxCheckpointBytes", limits.max_checkpoint_bytes);
    try writeField(&json, "scrollbackBytes", limits.scrollback_bytes);
    try writeField(&json, "journalBytes", limits.journal_bytes);
    try writeField(&json, "checkpointOutputBytes", limits.checkpoint_output_bytes);
    try writeField(&json, "checkpointIntervalMs", limits.checkpoint_interval_ms);
    try writeField(&json, "exitedRetentionMs", limits.exited_retention_ms);
    try writeField(&json, "minCols", limits.min_cols);
    try writeField(&json, "maxCols", limits.max_cols);
    try writeField(&json, "minRows", limits.min_rows);
    try writeField(&json, "maxRows", limits.max_rows);
    try json.endObject();
    try writeField(&json, "revision", registry.currentRevision());
    try json.endObject();
    try respondJson(request, .ok, writer.buffered(), null, false);
}

fn respondList(registry: *Registry, request: anytype) !void {
    var sessions: [64]Session.Metadata = undefined;
    const count = registry.list(&sessions);
    var output_buffer: [64 * 1024]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    try json.beginObject();
    try writeField(&json, "revision", registry.currentRevision());
    try json.objectField("sessions");
    try json.beginArray();
    for (sessions[0..count]) |*metadata| try writeMetadata(&json, metadata, registry.currentRevision());
    try json.endArray();
    try json.endObject();
    try respondJson(request, .ok, writer.buffered(), null, false);
}

fn respondCreate(registry: *Registry, request: anytype) !void {
    if (!jsonContentType(request)) return respondError(request, .unsupported_media_type, "content_type", "application/json is required");
    var idempotency_buffer: [128]u8 = undefined;
    const idempotency_key = copyIdempotencyKey(request, &idempotency_buffer) orelse {
        return respondError(request, .bad_request, "idempotency_key_required", "Idempotency-Key is required");
    };
    var body_buffer: [max_request_bytes + 1]u8 = undefined;
    const body = readBody(request, registry.limits.max_request_bytes, &body_buffer) catch |err| {
        return respondBodyError(request, err);
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.smp_allocator);
    defer arena.deinit();
    const parsed = std.json.parseFromSlice(CreateBody, arena.allocator(), body, .{}) catch
        return respondError(request, .bad_request, "invalid_json", "invalid create request");
    defer parsed.deinit();
    const geometry = if (parsed.value.geometry) |value|
        Session.Geometry{
            .cols = value.cols,
            .rows = value.rows,
            .cell_width_px = value.cellWidthPx,
            .cell_height_px = value.cellHeightPx,
        }
    else
        Session.Geometry{ .cols = 80, .rows = 24, .cell_width_px = 8, .cell_height_px = 16 };
    const name = parsed.value.name orelse "";
    const request_hash = sha256(body);
    const result = registry.create(.{
        .profile = parsed.value.profile,
        .name = name,
        .geometry = geometry,
    }, idempotency_key, request_hash) catch |err| return respondRegistryError(request, err);

    var id_buffer: [36]u8 = undefined;
    const id_text = Registry.formatId(result.metadata.id, &id_buffer);
    var location_buffer: [64]u8 = undefined;
    const location = try std.fmt.bufPrint(&location_buffer, "/api/sessions/{s}", .{id_text});
    var output_buffer: [4096]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    try writeMetadata(&json, &result.metadata, registry.currentRevision());
    try respondJson(request, .created, writer.buffered(), location, result.replayed);
}

fn respondGet(registry: *Registry, request: anytype, id: Session.Id) !void {
    var metadata = registry.get(id) orelse return respondError(request, .not_found, "not_found", "session not found");
    var output_buffer: [4096]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    try writeMetadata(&json, &metadata, registry.currentRevision());
    try respondJson(request, .ok, writer.buffered(), null, false);
}

fn respondRename(registry: *Registry, request: anytype, id: Session.Id) !void {
    if (!jsonContentType(request)) return respondError(request, .unsupported_media_type, "content_type", "application/json is required");
    if (idempotencyKey(request) == null)
        return respondError(request, .bad_request, "idempotency_key_required", "Idempotency-Key is required");
    var body_buffer: [max_request_bytes + 1]u8 = undefined;
    const body = readBody(request, registry.limits.max_request_bytes, &body_buffer) catch |err| return respondBodyError(request, err);
    var arena = std.heap.ArenaAllocator.init(std.heap.smp_allocator);
    defer arena.deinit();
    const parsed = std.json.parseFromSlice(RenameBody, arena.allocator(), body, .{}) catch
        return respondError(request, .bad_request, "invalid_json", "invalid rename request");
    defer parsed.deinit();
    var metadata = registry.rename(id, parsed.value.name) catch |err| return respondRegistryError(request, err);
    var output_buffer: [4096]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    try writeMetadata(&json, &metadata, registry.currentRevision());
    try respondJson(request, .ok, writer.buffered(), null, false);
}

fn respondTerminate(registry: *Registry, request: anytype, id_text: []const u8) !void {
    var key_buffer: [128]u8 = undefined;
    const key = copyIdempotencyKey(request, &key_buffer) orelse
        return respondError(request, .bad_request, "idempotency_key_required", "Idempotency-Key is required");
    const request_hash = sha256(id_text);
    const id = Registry.parseId(id_text) orelse return respondError(request, .not_found, "not_found", "session not found");
    var body_buffer: [max_request_bytes + 1]u8 = undefined;
    const body = readBody(request, registry.limits.max_request_bytes, &body_buffer) catch |err| return respondBodyError(request, err);
    if (body.len != 0) return respondError(request, .bad_request, "invalid_body", "request body could not be read");
    const result = registry.terminate(id, key, request_hash) catch |err| return respondRegistryError(request, err);
    var output_buffer: [4096]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    try writeMetadata(&json, &result.metadata, registry.currentRevision());
    try respondJson(request, .accepted, writer.buffered(), null, result.replayed);
}

fn respondDelete(registry: *Registry, request: anytype, id: Session.Id) !void {
    if (idempotencyKey(request) == null)
        return respondError(request, .bad_request, "idempotency_key_required", "Idempotency-Key is required");
    var body_buffer: [max_request_bytes + 1]u8 = undefined;
    const body = readBody(request, registry.limits.max_request_bytes, &body_buffer) catch |err| return respondBodyError(request, err);
    if (body.len != 0) return respondError(request, .bad_request, "invalid_body", "request body could not be read");
    registry.delete(id) catch |err| return respondRegistryError(request, err);
    const headers = noContentHeaders();
    try request.respond("", .{ .status = .no_content, .extra_headers = &headers, .keep_alive = responseKeepAlive(request) });
}

fn writeMetadata(json: *std.json.Stringify, metadata: *const Session.Metadata, revision: u64) !void {
    var id_buffer: [36]u8 = undefined;
    var generation_buffer: [36]u8 = undefined;
    var attachment_id_buffer: [16]u8 = undefined;
    var lease_epoch_buffer: [32]u8 = undefined;
    try json.beginObject();
    try json.objectField("id");
    try json.write(Registry.formatId(metadata.id, &id_buffer));
    try json.objectField("generation");
    try json.write(Registry.formatId(metadata.generation, &generation_buffer));
    try json.objectField("name");
    try json.write(metadata.nameSlice());
    try json.objectField("title");
    try json.write(metadata.titleSlice());
    try json.objectField("state");
    try json.write(@tagName(metadata.state));
    try writeField(json, "createdAtMs", metadata.created_at_ms);
    try writeField(json, "lastActivityMs", metadata.last_activity_ms);
    try json.objectField("geometry");
    try json.beginObject();
    try writeField(json, "cols", metadata.geometry.cols);
    try writeField(json, "rows", metadata.geometry.rows);
    try writeField(json, "cellWidthPx", metadata.geometry.cell_width_px);
    try writeField(json, "cellHeightPx", metadata.geometry.cell_height_px);
    try json.endObject();
    try writeField(json, "attachments", metadata.attachment_count);
    try json.objectField("controller");
    if (metadata.controller_attachment_id) |attachment_id| {
        const attachment_id_text = try std.fmt.bufPrint(&attachment_id_buffer, "{x:0>16}", .{attachment_id});
        const lease_epoch_text = try std.fmt.bufPrint(&lease_epoch_buffer, "{d}", .{metadata.lease_epoch});
        try json.beginObject();
        try json.objectField("attachmentId");
        try json.write(attachment_id_text);
        try json.objectField("leaseEpoch");
        try json.write(lease_epoch_text);
        try json.endObject();
    } else {
        try json.write(null);
    }
    try json.objectField("exitStatus");
    if (metadata.exit_status) |status| try json.write(status) else try json.write(null);
    try writeField(json, "eventSeq", metadata.event_seq);
    try writeField(json, "outputOffset", metadata.output_offset);
    try writeField(json, "checkpointEventSeq", metadata.checkpoint_event_seq);
    try writeField(json, "checkpointBytes", metadata.checkpoint_bytes);
    try writeField(json, "revision", revision);
    try json.endObject();
}

fn writeField(json: *std.json.Stringify, name: []const u8, value: anytype) !void {
    try json.objectField(name);
    try json.write(value);
}

fn readBody(request: anytype, limit: usize, output: []u8) ![]const u8 {
    if (request.head.content_length) |content_length|
        if (content_length > @as(u64, limit)) return error.BodyTooLarge;
    if (request.head.content_length == null and request.head.transfer_encoding == .none and requestHasBody(request.head.method))
        return output[0..0];
    if (@hasDecl(@TypeOf(request.*), "memoryBody"))
        return request.memoryBody(limit, output);
    var reader_buffer: [4096]u8 = undefined;
    if (request.head.expect != null) {
        const reader = try request.readerExpectContinue(&reader_buffer);
        const count = try reader.readSliceShort(output);
        if (count > limit) return error.BodyTooLarge;
        return output[0..count];
    }
    const reader = request.readerExpectNone(&reader_buffer);
    const count = try reader.readSliceShort(output);
    if (count > limit) return error.BodyTooLarge;
    return output[0..count];
}

fn respondBodyError(request: anytype, err: anyerror) !void {
    return switch (err) {
        error.BodyTooLarge => respondError(request, .payload_too_large, "body_too_large", "request body is too large"),
        else => respondError(request, .bad_request, "invalid_body", "request body could not be read"),
    };
}

fn respondRegistryError(request: anytype, err: anyerror) !void {
    return switch (err) {
        error.SessionNotFound => respondError(request, .not_found, "not_found", "session not found"),
        error.SessionRunning, error.SessionBusy => respondError(request, .conflict, "session_running", "session has not exited"),
        error.LiveSessionLimit, error.RetainedSessionLimit => respondError(request, .too_many_requests, "session_limit", "session limit reached"),
        error.IdempotencyConflict => respondError(request, .conflict, "idempotency_conflict", "Idempotency-Key was reused for another request"),
        error.UnknownCommandProfile => respondError(request, .unprocessable_entity, "profile", "unknown command profile"),
        error.InvalidSessionName => respondError(request, .unprocessable_entity, "name", "invalid session name"),
        error.InvalidGeometry => respondError(request, .unprocessable_entity, "geometry", "invalid terminal geometry"),
        error.InvalidSessionState => respondError(request, .conflict, "state", "operation is invalid for session state"),
        else => respondError(request, .internal_server_error, "internal", "session operation failed"),
    };
}

fn respondError(request: anytype, status: std.http.Status, code: []const u8, message: []const u8) !void {
    var output_buffer: [1024]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    try json.beginObject();
    try json.objectField("error");
    try json.beginObject();
    try json.objectField("code");
    try json.write(code);
    try json.objectField("message");
    try json.write(message);
    try json.endObject();
    try json.endObject();
    try respondJson(request, status, writer.buffered(), null, false);
}

fn respondJson(request: anytype, status: std.http.Status, body: []const u8, location: ?[]const u8, replayed: bool) !void {
    const base = responseHeaders();
    if (location) |value| {
        const headers = base ++ [_]std.http.Header{
            .{ .name = "Location", .value = value },
            .{ .name = "Idempotency-Replayed", .value = if (replayed) "true" else "false" },
        };
        return request.respond(body, .{ .status = status, .extra_headers = &headers, .keep_alive = responseKeepAlive(request) });
    }
    const headers = base ++ [_]std.http.Header{
        .{ .name = "Idempotency-Replayed", .value = if (replayed) "true" else "false" },
    };
    try request.respond(body, .{ .status = status, .extra_headers = &headers, .keep_alive = responseKeepAlive(request) });
}

fn responseHeaders() [5]std.http.Header {
    return .{
        .{ .name = "Content-Type", .value = "application/json; charset=utf-8" },
        .{ .name = "Cache-Control", .value = "no-store" },
        .{ .name = "Content-Security-Policy", .value = "default-src 'none'; frame-ancestors 'none'" },
        .{ .name = "X-Content-Type-Options", .value = "nosniff" },
        .{ .name = "Referrer-Policy", .value = "no-referrer" },
    };
}

fn noContentHeaders() [4]std.http.Header {
    return .{
        .{ .name = "Cache-Control", .value = "no-store" },
        .{ .name = "Content-Security-Policy", .value = "default-src 'none'; frame-ancestors 'none'" },
        .{ .name = "X-Content-Type-Options", .value = "nosniff" },
        .{ .name = "Referrer-Policy", .value = "no-referrer" },
    };
}

fn methodNotAllowed(request: anytype) !void {
    try respondError(request, .method_not_allowed, "method_not_allowed", "method not allowed");
}

fn isMutation(method: std.http.Method) bool {
    return method == .POST or method == .PATCH or method == .DELETE;
}

fn requestHasBody(method: std.http.Method) bool {
    return method == .POST or method == .PUT or method == .PATCH or method == .DELETE;
}

fn responseKeepAlive(request: anytype) bool {
    return !(requestHasBody(request.head.method) and request.head.content_length == null and request.head.transfer_encoding == .none);
}

fn validOrigin(request: anytype, expected: []const u8) bool {
    if (expected.len == 0) return true;
    var headers = request.iterateHeaders();
    while (headers.next()) |header|
        if (std.ascii.eqlIgnoreCase(header.name, "Origin")) return std.mem.eql(u8, header.value, expected);
    return false;
}

fn idempotencyKey(request: anytype) ?[]const u8 {
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "Idempotency-Key")) continue;
        if (header.value.len == 0 or header.value.len > 128) return null;
        return header.value;
    }
    return null;
}

fn copyIdempotencyKey(request: anytype, buffer: []u8) ?[]const u8 {
    const value = idempotencyKey(request) orelse return null;
    if (value.len > buffer.len) return null;
    @memcpy(buffer[0..value.len], value);
    return buffer[0..value.len];
}

fn jsonContentType(request: anytype) bool {
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "Content-Type")) continue;
        const value = std.mem.trim(u8, header.value, " \t");
        return std.ascii.startsWithIgnoreCase(value, "application/json") and
            (value.len == "application/json".len or value["application/json".len] == ';');
    }
    return false;
}

fn sha256(bytes: []const u8) [32]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return digest;
}

pub const MemoryInput = struct {
    method: std.http.Method,
    target: []const u8,
    origin: []const u8 = "",
    content_type: []const u8 = "",
    idempotency_key: []const u8 = "",
    body: []const u8 = "",
};

pub const MemoryResponse = struct {
    allocator: std.mem.Allocator,
    body: []u8,
    content_type: []u8,
    location: ?[]u8,
    status: std.http.Status,
    replayed: bool,

    pub fn deinit(self: *MemoryResponse) void {
        if (self.body.len != 0) self.allocator.free(self.body);
        if (self.content_type.len != 0) self.allocator.free(self.content_type);
        if (self.location) |location| self.allocator.free(location);
        self.* = undefined;
    }
};

const MemoryHeaderIterator = struct {
    headers: []const std.http.Header,
    index: usize = 0,

    pub fn next(self: *MemoryHeaderIterator) ?std.http.Header {
        if (self.index == self.headers.len) return null;
        const header = self.headers[self.index];
        self.index += 1;
        return header;
    }
};

const MemoryRequest = struct {
    head: struct {
        method: std.http.Method,
        target: []const u8,
        content_length: ?u64,
        transfer_encoding: std.http.TransferEncoding,
        expect: ?[]const u8,
    },
    headers: [3]std.http.Header = undefined,
    header_count: usize = 0,
    body: []const u8,
    response: *MemoryResponse,

    fn init(input: MemoryInput, response: *MemoryResponse) MemoryRequest {
        var request = MemoryRequest{
            .head = .{
                .method = input.method,
                .target = input.target,
                .content_length = input.body.len,
                .transfer_encoding = .none,
                .expect = null,
            },
            .body = input.body,
            .response = response,
        };
        if (input.origin.len != 0) {
            request.headers[request.header_count] = .{ .name = "Origin", .value = input.origin };
            request.header_count += 1;
        }
        if (input.content_type.len != 0) {
            request.headers[request.header_count] = .{ .name = "Content-Type", .value = input.content_type };
            request.header_count += 1;
        }
        if (input.idempotency_key.len != 0) {
            request.headers[request.header_count] = .{ .name = "Idempotency-Key", .value = input.idempotency_key };
            request.header_count += 1;
        }
        return request;
    }

    pub fn iterateHeaders(self: *MemoryRequest) MemoryHeaderIterator {
        return .{ .headers = self.headers[0..self.header_count] };
    }

    pub fn memoryBody(self: *MemoryRequest, limit: usize, output: []u8) ![]const u8 {
        if (self.body.len > limit or self.body.len > output.len) return error.BodyTooLarge;
        @memcpy(output[0..self.body.len], self.body);
        return output[0..self.body.len];
    }

    pub fn respond(self: *MemoryRequest, body: []const u8, options: anytype) !void {
        var content_type: []const u8 = "";
        var location: ?[]const u8 = null;
        var replayed = false;
        for (options.extra_headers) |header| {
            if (std.ascii.eqlIgnoreCase(header.name, "Content-Type")) content_type = header.value;
            if (std.ascii.eqlIgnoreCase(header.name, "Location")) location = header.value;
            if (std.ascii.eqlIgnoreCase(header.name, "Idempotency-Replayed"))
                replayed = std.mem.eql(u8, header.value, "true");
        }
        const allocator = self.response.allocator;
        const copied_body = try allocator.dupe(u8, body);
        errdefer allocator.free(copied_body);
        const copied_content_type = try allocator.dupe(u8, content_type);
        errdefer if (copied_content_type.len != 0) allocator.free(copied_content_type);
        const copied_location = if (location) |value| try allocator.dupe(u8, value) else null;
        errdefer if (copied_location) |value| allocator.free(value);
        self.response.body = copied_body;
        self.response.content_type = copied_content_type;
        self.response.location = copied_location;
        self.response.status = options.status;
        self.response.replayed = replayed;
    }
};

pub fn serveMemory(
    registry: *Registry,
    expected_origin: []const u8,
    allocator: std.mem.Allocator,
    input: MemoryInput,
) !MemoryResponse {
    var response = MemoryResponse{
        .allocator = allocator,
        .body = &.{},
        .content_type = &.{},
        .location = null,
        .status = .ok,
        .replayed = false,
    };
    errdefer response.deinit();
    var request = MemoryRequest.init(input, &response);
    if (!try serve(registry, expected_origin, &request)) return error.NotApi;
    return response;
}
