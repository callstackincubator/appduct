// Everything the landing page says, in one place: the page renders it, and index.md.ts turns the
// same words into the Markdown copy agents read. Change copy here, not in the components.

export const site = {
	title: 'Appduct — Turn your running app into an MCP server',
	description:
		'Register functions in your app and your AI agent calls them over MCP. So can your tests and your terminal. iOS, Android, React Native, Flutter and web. Open source, debug builds only.',
	ogAlt: 'Appduct by Callstack. Your app is an MCP server now.',
	repo: 'https://github.com/callstackincubator/appduct',
	install: 'npm install -g appduct',
};

// The motto, shared with the social card and the README banner (og/og.html).
export const hero = {
	title: 'Your app is an <em>MCP server now.</em>',
	lede: 'Register functions in your app and your agent calls them as tools. Three calls instead of a minute of tapping.',
	// What the agent sees once the app is running: the same three tools the race below calls.
	app: 'Shop · iPhone 17',
	tools: [
		{ name: 'login', args: 'user', about: 'Sign in as a test user' },
		{ name: 'seed_cart', args: 'items', about: 'Fill the cart' },
		{ name: 'open_screen', args: 'name', about: 'Go to any screen' },
	],
};

export const platforms = [
	{
		id: 'ios',
		name: 'iOS',
		pkg: 'AppductCore',
		install: '.package(url: "https://github.com/callstackincubator/appduct", from: "0.10.0")',
		note: 'Swift, iOS 15.1+. Swift Package Manager or CocoaPods.',
		docs: 'install/ios',
		file: 'ShopApp.swift',
		lang: 'swift',
		code: `import AppductCore

try Appduct.shared.register(
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: [
    "type": "object",
    "properties": ["items": ["type": "number"]],
  ]
) { args in
  let items = (args["items"] as? NSNumber)?.intValue ?? 0
  return ["added": items]
}`,
	},
	{
		id: 'android',
		name: 'Android',
		pkg: 'com.callstack.appduct:core',
		install: 'debugImplementation("com.callstack.appduct:core:<version>")',
		note: 'Kotlin, Android 7.0+. Maven Central, with a no-op artifact for release.',
		docs: 'install/android',
		file: 'ShopApp.kt',
		lang: 'kotlin',
		code: `import com.callstack.appduct.Appduct
import org.json.JSONObject

Appduct.register(
  name = "seed_cart",
  description = "Fill the cart with test items.",
  inputSchema = JSONObject(
    """{"type":"object","properties":{"items":{"type":"number"}}}""",
  ),
) { args ->
  JSONObject().put("added", args.optInt("items"))
}`,
	},
	{
		id: 'react-native',
		name: 'React Native',
		pkg: '@appduct/react-native',
		install: 'npm install @appduct/react-native zod',
		note: 'Expo dev builds or bare apps. New Architecture.',
		docs: 'install/react-native',
		file: 'CartScreen.tsx',
		lang: 'tsx',
		code: `import { useAppductTool } from "@appduct/react-native";
import { z } from "zod";

useAppductTool({
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: z.object({ items: z.number() }),
  handler: async ({ items }) => ({ added: items }),
});`,
	},
	{
		id: 'flutter',
		name: 'Flutter',
		pkg: 'appduct',
		install: 'flutter pub add appduct',
		note: 'Dart. Phones and desktop, in debug and profile builds.',
		docs: 'install/flutter',
		file: 'main.dart',
		lang: 'dart',
		code: `import 'package:appduct/appduct.dart';

Appduct.instance.registerTool(
  'seed_cart',
  description: 'Fill the cart with test items.',
  inputSchema: {
    'type': 'object',
    'properties': {'items': {'type': 'number'}},
  },
  handler: (args, context) => {'added': args['items']},
);`,
	},
	{
		id: 'web',
		name: 'Web',
		pkg: '@appduct/web',
		install: 'npm install @appduct/web',
		note: 'Any framework. Runs on localhost, left out of production bundles.',
		docs: 'install/web',
		file: 'cart.ts',
		lang: 'ts',
		code: `import { registerTool } from "@appduct/web";

registerTool({
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: {
    type: "object",
    properties: { items: { type: "number" } },
  },
  handler: async ({ items }) => ({ added: items }),
});`,
	},
] as const;

export const callers = [
	{
		id: 'agent',
		name: 'Agent',
		lang: 'json',
		code: `{
  "mcpServers": {
    "appduct": { "command": "appduct", "args": ["mcp"] }
  }
}`,
	},
	{
		id: 'test',
		name: 'Test',
		lang: 'ts',
		code: `import { connect } from "appduct/client";

const app = await connect();
await app.call("seed_cart", { items: 3 });`,
	},
	{
		id: 'terminal',
		name: 'Terminal',
		lang: 'sh',
		code: `$ appduct tools call seed_cart --input '{"items":3}'`,
	},
] as const;

export const why = [
	{
		icon: 'agent',
		title: 'Agents drive your app',
		body: 'Your agent reads your tools and calls them. Fewer screenshots, no guessed taps.',
	},
	{
		icon: 'test',
		title: 'Tests skip the setup',
		body: 'Log in, seed data, open the screen. One call each. Then test the part that matters.',
	},
	{
		icon: 'lock',
		title: 'No debug menu to hide',
		body: 'No secret gestures, no admin screen. Only the functions you register are reachable.',
	},
] as const;

export const safety = [
	{ title: 'Debug builds only', body: 'Release builds leave Appduct out at compile time. Opt in for internal builds.' },
	{ title: 'Only what you register', body: 'Nothing else in the app can be called.' },
	{ title: 'Encrypted', body: 'Every connection is encrypted, and the app checks who is on the other end.' },
	{ title: 'Runs on your machine', body: 'One local service for every device. No account, no cloud.' },
] as const;

/** The scrolling strip under the hero. */
export const marquee = [
	'iOS',
	'SwiftUI',
	'UIKit',
	'Android',
	'Kotlin',
	'Jetpack Compose',
	'React Native',
	'Expo',
	'Flutter',
	'Web',
] as const;

export const agents = {
	clients: ['Claude Code', 'Cursor', 'Any MCP client'],
	skill: 'npx skills add callstackincubator/appduct --skill appduct',
};

export const faq = [
	{
		q: 'What is Appduct?',
		a: 'An open-source tool that turns your running app into an MCP server. You register functions in your app, and your AI agent calls them as tools. Your tests and your terminal can call them too.',
	},
	{
		q: 'Does my app run a server?',
		a: 'No. Your app connects out to the Appduct service on your computer, over an encrypted connection. `appduct mcp` serves your app\'s tools to your agent from there.',
	},
	{
		q: 'Does it end up in my release build?',
		a: 'No. Appduct is in debug builds only (debug and profile in Flutter), and release builds leave it out at compile time. You can opt in for internal builds, like a TestFlight build your CI drives.',
	},
	{
		q: 'Which platforms does it support?',
		a: 'iOS in Swift, Android in Kotlin, React Native (Expo development builds or bare apps; Expo Go is not supported), Flutter, and web pages in any framework.',
	},
	{
		q: 'Which agents work with it?',
		a: 'Any MCP client, like Claude Code or Cursor. Agents that work in a shell can use the CLI with the Appduct skill.',
	},
	{
		q: 'What does it cost?',
		a: 'Nothing. It is MIT-licensed and runs on your machine.',
	},
] as const;
