# Use Appduct with an agent

An agent can reach your app's tools in two ways: over MCP, or through the `appduct` CLI. Both need the CLI installed (`npm install -g appduct`) and your app running with Appduct in it.

Both read your app's deep-link scheme from its project files (`Info.plist` on iOS, `build.gradle` on Android, `app.json` in an Expo app), so there's nothing to configure.

## Over MCP

Add Appduct to your agent's MCP config. This works in Claude Code, Cursor, and any other MCP client:

```json
{
  "mcpServers": {
    "appduct": { "command": "appduct", "args": ["mcp"] }
  }
}
```

Your app's tools don't appear as separate MCP tools. The agent lists, describes and calls them through Appduct's built-in tools, such as `appduct_list_tools` and `appduct_call_tool`, so the agent's tool list stays the same size however many tools your app registers. The built-in tools describe themselves, so the agent needs no extra instructions.

## Through the CLI

For agents that work in a shell, and for scripts and CI. Install the Appduct skill so the agent knows the commands:

```bash
npx skills add callstackincubator/appduct --skill appduct
```

## Let an agent set up Appduct

If an agent will add Appduct to your app or write its tools, install the skill above even if you connect over MCP. It covers setup and the rules tool schemas have to follow.
