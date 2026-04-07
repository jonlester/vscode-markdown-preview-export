import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

// well-known identifiers used in multiple places
const CONTEXT_HAS_PROVIDER = 'markdownPreviewExport.hasProvider';
const CMD_EXPORT_PREVIEW = 'markdown.exportPreview';
const CMD_CANCEL_PREVIEW = 'markdown.cancelPreviewExport';
const STATUS_TEXT_EXPORTING = "$(loading~spin) Exporting preview... $(x) Cancel";
const CONFIG_SECTION = 'markdownPreviewExport';
const CONFIG_EMBED_LOCAL_IMAGES = 'embedLocalImages';
const CONFIG_OUTPUT_MODE = 'outputMode';
const OUTPUT_MODE_TEMP = 'temp';
const OUTPUT_MODE_BESIDE_MARKDOWN = 'besideMarkdown';
const OUTPUT_MODE_ASK = 'ask';
const DEFAULT_OUTPUT_FILE_NAME = 'markdown-preview.html';
const OPEN_IN_BROWSER_LABEL = 'Open in Browser';
const REVEAL_IN_EXPLORER_LABEL = 'Reveal in Explorer';
const COPY_PATH_LABEL = 'Copy Path';

const IMAGE_MIME_TYPES: Record<string, string> = {
	'.apng': 'image/apng',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.webp': 'image/webp',
};

type OutputMode =
	| typeof OUTPUT_MODE_TEMP
	| typeof OUTPUT_MODE_BESIDE_MARKDOWN
	| typeof OUTPUT_MODE_ASK;

type PreviewProvider = {
	isDisposed?: boolean;
	cspSource?: string;
	asWebviewUri?: (resource: vscode.Uri) => vscode.Uri;
	_contentProvider?: {
		renderDocument?: (...args: unknown[]) => Promise<{ html: string }>;
	};
	_previewConfigurations?: unknown;
	state?: unknown;
	_imageInfo?: unknown;
};

type MarkdownPreviewSettings = {
	scrollBeyondLastLine: boolean;
	wordWrap: boolean;
	markEditorSelection: boolean;
	fontFamily: string | undefined;
	fontSize: number;
	lineHeight: number;
	styles: string[];
};

// main helper object
const markdownHelper = (() => {
	let cache:
		| {
				ResourceUri: vscode.Uri;
				Provider: PreviewProvider;
		  }
		| undefined = undefined;

	return {
		update: ([, , env]: any[]): void => {
			if (!env || !env.currentDocument || !env.resourceProvider) {
				// The markdown render API also runs markdown-it plugins but does not provide
				// a webview resource provider. Ignore those renders so they do not invalidate
				// the currently active preview cache.
				return;
			}

			cache = {
				ResourceUri: env.currentDocument,
				Provider: env.resourceProvider,
			};

			// Indicate that we now have a valid preview provider reference
			void vscode.commands.executeCommand('setContext', CONTEXT_HAS_PROVIDER, true);
		},

		render: async (token: vscode.CancellationToken) => {
			console.log('Attempting to export markdown preview');

			if (cache === undefined || cache.Provider.isDisposed) {
				// If provider is not available anymore, clear the context so the menu hides
				void vscode.commands.executeCommand('setContext', CONTEXT_HAS_PROVIDER, false);
				return Promise.reject('No preview provider found');
			}

			const resourceUri = cache?.ResourceUri;
			const provider = cache?.Provider;
			let document: vscode.TextDocument;

			try {
				document = await vscode.workspace.openTextDocument(resourceUri);
			} catch (error) {
				console.error('Error retrieving file information:', error);
				vscode.window.showErrorMessage(
					`Unable to load source document: ${resourceUri.toString()}`
				);
				return Promise.reject('Unable to load source document');
			}

			const html = await renderPreviewDocument(document, provider, token);
			if (token.isCancellationRequested) {
				return;
			}

			const outFile = await getOutputFile(document);
			if (outFile === undefined || token.isCancellationRequested) {
				return;
			}

			const encoder = new TextEncoder();
			const data = encoder.encode(html);
			try {
				await vscode.workspace.fs.writeFile(outFile, data);
				await showSaveActions(outFile);
			} catch (error) {
				console.error('Error writing file:', error);
				vscode.window.showErrorMessage(`Failed to save markdown preview: ${error}`);
			}
		},
	};
})();

