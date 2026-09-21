// @ts-check
// Expressive Code config lives in its own file (rather than inline in astro.config.mjs) so the
// `<Code>` component on the landing page renders with the same custom themes as Markdown fences.
import { defineEcConfig, ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';

/**
 * A minimal VS Code-style theme built from the Callstack code-block palette.
 * @param {'dark' | 'light'} type
 * @param {Record<'bg' | 'fg' | 'kw' | 'str' | 'fn' | 'num' | 'com' | 'punc' | 'type', string>} c
 */
function callstackTheme(type, c) {
	const theme = {
		name: `callstack-${type}`,
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
	bg: '#131116',
	fg: '#efedf5',
	kw: '#c7a3ff',
	str: '#addfc5',
	fn: '#e2d0ff',
	num: '#efc28f',
	com: '#aaa5b4',
	punc: '#bab4c7',
	type: '#e2d0ff',
});

const light = callstackTheme('light', {
	bg: '#f7f5fb',
	fg: '#29232f',
	kw: '#7222c9',
	str: '#286345',
	fn: '#5d388b',
	num: '#9a4c19',
	com: '#726a7d',
	punc: '#766b84',
	type: '#5d388b',
});

export default defineEcConfig({
	themes: [dark, light],
	styleOverrides: {
		borderRadius: '0',
		borderWidth: '1px',
		borderColor: ({ theme }) => (theme.type === 'dark' ? '#ffffff26' : '#ded7e8'),
		codeFontFamily: "'Geist Mono', ui-monospace, monospace",
		codeFontSize: '0.875rem',
		codeLineHeight: '1.7',
		uiFontFamily: "'Geist Mono', ui-monospace, monospace",
		frames: {
			shadowColor: 'transparent',
			frameBoxShadowCssValue: 'none',
			editorActiveTabIndicatorTopColor: '#8232ff',
			editorActiveTabIndicatorBottomColor: 'transparent',
			editorTabBarBackground: ({ theme }) => (theme.type === 'dark' ? '#0b0a0d' : '#efebf6'),
			editorActiveTabBackground: ({ theme }) => (theme.type === 'dark' ? '#131116' : '#f7f5fb'),
			terminalTitlebarBackground: ({ theme }) => (theme.type === 'dark' ? '#0b0a0d' : '#efebf6'),
			terminalBackground: ({ theme }) => (theme.type === 'dark' ? '#131116' : '#f7f5fb'),
			terminalTitlebarDotsOpacity: '0.35',
			terminalTitlebarBorderBottomColor: ({ theme }) => (theme.type === 'dark' ? '#ffffff1a' : '#ded7e8'),
			tooltipSuccessBackground: '#8232ff',
			tooltipSuccessForeground: '#ffffff',
			inlineButtonBorder: ({ theme }) => (theme.type === 'dark' ? '#ffffff40' : '#00000030'),
		},
	},
});
