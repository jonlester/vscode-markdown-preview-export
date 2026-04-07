# markdown-preview-export

Export your Markdown preview from Visual Studio Code exactly as you see it (styles, images, etc) to an HTML file. Open the result in your browser to print, save as PDF, or share.  

## Features

- **Export Markdown Preview as HTML**: Export the current Markdown preview (not just the raw Markdown) as a styled HTML file (WYSIWYG)
- **Embed Local Images**: Include local images directly in the exported HTML by default, so the file is easier to share.
- **Cancel Export**: The logic is non-deterministic since it relies any other extensions or customizations you may have that alter the markdown preview.  There's a potential for problems, so you can cancel the export by clicking the status bar button.

## Usage

1. Open a Markdown file and preview it (`Ctrl+Shift+V` or `Cmd+Shift+V`).
2. Click the **Export Preview** button in the preview title bar, or run the `Markdown: Export Preview` command from the Command Palette.
3. The extension saves the HTML file to your system's temporary folder (e.g., `C:\Users\<user>\AppData\Local\Temp\markdown-preview.html` on Windows).
4. After export, click **Open in Browser** in the notification to launch in your default system browser.  If you are exporting multiple documents, there's no need to open another window -- just refresh.

![A red circled icon in the preview title bar at the top right is highlighted with a tooltip that reads Export Preview, indicating the export action.](/assets/Screenshot.png)

> **Note!**
> If you already had a markdown preview open when you install or enable this extension, you'll need to close and re-open it or open another to make the menu option visible.  From then on it should always be visible.

## Commands

- `Markdown: Export Preview` (`markdown.exportPreview`): Export the current Markdown preview as HTML.
- `Markdown: Cancel Markdown Preview Export` (`markdown.cancelPreviewExport`): Cancel an ongoing export operation.

## Requirements

No additional requirements or dependencies.

## Extension Settings

- `markdownPreviewExport.embedLocalImages`: Embed local images as data URIs in the exported HTML. Remote and existing data URI images are left unchanged. Defaults to `true`.

## Limitations

- Only exports the current preview. If the preview is not open, the command will not work.
- The exported HTML is saved to your system's temp directory and will be overwritten on each export.

## How it works

The extension hooks into the Markdown preview rendering process, captures the fully rendered HTML (including styles and theme), and writes it to a temporary file. The method used isn't an official VS Code API, so it could break in future releases.

## Release Notes

### 0.0.1
- Initial release: Export Markdown preview as HTML, matching VS Code theme, with quick open in browser.

### 0.0.2
- Bug fixes for edge cases during installation
