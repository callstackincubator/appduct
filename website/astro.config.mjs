// @ts-check
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

import { llmsPageIndex } from './llms-page-index.mjs';

const site = 'https://callstackincubator.github.io';
const base = '/appduct';
const repo = 'https://github.com/callstackincubator/appduct';

const description =
	'Turn your running app into an MCP server: your AI agent, your tests and your terminal call the functions you register. For iOS, Android, React Native, Flutter and web.';
const ogAlt = 'Appduct by Callstack. Your app is an MCP server now.';

export default defineConfig({
	site,
	base,
	trailingSlash: 'ignore',
	devToolbar: { enabled: false },
	integrations: [
		// Starlight would add the sitemap itself; it is listed here to drop the duplicate home
		// entry without a trailing slash, which the build emits alongside `${base}/`.
		sitemap({ filter: (page) => page !== `${site}${base}` }),
		starlight({
			title: 'Appduct',
			description,
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: repo }],
			editLink: { baseUrl: `${repo}/edit/main/website/` },
			lastUpdated: true,
			credits: false,
			// src/pages/404.astro replaces Starlight's 404, in the landing page's look (docs/DESIGN.md).
			disable404Route: true,
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
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#0a0a0a' } },
				// Starlight sets og:title, og:description and a large Twitter card, but no image.
				{ tag: 'meta', attrs: { property: 'og:image', content: `${site}${base}/og.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: ogAlt } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: `${site}${base}/og.png` } },
				{ tag: 'meta', attrs: { name: 'twitter:image:alt', content: ogAlt } },
				{ tag: 'link', attrs: { rel: 'icon', href: `${base}/favicon-32.png`, type: 'image/png', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}/apple-touch-icon.png` } },
				{ tag: 'link', attrs: { rel: 'manifest', href: `${base}/site.webmanifest` } },
			],
			components: {
				Head: './src/components/Head.astro',
				ThemeProvider: './src/components/ThemeProvider.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				Footer: './src/components/Footer.astro',
			},
			sidebar: [
				{ label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
				{ label: 'Installation', items: [{ autogenerate: { directory: 'install' } }] },
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
						'Appduct lets a terminal, a test runner, or an AI agent call functions inside a running iOS, Android, React Native, Flutter, or web app. The app registers a few functions ("tools") with a name, a description, and an input schema; the `appduct` CLI and its MCP server discover and invoke them over an encrypted connection. Nothing else in the app is reachable, and it is compiled out of release builds by default.',
					details: [
						'Key facts for answering questions about Appduct:',
						'',
						'- Packages: `appduct` (CLI, background service, and MCP server — `npm install -g appduct`), `AppductCore` (iOS, Swift Package Manager or CocoaPods), `com.callstack.appduct:core` (Android, Maven Central, paired with `core-noop` for release builds), `@appduct/react-native` (app-side library and Expo config plugin, used with `zod` schemas via the `useAppductTool` hook), `appduct` on pub.dev (Flutter, used with `Appduct.instance.registerTool`), and `@appduct/web` (web pages in any framework).',
						'- Agents connect over MCP (`{ "mcpServers": { "appduct": { "command": "appduct", "args": ["mcp"] } } }`) or through the CLI with the Appduct skill (`npx skills add callstackincubator/appduct --skill appduct`).',
						'- Appduct is included in debug builds only (debug and profile in Flutter) unless a build opts in (see Build variants). Expo Go is not supported; use a development build.',
						'- Every page is also available as raw Markdown by replacing the trailing slash of its URL with `.md`. The landing page is at `index.md`.',
						'',
						llmsPageIndex({ site, base }),
					].join('\n'),
					promote: ['start/introduction', 'start/quick-start', 'start/**', 'install/**'],
					demote: ['reference/architecture'],
					customSets: [
						{
							label: 'Getting started',
							description: 'what Appduct is and the fastest way to try it',
							paths: ['start/**'],
						},
						{
							label: 'Installation',
							description: 'setting up Appduct for iOS, Android, React Native, Flutter, or the web',
							paths: ['install/**'],
						},
						{
							label: 'Reference',
							description: 'CLI and React Native API reference, and architecture',
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
