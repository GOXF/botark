import SwiftUI
import UniformTypeIdentifiers

struct SyncSettingsView: View {
    @Bindable var store: BotArkStore
    @Binding var showQRScanner: Bool
    @Binding var showAddHermes: Bool

    @State private var showBundleImporter = false
    @State private var pendingBundleData: Data?
    @State private var pendingBundleName = ""
    @State private var bundleTransferKey = ""
    @State private var showTransferKeyPrompt = false
    @State private var importNotice: String?
    @State private var importError: String?
    @State private var showWipeConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(String(localized: "Sync"))
                    .font(ArkFont.bold(19))
                    .tracking(-0.4)
                Spacer()
                Text("ZERO-SERVER")
                    .font(ArkFont.mono(10))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(ArkTheme.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    obsidianBridgeHeroCard
                    offlineBundleCard
                    directHermesCard
                    footerActions
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 88)
            }
        }
        .background(ArkTheme.canvas.ignoresSafeArea())
        .fileImporter(
            isPresented: $showBundleImporter,
            allowedContentTypes: [.data, .json],
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
        }
        .alert(String(localized: "Enter Transfer Key"), isPresented: $showTransferKeyPrompt) {
            TextField(String(localized: "Paste the Key from Desktop"), text: $bundleTransferKey)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button(String(localized: "Cancel"), role: .cancel) {
                pendingBundleData = nil
                bundleTransferKey = ""
            }
            Button(String(localized: "Decrypt and Import")) { decryptPendingBundle() }
        } message: {
            Text(pendingBundleName)
        }
        .confirmationDialog(String(localized: "Clear Local Sync Cache and Keys?"), isPresented: $showWipeConfirm, titleVisibility: .visible) {
            Button(String(localized: "Clear All Data"), role: .destructive) { store.wipeAllLocalData() }
            Button(String(localized: "Cancel"), role: .cancel) {}
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(ArkFont.semibold(11.5))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 2)
    }

    /// Signature Teenage-Engineering / Hardware-inspired Obsidian Bridge Card
    private var obsidianBridgeHeroCard: some View {
        ZStack(alignment: .topTrailing) {
            RadialGradient(
                colors: [ArkTheme.prismBlue.opacity(0.26), ArkTheme.prismViolet.opacity(0.10), .clear],
                center: .topTrailing,
                startRadius: 4,
                endRadius: 180
            )

            VStack(alignment: .leading, spacing: 14) {
                if let desktop = store.pairedDesktop {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                LivingPulseDot(
                                    color: store.connectionState.isBridgeConnected ? ArkTheme.emerald : .gray,
                                    size: 6.5,
                                    animated: store.connectionState.isBridgeConnected
                                )
                                Text(store.connectionState.isBridgeConnected ? "LIVE BRIDGE" : "OFFLINE")
                                    .font(ArkFont.mono(10))
                                    .foregroundStyle(store.connectionState.isBridgeConnected ? ArkTheme.emerald : Color.white.opacity(0.55))
                            }

                            Text(desktop.hostName)
                                .font(ArkFont.bold(17))
                                .foregroundStyle(.white)
                                .padding(.top, 2)

                            Text("\(desktop.activeHost):\(String(desktop.port)) · \(desktop.fingerprint)")
                                .font(ArkFont.mono(11))
                                .foregroundStyle(Color.white.opacity(0.62))
                        }

                        Spacer()

                        Text("\(store.snapshot.bots.count) BOTS")
                            .font(ArkFont.mono(10))
                            .foregroundStyle(Color.white.opacity(0.75))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.09), in: Capsule())
                    }

                    HStack(spacing: 8) {
                        Button {
                            Task { await store.reconnectDesktop() }
                        } label: {
                            Label(String(localized: "Reconnect"), systemImage: "arrow.clockwise")
                                .font(ArkFont.semibold(12.5))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .background(Color.white.opacity(0.11), in: Capsule())
                        }
                        .buttonStyle(.plain)

                        Button {
                            showQRScanner = true
                        } label: {
                            Label(String(localized: "Scan Again"), systemImage: "qrcode.viewfinder")
                                .font(ArkFont.semibold(12.5))
                                .foregroundStyle(ArkTheme.obsidian)
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .background(Color(red: 0.985, green: 0.980, blue: 0.972), in: Capsule())
                        }
                        .buttonStyle(.plain)

                        Button {
                            store.unpairDesktop()
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(Color(red: 1.0, green: 0.50, blue: 0.50))
                                .frame(width: 36, height: 36)
                                .background(Color.red.opacity(0.18), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(localized: "Unpair"))
                    }
                } else {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(String(localized: "No Desktop Paired"))
                                .font(ArkFont.bold(16))
                                .foregroundStyle(.white)
                            Text("LAN · Hotspot · Tailscale")
                                .font(ArkFont.mono(11))
                                .foregroundStyle(Color.white.opacity(0.6))
                        }
                        Spacer()
                        Button {
                            showQRScanner = true
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 12.5, weight: .semibold))
                                Text(String(localized: "Scan"))
                                    .font(ArkFont.semibold(12.5))
                            }
                            .foregroundStyle(ArkTheme.obsidian)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Color(red: 0.985, green: 0.980, blue: 0.972), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(16)
        }
        .background(ArkTheme.obsidian, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(Color.white.opacity(0.09), lineWidth: 0.8)
        )
        .shadow(color: .black.opacity(0.16), radius: 18, y: 8)
    }

    private var offlineBundleCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionLabel(String(localized: "Offline Sync Bundle"))

            VStack(spacing: 0) {
                Button {
                    showBundleImporter = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.down.doc")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.primary)
                            .frame(width: 30, height: 30)
                            .background(ArkTheme.subtleFill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        Text(String(localized: "Import Encrypted .botark-sync Bundle"))
                            .font(ArkFont.medium(13.5))
                            .foregroundStyle(.primary)
                        Spacer()
                        Text("AirDrop")
                            .font(ArkFont.mono(10.5))
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 11)
                }
                .buttonStyle(.plain)

                if let importNotice {
                    Divider().padding(.leading, 14)
                    Label(importNotice, systemImage: "checkmark.circle.fill")
                        .font(ArkFont.medium(12))
                        .foregroundStyle(ArkTheme.emerald)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                }
                if let importError {
                    Divider().padding(.leading, 14)
                    Label(importError, systemImage: "exclamationmark.triangle.fill")
                        .font(ArkFont.medium(12))
                        .foregroundStyle(ArkTheme.rose)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                }
            }
            .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            .shadow(color: ArkTheme.cardShadow, radius: 10, y: 4)
        }
    }

    private var directHermesCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionLabel(String(localized: "Standalone Hermes"))

            VStack(spacing: 0) {
                ForEach(store.directHermesCredentials) { cred in
                    HStack(spacing: 10) {
                        PlatformIconView(platform: .hermes, size: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(cred.botName ?? cred.displayName ?? "Hermes")
                                .font(ArkFont.semibold(13.5))
                            Text(cred.baseUrl)
                                .font(ArkFont.mono(10.5))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        Text("Keychain")
                            .font(ArkFont.mono(10))
                            .foregroundStyle(ArkTheme.emerald)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3.5)
                            .background(ArkTheme.emerald.opacity(0.11), in: Capsule())
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 11)

                    Divider().padding(.leading, 47)
                }

                Button {
                    showAddHermes = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(ArkTheme.onInk)
                            .frame(width: 24, height: 24)
                            .background(ArkTheme.ink, in: Circle())
                        Text(String(localized: "Add Standalone Hermes Server"))
                            .font(ArkFont.medium(13.5))
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 11)
                }
                .buttonStyle(.plain)
            }
            .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            .shadow(color: ArkTheme.cardShadow, radius: 10, y: 4)
        }
    }

    private var footerActions: some View {
        VStack(spacing: 12) {
            Button {
                showWipeConfirm = true
            } label: {
                Text(String(localized: "Clear Local Cache and Keys"))
                    .font(ArkFont.medium(12.5))
                    .foregroundStyle(ArkTheme.rose)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)

            Text("AES-256-GCM · Keychain · No Cloud Relay")
                .font(ArkFont.mono(10))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
        }
        .padding(.top, 2)
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        importNotice = nil
        importError = nil
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                pendingBundleData = try Data(contentsOf: url)
                pendingBundleName = url.lastPathComponent
                bundleTransferKey = ""
                showTransferKeyPrompt = true
            } catch {
                importError = error.localizedDescription
            }
        case .failure(let error):
            importError = error.localizedDescription
        }
    }

    private func decryptPendingBundle() {
        guard let data = pendingBundleData else { return }
        do {
            try store.importOfflineBundle(fileData: data, transferKey: bundleTransferKey)
            importNotice = String.localizedStringWithFormat(String(localized: "Agents Imported: %lld"), store.snapshot.bots.count)
            importError = nil
        } catch {
            importError = String(localized: "Incorrect Key or Damaged File")
        }
        pendingBundleData = nil
        bundleTransferKey = ""
    }
}

struct AddStandaloneHermesSheet: View {
    @Bindable var store: BotArkStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = "Hermes"
    @State private var baseUrl = "http://127.0.0.1:8642"
    @State private var apiKey = ""
    @State private var model = ""
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "Connection Details")) {
                    TextField(String(localized: "Name"), text: $name)
                        .font(ArkFont.regular(14))
                    TextField("Base URL", text: $baseUrl)
                        .font(ArkFont.mono(13))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField(String(localized: "API Key (Optional)"), text: $apiKey)
                        .font(ArkFont.regular(14))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(String(localized: "Model (Blank to Auto-Detect)"), text: $model)
                        .font(ArkFont.regular(14))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(ArkFont.regular(12.5))
                            .foregroundStyle(ArkTheme.rose)
                    }
                }
            }
            .navigationTitle(String(localized: "Connect to Hermes"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await connect() }
                    } label: {
                        if busy { ProgressView() } else { Text(String(localized: "Add")).fontWeight(.semibold) }
                    }
                    .disabled(busy || baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func connect() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await store.addStandaloneHermes(
                name: name,
                baseUrl: baseUrl,
                apiKey: apiKey.isEmpty ? nil : apiKey,
                model: model.isEmpty ? nil : model
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
