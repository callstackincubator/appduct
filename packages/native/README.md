<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct native SDKs

The Swift and Kotlin SDKs let you register tools in native apps and call them from a terminal, a test runner or an AI agent.

## Choose your SDK

- [iOS](https://github.com/callstackincubator/appduct/blob/main/packages/native/ios/README.md): Swift SDK, installed with Swift Package Manager or CocoaPods
- [Android](https://github.com/callstackincubator/appduct/blob/main/packages/native/android/README.md): Kotlin SDK, installed from Maven Central
- For a React Native app, use [`@appduct/react-native`](https://github.com/callstackincubator/appduct/blob/main/packages/react-native/README.md).

## Try an example

The [SwiftUI playground](https://github.com/callstackincubator/appduct/blob/main/playground-native/ios/README.md) and [Compose playground](https://github.com/callstackincubator/appduct/blob/main/playground-native/android/README.md) register the same five demo tools and the `playground_ping` event.

## Contributing

See [Native core development](https://github.com/callstackincubator/appduct/blob/main/docs/internal/native-core.md) for source layout, React Native integration and publishing. [Conformance fixtures](https://github.com/callstackincubator/appduct/blob/main/packages/native/fixtures/README.md) check shared behavior across implementations.

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
