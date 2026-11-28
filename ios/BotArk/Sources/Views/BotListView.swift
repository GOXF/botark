import SwiftUI

struct BotListView: View {
    @Bindable var store: BotArkStore
    @Binding var showQRScanner: Bool
    @Binding var showAddPicker: Bool
    let onPickPlatform: (PlatformId) -> Void
    let onSelectBot: (String) -> Void

    @State private var selectedPlatform: PlatformId? = nil
    @State private var glowBreath = false

    private var filteredBots: [SyncedBot] {
        store.snapshot.bots.filter { bot in
            if let filter = selectedPlatform, bot.platformId != filter {
                return false
            }
            return true
        }
    }

    private var pinnedBots: [SyncedBot] {
        filteredBots.filter { $0.pinned == true }
    }

    private var unpinnedBots: [SyncedBot] {
        filteredBots.filter { $0.pinned != true }
    }

    var body: some View {
        ZStack(alignment: .top) {
            ArkTheme.canvas.ignoresSafeArea()

            // Subtle ambient prismatic top glow (BotArk signature atmosphere)
            LinearGradient(
                colors: [
                    ArkTheme.prismBlue.opacity(0.06),
                    ArkTheme.prismViolet.opacity(0.03),
                    .clear
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .frame(height: 220)
            .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar

                if store.snapshot.bots.isEmpty {
                    signatureOnboarding
                } else {
                    workspaceFeed
                }
            }
        }
    }

    // MARK: - Editorial Header Bar

    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image("BotArkLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 24, height: 24)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .shadow(color: .black.opacity(0.12), radius: 4, y: 2)

                Text("BotArk")
                    .font(ArkFont.bold(19))
                    .tracking(-0.4)
                    .foregroundStyle(.primary)
            }

            if !store.snapshot.bots.isEmpty {
                inlineConnectionChip
            }

            Spacer(minLength: 4)

            Button {
                showAddPicker = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 34, height: 34)
                    .background(ArkTheme.surface, in: Circle())
                    .overlay(Circle().strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
                    .shadow(color: ArkTheme.cardShadow, radius: 6, y: 2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(String(localized: "Add Standalone Agent"))

            Button {
                showQRScanner = true
            } label: {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ArkTheme.onInk)
                    .frame(width: 34, height: 34)
                    .background(ArkTheme.ink, in: Circle())
                    .shadow(color: .black.opacity(0.14), radius: 8, y: 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(String(localized: "Scan to Pair"))
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private var inlineConnectionChip: some View {
        let dotColor: Color = {
            switch store.connectionState {
            case .connected: return ArkTheme.emerald
            case .connecting: return ArkTheme.amber
            case .offline, .unpaired: return store.hasStandaloneBots ? ArkTheme.emerald : .gray
            }
        }()

        let label: String = {
            switch store.connectionState {
            case .connected(let host, _): return host
            case .connecting: return String(localized: "Connecting")
            case .offline(let host): return store.hasStandaloneBots ? String(localized: "Standalone") : String.localizedStringWithFormat(String(localized: "%@ · Offline"), host)
            case .unpaired: return store.hasStandaloneBots ? String(localized: "Standalone") : String(localized: "Not Paired")
            }
        }()

        return Button {
            if store.pairedDesktop != nil, !store.connectionState.isBridgeConnected {
                Task { await store.reconnectDesktop() }
            } else if store.pairedDesktop == nil {
                showQRScanner = true
            }
        } label: {
            HStack(spacing: 4) {
                LivingPulseDot(
                    color: dotColor,
                    size: 6,
                    animated: store.connectionState.isBridgeConnected
                )
                Text(label)
                    .font(ArkFont.medium(11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.leading, 6)
            .padding(.trailing, 9)
            .padding(.vertical, 4)
            .background(ArkTheme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Signature Living Onboarding (Pick Any Platform Right Away!)

    private let onboardingColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    private var signatureOnboarding: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                // Compact living 4-color prismatic orbital emblem
                ZStack {
                    Circle()
                        .fill(ArkTheme.prismBlue.opacity(0.18))
                        .frame(width: 78, height: 78)
                        .blur(radius: 18)
                        .offset(x: -16, y: -8)
                    Circle()
                        .fill(ArkTheme.prismViolet.opacity(0.16))
                        .frame(width: 76, height: 76)
                        .blur(radius: 18)
                        .offset(x: 16, y: -6)
                    Circle()
                        .fill(ArkTheme.prismAmber.opacity(0.14))
                        .frame(width: 70, height: 70)
                        .blur(radius: 16)
                        .offset(x: -12, y: 12)
                    Circle()
                        .fill(ArkTheme.prismTeal.opacity(0.14))
                        .frame(width: 70, height: 70)
                        .blur(radius: 16)
                        .offset(x: 14, y: 12)

                    Circle()
                        .strokeBorder(ArkTheme.hairline, style: StrokeStyle(lineWidth: 1, dash: [3, 5]))
                        .frame(width: 98, height: 98)
                        .scaleEffect(glowBreath ? 1.03 : 0.98)
                        .animation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true), value: glowBreath)

                    Image("BotArkLogo")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 58, height: 58)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .shadow(color: .black.opacity(0.16), radius: 14, y: 8)
                }
                .frame(height: 122)
                .padding(.top, 2)
                .onAppear { glowBreath = true }

                VStack(spacing: 5) {
                    Text(String(localized: "Your AI Workspace on iPhone"))
                        .font(ArkFont.bold(21))
                        .tracking(-0.5)

                    Text(String(localized: "Choose a platform to start. No desktop required."))
                        .font(ArkFont.regular(12.5))
                        .foregroundStyle(.secondary)
                }

                // Instant 2x3 Interactive Platform Picker Grid right on Launch!
                LazyVGrid(columns: onboardingColumns, spacing: 10) {
                    ForEach(PlatformId.pickerOrder) { platform in
                        PlatformPickerCard(platform: platform) {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            onPickPlatform(platform)
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)

                // Tactile Obsidian secondary pill for Zero-Server Desktop QR Sync
                Button {
                    showQRScanner = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 14.5, weight: .semibold))
                        Text(String(localized: "Scan to Sync with Desktop"))
                            .font(ArkFont.semibold(13.5))
                    }
                    .foregroundStyle(ArkTheme.onInk)
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
                    .background(ArkTheme.ink, in: Capsule())
                    .shadow(color: .black.opacity(0.14), radius: 12, y: 5)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 18)
                .padding(.top, 16)

                Text(String(localized: "Direct access · Separate sessions · No relay servers"))
                    .font(ArkFont.mono(10))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 14)
                    .padding(.bottom, 92)
            }
        }
    }

    // MARK: - Editorial Workspace Feed (Pinned Bento Deck + Clean Cards)

    private var workspaceFeed: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                platformFilterStrip
                    .padding(.top, 2)

                // Pinned bots -> Tactile Horizontal Bento Deck!
                if !pinnedBots.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionHeader(String(localized: "Pinned"), trailing: "\(pinnedBots.count)")

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(pinnedBots) { bot in
                                    Button {
                                        onSelectBot(bot.id)
                                    } label: {
                                        pinnedBentoCard(bot)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 18)
                            .padding(.vertical, 2)
                        }
                        .padding(.horizontal, -18)
                    }
                }

                // Remaining groups -> Crisp editorial conversation cards
                if store.snapshot.groups.isEmpty {
                    if !unpinnedBots.isEmpty {
                        botGroupCard(title: String(localized: "All"), bots: unpinnedBots)
                    }
                } else {
                    ForEach(store.snapshot.groups) { group in
                        let members = unpinnedBots.filter { $0.groupId == group.id }
                        if !members.isEmpty {
                            botGroupCard(title: group.displayName(), bots: members)
                        }
                    }
                    let knownIds = Set(store.snapshot.groups.map(\.id))
                    let ungrouped = unpinnedBots.filter { !knownIds.contains($0.groupId) }
                    if !ungrouped.isEmpty {
                        botGroupCard(title: String(localized: "Other"), bots: ungrouped)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 86) // clear floating dock cleanly
        }
        .refreshable {
            await store.reconnectDesktop()
        }
    }

    private func sectionHeader(_ title: String, trailing: String? = nil) -> some View {
        HStack {
            Text(title)
                .font(ArkFont.semibold(11.5))
                .foregroundStyle(.secondary)
            if let trailing {
                Text(trailing)
                    .font(ArkFont.mono(10.5))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(.horizontal, 2)
    }

    private var platformFilterStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                filterPill(title: String(localized: "All"), platform: nil, count: store.snapshot.bots.count)
                ForEach(PlatformId.allCases) { platform in
                    let count = store.snapshot.bots.filter { $0.platformId == platform }.count
                    if count > 0 {
                        filterPill(title: platform.shortLabel, platform: platform, count: count)
                    }
                }
            }
            .padding(.horizontal, 18)
        }
        .padding(.horizontal, -18)
    }

    private func filterPill(title: String, platform: PlatformId?, count: Int) -> some View {
        let active = selectedPlatform == platform
        return Button {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                selectedPlatform = platform
            }
        } label: {
            HStack(spacing: 5) {
                if let platform {
                    PlatformIconView(platform: platform, size: 13)
                }
                Text(title)
                    .font(active ? ArkFont.semibold(12) : ArkFont.medium(12))
                Text("\(count)")
                    .font(ArkFont.mono(10))
                    .opacity(active ? 0.75 : 0.55)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 6.5)
            .background(active ? ArkTheme.ink : ArkTheme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(active ? .clear : ArkTheme.hairline, lineWidth: 0.8))
            .foregroundStyle(active ? ArkTheme.onInk : .primary)
        }
        .buttonStyle(.plain)
    }

    private func pinnedBentoCard(_ bot: SyncedBot) -> some View {
        let status = store.status(for: bot)
        let lastMsg = store.snapshot.messages[bot.id]?.last
        let pendingCount = (store.snapshot.approvals[bot.activeAccountId] ?? []).filter { $0.status == "pending" }.count

        return ZStack(alignment: .topTrailing) {
            // Subtle platform-tinted corner glow
            RadialGradient(
                colors: [bot.platformId.brandColor.opacity(0.11), .clear],
                center: .topTrailing,
                startRadius: 2,
                endRadius: 96
            )

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    BotAvatarView(bot: bot, status: status, size: 36)
                    Spacer()
                    if pendingCount > 0 {
                        Text(String.localizedStringWithFormat(String(localized: "%lld Approvals"), pendingCount))
                            .font(ArkFont.semibold(10))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(ArkTheme.amber, in: Capsule())
                    } else {
                        PlatformBadgePill(platform: bot.platformId)
                    }
                }

                Spacer(minLength: 2)

                VStack(alignment: .leading, spacing: 3) {
                    Text(bot.name)
                        .font(ArkFont.semibold(13.5))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(cleanPreview(lastMsg?.text) ?? bot.platformId.displayName)
                        .font(ArkFont.regular(11.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(13)
        }
        .frame(width: 164, height: 122)
        .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    pendingCount > 0 ? ArkTheme.amber.opacity(0.45) : ArkTheme.hairline,
                    lineWidth: pendingCount > 0 ? 1.1 : 0.8
                )
        )
        .shadow(color: ArkTheme.cardShadow, radius: 12, y: 4)
    }

    private func botGroupCard(title: String, bots: [SyncedBot]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionHeader(title)

            VStack(spacing: 0) {
                ForEach(Array(bots.enumerated()), id: \.element.id) { idx, bot in
                    Button {
                        onSelectBot(bot.id)
                    } label: {
                        editorialBotRow(bot)
                    }
                    .buttonStyle(.plain)

                    if idx < bots.count - 1 {
                        Divider()
                            .overlay(ArkTheme.hairline)
                            .padding(.leading, 62)
                    }
                }
            }
            .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
            )
            .shadow(color: ArkTheme.cardShadow, radius: 10, y: 4)
        }
    }

    private func editorialBotRow(_ bot: SyncedBot) -> some View {
        let status = store.status(for: bot)
        let lastMsg = store.snapshot.messages[bot.id]?.last
        let isTyping = store.typingByBotId[bot.id] == true
        let pendingCount = (store.snapshot.approvals[bot.activeAccountId] ?? []).filter { $0.status == "pending" }.count

        return HStack(spacing: 11) {
            BotAvatarView(bot: bot, status: status, size: 40)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(bot.name)
                        .font(ArkFont.semibold(14))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    PlatformBadgePill(platform: bot.platformId)
                    Spacer(minLength: 4)
                    if let ts = lastMsg?.createdAt, ts > 0 {
                        Text(Self.formatShortTime(ts))
                            .font(ArkFont.mono(10.5))
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                }

                HStack(spacing: 6) {
                    if isTyping {
                        Text(String(localized: "Generating…"))
                            .font(ArkFont.medium(12.5))
                            .foregroundStyle(ArkTheme.accent)
                    } else {
                        Text(
                            bot.isStandaloneWeb
                                ? String.localizedStringWithFormat(String(localized: "Direct Connection · %@"), URL(string: bot.standaloneUrl ?? "")?.host ?? bot.platformId.displayName)
                                : (cleanPreview(lastMsg?.text) ?? bot.platformId.displayName)
                        )
                            .font(ArkFont.regular(12.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)

                    if pendingCount > 0 {
                        Text(String.localizedStringWithFormat(String(localized: "%lld Approvals"), pendingCount))
                            .font(ArkFont.semibold(10))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6.5)
                            .padding(.vertical, 2)
                            .background(ArkTheme.amber, in: Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    private func cleanPreview(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return raw
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "\n", with: " ")
    }

    private static func formatShortTime(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let fmt = DateFormatter()
        fmt.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "MM/dd"
        return fmt.string(from: date)
    }
}
