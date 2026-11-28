import SwiftUI
import UIKit

struct ApprovalsView: View {
    @Bindable var store: BotArkStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(String(localized: "Approvals"))
                    .font(ArkFont.bold(19))
                    .tracking(-0.4)
                if !store.pendingApprovals.isEmpty {
                    Text("\(store.pendingApprovals.count)")
                        .font(ArkFont.mono(11))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(ArkTheme.amber, in: Capsule())
                }
                Spacer()
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 12)

            if store.pendingApprovals.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(.tertiary)
                    Text(String(localized: "No Pending Approvals"))
                        .font(ArkFont.medium(14))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.bottom, 70)
            } else {
                ScrollView {
                    LazyVStack(spacing: 11) {
                        ForEach(store.pendingApprovals) { item in
                            approvalCard(item)
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 86)
                }
            }
        }
        .background(ArkTheme.canvas.ignoresSafeArea())
    }

    private func approvalCard(_ item: PendingApprovalItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                PlatformIconView(platform: item.platformId, size: 17)
                Text(item.botName)
                    .font(ArkFont.semibold(13))
                PlatformBadgePill(platform: item.platformId)
                Spacer()
                if let host = item.approval.host, !host.isEmpty {
                    Text(host)
                        .font(ArkFont.mono(10.5))
                        .foregroundStyle(.tertiary)
                }
            }

            Text(item.approval.title)
                .font(ArkFont.semibold(14))

            if let detail = item.approval.detail, !detail.isEmpty {
                Text(detail)
                    .font(ArkFont.mono(11))
                    .foregroundStyle(.secondary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ArkTheme.subtleFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            HStack(spacing: 7) {
                pillButton(String(localized: "Allow"), fill: ArkTheme.ink, fg: ArkTheme.onInk) { decide(item, decision: "allow_once") }
                pillButton(String(localized: "This Session"), fill: ArkTheme.subtleFill, fg: .primary) { decide(item, decision: "allow_session") }
                pillButton(String(localized: "Always"), fill: ArkTheme.subtleFill, fg: .primary) { decide(item, decision: "allow_always") }
                Spacer()
                pillButton(String(localized: "Deny"), fill: ArkTheme.rose.opacity(0.10), fg: ArkTheme.rose) { decide(item, decision: "deny") }
            }
        }
        .padding(14)
        .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
        )
        .shadow(color: ArkTheme.cardShadow, radius: 10, y: 4)
    }

    private func pillButton(_ label: String, fill: Color, fg: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(ArkFont.semibold(11.5))
                .foregroundStyle(fg)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .background(fill, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func decide(_ item: PendingApprovalItem, decision: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task { await store.decideApproval(item: item, decision: decision) }
    }
}
