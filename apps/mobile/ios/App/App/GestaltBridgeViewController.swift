import Capacitor

final class GestaltBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(GestaltProtectedStoragePlugin())
    }
}
