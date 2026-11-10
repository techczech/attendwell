import SwiftUI
import NearbyLink

struct ContentView: View {
    @ObservedObject var model: SpikeModel
    @State private var search = ""
    @State private var scanning = false

    private var shown: [NameEntry] {
        let visible = model.names.filter { !$0.hidden }
        return search.isEmpty ? visible : visible.filter { $0.displayName.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                pairing
                Text(model.status).font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.vertical, 8)
                    .background(model.connectedMac == nil ? Color.orange.opacity(0.25) : Color.green.opacity(0.25))
                HStack(spacing: 0) {
                    namesList
                    Divider()
                    logView
                }
            }
            .navigationTitle(model.title.isEmpty ? "Nearby Spike" : model.title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationViewStyle(.stack)
        .sheet(isPresented: $scanning) { QRScannerView { code in model.keyText = code; scanning = false; model.connect() } }
    }

    private var pairing: some View {
        HStack {
            TextField("Paste key (or the QR text)", text: $model.keyText).textFieldStyle(.roundedBorder).autocapitalization(.none).disableAutocorrection(true)
            Button("Connect") { model.connect() }.buttonStyle(.borderedProminent)
            if QRScannerView.isAvailable { Button("Scan") { scanning = true }.buttonStyle(.bordered) }
        }.padding(.horizontal).padding(.top, 8)
        .overlay(alignment: .bottomLeading) { if let e = model.keyError { Text(e).font(.caption).foregroundColor(.red).padding(.horizontal) } }
    }

    private var namesList: some View {
        VStack(spacing: 0) {
            TextField("Search names", text: $search).textFieldStyle(.roundedBorder).padding(8)
            List(shown, id: \.id) { n in
                Button { model.checkIn(n) } label: {
                    HStack { Text(n.displayName); Spacer(); if model.checkedIn.contains(n.id) { Image(systemName: "checkmark.circle.fill").foregroundColor(.green) } }
                }
            }.listStyle(.plain)
        }.frame(minWidth: 280, maxWidth: .infinity)
    }

    private var logView: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Event log (\(model.log.count))").font(.subheadline.bold())
                Spacer()
                ShareLink(item: model.logText) { Label("Share log", systemImage: "square.and.arrow.up") }
            }.padding(8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(model.log.enumerated()), id: \.offset) { i, l in Text(l).font(.system(size: 11, design: .monospaced)).id(i) }
                    }.padding(.horizontal, 8)
                }.onChange(of: model.log.count) { n in proxy.scrollTo(n - 1, anchor: .bottom) }
            }
        }.frame(minWidth: 280, maxWidth: .infinity).background(Color(white: 0.5, opacity: 0.08))
    }
}
