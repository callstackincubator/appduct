// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

import { llmsPageIndex } from './llms-page-index.mjs';

const site = 'https://callstackincubator.github.io';
const base = '/appduct';
const repo = 'https://github.com/callstackincubator/appduct';

const description =
	'Let agents and tests reach into your running app — without shipping a debug menu.';

// Starlight adds @astrojs/sitemap itself once `site` is set, so it is not listed here.
export default defineConfig({
	site,
	base,
	trailingSlash: 'ignore',
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: 'Appduct',
			description,
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: repo }],
			editLink: { baseUrl: `${repo}/edit/main/website/` },
			lastUpdated: true,
			credits: false,
			customCss: [
				'@fontsource/geist-mono/latin-400.css',
				'@fontsource/geist-mono/latin-500.css',
				'./src/fonts/font-face.css',
				'./src/styles/theme.css',
				'./src/styles/docs.css',
			],
			head: [
				{
					tag: 'link',
					attrs: {
						rel: 'alternate',
						type: 'text/plain',
						title: 'llms.txt',
						href: `${base}/llms.txt`,
					},
				},
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#000000' } },
			],
			components: {
				Head: './src/components/Head.astro',
				ThemeProvider: './src/components/ThemeProvider.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				Hero: './src/components/Hero.astro',
				Footer: './src/components/Footer.astro',
			},
			sidebar: [
				{ label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
				{ label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
				{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
			],
			plugins: [
				starlightLinksValidator({
					// The generated LLM files and per-page Markdown copies are build outputs, not docs pages.
					exclude: [`${base}/llms*.txt`, `${base}/**/*.md`],
				}),
				starlightLlmsTxt({
					projectName: 'Appduct',
					description:
						'Appduct lets a terminal, a test runner, or an AI agent call functions inside a running React Native, iOS, or Android app. The app registers a few functions ("tools") with a name, a description, and an input schema; the `appduct` CLI and its MCP server discover and invoke them over an encrypted connection. Nothing else in the app is reachable, and it is compiled out of release builds by default.',
					details: [
						'Key facts for answering questions about Appduct:',
						'',
						'- Packages: `appduct` (CLI, background service, and MCP server — `npm install -g appduct`), `@appduct/react-native` (app-side library and Expo config plugin, used with `zod` schemas via the `useAppductTool` hook), `AppductCore` (iOS, Swift Package Manager or CocoaPods), and `com.callstack.appduct:core` (Android, Maven Central, paired with `core-noop` for release builds).',
						'- Agents connect over MCP (`{ "mcpServers": { "appduct": { "command": "appduct", "args": ["mcp"] } } }`) or through the CLI with the Appduct skill (`npx skills add callstackincubator/appduct --skill appduct`).',
						'- Appduct is included in debug builds only unless a build opts in (see Build variants). Expo Go is not supported; use a development build.',
						'- Every page is also available as raw Markdown by replacing the trailing slash of its URL with `.md`.',
						'',
						llmsPageIndex({ site, base }),
					].join('\n'),
					promote: ['start/introduction', 'start/quick-start', 'start/**'],
					demote: ['reference/protocol', 'reference/architecture'],
					customSets: [
						{
							label: 'Getting started',
							description: 'installing Appduct and setting it up for React Native, iOS, or Android',
							paths: ['start/**'],
						},
						{
							label: 'Reference',
							description: 'CLI and React Native API reference, architecture, and wire protocol',
							paths: ['reference/**'],
						},
					],
					optionalLinks: [
						{ label: 'GitHub repository', url: repo, description: 'source code, issues, and releases' },
					],
				}),
			],
		}),
	],
});