async function getOutputFile(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
	const outputMode = getOutputModeConfiguration(document.uri);
	if (outputMode === OUTPUT_MODE_ASK) {
		return vscode.window.showSaveDialog({
			defaultUri: getBesideMarkdownOutputUri(document.uri) ?? getTempOutputUri(),
			filters: {
				HTML: ['html', 'htm'],
			},
			saveLabel: 'Export Preview',
			title: 'Export Markdown Preview',
		});
	}
	if (outputMode === OUTPUT_MODE_BESIDE_MARKDOWN) {
		const outputUri = getBesideMarkdownOutputUri(document.uri);
		if (outputUri) {
			return outputUri;
		}
		void vscode.window.showWarningMessage(
			'Unable to save beside the current Markdown document. Falling back to the temporary folder.'
		);
	}
	return getTempOutputUri();
}

function getOutputModeConfiguration(resourceUri: vscode.Uri): OutputMode {
	const value = vscode.workspace
		.getConfiguration(CONFIG_SECTION, resourceUri)
		.get<string>(CONFIG_OUTPUT_MODE, OUTPUT_MODE_TEMP);

	switch (value) {
		case OUTPUT_MODE_BESIDE_MARKDOWN:
		case OUTPUT_MODE_ASK:
		case OUTPUT_MODE_TEMP:
			return value;
		default:
			return OUTPUT_MODE_TEMP;
	}
}

function getTempOutputUri(): vscode.Uri {
	return vscode.Uri.file(path.join(os.tmpdir(), DEFAULT_OUTPUT_FILE_NAME));
}

export function getBesideMarkdownOutputUri(resourceUri: vscode.Uri): vscode.Uri | undefined {
	const fileName = getOutputFileName(resourceUri);
	if (resourceUri.scheme === 'untitled') {
		return undefined;
	}
	if (resourceUri.scheme === 'file') {
		return vscode.Uri.file(path.join(path.dirname(resourceUri.fsPath), fileName));
	}
	return resourceUri.with({
		fragment: '',
		path: path.posix.join(path.posix.dirname(resourceUri.path), fileName),
		query: '',
	});
}

function getOutputFileName(resourceUri: vscode.Uri): string {
	const sourcePath = resourceUri.scheme === 'file' ? resourceUri.fsPath : resourceUri.path;
	const name = path.basename(sourcePath, path.extname(sourcePath));
	return `${name || 'markdown-preview'}.html`;
}

async function showSaveActions(outFile: vscode.Uri): Promise<void> {
	const message = `Markdown preview saved to ${getDisplayPath(outFile)}`;
	const selection = await vscode.window.showInformationMessage(
		message,
		OPEN_IN_BROWSER_LABEL,
		REVEAL_IN_EXPLORER_LABEL,
		COPY_PATH_LABEL
	);

	if (selection === OPEN_IN_BROWSER_LABEL) {
		await vscode.env.openExternal(outFile);
	} else if (selection === REVEAL_IN_EXPLORER_LABEL) {
		await vscode.commands.executeCommand('revealFileInOS', outFile);
	} else if (selection === COPY_PATH_LABEL) {
		await vscode.env.clipboard.writeText(getDisplayPath(outFile));
	}
}

