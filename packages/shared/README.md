[![Appduct][appduct-banner]][repo]

### Shared library for Appduct

[![MIT license][license-badge]][license] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

**`@appduct/shared`** is the wire protocol v2 implementation shared by the `appduct` daemon/CLI/MCP and `@appduct/react-native`: the bootstrap payload codec, every post-claim message type and its strict runtime guard, the control-plane RPC method/param/result types, the shared error-type enum, and Standard Schema helpers — all with **no runtime dependencies**. Depend on it directly if you're writing a new client or server that speaks the Appduct wire protocol (see [`docs/PROTOCOL.md`][protocol] for the field-level spec this package implements); most consumers of Appduct itself never need to import it, since `appduct` and `@appduct/react-native` already re-export what they need from it.

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[appduct-banner]: https://img.shields.io/badge/Appduct-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/appduct
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
[protocol]: https://github.com/callstackincubator/appduct/blob/main/docs/PROTOCOL.md
[license-badge]: https://img.shields.io/github/license/callstackincubator/appduct?style=for-the-badge
[license]: https://github.com/callstackincubator/appduct/blob/main/LICENSE
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/appduct/pulls
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
