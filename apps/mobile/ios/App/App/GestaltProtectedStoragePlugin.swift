import Foundation
import Capacitor
import Security

@objc(GestaltProtectedStoragePlugin)
public final class GestaltProtectedStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GestaltProtectedStoragePlugin"
    public let jsName = "GestaltProtectedStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.alibaba.gestalt.mobile.protected-storage.v1"

    @objc func get(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve()
            return
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Protected Mobile value cannot be opened", nil, securityError(status))
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = validKey(call), let value = call.getString("value") else {
            if call.getString("value") == nil { call.reject("Protected Mobile value is required") }
            return
        }
        let data = Data(value.utf8)
        let query = baseQuery(key)
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            call.reject("Protected Mobile value cannot be stored", nil, securityError(status))
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Protected Mobile value cannot be removed", nil, securityError(status))
            return
        }
        call.resolve()
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private func validKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"),
              key.range(of: "^[A-Za-z0-9:._-]{1,256}$", options: .regularExpression) != nil else {
            call.reject("Protected Mobile key is invalid")
            return nil
        }
        return key
    }

    private func securityError(_ status: OSStatus) -> Error {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
}
