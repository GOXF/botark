# Changelog

All notable changes to **BotArk** (formerly BotHub) are documented in this file.

## [0.17.1] - 2026-11-28

### Changed

- Expanded English and Simplified Chinese across the desktop workspace and iOS companion ([PR 88](https://github.com/qybaihe/botark/pull/88)). New desktop profiles use the first supported system language; existing profiles keep their saved preference. Native account dialogs and the macOS Settings menu follow the app language.
- Open Settings on macOS from the BotArk menu or with `⌘,`. An active modal keeps focus, so opening Settings cannot silently discard an in-progress dialog. On iOS, the built-in standalone group follows the current language without renaming custom groups.
- Clarified browser sign-in handoffs and local MCP consent in English, including which program, arguments and working directory are being approved. Known delivery and IPC errors are translated at display time; conversation text, provider messages outside the catalog, and stored protocol values are left alone.
- Switching languages no longer reloads the desktop workspace or clears an unsaved group name. Both languages now explain that live mobile sync uses HTTP and should only be used on a trusted network.

## [0.17.0] - 2026-11-27

### Added

- **Native Google Gemini platform adapter** (#86, closes #72): full desktop integration for Google AI Studio API keys (with custom Base URL and per-account proxy support, encrypted vault storage, and isolated `gemini.google.com` WebSession), SSE streaming chat with signed `thoughtSignature` preservation and thought summaries, Google Search grounding citations & sandboxed search cards, multimodal image/PDF/audio/text attachments, dynamic model discovery & switching, per-turn token usage metadata, local SQLite (`0o600`) multi-session history, and independent Cancellation in Collaboration Rooms.
- **Reusable Slash Prompt Templates & Prompt Library** (#85): type `/` or click the toolbar slash button in either direct chats or Collaboration Rooms to fuzzy-search and insert prompt templates at the caret with `{{date}}`, `{{bot}}`, `{{clipboard}}`, and `{{cursor}}` expansion, IME & `@mention` priority handling, 6 editable Chinese starter templates, pinning, usage-based ranking, and JSON import/export via a lazy-loaded library dialog (`⌘K` or General Settings).
- **In-Conversation Find (`⌘F`), Collaboration Room Search (`⌘K`) & Multi-Format Local Export** (#84): added `⌘F`/`Ctrl+F` find bar with match counter, keyboard stepping, transient row highlight, and automatic older-window expansion across direct chats and Collaboration Rooms; extended `⌘K` Command Palette to search room posts by text or sender with direct jump-to-message; added scoped Markdown (`.md`) and sanitized JSON (`.json`, stripping inline binary/base64 payloads) exports alongside standalone HTML in `ShareConversationDialog` and room header menus.

## [0.16.1] - 2026-11-27

### Fixed

- **Muse `session.start` & `{ method, params }` envelope compatibility** (#83, fixes #81): sent `{ method: '/api/session/start', params: {} }` when creating new Muse conversations and added automatic `requiresParamsEnvelope` self-healing & caching in `MuseNativeGateway` for daemon endpoints requiring `{ method, params }`.
- **Muse quota discovery & fallback UX** (#83, fixes #82): prioritized `/` over `/settings` for `fetchSubscriptionAction`, prevented `403` on stale hashes from aborting rediscovery, added minified Turbopack `(0,e.createServerReference)(...)` + nested lazy chunk scanning and inline RSC flight fallback, synced quota IPC event errors, and added a quick 「前往 Muse 查看」 link when usage is unavailable.
- **Consecutive send error bar layout & IPC error cleanup** (#83, fixes #82): replaced fixed `h-5` with `min-h-5 flex-wrap` and `shrink-0 whitespace-nowrap` action controls on `MessageBubble` so long errors never crush buttons or overlap subsequent bubbles; stripped Electron `Error invoking remote method` prefixes and mapped `Muse turn superseded` to concise Chinese copy.
- **Collaboration room delivery vs. silence distinction** (#80): separated delivered-but-silent turns from undelivered failures so users avoid accidental duplicate resends.
- **Hark connect card OAuth links** (#79): opened the provider authorization link (with connected-accounts fallback) instead of posting literal `Connect <provider>` into chat.
- **PDF preview rendering** (#78): allowed `frame-src 'self' blob:` in CSP and enabled the built-in PDF viewer (`plugins: true`) so PDF previews render instead of showing a blank frame.

## [0.16.0] - 2026-11-26

### Added

- **Native DS Bot (`Fei-Craft/DS-Bot`) platform adapter** (#75, #73): full multi-protocol support covering Noise_IK encrypted Relay, DSH Web/Docker HTTP+SSE, and MCP HTTP (local & remote), with automatic team roster & group chat sync, streaming chat, multimodal attachments, interactive tool approvals, `ask_user` prompt cards, `MEMORY.md` editor, scheduled tasks, and token usage tracking.
- **Proxy availability & latency testing** (#77): real end-to-end proxy probing through BotArk's `proxyFetch` transport (HTTP, HTTPS TLS ALPN, SOCKS5/5H, authenticated proxies, and direct mode) with latency (`ms`), exit region/IP lookup, per-account draft testing in Inspector, concurrent batch pool testing (`全部测速`), and one-click failed-proxy cleanup (`移除失效`).
- **Hardened Hark Workspace Portal** (#74): scoped workspace portal bridge for Hark collaboration room members using cloudflared HTTPS tunnels with strict path containment and access guards.
- **Cue embedded WebSession & persistent background watch** (#76): enabled one-click isolated `cue.im` WebSession view in chat/inspector and warm Socket.IO background watching for scheduled tasks and cross-device replies.

### Fixed

- **Cue adapter hardening** (#76): wired end-to-end `stopRun` cancellation across chat and Collaboration Rooms (`platformCancel.ts`, `CueAdapter`, native Socket.IO, and Manus OpenAPI v2 `task.stop`), replaced the fixed 120s timeout with an activity-refreshed inactivity deadline (up to 10 min), prevented premature WebSocket close on idle settle, forwarded image/file attachments via `file.upload` (+ presigned `PUT`) instead of silently dropping them, extracted tool calls & rich media across streaming and history sync (with allowlisted `downloadMedia` proxy), implemented OpenAPI v2 paginated `getHistory` and live polling progress, enforced live credential verification on UI import, propagated real `401/403` errors on `health`/`listAgents` with same-identity partition cookie recapture, and added Cue to `OnboardingGuide`.

### Changed

- Updated Electron to `45.4.1`, `https-proxy-agent` to `9.1.0`, `tailwindcss` / `@tailwindcss/vite` to `4.3.5`, and `vitest` to `5.1.1`.

## [0.15.1] - 2026-11-25

### Added

- Antigravity universal credential paste import (Cookie header, Bash / Windows cURL, and Cookie-Editor JSON) with verification and rollback on failure.
- Incremental 80-message windowing in long chats with scroll preservation and automatic search expansion.
- Collaboration room search in Command Palette (`⌘K`) with pinned rooms prioritized first.

### Fixed

- Hardened Google OAuth desktop browser fingerprinting across Windows, macOS, and Linux (`window.chrome`, PDF plugins/MIME types, full high-entropy `Sec-CH-UA-*` / `userAgentData`, native `Function.prototype.toString` masking, synchronous iframe realm patching, and Firefox compatibility fingerprint with stale rejection cookie cleanup) to resolve Antigravity Windows login blocks and recognition (#63).
- Persisted verified Antigravity Google `authuser` indices across restarts and kept compatibility mode intact during sign-in polling.
- Used plain-language collaboration room framing for Hark members and allowed `blob:`/`data:` media playback in renderer CSP.

### Changed

- Refactored major monoliths (`SettingsView`, `muse-native/chat`, `MessageBubble`, `dotClient`, `RoomView`, `botStore`), deduplicated inspector parsers into shared helpers, removed unused `AddAccountsDialog`, and code-split non-startup panels into `React.lazy` chunks (−15.6% initial web JS).

## [0.15.0] - 2026-11-24

### Added

- Pin group chats and administrator dispatch rooms to the top of the sidebar.
- Preview Muse browser activity inline in native chat.

### Fixed

- Room handoffs resolve full `@mentions`, survive member renames, and recover when a direct request is mislabeled `[FINAL]`. Bots can also hand off explicitly by ID, and queued members receive the original assigning message.
- Slack replies stay in their original thread, and workspace tool arguments stay local.
- Reduced background work from inspector polling, workspace saves, and idle mobile sync. Hardened account proxy routing and vault writes.

## [0.14.1] - 2026-11-23

### Fixed

- Kept selected workspace excerpts separate from room routing and delivered them to late participants.
- Recovered interrupted handoffs and isolated Hermes sessions across Slack threads.

## [0.14.0] - 2026-11-23

### Added

- Native administrator dispatch with revocable permissions, delegation to room members, and review of their replies.
- Scoped Hark browser previews with refresh in native conversations.
- MCP setup for connecting authorized DS Bot teams to native rooms.

### Fixed

- Discarded pending turns when a room member changes account or agent.

## [0.13.2] - 2026-11-23

### Fixed

- Corrected Muse `session.start` requests and recovered stale gateway routes after HTTP 404 or 400 responses.
- Let room turns fall back to session creation during chat when the Muse session endpoint fails.

## [0.13.1] - 2026-11-23

### Fixed

- Parsed Muse Sentinel approval snapshots and scopes correctly and recovered subscriptions interrupted mid-reply.

## [0.13.0] - 2026-11-23

### Added

- Native Cue streaming chat, agent discovery, full history sync, and an inspector for credits, files, scheduled tasks, skills, and cloud computers.
- Drag and drop bots into and between rooms, and configure workspace MCP tools from the room.
- Recognized Cue bots in iOS and Android workspace sync.

### Fixed

- Improved Cue sign-in and macOS `cuedev://` handoff, Google OAuth popups, and Windows startup.
- Kept Hark projects in sync across windows and restored automatic conversation titles.

## [0.12.1] - 2026-11-22

### Added

- Photo and video attachments in the mobile sync apps, with fullscreen image previews and native video playback.
- Hermes model presets and a persistent custom model ID.

### Fixed

- Migrated Muse session calls to `/api/session/*` and repaired avatar, persona, memory, and quota sync.
- Added HTTPS and authenticated proxy support, and improved Google OAuth in embedded login windows.

## [0.12.0] - 2026-11-22

### Added

- Sand desktop redesign with updated room controls, a room inspector, and a workspace MCP panel.
- Quote replies across six platforms, HTML and Markdown conversation sharing, and in-app Cloud Browser, Cloud Computer, and Credential Vault views.

### Changed

- Reduced desktop memory use by starting native Muse sessions without a WebView and suspending idle embedded views.

## [0.11.1] - 2026-11-22

### Fixed

- Native rooms run independently of the optional Slack bridge.

## [0.11.0] - 2026-11-22

### Added

- Native collaboration rooms with bounded mention-based turns, scoped workspaces, and approval-based local MCP tools.
- Optional Slack Socket Mode bridge for routing channels and threads into rooms.
- Hark project selection and conversation-scoped history, with live subscriptions between sends.

### Fixed

- Reconciled queued mobile messages with desktop acknowledgments and kept reconnect and export snapshots current.
- Kept Hermes approvals and activity with the current run and waited for gateway acceptance before acknowledging a send.

## [0.10.1] - 2026-11-21

### Added

- Standalone iOS and Android bot sessions with a platform picker and isolated sign-ins.
- Expanded image, video, and audio attachments across Hark, Dot, Grok, Hermes, and Muse, and polished PDF previews and the image lightbox.

### Fixed

- Assembled and previewed Muse-generated images reliably and kept old history from appearing beneath new replies.

## [0.10.0] - 2026-11-20

### Added

- Google Antigravity Cloud Agents with native chat and a dedicated inspector.

### Changed

- Refreshed the mobile interface and improved Muse sign-in and Google SSO popups.

## [0.9.0] - 2026-11-19

### Added

- Native Jetpack Compose Android companion with QR pairing, live desktop sync, and direct Hermes access.

### Changed

- Updated the native Android and iOS companion interfaces.

## [0.8.0] - 2026-11-19

### Added

- Native SwiftUI iOS companion with direct QR pairing to BotArk Desktop, live chat and approvals, and encrypted offline export for direct Hermes access.

## [0.7.0] - 2026-11-19

### Added

- Nous Research Hermes Agent integration for local and remote servers, with streaming chat, tool approvals, persistent sessions, scheduled jobs, and skills.
- Public BotArk website on GitHub Pages.

### Fixed

- Restored Hark session and artifact handling.

## [0.6.0] - 2026-11-18

### Changed
- **Rebranded to BotArk**: Official project, repository (`qybaihe/botark`), macOS signed & notarized `.dmg`/`.zip`, and Windows NSIS installer renamed to **BotArk** — with automatic local `userData` migration so existing accounts and sessions carry over seamlessly.
- **Flagship Documentation Overhaul**: Upgraded all 16 localized READMEs with visual Bento workflow galleries, inline platform icons, streamlined quick-start guides, and updated `1280×640` social preview cards.

## [0.5.1] - 2026-11-17

### Changed
- **Redesigned Flagship 3D App Icon ("The Living Nexus")**: Brand-new macOS continuous-curvature squircle `.icns` (10-layer Retina iconset) and Windows `1024×1024` installer icon crafted with dark anodized titanium, four refractive dichroic glass petals, and a sculpted 3D ceramic Bot core.
- **Refreshed Brand Assets & Documentation**: Updated README brand emblem, `1280×640` GitHub social preview card, 16-language README guides, and repository community health templates.

## [0.5.0] - 2026-11-16

### Added
- **Official Apple Developer ID Signed & Notarized macOS Builds**: Both `arm64` (Apple Silicon) and `x64` (Intel) `.dmg` & `.zip` installers open directly without Gatekeeper warnings and support 1-click in-app updates.
- **Grok Bot 1-Account → Multi-Bot Sidebar Sync**: Signing into or importing a single Grok Bot account automatically populates every agent and group room under that account as an individual Bot in the left sidebar. Create new bots on an existing account without re-authenticating.
- **Zero-Bounce Grok Sign-In & Universal Credential Import**: Keeps OAuth popups (Google, X, Apple, GitHub) inside the login partition, blocks external deep-link app hijacking, honors OS system proxies (e.g. Clash / Surge), supports **1-click default browser authorization**, and imports Access Tokens, Cookies, JSON, or API Keys directly.
- **Tailored Right-Side Workbench (`⌘I`)**: Product-specific panels for **Grok Bot**, **ChatGPT Dot**, **Meta Muse**, and **Hark** covering sessions, subagent tasks, memories, skills, schedules, cloud sandboxes, and file libraries.
- **Full-Screen Interactive Quick Guide**: Step-by-step visual walkthrough of the three-column layout, account import entry points, and right-side workbench.

## [0.4.0] - 2026-11-09

### Added
- Multi-platform workspace uniting **Meta Muse**, **Grok Bot**, **Hark**, and **ChatGPT Dot** in one Electron + React desktop client.
- Per-account isolated partitions, Keychain-encrypted token storage, and 1-to-1 HTTP / SOCKS5 proxy pool routing.
- Streaming chat with tool-call traces, interactive approvals, document canvas, and animated `GrokBotMark` avatars.
