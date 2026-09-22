// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "JevQAMonitor",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "JevQAMonitor",
            path: "Sources/JevQAMonitor"
        )
    ]
)
