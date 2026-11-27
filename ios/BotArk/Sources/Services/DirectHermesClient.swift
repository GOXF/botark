import Foundation

public struct ParsedHermesSseEvent: Equatable, Sendable {
    public let event: String
    public let data: String
}

/// Incremental SSE parser for standalone Hermes API Server streaming on iOS.
public struct HermesSseParser: Sendable {
    private var currentEvent = ""
    private var currentData: [String] = []

    public init() {}

    public mutating func feedLine(_ rawLine: String) -> ParsedHermesSseEvent? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty {
            defer {
                currentEvent = ""
                currentData = []
            }
            guard !currentData.isEmpty else { return nil }
            return ParsedHermesSseEvent(
                event: currentEvent.isEmpty ? "message" : currentEvent,
                data: currentData.joined(separator: "\n")
            )
        }
        if line.hasPrefix(":") { return nil }
        if line.hasPrefix("event:") {
            currentEvent = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
            let value = line.dropFirst(5)
            currentData.append(value.hasPrefix(" ") ? String(value.dropFirst()) : String(value))
        }
        return nil
    }
}

public enum DirectHermesError: LocalizedError {
    case invalidUrl(String)
    case httpError(Int, String)

    public var errorDescription: String? {
        switch self {
        case .invalidUrl(let u): return String.localizedStringWithFormat(String(localized: "Invalid Hermes server URL: %@"), u)
        case .httpError(let code, let msg): return "Hermes HTTP \(code): \(msg)"
        }
    }
}

