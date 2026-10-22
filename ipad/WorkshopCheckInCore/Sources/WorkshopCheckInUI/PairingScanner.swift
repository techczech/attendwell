#if os(iOS)
import SwiftUI
import AVFoundation
import UIKit

/// Only QR payload strings leave this controller. Camera frames are never
/// stored, logged or sent. Simulator compilation is not camera verification.
struct PairingScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onDenied: () -> Void
    func makeUIViewController(context: Context) -> ScannerController {
        ScannerController(onCode: onCode, onDenied: onDenied)
    }
    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) { controller.stop() }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "org.workshop-check-in.camera")
    private let onCode: (String) -> Void
    private let onDenied: () -> Void
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false
    private var visible = false
    init(onCode: @escaping (String) -> Void, onDenied: @escaping () -> Void) {
        self.onCode = onCode; self.onDenied = onDenied; super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Not used") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        let layer = AVCaptureVideoPreviewLayer(session: session); layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer); preview = layer
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); visible = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, self.visible else { return }
                    if granted { self.configure() } else { self.onDenied() }
                }
            }
        default: onDenied()
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews(); preview?.frame = view.bounds
        if let orientation = view.window?.windowScene?.interfaceOrientation,
           let connection = preview?.connection, connection.isVideoOrientationSupported {
            switch orientation {
            case .landscapeLeft: connection.videoOrientation = .landscapeLeft
            case .landscapeRight: connection.videoOrientation = .landscapeRight
            case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
            default: connection.videoOrientation = .portrait
            }
        }
    }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stop() }
    func stop() { visible = false; queue.async { [session] in if session.isRunning { session.stopRunning() } } }
    private func configure() {
        queue.async { [weak self] in
            guard let self else { return }
            if self.session.inputs.isEmpty {
                guard let camera = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: camera), self.session.canAddInput(input) else {
                    DispatchQueue.main.async { self.onDenied() }; return
                }
                self.session.beginConfiguration(); self.session.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard self.session.canAddOutput(output) else {
                    self.session.commitConfiguration(); DispatchQueue.main.async { self.onDenied() }; return
                }
                self.session.addOutput(output); output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]; self.session.commitConfiguration()
            }
            self.session.startRunning()
        }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, visible, let qr = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let text = qr.stringValue else { return }
        delivered = true; stop(); onCode(text)
    }
}
#endif
