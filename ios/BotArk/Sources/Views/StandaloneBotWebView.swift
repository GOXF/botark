import CryptoKit
import SwiftUI
import WebKit

/// Full-featured standalone in-app session for web-native AI agents (Antigravity, Meta Muse,
/// ChatGPT Dot, Hark, Grok) with per-bot isolated cookie storage (`WKWebsiteDataStore(forIdentifier:)`
/// on iOS 17+), clean Safari iOS UA for Google/Meta OAuth, and BotArk's signature chrome.
struct StandaloneBotWebView: View {
    @Bindable var store: BotArkStore
    let botId: String
    let onBack: () -> Void

    @State private var currentUrlString: String = ""
    @State private var estimatedProgress: Double = 0
    @State private var isLoading: Bool = true
    @State private var canGoBack: Bool = false
    @State private var loadError: String? = nil
    @State private var reloadToken = UUID()
    @State private var backTrigger = UUID()
    @State private var confirmDelete = false
    @Environment(\.openURL) private var openURL

    private var bot: SyncedBot? {
        store.snapshot.bots.first { $0.id == botId }
    }

    private var targetUrl: URL {
        let raw = bot?.standaloneUrl ?? bot?.platformId.defaultHomeUrl ?? "https://antigravity.google.com"
        return URL(string: raw) ?? URL(string: "https://antigravity.google.com")!
    }

