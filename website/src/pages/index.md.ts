// The landing page as Markdown, at /appduct/index.md, for agents that would rather not parse
// the animated HTML. Built from the same copy the page renders (src/landing/content.ts).
import type { APIRoute } from 'astro';

import { agents, callers, faq, platforms, safety, site, why } from '../landing/content';

export const GET: APIRoute = ({ site: origin }) => {
	const base = import.meta.env.BASE_URL.replace(/\/$/, '');
	const url = (slug: string) => new URL(`${base}/${slug}.md`, origin).href;
	const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;

	const markdown = [
		'# Appduct',
		`> ${site.description}`,
		'Appduct lets a terminal, a test runner or an AI agent call functions inside your app while it runs. You register a few functions ("tools") with a name, a description and an input schema. Nothing else in the app is reachable.',
		`Install the CLI: \`${site.install}\`. Docs index for agents: ${new URL(`${base}/llms.txt`, origin).href}`,
		'## Why use it',
		why.map(({ title, body }) => `- **${title}.** ${body}`).join('\n'),
		'## Register a tool in your app',
		...platforms.flatMap((p) => [
			`### ${p.name}`,
			`Package: \`${p.pkg}\`. ${p.note} Setup: ${url(p.docs)}`,
			fence(p.lang, p.code),
		]),
		'## Call it',
		...callers.flatMap((c) => [`### From ${c.name.toLowerCase() === 'agent' ? 'an agent (MCP config)' : `a ${c.name.toLowerCase()}`}`, fence(c.lang, c.code)]),
		`Agents that work in a shell can use the CLI with the Appduct skill: \`${agents.skill}\`. Works with ${agents.clients.join(', ')}. Guide: ${url('guides/agents')}`,
		'## Safe by default',
		safety.map(({ title, body }) => `- **${title}.** ${body}`).join('\n'),
		`Security model: ${url('guides/security')}. Build variants: ${url('guides/build-variants')}`,
		'## FAQ',
		faq.map(({ q, a }) => `### ${q}\n\n${a}`).join('\n\n'),
		'## Links',
		[
			`- Quick start: ${url('start/quick-start')}`,
			`- Introduction: ${url('start/introduction')}`,
			`- GitHub: ${site.repo}`,
			'- License: MIT',
		].join('\n'),
	].join('\n\n');

	return new Response(`${markdown}\n`, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
