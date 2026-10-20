import Capacitor
class LocalViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocalMediaPlugin())
    }
}
