import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import * as os from 'os';
import * as path from 'path';

// main helper object
const markdownHelper = (() => {
	let cache:
		| {
				ResourceUri: vscode.Uri;
				Provider: any;
		  }
		| undefined = undefined;

	return {
		update: ([, , env]: any[]): void => {
			if (!env || !env.currentDocument || !env.resourceProvider) {
				return;
			}

			cache = {
				ResourceUri: env.currentDocument,
				Provider: env.resourceProvider,
			};
		},

		render: async (token: vscode.CancellationToken) => {
			console.log('Attempting to export markdown preview');

			if (cache === undefined || cache.Provider.isDisposed) {
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

			const webviewResourceProvider = {
				cspSource: provider.cspSource,
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

			const html = appendThemeClass(bodyFromMetaContent(result.html));

			// Save the html to a file in the user's temp folder
			const tempDir = os.tmpdir();
			const outFilePath = path.join(tempDir, 'markdown-preview.html');
			const outFile = vscode.Uri.file(outFilePath);
			const encoder = new TextEncoder();
			const data = encoder.encode(html);
			try {
				await vscode.workspace.fs.writeFile(outFile, data);

				// Show an information message with a clickable link
				const openLabel = 'Open in Browser';
				const message = `Markdown preview saved to ${outFile.fsPath}`;
				const selection = await vscode.window.showInformationMessage(
					message,
					openLabel
				);

				if (selection === openLabel) {
					await vscode.env.openExternal(outFile);
				}
			} catch (error) {
				console.error('Error writing file:', error);
				vscode.window.showErrorMessage(`Failed to save markdown preview: ${error}`);
			}
		},
	};
})();

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
export async function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('markdown.exportPreview', async () => {
			const cancellationTokenSource = new vscode.CancellationTokenSource();

			// Register the token source with the context for disposal
			context.subscriptions.push(cancellationTokenSource);

			try {
				// Create a status bar item to allow cancellation
				const statusBarItem = vscode.window.createStatusBarItem(
					vscode.StatusBarAlignment.Left
				);
				statusBarItem.text = '$(loading~spin) Exporting preview... $(x) Cancel';
				statusBarItem.command = 'markdown.cancelPreviewExport';
				statusBarItem.show();
				context.subscriptions.push(statusBarItem);

				// Register a command to cancel the operation
				const cancelDisposable = vscode.commands.registerCommand(
					'markdown.cancelPreviewExport',
					() => {
						cancellationTokenSource.cancel();
						statusBarItem.hide();
						vscode.window.showInformationMessage(
							'Preview export cancelled'
						);
					}
				);
				context.subscriptions.push(cancelDisposable);

				// Render the preview to HTML
				await markdownHelper.render(cancellationTokenSource.token);

				// Clean up
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
				// Clean up resources
				cancellationTokenSource.dispose();
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
