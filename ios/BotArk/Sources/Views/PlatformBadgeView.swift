import SwiftUI
import UIKit

/// BotArk Signature Mobile Design System ("Warm Alabaster Studio + Deep Obsidian Ink + Prismatic Accent")
enum ArkTheme {
    /// Warm museum paper light / deep obsidian night dark
    static let canvas = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.051, green: 0.055, blue: 0.071, alpha: 1) // #0D0E12
            : UIColor(red: 0.980, green: 0.973, blue: 0.961, alpha: 1) // #FAF8F5
    })

    static let surface = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.086, green: 0.094, blue: 0.125, alpha: 1) // #161820
            : UIColor.white
    })

    static let subtleFill = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1.0, alpha: 0.065)
            : UIColor(red: 0.11, green: 0.10, blue: 0.09, alpha: 0.048)
    })

    static let hairline = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1.0, alpha: 0.09)
            : UIColor(red: 0.11, green: 0.10, blue: 0.09, alpha: 0.075)
    })

    /// Primary luxury ink (Obsidian in Light / Warm Porcelain in Dark)
    static let ink = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.973, green: 0.969, blue: 0.957, alpha: 1) // #F8F7F4
            : UIColor(red: 0.078, green: 0.082, blue: 0.102, alpha: 1) // #14151A
    })

    static let onInk = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.078, green: 0.082, blue: 0.102, alpha: 1)
            : UIColor(red: 0.988, green: 0.984, blue: 0.976, alpha: 1)
    })

    /// Always-dark hardware surface (Floating Dock & Sync Bridge Hero Card)
    static let obsidian = Color(red: 0.086, green: 0.090, blue: 0.114) // #16171D
    static let obsidianElevated = Color(red: 0.133, green: 0.141, blue: 0.176)

    static let accent = Color(red: 0.231, green: 0.357, blue: 1.0) // #3B5BFF Luminous Iris
    static let emerald = Color(red: 0.063, green: 0.725, blue: 0.506) // #10B981
    static let amber = Color(red: 0.961, green: 0.620, blue: 0.043) // #F59E0B
    static let rose = Color(red: 0.937, green: 0.267, blue: 0.267) // #EF4444

    /// Soft 4-color prismatic palette inspired by BotArk's 3D glass emblem
    static let prismBlue = Color(red: 0.25, green: 0.52, blue: 1.0)
    static let prismViolet = Color(red: 0.56, green: 0.32, blue: 0.98)
    static let prismAmber = Color(red: 0.98, green: 0.64, blue: 0.20)
    static let prismTeal = Color(red: 0.12, green: 0.76, blue: 0.68)

    static let cardShadow = Color(red: 0.11, green: 0.10, blue: 0.09).opacity(0.05)
}

/// Custom bundled Plus Jakarta Sans + JetBrains Mono typography scale
enum ArkFont {
    static func bold(_ size: CGFloat) -> Font {
        .custom("PlusJakartaSans-Bold", size: size)
    }

    static func semibold(_ size: CGFloat) -> Font {
        .custom("PlusJakartaSans-SemiBold", size: size)
    }

    static func medium(_ size: CGFloat) -> Font {
        .custom("PlusJakartaSans-Medium", size: size)
    }

    static func regular(_ size: CGFloat) -> Font {
        .custom("PlusJakartaSans-Regular", size: size)
    }

    static func mono(_ size: CGFloat) -> Font {
        .custom("JetBrainsMono-Medium", size: size)
    }
}

extension PlatformId {
    var brandColor: Color {
        switch self {
        case .grok: return Color(red: 0.16, green: 0.18, blue: 0.24)
        case .metaMuse: return Color(red: 0.11, green: 0.45, blue: 0.96)
        case .dot: return Color(red: 0.05, green: 0.60, blue: 0.48)
        case .hark: return Color(red: 0.91, green: 0.40, blue: 0.16)
        case .hermes: return Color(red: 0.47, green: 0.31, blue: 0.94)
        case .antigravity: return Color(red: 0.25, green: 0.52, blue: 0.96)
        case .cue: return Color(red: 0.26, green: 0.62, blue: 0.98)
        }
    }
}

extension ConnectionStatus {
    var dotColor: Color {
        switch self {
        case .online: return ArkTheme.emerald
        case .busy: return ArkTheme.accent
        case .attention: return ArkTheme.amber
        case .offline: return .secondary.opacity(0.45)
        case .error: return ArkTheme.rose
        }
    }
}

/// Subtle breathing status dot that feels alive without being distracting
struct LivingPulseDot: View {
    let color: Color
    var size: CGFloat = 7
    var animated: Bool = true
    @State private var pulsing = false

    var body: some View {
        ZStack {
            if animated {
                Circle()
                    .fill(color.opacity(0.32))
                    .frame(width: size * 2.1, height: size * 2.1)
                    .scaleEffect(pulsing ? 1.15 : 0.65)
                    .opacity(pulsing ? 0.0 : 0.7)
                    .animation(.easeOut(duration: 1.9).repeatForever(autoreverses: false), value: pulsing)
            }
            Circle()
                .fill(color)
                .frame(width: size, height: size)
        }
        .frame(width: size * 1.8, height: size * 1.8)
        .onAppear { pulsing = true }
    }
}

struct PlatformIconView: View {
    let platform: PlatformId
    var size: CGFloat = 18

    var body: some View {
        Image(platform.assetImageName)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
    }
}

struct BotAvatarView: View {
    let bot: SyncedBot
    let status: ConnectionStatus
    var size: CGFloat = 40

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            avatarCore
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                        .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
                )

            Circle()
                .fill(status.dotColor)
                .frame(width: max(8.5, size * 0.22), height: max(8.5, size * 0.22))
                .overlay(
                    Circle()
                        .stroke(ArkTheme.surface, lineWidth: 1.8)
                )
                .offset(x: 1.5, y: 1.5)
        }
    }

    @ViewBuilder
    private var avatarCore: some View {
        if let rawAvatar = bot.avatar, let uiImage = Self.decodeBase64Image(rawAvatar) {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFill()
        } else if let emoji = bot.emoji, !emoji.isEmpty {
            ZStack {
                bot.platformId.brandColor.opacity(0.11)
                Text(emoji)
                    .font(.system(size: size * 0.46))
            }
        } else {
            ZStack {
                LinearGradient(
                    colors: [bot.platformId.brandColor.opacity(0.14), bot.platformId.brandColor.opacity(0.04)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                Image(bot.platformId.assetImageName)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.18)
            }
        }
    }

    static func decodeBase64Image(_ raw: String) -> UIImage? {
        if !raw.hasPrefix("data:") && raw.count < 512 && (raw.contains("/") || raw.contains(".")) {
            return nil
        }
        let base64Part: String
        if let commaRange = raw.range(of: ",") {
            base64Part = String(raw[commaRange.upperBound...])
        } else {
            base64Part = raw
        }
        guard let data = Data(base64Encoded: base64Part, options: .ignoreUnknownCharacters) else {
            return nil
        }
        return UIImage(data: data)
    }
}

struct PlatformBadgePill: View {
    let platform: PlatformId

    var body: some View {
        Text(platform.shortLabel)
            .font(ArkFont.semibold(10))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: true)
            .padding(.horizontal, 6.5)
            .padding(.vertical, 2.5)
            .background(platform.brandColor.opacity(0.10), in: Capsule())
            .foregroundStyle(platform.brandColor)
    }
}
