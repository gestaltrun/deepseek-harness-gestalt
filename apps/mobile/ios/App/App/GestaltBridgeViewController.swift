import Capacitor
import Network
import WebKit

final class GestaltBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(GestaltProtectedStoragePlugin())
        #if DEBUG && targetEnvironment(simulator)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            if #available(iOS 17.0, *), let proxy = self?.simulatorProxyConfiguration() {
                self?.webView?.configuration.websiteDataStore.proxyConfigurations = [proxy]
            }
        }
        #endif
    }

    #if DEBUG && targetEnvironment(simulator)
    @available(iOS 17.0, *)
    private func simulatorProxyConfiguration() -> ProxyConfiguration? {
        let environment = ProcessInfo.processInfo.environment
        let host = environment["DSH_IOS_SIMULATOR_PROXY_HOST"]
        let port = environment["DSH_IOS_SIMULATOR_PROXY_PORT"]
        if host == nil && port == nil { return nil }
        guard let host, !host.isEmpty, let port, let value = UInt16(port), value > 0,
              let endpointPort = NWEndpoint.Port(rawValue: value) else {
            fatalError("iOS Simulator proxy requires a non-empty host and a port from 1 through 65535")
        }
        let endpoint = NWEndpoint.hostPort(host: .name(host, nil), port: endpointPort)
        return ProxyConfiguration(httpCONNECTProxy: endpoint)
    }
    #endif
}