/// Standalone zero-server Hermes client on iOS.
/// Used automatically when BotArk Desktop is asleep/offline and the user chats with a Hermes bot.
public actor DirectHermesClient {
    private let session: URLSession
    private var activeRunIds: [String: String] = [:]

    public init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: cfg)
    }

    public static func normalizeBaseUrl(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "http://\(s)" }
        while s.hasSuffix("/") { s.removeLast() }
        if s.lowercased().hasSuffix("/v1/chat/completions") {
            s = String(s.dropLast("/v1/chat/completions".count))
        } else if s.lowercased().hasSuffix("/v1") {
            s = String(s.dropLast(3))
        }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    public func probe(baseUrl: String, apiKey: String?) async throws -> (version: String?, defaultModel: String) {
        let base = Self.normalizeBaseUrl(baseUrl)
        var version: String?
        if let healthUrl = URL(string: "\(base)/health") {
            if let (data, resp) = try? await session.data(from: healthUrl),
               let http = resp as? HTTPURLResponse, http.statusCode == 200,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                version = obj["version"] as? String
            }
        }
        guard let modelsUrl = URL(string: "\(base)/v1/models") else {
            throw DirectHermesError.invalidUrl(baseUrl)
        }
        var req = URLRequest(url: modelsUrl)
        if let key = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw DirectHermesError.httpError(0, String(localized: "No Response"))
        }
        guard http.statusCode == 200 else {
            throw DirectHermesError.httpError(http.statusCode, http.statusCode == 401 ? String(localized: "Invalid API Key") : String(localized: "Connection Failed"))
        }
        var model = "hermes-agent"
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let list = obj["data"] as? [[String: Any]],
           let first = list.first?["id"] as? String, !first.isEmpty {
            model = first
        }
        return (version, model)
    }

    private func createSession(base: String, apiKey: String?, title: String, model: String?) async throws -> String {
        guard let url = URL(string: "\(base)/api/sessions") else {
            throw DirectHermesError.invalidUrl(base)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = apiKey, !key.isEmpty {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        var body: [String: Any] = ["source": "api_server", "title": String(title.prefix(60))]
        if let model, !model.isEmpty, model != "hermes-agent" { body["model"] = model }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw DirectHermesError.httpError(0, String(localized: "Could Not Create Session"))
        }
        guard (200...299).contains(http.statusCode) else {
            throw DirectHermesError.httpError(http.statusCode, String(localized: "Session Creation Failed"))
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let sess = obj["session"] as? [String: Any], let id = sess["id"] as? String { return id }
            if let id = obj["id"] as? String { return id }
        }
        throw DirectHermesError.httpError(502, String(localized: "Missing Session ID"))
    }

    public func streamChat(
        credential: DirectHermesCredential,
        botId: String,
        sessionId existingSessionId: String?,
        text: String,
        onDelta: @escaping @Sendable (String, String, [SyncedToolCall], String?) -> Void,
        onApproval: @escaping @Sendable ([SyncedApproval]) -> Void
    ) async throws -> (messageId: String, sessionId: String?, finalText: String, tools: [SyncedToolCall]) {
        let base = Self.normalizeBaseUrl(credential.baseUrl)
        var sid = existingSessionId
        var useOpenAIFallback = false

        if sid == nil || sid?.isEmpty == true {
            do {
                sid = try await createSession(base: base, apiKey: credential.apiKey, title: text, model: credential.model)
            } catch DirectHermesError.httpError(let code, _) where code == 404 || code == 405 || code == 501 {
                useOpenAIFallback = true
            }
        }

        if !useOpenAIFallback, let sessionId = sid {
            do {
                return try await streamNativeSession(
                    base: base,
                    credential: credential,
                    botId: botId,
                    sessionId: sessionId,
                    text: text,
                    onDelta: onDelta,
                    onApproval: onApproval
                )
            } catch DirectHermesError.httpError(let code, _) where code == 404 || code == 405 || code == 501 {
                useOpenAIFallback = true
            }
        }

        return try await streamOpenAIFallback(
            base: base,
            credential: credential,
            botId: botId,
            sessionId: sid,
            text: text,
            onDelta: onDelta
        )
    }

    private func streamNativeSession(
        base: String,
        credential: DirectHermesCredential,
        botId: String,
        sessionId: String,
        text: String,
        onDelta: @escaping @Sendable (String, String, [SyncedToolCall], String?) -> Void,
        onApproval: @escaping @Sendable ([SyncedApproval]) -> Void
    ) async throws -> (String, String?, String, [SyncedToolCall]) {
        let encodedSid = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        guard let url = URL(string: "\(base)/api/sessions/\(encodedSid)/chat/stream") else {
            throw DirectHermesError.invalidUrl(base)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("botark-ios:\(botId)", forHTTPHeaderField: "X-Hermes-Session-Key")
        if let key = credential.apiKey, !key.isEmpty {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        var body: [String: Any] = ["message": text]
        if let model = credential.model, !model.isEmpty { body["model"] = model }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (bytes, resp) = try await session.bytes(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw DirectHermesError.httpError(0, String(localized: "No Response"))
        }
        guard http.statusCode == 200 else {
            throw DirectHermesError.httpError(http.statusCode, String(localized: "Streaming Request Failed"))
        }

        var parser = HermesSseParser()
        var messageId = "hermes_\(Int(Date().timeIntervalSince1970 * 1000))"
        var effectiveSid = http.value(forHTTPHeaderField: "X-Hermes-Session-Id") ?? sessionId
        var accumulated = ""
        var completed = ""
        var tools: [SyncedToolCall] = []

        for try await line in bytes.lines {
            guard let frame = parser.feedLine(line) else { continue }
            guard frame.data != "[DONE]",
                  let data = frame.data.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            if let runId = obj["run_id"] as? String, !runId.isEmpty {
                activeRunIds[credential.accountId] = runId
            }
            if let s = obj["session_id"] as? String, !s.isEmpty { effectiveSid = s }

            switch frame.event {
            case "message.started":
                if let m = obj["message"] as? [String: Any], let id = m["id"] as? String {
                    messageId = "hermes_\(id)"
                }
            case "assistant.delta":
                if let id = obj["message_id"] as? String { messageId = "hermes_\(id)" }
                if let delta = obj["delta"] as? String, !delta.isEmpty {
                    accumulated += delta
                    onDelta(messageId, accumulated, tools, effectiveSid)
                }
            case "tool.started":
                let name = (obj["tool_name"] as? String) ?? "tool"
                let preview = obj["preview"] as? String
                tools.append(SyncedToolCall(id: "t_\(tools.count + 1)", name: name, status: "running", summary: preview))
                onDelta(messageId, accumulated, tools, effectiveSid)
            case "tool.completed", "tool.failed":
                let name = (obj["tool_name"] as? String) ?? "tool"
                let preview = obj["preview"] as? String
                let status = frame.event == "tool.failed" ? "errored" : "completed"
                if let idx = tools.lastIndex(where: { $0.name == name && $0.status == "running" }) {
                    tools[idx].status = status
                    if let preview { tools[idx].summary = preview }
                } else {
                    tools.append(SyncedToolCall(id: "t_\(tools.count + 1)", name: name, status: status, summary: preview))
                }
                onDelta(messageId, accumulated, tools, effectiveSid)
            case "approval.request":
                let reqId = (obj["request_id"] as? String) ?? "apr_\(Int(Date().timeIntervalSince1970))"
                let cmd = (obj["command"] as? String) ?? ""
                let desc = (obj["description"] as? String) ?? ""
                let approval = SyncedApproval(
                    id: reqId,
                    status: "pending",
                    title: cmd.isEmpty ? (desc.isEmpty ? String(localized: "Hermes Command Approval") : desc) : String.localizedStringWithFormat(String(localized: "Allow command: %@"), cmd),
                    detail: desc.isEmpty ? cmd : desc,
                    approvalType: "hermes_command",
                    decisionOptions: ["allow_once", "allow_session", "deny"]
                )
                onApproval([approval])
            case "assistant.completed":
                if let c = obj["content"] as? String, !c.isEmpty { completed = c }
            case "error":
                let msg = (obj["message"] as? String) ?? String(localized: "Hermes Encountered an Error")
                throw DirectHermesError.httpError(502, msg)
            default:
                break
            }
        }

        let final = completed.isEmpty ? accumulated : completed
        onApproval([])
        return (messageId, effectiveSid, final, tools)
    }

    private func streamOpenAIFallback(
        base: String,
        credential: DirectHermesCredential,
        botId: String,
        sessionId: String?,
        text: String,
        onDelta: @escaping @Sendable (String, String, [SyncedToolCall], String?) -> Void
    ) async throws -> (String, String?, String, [SyncedToolCall]) {
        guard let url = URL(string: "\(base)/v1/chat/completions") else {
            throw DirectHermesError.invalidUrl(base)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("botark-ios:\(botId)", forHTTPHeaderField: "X-Hermes-Session-Key")
        if let sessionId { req.setValue(sessionId, forHTTPHeaderField: "X-Hermes-Session-Id") }
        if let key = credential.apiKey, !key.isEmpty {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": credential.model ?? "hermes-agent",
            "stream": true,
            "messages": [["role": "user", "content": text]]
        ])

        let (bytes, resp) = try await session.bytes(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            throw DirectHermesError.httpError(code, String(localized: "OpenAI-Compatible Request Failed"))
        }

        var parser = HermesSseParser()
        var messageId = "hermes_\(Int(Date().timeIntervalSince1970 * 1000))"
        let effectiveSid = http.value(forHTTPHeaderField: "X-Hermes-Session-Id") ?? sessionId
        var accumulated = ""

        for try await line in bytes.lines {
            guard let frame = parser.feedLine(line), frame.data != "[DONE]",
                  let data = frame.data.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let id = obj["id"] as? String { messageId = "hermes_\(id)" }
            if let choices = obj["choices"] as? [[String: Any]],
               let delta = choices.first?["delta"] as? [String: Any],
               let piece = delta["content"] as? String, !piece.isEmpty {
                accumulated += piece
                onDelta(messageId, accumulated, [], effectiveSid)
            }
        }
        return (messageId, effectiveSid, accumulated, [])
    }

    public func decideApproval(credential: DirectHermesCredential, approvalId: String, decision: String) async throws {
        guard let runId = activeRunIds[credential.accountId] else { return }
        let base = Self.normalizeBaseUrl(credential.baseUrl)
        guard let url = URL(string: "\(base)/v1/runs/\(runId)/approval") else { return }
        let choice: String
        switch decision {
        case "allow_once", "allow-once": choice = "once"
        case "allow_session", "allow-session": choice = "session"
        case "allow_always", "allow-always": choice = "always"
        default: choice = "deny"
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = credential.apiKey, !key.isEmpty {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "choice": choice,
            "request_id": approvalId
        ])
        _ = try await session.data(for: req)
    }
}
