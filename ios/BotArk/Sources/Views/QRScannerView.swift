import AVFoundation
import SwiftUI
import UIKit

struct QRScannerSheet: View {
    @Bindable var store: BotArkStore
    @Environment(\.dismiss) private var dismiss

    @State private var manualUri = ""
    @State private var torchEnabled = false
    @State private var cameraAvailable = false
    @State private var scannedOnce = false
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    scannerHero

                    VStack(alignment: .leading, spacing: 10) {
                        Text(String(localized: "Paste Pairing Link"))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.secondary)

                        HStack(spacing: 8) {
                            TextField("botark://pair?...", text: $manualUri, axis: .vertical)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .font(.system(size: 12, design: .monospaced))
                                .lineLimit(2...3)
                                .padding(10)
                                .background(ArkTheme.subtleFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                            Button {
                                if let pasted = UIPasteboard.general.string {
                                    manualUri = pasted
                                }
                            } label: {
                                Image(systemName: "doc.on.clipboard")
                                    .font(.system(size: 14, weight: .medium))
                                    .frame(width: 38, height: 38)
                                    .background(ArkTheme.subtleFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .accessibilityLabel(String(localized: "Paste"))
                        }

                        Button {
                            Task { await performPairing(uri: manualUri) }
                        } label: {
                            HStack(spacing: 6) {
                                if store.pairingBusy {
                                    ProgressView().tint(.white)
                                } else {
                                    Image(systemName: "bolt.horizontal.fill")
                                        .font(.system(size: 13, weight: .semibold))
                                }
                                Text(store.pairingBusy ? String(localized: "Pairing…") : String(localized: "Pair Now"))
                                    .font(.system(size: 14, weight: .semibold))
                            }
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .background(ArkTheme.accent, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(store.pairingBusy || manualUri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding(14)
                    .background(ArkTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .strokeBorder(ArkTheme.hairline, lineWidth: 0.8)
                    )

                    if let err = localError ?? store.lastError {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(.orange)
                            Text(err)
                                .font(.system(size: 12.5))
                                .foregroundStyle(.primary)
                            Spacer(minLength: 0)
                        }
                        .padding(11)
                        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                .padding(16)
            }
            .background(ArkTheme.canvas.ignoresSafeArea())
            .navigationTitle(String(localized: "Scan to Pair"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Close")) { dismiss() }
                }
            }
            .onAppear {
                cameraAvailable = AVCaptureDevice.default(for: .video) != nil
            }
        }
    }

    private var scannerHero: some View {
        ZStack {
            if cameraAvailable {
                CameraQRPreview(torchEnabled: $torchEnabled) { code in
                    guard !scannedOnce, !store.pairingBusy else { return }
                    scannedOnce = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    manualUri = code
                    Task {
                        await performPairing(uri: code)
                    }
                }
                .frame(height: 270)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(scannerReticle)
                .overlay(alignment: .topTrailing) {
                    Button {
                        torchEnabled.toggle()
                    } label: {
                        Image(systemName: torchEnabled ? "flashlight.on.fill" : "flashlight.off.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(10)
                            .background(.black.opacity(0.55), in: Circle())
                    }
                    .padding(12)
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 46, weight: .light))
                        .foregroundStyle(Color("AccentColor"))
                    Text(String(localized: "No rear camera detected"))
                        .font(.subheadline.weight(.semibold))
                    Text(String(localized: "In the Xcode simulator, paste the botark://pair?... link from the desktop app below, or open the link directly."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 12)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 190)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
        }
    }

    private var scannerReticle: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(.white.opacity(0.85), lineWidth: 2.5)
                .frame(width: 190, height: 190)

            VStack {
                Spacer()
                Text(String(localized: "Point the camera at the BotArk desktop pairing code"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(.bottom, 14)
            }
        }
    }

    private var zeroServerTipsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(String(localized: "Direct Connection, No Relay"), systemImage: "lock.shield.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.green)
            Text(String(localized: "Pair over the same Wi-Fi network, a hotspot, or Tailscale. Use a trusted network: the bridge itself uses HTTP and does not use a third-party relay."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func performPairing(uri: String) async {
        localError = nil
        await store.pair(withUri: uri)
        if store.connectionState.isBridgeConnected {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } else {
            scannedOnce = false
            localError = store.lastError
        }
    }
}

private struct CameraQRPreview: UIViewControllerRepresentable {
    @Binding var torchEnabled: Bool
    let onCodeScanned: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onCodeScanned = onCodeScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {
        uiViewController.setTorch(enabled: torchEnabled)
    }
}

private final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCodeScanned: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var isConfigured = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureCaptureIfAuthorized()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if isConfigured && !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        setTorch(enabled: false)
        if session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.stopRunning()
            }
        }
    }

    func setTorch(enabled: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        try? device.lockForConfiguration()
        device.torchMode = enabled ? .on : .off
        device.unlockForConfiguration()
    }

    private func configureCaptureIfAuthorized() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setupSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted {
                    DispatchQueue.main.async { self?.setupSession() }
                }
            }
        default:
            break
        }
    }

    private func setupSession() {
        guard !isConfigured,
              let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }

        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview
        isConfigured = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let readable = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              readable.type == .qr,
              let value = readable.stringValue,
              !value.isEmpty else { return }
        onCodeScanned?(value)
    }
}