function getDisplayPath(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

async function renderPreviewDocument(
	document: vscode.TextDocument,
	provider: PreviewProvider,
	token: vscode.CancellationToken
): Promise<string> {
	const legacyHtml = await tryRenderWithPreviewProvider(document, provider, token);
	const html = legacyHtml !== undefined
		? legacyHtml
		: await renderMarkdownDocument(document, token);
	return rewriteImageSources(
		html,
		document.uri,
		getEmbedLocalImagesConfiguration(document.uri),
		token
	);
}

async function tryRenderWithPreviewProvider(
	document: vscode.TextDocument,
	provider: PreviewProvider,
	token: vscode.CancellationToken
): Promise<string | undefined> {
	if (typeof provider._contentProvider?.renderDocument !== 'function') {
		return undefined;
	}

	const webviewResourceProvider = {
		cspSource: provider.cspSource ?? '',
		asWebviewUri: (resource: vscode.Uri): vscode.Uri => {
			return resource;
		},
	};
	const result = await provider._contentProvider.renderDocument(
		document,
		webviewResourceProvider,
		provider._previewConfigurations,
		undefined,
		undefined,
		provider.state,
		provider._imageInfo,
		token
	);

	return appendThemeClass(bodyFromMetaContent(result.html));
}

async function renderMarkdownDocument(
	document: vscode.TextDocument,
	token: vscode.CancellationToken
): Promise<string> {
	const bodyContent = await vscode.commands.executeCommand<string>(
		'markdown.api.render',
		document
	);
	if (token.isCancellationRequested) {
		return '';
	}
	if (typeof bodyContent !== 'string') {
		throw new Error('VS Code Markdown renderer did not return HTML');
	}

	const bodyHtml = `<div class="markdown-body" dir="auto">${bodyContent}<div class="code-line" data-line="${document.lineCount}"></div></div>`;
	return buildExportDocument(document.uri, bodyHtml);
}

function getEmbedLocalImagesConfiguration(resourceUri: vscode.Uri): boolean {
	return vscode.workspace
		.getConfiguration(CONFIG_SECTION, resourceUri)
		.get(CONFIG_EMBED_LOCAL_IMAGES, true);
}

function buildExportDocument(resourceUri: vscode.Uri, bodyHtml: string): string {
	const settings = getMarkdownPreviewSettings(resourceUri);
	const themeId = getColorTheme();
	const bodyClasses = [
		'vscode-body',
		themeId,
		settings.scrollBeyondLastLine ? 'scrollBeyondLastLine' : '',
		settings.wordWrap ? 'wordWrap' : '',
		settings.markEditorSelection ? 'showEditorSelection' : '',
	].filter(Boolean);

	return `<!DOCTYPE html>
<html style="${escapeHtmlAttribute(getMarkdownPreviewStyle(settings))}">
<head>
	<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
	${getMarkdownPreviewStyleLinks(resourceUri, settings).join('\n\t')}
	<base href="${escapeHtmlAttribute(uriToBrowserUrl(resourceUri))}">
</head>
<body class="${escapeHtmlAttribute(bodyClasses.join(' '))}">
	${bodyHtml}
</body>
</html>`;
}

function getMarkdownPreviewSettings(resourceUri: vscode.Uri): MarkdownPreviewSettings {
	const editorConfig = vscode.workspace.getConfiguration('editor', resourceUri);
	const markdownConfig = vscode.workspace.getConfiguration('markdown', resourceUri);
	const markdownEditorConfig = vscode.workspace.getConfiguration('[markdown]', resourceUri) as any;

	let wordWrap = editorConfig.get('wordWrap', 'off') !== 'off';
	if (markdownEditorConfig?.['editor.wordWrap']) {
		wordWrap = markdownEditorConfig['editor.wordWrap'] !== 'off';
	}

	return {
		scrollBeyondLastLine: editorConfig.get('scrollBeyondLastLine', false),
		wordWrap,
		markEditorSelection: markdownConfig.get('preview.markEditorSelection', true),
		fontFamily: markdownConfig.get('preview.fontFamily', undefined),
		fontSize: Math.max(8, +markdownConfig.get('preview.fontSize', NaN)),
		lineHeight: Math.max(0.6, +markdownConfig.get('preview.lineHeight', NaN)),
		styles: markdownConfig.get('styles', []),
	};
}

function getMarkdownPreviewStyle(settings: MarkdownPreviewSettings): string {
	return [
		settings.fontFamily ? `--markdown-font-family: ${settings.fontFamily};` : '',
		isNaN(settings.fontSize) ? '' : `--markdown-font-size: ${settings.fontSize}px;`,
		isNaN(settings.lineHeight) ? '' : `--markdown-line-height: ${settings.lineHeight};`,
	].join(' ');
}

function getMarkdownPreviewStyleLinks(
	resourceUri: vscode.Uri,
	settings: MarkdownPreviewSettings
): string[] {
	const links = getContributedMarkdownPreviewStyleUris().map((styleUri) => {
		return `<link rel="stylesheet" type="text/css" href="${escapeHtmlAttribute(uriToBrowserUrl(styleUri))}">`;
	});

	for (const style of settings.styles) {
		if (typeof style !== 'string') {
			continue;
		}
		links.push(
			`<link rel="stylesheet" class="code-user-style" data-source="${escapeHtmlAttribute(style)}" href="${escapeHtmlAttribute(resolveMarkdownStyle(style, resourceUri))}" type="text/css" media="screen">`
		);
	}

	return links;
}

function getContributedMarkdownPreviewStyleUris(): vscode.Uri[] {
	const styleUris: vscode.Uri[] = [];
	for (const extension of vscode.extensions.all) {
		const contributedStyles = extension.packageJSON?.contributes?.['markdown.previewStyles'];
		if (!Array.isArray(contributedStyles)) {
			continue;
		}
		for (const style of contributedStyles) {
			if (typeof style !== 'string') {
				continue;
			}
			try {
				styleUris.push(vscode.Uri.joinPath(extension.extensionUri, style));
			} catch (error) {
				console.warn(`Unable to resolve markdown preview style ${style}`, error);
			}
		}
	}
	return styleUris;
}

function resolveMarkdownStyle(style: string, resourceUri: vscode.Uri): string {
	if (!style || isExternalUri(style)) {
		return style;
	}
	if (/^[a-z]:[\\/]/i.test(style) || style.startsWith('/')) {
		return uriToBrowserUrl(vscode.Uri.file(style));
	}
	if (isUriString(style)) {
		const uri = vscode.Uri.parse(style);
		return uri.scheme === 'file' ? uriToBrowserUrl(uri) : style;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(resourceUri);
	const baseUri = workspaceFolder?.uri ?? vscode.Uri.joinPath(resourceUri, '..');
	return resolveRelativeBrowserUrl(style, baseUri);
}

/**
 * Replaces the first <script> tag inside <body> with the decoded HTML content
 * from the <meta id="vscode-markdown-preview-data"> tag's "data-initial-md-content" attribute.
 * @param html The HTML document as a string.
 * @returns The modified HTML string.
 */
function bodyFromMetaContent(html: string): string {
	// 1. Extract the meta tag's data-initial-md-content attribute
	const metaMatch = html.match(
		/(<meta[^>]+id=["']vscode-markdown-preview-data["'][^>]+)data-initial-md-content=["']([^"']*)["']([^>]*>)/i
	);
	if (!metaMatch) {
		// If not found, return html unchanged
		return html;
	}

	// HTML decode the attribute value
	const encodedContent = metaMatch[2];
	const decodedContent = unescapeAttribute(encodedContent);

	// Remove the data-initial-md-content attribute from the meta tag
	const metaTagWithAttr = metaMatch[0];
	const metaTagWithoutAttr = metaMatch[1] + metaMatch[3];
	const htmlWithoutAttr = html.replace(metaTagWithAttr, metaTagWithoutAttr);

	// Replace the first <script> tag inside <body> with the decoded content
	return htmlWithoutAttr.replace(
		/(<body[^>]*>[\s\S]*?)(<script\b[^>]*>[\s\S]*?<\/script>)/i,
		(_match, before) => {
			return before + decodedContent;
		}
	);
}

/**
 * Decodes HTML entities in a string (basic implementation).
 * @param str The encoded HTML string.
 * @returns The decoded string.
 */
function unescapeAttribute(str: string): string {
	return str
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

function escapeHtmlAttribute(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function restoreOriginalImageSources(html: string, resourceUri: vscode.Uri): string {
	return html.replace(/<img\b[^>]*>/gi, (tag) => {
		const dataSrc = getHtmlAttribute(tag, 'data-src');
		if (!dataSrc) {
			return tag;
		}
		return setHtmlAttribute(tag, 'src', resolveMarkdownResource(dataSrc, resourceUri));
	});
}

export async function rewriteImageSources(
	html: string,
	resourceUri: vscode.Uri,
	embedLocalImages: boolean,
	token?: vscode.CancellationToken
): Promise<string> {
	const imageTag = /<img\b[^>]*>/gi;
	let result = '';
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = imageTag.exec(html)) !== null) {
		result += html.slice(lastIndex, match.index);
		result += await rewriteImageTag(match[0], resourceUri, embedLocalImages, token);
		lastIndex = imageTag.lastIndex;
	}

	return result + html.slice(lastIndex);
}

async function rewriteImageTag(
	tag: string,
	resourceUri: vscode.Uri,
	embedLocalImages: boolean,
	token?: vscode.CancellationToken
): Promise<string> {
	if (token?.isCancellationRequested) {
		return tag;
	}

	const source = getHtmlAttribute(tag, 'data-src') ?? getHtmlAttribute(tag, 'src');
	if (!source) {
		return tag;
	}

	if (embedLocalImages) {
		const localResource = resolveLocalMarkdownResource(source, resourceUri);
		if (localResource) {
			const dataUri = await tryReadImageAsDataUri(localResource);
			if (dataUri) {
				return setHtmlAttribute(tag, 'src', dataUri);
			}
		}
	}

	return setHtmlAttribute(tag, 'src', resolveMarkdownResource(source, resourceUri));
}

function getHtmlAttribute(tag: string, name: string): string | undefined {
	const match = tag.match(
		new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
	);
	return match ? unescapeAttribute(match[2] ?? match[3] ?? match[4] ?? '') : undefined;
}

function setHtmlAttribute(tag: string, name: string, value: string): string {
	const escapedValue = escapeHtmlAttribute(value);
	const attribute = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
	if (attribute.test(tag)) {
		return tag.replace(attribute, (_match, prefix) => `${prefix}"${escapedValue}"`);
	}
	return tag.replace(/\/?>$/, (end) => ` ${name}="${escapedValue}"${end}`);
}

function resolveMarkdownResource(source: string, resourceUri: vscode.Uri): string {
	if (!source || isExternalUri(source)) {
		return source;
	}
	if (/^[a-z]:[\\/]/i.test(source)) {
		return uriToBrowserUrl(vscode.Uri.file(source));
	}
	if (isUriString(source)) {
		const uri = vscode.Uri.parse(source);
		return uri.scheme === 'file' ? uriToBrowserUrl(uri) : source;
	}
	if (source.startsWith('/')) {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (workspaceFolder) {
			return uriToBrowserUrl(vscode.Uri.joinPath(workspaceFolder.uri, source.replace(/^\/+/, '')));
		}
		return uriToBrowserUrl(vscode.Uri.file(source));
	}
	return resolveRelativeBrowserUrl(source, vscode.Uri.joinPath(resourceUri, '..'));
}

function resolveLocalMarkdownResource(
	source: string,
	resourceUri: vscode.Uri
): vscode.Uri | undefined {
	if (!source || isExternalUri(source)) {
		return undefined;
	}
	if (/^[a-z]:[\\/]/i.test(source)) {
		return vscode.Uri.file(stripQueryAndFragment(source));
	}
	if (isUriString(source)) {
		const uri = vscode.Uri.parse(source);
		return uri.scheme === 'file' ? uri.with({ query: '', fragment: '' }) : undefined;
	}
	if (source.startsWith('/')) {
		const pathWithoutQuery = stripQueryAndFragment(source).replace(/^\/+/, '');
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (workspaceFolder) {
			return vscode.Uri.joinPath(workspaceFolder.uri, pathWithoutQuery);
		}
		return vscode.Uri.file(stripQueryAndFragment(source));
	}
	return vscode.Uri.joinPath(
		vscode.Uri.joinPath(resourceUri, '..'),
		stripQueryAndFragment(source)
	);
}

function stripQueryAndFragment(value: string): string {
	return value.replace(/[?#].*$/, '');
}

async function tryReadImageAsDataUri(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		const mimeType = getImageMimeType(uri);
		return `data:${mimeType};base64,${Buffer.from(data).toString('base64')}`;
	} catch (error) {
		console.warn(`Unable to embed local markdown image ${uri.toString()}`, error);
		return undefined;
	}
}

function getImageMimeType(uri: vscode.Uri): string {
	return IMAGE_MIME_TYPES[path.extname(uri.fsPath).toLowerCase()] ?? 'application/octet-stream';
}

function resolveRelativeBrowserUrl(reference: string, baseDirectory: vscode.Uri): string {
	try {
		const base = uriToBrowserUrl(baseDirectory);
		return new URL(reference, base.endsWith('/') ? base : `${base}/`).toString();
	} catch {
		return reference;
	}
}

function uriToBrowserUrl(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? pathToFileURL(uri.fsPath).toString() : uri.toString();
}

function isExternalUri(value: string): boolean {
	return /^(https?|data):/i.test(value);
}

function isUriString(value: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * Retrieves the current color theme of the VS Code editor as a string identifier.
 *
 * @returns {string} The string identifier of the current color theme type
 */
function getColorTheme(): string {
	const colorThemeKind = vscode.window.activeColorTheme.kind;
	let themeId: string;

	switch (colorThemeKind) {
		case vscode.ColorThemeKind.Dark:
			themeId = 'vscode-dark';
			break;
		case vscode.ColorThemeKind.Light:
			themeId = 'vscode-light';
			break;
		case vscode.ColorThemeKind.HighContrast:
			themeId = 'vscode-high-contrast';
			break;
		case vscode.ColorThemeKind.HighContrastLight:
			themeId = 'vscode-high-contrast-light';
			break;
		default:
			themeId = 'vscode-dark'; // fallback
	}
	return themeId;
}

/**
 * Appends the current color theme id to the class attribute of the <body> tag.
 * @param html The HTML document as a string.
 * @returns The modified HTML string.
 */
function appendThemeClass(html: string): string {
	const themeId = getColorTheme();
	return html.replace(
		/<body([^>]*)class=["']([^"']*)["']/i,
		(_match, before, classValue) => {
			// Avoid duplicate themeId
			const classes = classValue.split(/\s+/);
			if (!classes.includes(themeId)) {
				classes.push(themeId);
			}
			return `<body${before}class="${classes.join(' ')}"`;
		}
	);
}

// track currently active export so we don't run two exports at once
let activeExportCancellation: vscode.CancellationTokenSource | undefined = undefined;

export async function activate(context: vscode.ExtensionContext) {
	// Ensure the export button is hidden until we obtain a valid preview provider
	// this avoids the condition where the button is visible but doesn't work when a 
	// preview window is already open at the time the extension is installed or enabled
	void vscode.commands.executeCommand('setContext', CONTEXT_HAS_PROVIDER, false);

		context.subscriptions.push(
			vscode.commands.registerCommand(CMD_EXPORT_PREVIEW, async () => {
				// If an export is already active, offer to cancel it or abort starting a new one
				if (activeExportCancellation && !activeExportCancellation.token.isCancellationRequested) {
					const choice = await vscode.window.showInformationMessage(
						'Another export is already in progress.',
						{ modal: false },
						'Cancel and start new'
					);
					if (choice !== 'Cancel and start new') {
						return; // abort starting a new export
					}
					// cancel the previous export and continue
					activeExportCancellation.cancel();
				}

				const cancellationTokenSource = new vscode.CancellationTokenSource();
				activeExportCancellation = cancellationTokenSource;

				// Register the token source with the context for disposal
				context.subscriptions.push(cancellationTokenSource);

				// Declare disposables here so we can clean them up even if errors occur
				let statusBarItem: vscode.StatusBarItem | undefined;
				let cancelDisposable: vscode.Disposable | undefined;

				try {
					// Create a status bar item to allow cancellation
					statusBarItem = vscode.window.createStatusBarItem(
						vscode.StatusBarAlignment.Left
					);
					statusBarItem.text = STATUS_TEXT_EXPORTING;
					statusBarItem.command = CMD_CANCEL_PREVIEW;
					statusBarItem.show();
					context.subscriptions.push(statusBarItem);

					// Register a command to cancel the operation
					cancelDisposable = vscode.commands.registerCommand(
						CMD_CANCEL_PREVIEW,
						() => {
							cancellationTokenSource.cancel();
							statusBarItem?.hide();
							vscode.window.showInformationMessage(
								'Preview export cancelled'
							);
						}
					);
					context.subscriptions.push(cancelDisposable);

					// Render the preview to HTML
					await markdownHelper.render(cancellationTokenSource.token);

					// Clean up on success
					statusBarItem.hide();
					cancelDisposable.dispose();
				} catch (error) {
					if (cancellationTokenSource.token.isCancellationRequested) {
						console.log('Operation was cancelled by user');
					} else {
						console.error('Error in preview generation:', error);
						vscode.window.showErrorMessage(`Failed to generate preview: ${error}`);
					}
				} finally {
					// Ensure we always hide and dispose the status bar and the cancel command
					try {
						statusBarItem?.hide();
						statusBarItem?.dispose();
					} catch (e) {
						// ignore
					}
					try {
						cancelDisposable?.dispose();
					} catch (e) {
						// ignore
					}
					// Always dispose of the token source
					cancellationTokenSource.dispose();
					// Clear active marker so new exports can start
					if (activeExportCancellation === cancellationTokenSource) {
						activeExportCancellation = undefined;
					}
				}
			})
		);

	// Register the markdown-it plugin
	return {
		extendMarkdownIt(md: MarkdownIt): MarkdownIt {
			//bind the original render method so that we can get references to the
			//preview provider and the current document whenever the preview refreshes
			//we aren't actually rendering the preview here, it's jsut a lifecycle event
			//that we can use
			const renderer = md.renderer.render.bind(md.renderer);

			md.renderer.render = (...args) => {
				// update the cached preview provider
				markdownHelper.update(args);
				// pass the call on to the original render method
				return renderer(...args) as string;
			};
			return md;
		},
	};
}
