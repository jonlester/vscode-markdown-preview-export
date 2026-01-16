import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import * as path from 'path';

// well-known identifiers used in multiple places
const CONTEXT_HAS_PROVIDER = 'markdownPreviewExport.hasProvider';
const CMD_EXPORT_PREVIEW = 'markdown.exportPreview';
const CMD_CANCEL_PREVIEW = 'markdown.cancelPreviewExport';
const STATUS_TEXT_EXPORTING = "$(loading~spin) Exporting preview... $(x) Cancel";

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
				// No provider available; ensure the context key is cleared so the menu is hidden
				void vscode.commands.executeCommand('setContext', CONTEXT_HAS_PROVIDER, false);
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

			// Suggest a filename based on the source document
			// We replace the extension (if present) with .html
			const docPath = document.uri.path;
			const lastDot = docPath.lastIndexOf('.');
			const lastSlash = docPath.lastIndexOf('/');
			const newPath = (lastDot > lastSlash) 
				? docPath.substring(0, lastDot) + '.html' 
				: docPath + '.html';
			const defaultUri = document.uri.with({ path: newPath });

			// Prompt user for save location
			const outFile = await vscode.window.showSaveDialog({
				defaultUri: defaultUri,
				saveLabel: 'Export HTML',
				filters: {
					'HTML': ['html']
				}
			});

			if (!outFile) {
				// User cancelled the dialog
				return;
			}

			if (token.isCancellationRequested) {
				return;
			}

			const encoder = new TextEncoder();
			const data = encoder.encode(html);
			try {
				await vscode.workspace.fs.writeFile(outFile, data);

				// Show an information message with a clickable link
				const openLabel = 'Open in Browser';
				const filename = path.basename(outFile.fsPath);
				const message = `Markdown preview exported to ${filename}`;
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