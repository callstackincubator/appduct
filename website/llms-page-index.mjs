// Builds the per-page index that goes into llms.txt. starlight-llms-txt only links the
// concatenated files, so this lists every docs page (title, description, raw-Markdown URL)
// the way llmstxt.org expects. It reads frontmatter straight from disk at config time, which
// keeps it in step with the sidebar without a second source of truth.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = fileURLToPath(new URL('./src/content/docs/', import.meta.url));

/** Sidebar groups in display order: directory → label. */
const groups = [
	['start', 'Start here'],
	['guides', 'Guides'],
	['reference', 'Reference'],
];

/** @param {string} source */
function frontmatter(source) {
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
	/** @param {RegExp} pattern */
	const field = (pattern) => {
		const raw = pattern.exec(block)?.[1]?.trim() ?? '';
		return raw.replace(/^(['"])(.*)\1$/, '$2');
	};
	const order = Number(/^\s+order:\s*(-?\d+)/m.exec(block)?.[1]);
	return {
		title: field(/^title:\s*(.+)$/m),
		description: field(/^description:\s*(.+)$/m),
		order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
	};
}

/**
 * @param {{ site: string, base: string }} options
 * @returns {string} Markdown lists (no headings — llms.txt `details` must not contain any).
 */
export function llmsPageIndex({ site, base }) {
	const sections = [];
	for (const [dir, label] of groups) {
		const full = join(docsDir, dir);
		if (!existsSync(full)) continue;
		const pages = readdirSync(full)
			.filter((name) => /\.mdx?$/.test(name))
			.map((name) => {
				const slug = `${dir}/${name.replace(/\.mdx?$/, '')}`;
				return { slug, ...frontmatter(readFileSync(join(full, name), 'utf8')) };
			})
			.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
		if (pages.length === 0) continue;
		const lines = pages.map(
			({ slug, title, description }) =>
				`- [${title || slug}](${site}${base}/${slug}.md)${description ? `: ${description}` : ''}`,
		);
		sections.push(`**${label}**\n\n${lines.join('\n')}`);
	}
	return sections.join('\n\n');
}
