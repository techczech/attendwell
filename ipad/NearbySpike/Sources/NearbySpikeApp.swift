import SwiftUI

@main
struct NearbySpikeApp: App {
    @StateObject private var model = SpikeModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .onChange(of: phase) { if $0 == .active { model.appDidBecomeActive() } }
        }
    }
}
