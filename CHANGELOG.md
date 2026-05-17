# Changelog

All notable changes to the "ai-code-workflow" extension will be documented in this file.

## 1.0.5

- Renamed the extension to AI Code Workflow for provider-neutral use.
- Added provider handoff support for ChatGPT, Claude, Gemini, and Grok.
- Added arbitrary local file attachments for handoff packages.
- Added Windows file-drop clipboard support for prepared handoff files.
- Made Prepare AI Request refresh Repomix every time.
- Added pasted screenshot assets with Ctrl+V and copied them into handoff packages.
- Added cleanup for old workflow temp folders.
- Improved the request builder UI and made Apply Patch a positive action.

## 1.0.4

- Added the first branded two-step workflow.
- Added a two-step workflow for preparing AI requests and applying AI patches.
- Added Repomix context refresh from the webview.
- Added bundled instruction template support for every project.
- Added AI handoff helpers for clipboard, prompt file, instruction file, and project context.

## 1.0.0

- Initial release with a webview for pasting and analyzing structured JSON edits.
- Added Webview interface for pasting and analyzing structured JSON edits.
- Implemented native VS Code side-by-side diff previews.
- Added automated code formatting post-application.
