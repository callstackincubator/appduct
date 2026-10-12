<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct shared library

`@appduct/shared` contains Appduct's wire protocol types and shared TypeScript SDK helpers. It is an internal dependency: you don't add it to your app directly, and its exports can change in any release.

## Used by

- [`appduct`](https://github.com/callstackincubator/appduct/blob/main/packages/appduct/README.md): CLI, MCP server and test client
- [`@appduct/react-native`](https://github.com/callstackincubator/appduct/blob/main/packages/react-native/README.md): React Native SDK
- [`@appduct/web`](https://github.com/callstackincubator/appduct/blob/main/packages/web/README.md): Web SDK

## Contributor documentation

- [Architecture](https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md): package boundaries and SDK entry points
- [Wire protocol](https://github.com/callstackincubator/appduct/blob/main/docs/PROTOCOL.md): messages, schemas and connection rules
- [Conformance fixtures](https://github.com/callstackincubator/appduct/blob/main/packages/native/fixtures/README.md): shared parsing and validation cases

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
