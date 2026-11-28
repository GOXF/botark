import CryptoKit
import Foundation

public enum SyncCryptoError: LocalizedError {
    case invalidBase64Key
    case invalidKeyLength(Int)
    case invalidCiphertextEncoding
    case decryptionFailed

    public var errorDescription: String? {
        switch self {
        case .invalidBase64Key: return String(localized: "Invalid Encryption Key Format")
        case .invalidKeyLength(let n): return String.localizedStringWithFormat(String(localized: "The AES-256 key must be 32 bytes (received %lld)."), n)
        case .invalidCiphertextEncoding: return String(localized: "Invalid Encrypted Data Format")
        case .decryptionFailed: return String(localized: "AES-256-GCM decryption failed. Check the decryption key.")
        }
    }
}

public enum SyncCrypto {
    public static func decodeBase64Url(_ input: String) -> Data? {
        var str = input
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = str.count % 4
        if remainder > 0 {
            str.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: str)
    }

    public static func encodeBase64Url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func symmetricKey(fromBase64Url keyString: String) throws -> SymmetricKey {
        guard let raw = decodeBase64Url(keyString) else {
            throw SyncCryptoError.invalidBase64Key
        }
        guard raw.count == 32 else {
            throw SyncCryptoError.invalidKeyLength(raw.count)
        }
        return SymmetricKey(data: raw)
    }

    /// Decrypts Node.js `encryptAesGcmCombined` base64 payload:
    ///   [12-byte nonce][ciphertext][16-byte GCM tag]
    public static func decryptAesGcmCombined(_ combinedBase64: String, keyBase64Url: String) throws -> Data {
        let key = try symmetricKey(fromBase64Url: keyBase64Url)
        guard let combined = Data(base64Encoded: combinedBase64.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw SyncCryptoError.invalidCiphertextEncoding
        }
        do {
            let sealedBox = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(sealedBox, using: key)
        } catch {
            throw SyncCryptoError.decryptionFailed
        }
    }

    public static func encryptAesGcmCombined(_ plaintext: Data, keyBase64Url: String, nonceData: Data? = nil) throws -> String {
        let key = try symmetricKey(fromBase64Url: keyBase64Url)
        let nonce: AES.GCM.Nonce
        if let nonceData {
            nonce = try AES.GCM.Nonce(data: nonceData)
        } else {
            nonce = AES.GCM.Nonce()
        }
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
        guard let combined = sealed.combined else {
            throw SyncCryptoError.decryptionFailed
        }
        return combined.base64EncodedString()
    }

    public static func fingerprint(forKeyBase64Url keyString: String) -> String {
        let digest = SHA256.hash(data: Data(keyString.utf8))
        return digest.prefix(4).map { String(format: "%02X", $0) }.joined()
    }
}
