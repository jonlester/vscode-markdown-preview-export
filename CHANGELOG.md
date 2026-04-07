# Change Log

All notable changes to the "markdown-preview-export" extension will be documented in this file.

## [0.0.3]

- Fixed compatibility with current VS Code by using the public `markdown.api.render` API, with a fallback to the legacy private API for older builds.
- Added `markdownPreviewExport.embedLocalImages` setting to embed local images as data URIs in exported HTML (enabled by default).
- Added `markdownPreviewExport.outputMode` setting to control where exported files are saved: system temp folder (`temp`), next to the Markdown file (`besideMarkdown`), or prompted each time (`ask`).
- Improved post-export notification with actions to open the file in your browser, reveal it in the file explorer, or copy its saved path.

## [0.0.2]

- Bug fixes for edge cases during installation

## [0.0.1]

- Initial release: Export Markdown preview as HTML, matching VS Code theme, with quick open in browser.