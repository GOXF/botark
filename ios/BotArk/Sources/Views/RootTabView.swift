import SwiftUI
import UIKit

enum BotArkTab: Hashable, CaseIterable {
    case chats
    case approvals
    case sync

    var label: String {
        switch self {
        case .chats: return String(localized: "Chats")
        case .approvals: return String(localized: "Approvals")
        case .sync: return String(localized: "Sync")
        }
    }

    var icon: String {
        switch self {
        case .chats: return "bubble.left.and.bubble.right.fill"
        case .approvals: return "checkmark.shield.fill"
        case .sync: return "dot.radiowaves.left.and.right"
        }
    }
}

struct RootTabView: View {
    @Bindable var store: BotArkStore
    @State private var selectedTab: BotArkTab = .chats
    @State private var activeChatBotId: String? = nil
    @State private var showQRScanner = false
    @State private var showAddHermes = false
    @State private var showAddPicker = false
    @State private var pendingWebPlatform: PlatformId? = nil
    @Namespace private var dockNamespace

    private func handlePickPlatform(_ platform: PlatformId) {
        if platform == .hermes {
            showAddHermes = true
        } else {
            pendingWebPlatform = platform
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ArkTheme.canvas.ignoresSafeArea()

            // Main screen content
            Group {
                if let chatBotId = activeChatBotId, selectedTab == .chats {
                    let activeBot = store.snapshot.bots.first { $0.id == chatBotId }
                    if activeBot?.isStandaloneWeb == true {
                        StandaloneBotWebView(
                            store: store,
                            botId: chatBotId,
                            onBack: {
                                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                    activeChatBotId = nil
                                }
                            }
                        )
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                    } else {
                        ChatView(
                            store: store,
                            botId: chatBotId,
                            onBack: {
                                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                    activeChatBotId = nil
                                }
                            }
                        )
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                } else {
                    switch selectedTab {
                    case .chats:
                        BotListView(
                            store: store,
                            showQRScanner: $showQRScanner,
                            showAddPicker: $showAddPicker,
                            onPickPlatform: handlePickPlatform,
                            onSelectBot: { botId in
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                    activeChatBotId = botId
                                }
                            }
                        )
                    case .approvals:
                        ApprovalsView(store: store)
                    case .sync:
                        SyncSettingsView(
                            store: store,
                            showQRScanner: $showQRScanner,
                            showAddHermes: $showAddHermes
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Signature Floating Obsidian Capsule Dock (auto-hides smoothly in Chat/Web for pure immersion!)
            if activeChatBotId == nil {
                floatingDock
                    .padding(.bottom, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $showQRScanner) {
            QRScannerSheet(store: store)
        }
        .sheet(isPresented: $showAddHermes) {
            AddStandaloneHermesSheet(store: store)
        }
        .sheet(isPresented: $showAddPicker) {
            AddBotPickerSheet(
                store: store,
                onPickPlatform: handlePickPlatform,
                onOpenScanner: { showQRScanner = true }
            )
        }
        .sheet(item: $pendingWebPlatform) { platform in
            AddStandaloneWebBotSheet(
                store: store,
                platform: platform,
                onCreated: { created in
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                        selectedTab = .chats
                        activeChatBotId = created.id
                    }
                },
                onSwitchToQR: { showQRScanner = true }
            )
        }
        #if DEBUG
        .task {
            switch ProcessInfo.processInfo.environment["BOTARK_TEST_TAB"] {
            case "approvals": selectedTab = .approvals
            case "sync": selectedTab = .sync
            default: break
            }
            if let openBot = ProcessInfo.processInfo.environment["BOTARK_TEST_OPEN_BOT"], !openBot.isEmpty {
                try? await Task.sleep(nanoseconds: 350_000_000)
                if store.snapshot.bots.contains(where: { $0.id == openBot }) {
                    activeChatBotId = openBot
                }
            }
        }
        #endif
    }

    private var floatingDock: some View {
        HStack(spacing: 4) {
            ForEach(BotArkTab.allCases, id: \.self) { tab in
                let active = selectedTab == tab
                let badge = tab == .approvals ? store.pendingApprovals.count : 0

                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
                        selectedTab = tab
                    }
                } label: {
                    HStack(spacing: 6) {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 14, weight: .semibold))

                            if badge > 0 {
                                Text(badge > 9 ? "9+" : "\(badge)")
                                    .font(ArkFont.mono(9))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .frame(minWidth: 14, minHeight: 14)
                                    .background(ArkTheme.amber, in: Capsule())
                                    .offset(x: 7, y: -6)
                            }
                        }

                        if active {
                            Text(tab.label)
                                .font(ArkFont.semibold(12.5))
                                .lineLimit(1)
                                .transition(.opacity.combined(with: .scale(scale: 0.9)))
                        }
                    }
                    .foregroundStyle(active ? ArkTheme.obsidian : Color.white.opacity(0.68))
                    .padding(.horizontal, active ? 16 : 14)
                    .frame(height: 40)
                    .background {
                        if active {
                            Capsule()
                                .fill(Color(red: 0.985, green: 0.980, blue: 0.972))
                                .matchedGeometryEffect(id: "dock-pill", in: dockNamespace)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(
            Capsule()
                .fill(ArkTheme.obsidian.opacity(0.95))
                .overlay(
                    Capsule()
                        .strokeBorder(Color.white.opacity(0.11), lineWidth: 0.8)
                )
                .shadow(color: .black.opacity(0.22), radius: 22, y: 10)
        )
    }
}
