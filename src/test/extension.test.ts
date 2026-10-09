import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	getBesideMarkdownOutputUri,
	getMarkdownPreviewStyleLinks,
	getWindowsOpenFileCommand,
	restoreOriginalImageSources,
	rewriteImageSources,
} from '../extension';

suite('Extension Test Suite', function () {
	this.timeout(10000);

	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Restores relative markdown image sources for browser export', () => {
		const resourceUri = vscode.Uri.file('/workspace/docs/readme.md');
		const base = pathToFileURL(vscode.Uri.joinPath(resourceUri, '..').fsPath).toString();
		const expected = new URL(
			'images/diagram.png?cache=1#section',
			base.endsWith('/') ? base : `${base}/`
		).toString();

		const html = restoreOriginalImageSources(
			'<p><img src="vscode-webview://preview/image.png" data-src="images/diagram.png?cache=1#section" alt="diagram"></p>',
			resourceUri
		);

		assert.ok(html.includes(`src="${expected}"`));
		assert.ok(html.includes('data-src="images/diagram.png?cache=1#section"'));
	});

	test('Uses browser-style file URLs for local markdown image sources', () => {
		const resourceUri = vscode.Uri.file(
			path.join(os.tmpdir(), 'workspace', 'docs', 'readme.md')
		);
		const expected = pathToFileURL(
			path.join(os.tmpdir(), 'workspace', 'assets', 'Screenshot.png')
		).toString();
		const html = restoreOriginalImageSources(
			'<img src="vscode-webview://preview/image.png" data-src="../assets/Screenshot.png">',
			resourceUri
		);

		if (process.platform === 'win32') {
			assert.ok(html.toLowerCase().includes(`src="${expected}"`.toLowerCase()));
		} else {
			assert.ok(html.includes(`src="${expected}"`));
		}
		assert.ok(!html.includes('file:///d%3A/'));
	});

	test('Embeds local markdown image sources as data URIs', async () => {
		const tempRoot = vscode.Uri.file(
			path.join(os.tmpdir(), `markdown-preview-export-${Date.now()}`)
		);
		const imageUri = vscode.Uri.joinPath(tempRoot, 'assets', 'image.png');
		const resourceUri = vscode.Uri.joinPath(tempRoot, 'docs', 'readme.md');

		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(tempRoot, 'assets'));
			await vscode.workspace.fs.writeFile(
				imageUri,
				Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
			);

			const html = await rewriteImageSources(
				'<img src="vscode-webview://preview/image.png" data-src="../assets/image.png">',
				resourceUri,
				true
			);

			assert.ok(html.includes('src="data:image/png;base64,iVBORw=="'));
			assert.ok(html.includes('data-src="../assets/image.png"'));
		} finally {
			try {
				await vscode.workspace.fs.delete(tempRoot, { recursive: true, useTrash: false });
			} catch {
				// ignore cleanup failures
			}
		}
	});

	test('Does not embed remote markdown image sources', async () => {
		const resourceUri = vscode.Uri.file('/workspace/docs/readme.md');
		const html = await rewriteImageSources(
			'<img src="https://example.com/image.png" data-src="https://example.com/image.png">',
			resourceUri,
			true
		);

		assert.ok(html.includes('src="https://example.com/image.png"'));
	});

	test('Escapes restored markdown image sources', () => {
		const resourceUri = vscode.Uri.file('/workspace/docs/readme.md');
		const html = restoreOriginalImageSources(
			'<img src="vscode-webview://preview/image.png" data-src="https://example.com/a.png?x=1&amp;y=2">',
			resourceUri
		);

		assert.ok(html.includes('src="https://example.com/a.png?x=1&amp;y=2"'));
	});

	test('Renders markdown through the VS Code markdown API', async () => {
		const document = await vscode.workspace.openTextDocument({
			content: '# Exported Preview',
			language: 'markdown',
		});

		const html = await vscode.commands.executeCommand<string>('markdown.api.render', document);

		assert.strictEqual(typeof html, 'string');
		assert.ok(html.includes('Exported Preview'));
		assert.ok(html.includes('<h1'));
	});

	test('Exports markdown.styles links for print media', () => {
		const resourceUri = vscode.Uri.file('/workspace/docs/readme.md');
		const links = getMarkdownPreviewStyleLinks(resourceUri, {
			scrollBeyondLastLine: false,
			wordWrap: false,
			markEditorSelection: false,
			fontFamily: undefined,
			fontSize: NaN,
			lineHeight: NaN,
			styles: ['https://example.com/preview.css'],
		});
		const userStyleLink = links.find((link) => link.includes('class="code-user-style"'));

		assert.ok(userStyleLink);
		assert.ok(userStyleLink.includes('media="all"'));
		assert.ok(!userStyleLink.includes('media="screen"'));
	});

	test('Builds beside-markdown output file URI', () => {
		const expected = path.join(os.tmpdir(), 'workspace', 'docs', 'readme.html');
		const sourceUri = vscode.Uri.file(
			path.join(os.tmpdir(), 'workspace', 'docs', 'readme.md')
		);
		const outputUri = getBesideMarkdownOutputUri(sourceUri);

		assert.strictEqual(outputUri?.scheme, 'file');
		if (process.platform === 'win32') {
			assert.strictEqual(outputUri?.fsPath.toLowerCase(), expected.toLowerCase());
		} else {
			assert.strictEqual(outputUri?.fsPath, expected);
		}
	});

	test('Builds beside-markdown output URI with unicode file names', () => {
		const fileName = 'Интеграция по B2B заявкам Провайдер-Дилер';
		const expected = path.join(os.tmpdir(), 'workspace', 'Провайдеры', `${fileName}.html`);
		const sourceUri = vscode.Uri.file(
			path.join(os.tmpdir(), 'workspace', 'Провайдеры', `${fileName}.md`)
		);
		const outputUri = getBesideMarkdownOutputUri(sourceUri);

		assert.strictEqual(outputUri?.scheme, 'file');
		if (process.platform === 'win32') {
			assert.strictEqual(outputUri?.fsPath.toLowerCase(), expected.toLowerCase());
		} else {
			assert.strictEqual(outputUri?.fsPath, expected);
		}
	});

	test('Builds Windows shell command with encoded unicode path', () => {
		const filePath = 'e:\\GoogleDrive\\ISP\\Провайдеры\\Партнёры\\Дом.ру\\B2B\\API-and-LK\\Интеграция по B2B заявкам Провайдер-Дилер.html';
		const command = getWindowsOpenFileCommand(filePath);
		const encodedCommandIndex = command.args.indexOf('-EncodedCommand') + 1;
		const script = Buffer.from(command.args[encodedCommandIndex], 'base64').toString('utf16le');

		assert.strictEqual(command.executable, 'powershell.exe');
		assert.ok(command.args.includes('-EncodedCommand'));
		assert.ok(!command.args.some((arg) => arg.includes('Провайдеры')));
		assert.ok(script.includes('[Convert]::FromBase64String'));
		assert.ok(script.includes('Invoke-Item -LiteralPath $target -ErrorAction Stop'));
		assert.ok(!script.includes('Провайдеры'));
	});

	test('Does not build beside-markdown output URI for untitled documents', () => {
		const outputUri = getBesideMarkdownOutputUri(vscode.Uri.parse('untitled:Untitled-1'));

		assert.strictEqual(outputUri, undefined);
	});
});
