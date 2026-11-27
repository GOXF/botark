import SwiftUI
import UIKit

/// Tactile platform picker sheet triggered from the workspace `+` button so users can
/// add ANY standalone bot (Antigravity, Muse, Grok, Dot, Hark, Hermes) or pair Desktop anytime.
struct AddBotPickerSheet: View {
    @Bindable var store: BotArkStore
    let onPickPlatform: (PlatformId) -> Void
    let onOpenScanner: () -> Void
    @Environment(\.dismiss) private var dismiss

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                ArkTheme.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(localized: "Add Standalone Agent"))
                                .font(ArkFont.bold(20))
                                .tracking(-0.4)
                            Text(String(localized: "Runs on this device. Each account has separate storage and does not require the desktop app."))
                                .font(ArkFont.regular(12.5))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)

                        LazyVGrid(columns: columns, spacing: 10) {
                            ForEach(PlatformId.pickerOrder) { platform in
                                PlatformPickerCard(platform: platform) {
                                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                    dismiss()
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                                        onPickPlatform(platform)
                                    }
                                }
                            }
                        }

                        Button {
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                                onOpenScanner()
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 14, weight: .semibold))
                                Text(String(localized: "Or scan a code to sync all desktop bots"))
                                    .font(ArkFont.semibold(13.5))
                            }
                            .foregroundStyle(ArkTheme.onInk)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                            .background(ArkTheme.ink, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 4)
                    }
                    .padding(18)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Close")) { dismiss() }
                        .font(ArkFont.medium(14))
                }
            }
        }
    }
}

/// Reusable tactile 2-column card used both right at launch AND inside AddBotPickerSheet.
struct PlatformPickerCard: View {
    let platform: PlatformId
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .fill(platform.brandColor.opacity(0.11))
                            .frame(width: 36, height: 36)
                        PlatformIconView(platform: platform, size: 22)
                    }

                    Spacer(minLength: 4)

                    Text(platform.standaloneTag)
                        .font(ArkFont.medium(9.5))
                        .foregroundStyle(platform.brandColor)
                        .padding(.horizontal, 6.5)
                        .padding(.vertical, 2.5)
                        .background(platform.brandColor.opacity(0.10), in: Capsule())
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(platform.displayName)
                        .font(ArkFont.semibold(13.5))
                        .tracking(-0.2)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(platform.standaloneSubtitle)
                        .font(ArkFont.regular(11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
            )
            .shadow(color: ArkTheme.cardShadow, radius: 8, y: 3)
        }
        .buttonStyle(.plain)
    }
}

/// Quick-create sheet for launching a standalone web bot (Antigravity, Muse, Grok, Dot, Hark).
struct AddStandaloneWebBotSheet: View {
    @Bindable var store: BotArkStore
    let platform: PlatformId
    let onCreated: (SyncedBot) -> Void
    let onSwitchToQR: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""

    var body: some View {
        NavigationStack {
            ZStack {
                ArkTheme.canvas.ignoresSafeArea()

                VStack(spacing: 18) {
                    // Platform emblem with soft brand aura
                    ZStack {
                        Circle()
                            .fill(platform.brandColor.opacity(0.16))
                            .frame(width: 78, height: 78)
                            .blur(radius: 16)
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(ArkTheme.surface)
                            .frame(width: 64, height: 64)
                            .overlay(
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
                            )
                            .shadow(color: ArkTheme.cardShadow, radius: 12, y: 4)
                        PlatformIconView(platform: platform, size: 36)
                    }
                    .padding(.top, 10)

                    VStack(spacing: 4) {
                        Text(platform.displayName)
                            .font(ArkFont.bold(19))
                            .tracking(-0.3)
                        Text(platform.defaultHomeUrl)
                            .font(ArkFont.mono(11.5))
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text(String(localized: "Name"))
                            .font(ArkFont.medium(11.5))
                            .foregroundStyle(.secondary)
                            .padding(.leading, 4)

                        TextField(platform.displayName, text: $name)
                            .font(ArkFont.medium(14.5))
                            .padding(.horizontal, 14)
                            .frame(height: 44)
                            .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                    .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
                            )
                    }

                    Text(String(localized: "Opens the official sign-in page in a separate local session. The desktop app does not need to be online."))
                        .font(ArkFont.regular(12))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)

                    Spacer(minLength: 8)

                    VStack(spacing: 10) {
                        Button {
                            let created = store.addStandaloneWebBot(
                                platformId: platform,
                                name: name.isEmpty ? platform.displayName : name
                            )
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                                onCreated(created)
                            }
                        } label: {
                            HStack(spacing: 7) {
                                Image(systemName: "arrow.up.right.circle.fill")
                                    .font(.system(size: 15, weight: .semibold))
                                Text(String(localized: "Create and Sign In"))
                                    .font(ArkFont.semibold(14.5))
                            }
                            .foregroundStyle(ArkTheme.onInk)
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .background(ArkTheme.ink, in: Capsule())
                            .shadow(color: .black.opacity(0.14), radius: 12, y: 5)
                        }
                        .buttonStyle(.plain)

                        Button {
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                                onSwitchToQR()
                            }
                        } label: {
                            Text(String(localized: "Already using the desktop app? Scan to sync"))
                                .font(ArkFont.medium(12.5))
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(20)
            }
            .onAppear {
                if name.isEmpty { name = platform.displayName }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { dismiss() }
                        .font(ArkFont.medium(14))
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}