    var body: some View {
        VStack(spacing: 0) {
            chromeHeader

            ZStack(alignment: .top) {
                StandaloneWKWebViewRepresentable(
                    botId: botId,
                    initialUrl: targetUrl,
                    reloadToken: reloadToken,
                    backTrigger: backTrigger,
                    currentUrlString: $currentUrlString,
                    estimatedProgress: $estimatedProgress,
                    isLoading: $isLoading,
                    canGoBack: $canGoBack,
                    loadError: $loadError
                )
                .ignoresSafeArea(edges: .bottom)

                if let errText = loadError {
                    VStack(spacing: 12) {
                        Image(systemName: "wifi.exclamationmark")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(.secondary)
                        Text(String(localized: "Page Could Not Load"))
                            .font(ArkFont.semibold(15))
                        Text(errText)
                            .font(ArkFont.regular(12))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                            .padding(.horizontal, 24)
                        Button {
                            loadError = nil
                            reloadToken = UUID()
                        } label: {
                            Text(String(localized: "Reload"))
                                .font(ArkFont.semibold(13.5))
                                .foregroundStyle(ArkTheme.onInk)
                                .padding(.horizontal, 20)
                                .frame(height: 38)
                                .background(ArkTheme.ink, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(ArkTheme.canvas)
                }

                if isLoading && estimatedProgress < 0.99 {
                    GeometryReader { geo in
                        Rectangle()
                            .fill(bot?.platformId.brandColor ?? ArkTheme.accent)
                            .frame(width: max(24, geo.size.width * estimatedProgress), height: 2)
                            .animation(.easeOut(duration: 0.2), value: estimatedProgress)
                    }
                    .frame(height: 2)
                }
            }
        }
        .background(ArkTheme.canvas.ignoresSafeArea())
        .confirmationDialog(String(localized: "Remove Standalone Bot?"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(String(localized: "Remove and Clear Local Sign-In"), role: .destructive) {
                let idToDelete = botId
                onBack()
                Task {
                    if #available(iOS 17.0, *) {
                        let uuid = StandaloneWebStoreId.uuid(for: idToDelete)
                        try? await WKWebsiteDataStore.remove(forIdentifier: uuid)
                    }
                    store.removeStandaloneBot(botId: idToDelete)
                }
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text(String(localized: "Removes this standalone bot and its cookies from this device only. The desktop app is unaffected."))
        }
    }

    private var chromeHeader: some View {
        HStack(spacing: 10) {
            Button {
                if canGoBack {
                    backTrigger = UUID()
                } else {
                    onBack()
                }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 34, height: 34)
                    .background(ArkTheme.surface, in: Circle())
                    .overlay(Circle().strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)

            if let bot {
                PlatformIconView(platform: bot.platformId, size: 22)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(bot.name)
                            .font(ArkFont.semibold(14.5))
                            .tracking(-0.2)
                            .lineLimit(1)
                        Text(String(localized: "Standalone Bot"))
                            .font(ArkFont.medium(9.5))
                            .foregroundStyle(bot.platformId.brandColor)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(bot.platformId.brandColor.opacity(0.11), in: Capsule())
                    }
                    Text(displayHost)
                        .font(ArkFont.mono(10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 4)

            Button {
                reloadToken = UUID()
            } label: {
                Image(systemName: isLoading ? "xmark" : "arrow.clockwise")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .background(ArkTheme.surface, in: Circle())
                    .overlay(Circle().strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)

            Menu {
                if canGoBack {
                    Button {
                        onBack()
                    } label: {
                        Label(String(localized: "Back to Bot List"), systemImage: "square.grid.2x2")
                    }
                }
                Button {
                    if let url = URL(string: currentUrlString.isEmpty ? targetUrl.absoluteString : currentUrlString) {
                        openURL(url)
                    }
                } label: {
                    Label(String(localized: "Open in Safari"), systemImage: "safari")
                }
                Divider()
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label(String(localized: "Remove Standalone Bot"), systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .background(ArkTheme.surface, in: Circle())
                    .overlay(Circle().strokeBorder(ArkTheme.hairline, lineWidth: 0.8))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(ArkTheme.canvas)
        .overlay(alignment: .bottom) {
            Rectangle().fill(ArkTheme.hairline).frame(height: 0.6)
        }
    }

    private var displayHost: String {
        let raw = currentUrlString.isEmpty ? targetUrl.absoluteString : currentUrlString
        return URL(string: raw)?.host ?? raw
    }
}

private enum StandaloneWebStoreId {
    static func uuid(for botId: String) -> UUID {
        let digest = SHA256.hash(data: Data("botark.standalone.\(botId)".utf8))
        let bytes = Array(digest.prefix(16))
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5],
            (bytes[6] & 0x0F) | 0x40, bytes[7],
            (bytes[8] & 0x3F) | 0x80, bytes[9],
            bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}

private struct StandaloneWKWebViewRepresentable: UIViewRepresentable {
    let botId: String
    let initialUrl: URL
    let reloadToken: UUID
    let backTrigger: UUID
    @Binding var currentUrlString: String
    @Binding var estimatedProgress: Double
    @Binding var isLoading: Bool
    @Binding var canGoBack: Bool
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        if #available(iOS 17.0, *) {
            config.websiteDataStore = WKWebsiteDataStore(forIdentifier: StandaloneWebStoreId.uuid(for: botId))
        } else {
            config.websiteDataStore = .default()
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        // Clean Safari iOS User-Agent so Google / Meta / OpenAI OAuth never blocks sign-in
        webView.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.observe(webView)
        context.coordinator.lastReloadToken = reloadToken
        context.coordinator.lastBackTrigger = backTrigger
        webView.load(URLRequest(url: initialUrl))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            if webView.isLoading {
                webView.stopLoading()
            } else {
                webView.reload()
            }
        }
        if context.coordinator.lastBackTrigger != backTrigger {
            context.coordinator.lastBackTrigger = backTrigger
            if webView.canGoBack {
                webView.goBack()
            }
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: StandaloneWKWebViewRepresentable
        var lastReloadToken: UUID?
        var lastBackTrigger: UUID?
        private var progressObs: NSKeyValueObservation?
        private var loadingObs: NSKeyValueObservation?
        private var urlObs: NSKeyValueObservation?
        private var backObs: NSKeyValueObservation?

        init(parent: StandaloneWKWebViewRepresentable) {
            self.parent = parent
        }

        func observe(_ webView: WKWebView) {
            progressObs = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.estimatedProgress = wv.estimatedProgress }
            }
            loadingObs = webView.observe(\.isLoading, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.isLoading = wv.isLoading }
            }
            urlObs = webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.currentUrlString = wv.url?.absoluteString ?? "" }
            }
            backObs = webView.observe(\.canGoBack, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.canGoBack = wv.canGoBack }
            }
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            Task { @MainActor in self.parent.loadError = nil }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let nsErr = error as NSError
            if nsErr.code == NSURLErrorCancelled { return }
            Task { @MainActor in self.parent.loadError = error.localizedDescription }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            let nsErr = error as NSError
            if nsErr.code == NSURLErrorCancelled { return }
            Task { @MainActor in self.parent.loadError = error.localizedDescription }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }
    }
}
