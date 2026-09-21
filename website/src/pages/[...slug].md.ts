// Serves every docs page as raw Markdown at `<page>.md` (e.g. /appduct/start/quick-start.md),
// so agents can read the source without scraping HTML. The body is the authored MDX: import
// lines stay in, and component tags such as <Steps> appear as written.
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';

export const getStaticPaths = (async () => {
	const entries = await getCollection('docs', ({ id }) => id !== 'index' && id !== '404');
	return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: CollectionEntry<'docs'> }> = ({ props }) => {
	const { title, description } = props.entry.data;
	const header = [`# ${title}`, description ? `> ${description}` : ''].filter(Boolean).join('\n\n');
	const body = (props.entry.body ?? '').trim();
	return new Response(`${header}\n\n${body}\n`, {
		headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
	});
};
