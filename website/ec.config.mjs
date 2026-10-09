// @ts-check
// Expressive Code config lives in its own file (rather than inline in astro.config.mjs) so the
// `<Code>` component on the landing page renders with the same custom themes as Markdown fences.
import { defineEcConfig, ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';

/**
 * A minimal VS Code-style theme in the site's palette: neutral greys, strings in the accent.
 * @param {'dark' | 'light'} type
 * @param {Record<'bg' | 'fg' | 'kw' | 'str' | 'fn' | 'num' | 'com' | 'punc' | 'type', string>} c
 */
function callstackTheme(type, c) {
	const theme = {
		name: `appduct-${type}`,
		type,
		colors: {
			'editor.background': c.bg,
			'editor.foreground': c.fg,
		},
		tokenColors: [
			{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.com, fontStyle: 'italic' } },
			{
				scope: ['keyword', 'storage', 'storage.type', 'keyword.operator.new', 'keyword.control', 'variable.language', 'constant.language'],
				settings: { foreground: c.kw },
			},
			{ scope: ['string', 'string.quoted', 'string.template', 'markup.inline.raw'], settings: { foreground: c.str } },
			{ scope: ['entity.name.function', 'support.function', 'meta.function-call', 'entity.name.tag'], settings: { foreground: c.fn } },
			{ scope: ['constant.numeric', 'constant.other', 'support.constant'], settings: { foreground: c.num } },
			{ scope: ['entity.name.type', 'support.type', 'support.class', 'entity.other.attribute-name', 'support.type.property-name'], settings: { foreground: c.type } },
			{ scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: c.punc } },
			{ scope: ['variable', 'variable.other', 'meta.object-literal.key'], settings: { foreground: c.fg } },
		],
	};
	return ExpressiveCodeTheme.fromJSONString(JSON.stringify(theme));
}

const dark = callstackTheme('dark', {
	bg: '#111111',
	fg: '#ededed',
	kw: '#a3a3a3',
	str: '#3ddcff',
	fn: '#ffffff',
	num: '#ffc98a',
	com: '#8a8a8a',
	punc: '#9e9e9e',
	type: '#ffffff',
});

const light = callstackTheme('light', {
	bg: '#f6f6f5',
	fg: '#1f1f1f',
	kw: '#595959',
	str: '#00708c',
	fn: '#000000',
	num: '#9a4c19',
	com: '#6b6b6b',
	punc: '#666666',
	type: '#000000',
});

export default defineEcConfig({
	themes: [dark, light],
	styleOverrides: {
		borderRadius: '0',
		borderWidth: '1px',
		borderColor: ({ theme }) => (theme.type === 'dark' ? '#ffffff26' : '#dededb'),
		codeFontFamily: "'Geist Mono', ui-monospace, monospace",
		codeFontSize: '0.875rem',
		codeLineHeight: '1.7',
		uiFontFamily: "'Geist Mono', ui-monospace, monospace",
		frames: {
			shadowColor: 'transparent',
			frameBoxShadowCssValue: 'none',
			editorActiveTabIndicatorTopColor: '#3ddcff',
			editorActiveTabIndicatorBottomColor: 'transparent',
			editorTabBarBackground: ({ theme }) => (theme.type === 'dark' ? '#0a0a0a' : '#efefed'),
			editorActiveTabBackground: ({ theme }) => (theme.type === 'dark' ? '#111111' : '#f6f6f5'),
			terminalTitlebarBackground: ({ theme }) => (theme.type === 'dark' ? '#0a0a0a' : '#efefed'),
			terminalBackground: ({ theme }) => (theme.type === 'dark' ? '#111111' : '#f6f6f5'),
			terminalTitlebarDotsOpacity: '0.35',
			terminalTitlebarBorderBottomColor: ({ theme }) => (theme.type === 'dark' ? '#ffffff1a' : '#dededb'),
			tooltipSuccessBackground: '#3ddcff',
			tooltipSuccessForeground: '#0a0a0a',
			inlineButtonBorder: ({ theme }) => (theme.type === 'dark' ? '#ffffff40' : '#00000030'),
		},
	},
});
