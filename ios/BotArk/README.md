# BotArk for iOS (Native SwiftUI · Zero-Server Companion)

<div align="center">
  <table>
    <tr>
      <td align="center" width="25%">
        <img src="../../docs/assets/ios-onboarding.png" width="100%" alt="BotArk iOS Onboarding" /><br />
        <sub><b>QR Pairing</b></sub>
      </td>
      <td align="center" width="25%">
        <img src="../../docs/assets/ios-synced.png" width="100%" alt="BotArk iOS Live Sync" /><br />
        <sub><b>5-Platform List</b></sub>
      </td>
      <td align="center" width="25%">
        <img src="../../docs/assets/ios-chat.png" width="100%" alt="BotArk iOS Chat & Approvals" /><br />
        <sub><b>Chat &amp; Approvals</b></sub>
      </td>
      <td align="center" width="25%">
        <img src="../../docs/assets/ios-sync-settings.png" width="100%" alt="BotArk iOS Zero-Server Sync" /><br />
        <sub><b>Zero-Server Sync</b></sub>
      </td>
    </tr>
  </table>
</div>

Native **SwiftUI (iOS 17+)** companion app for **BotArk Desktop**, designed around a **100% Zero-Server** architecture — no cloud account, no relay server, no third-party backend.

## ✨ Two Zero-Server Sync Channels

1. **Channel 1 — Instant QR Pairing over LAN / Hotspot / Tailscale (All 5 Platforms)**
   - On BotArk Desktop, click the **QR icon** in the left sidebar (or open **Settings → iOS 扫码同步 / Mobile Sync**) and turn on the local sync bridge (`0.0.0.0:19472`).
   - Scan the QR code with **BotArk for iOS**.
   - Your iPhone automatically discovers the fastest reachable LAN or Tailscale IP, completes a single-use pairing handshake, stores its device token in **iOS Keychain**, and opens a live WebSocket bridge.
   - Syncs **Grok Bot**, **Meta Muse**, **ChatGPT Dot**, **Hark**, and **Hermes** bots, history, streaming replies, tool calls, and 1-tap security approvals.

2. **Channel 2 — Encrypted AirDrop Offline Bundle (`.botark-sync`) & Hermes Direct Mode**
   - Even without shared Wi-Fi, export an **AES-256-GCM** encrypted `.botark-sync` file from BotArk Desktop and AirDrop it to your iPhone.
   - Optionally toggle **"附带 Hermes 直连凭据 / Include Hermes direct credentials"**: Hermes API credentials are encrypted end-to-end with AES-256-GCM and stored in **iOS Keychain**, allowing your iPhone to keep chatting directly with remote Hermes API servers via native Swift SSE even when your Mac/PC is asleep.
   - You can also add standalone Hermes servers directly inside the iOS app without a computer.

## 🛠️ Build & Install onto Your iPhone (2 Minutes)

### Requirements
- macOS with **Xcode 15+** (Swift 5.9+, iOS 17.0+ target)
- Optional: `brew install xcodegen` (if modifying `project.yml`; `BotArk.xcodeproj` is already pre-generated!)

### Run on Your iPhone or Simulator
1. Open the Xcode project:
   ```bash
   open ios/BotArk/BotArk.xcodeproj
   ```
2. Select the **BotArk** target → **Signing & Capabilities** → choose your personal Apple ID Team (free Apple ID works for personal device installation).
3. Connect your iPhone via USB (or pick an iOS 17+ Simulator) and press **`⌘R`** to build and run!

### Regenerate Project & Run Unit Tests via CLI
```bash
cd ios/BotArk
xcodegen generate
xcodebuild test \
  -project BotArk.xcodeproj \
  -scheme BotArk \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  CODE_SIGNING_ALLOWED=NO
```

## 🔐 Security Model
- **Zero Cloud Servers**: All traffic stays strictly on your local network, personal hotspot, Tailscale mesh, or AirDrop.
- **Single-Use QR Pairing**: Each QR code contains a 256-bit single-use `pairToken` (10-minute TTL) and an ephemeral 256-bit AES-256-GCM transfer key (`CryptoKit.AES.GCM.SealedBox(combined:)` binary-compatible with Node.js `crypto`).
- **Per-Device Revocable Tokens**: Desktop stores only SHA-256 hashes of issued iPhone tokens (`0600` local file) and lets you revoke any paired device in one click.
- **iOS Hardware Keychain**: Paired desktop tokens and direct Hermes API keys are stored in iOS Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).


### Localization

BotArk's iOS interface follows the app language selected by iOS. English is the
development language and fallback; Simplified Chinese is bundled alongside it.
Third-party web pages, agent output and server-provided messages retain their
original language.

For app-owned copy, use `String(localized:)` and update the corresponding
`Resources/en.lproj` and `Resources/zh-Hans.lproj` entries. Keep format
placeholders consistent across languages. Camera and local-network prompts use
the `InfoPlist.strings` tables.
