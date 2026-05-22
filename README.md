# AI Code Workflow

AI Code Workflow is a VS Code extension for browser-based AI coding assistants such as ChatGPT, Claude, Gemini, Grok, and similar tools. It refreshes Repomix project context, builds one ready-to-send AI request file, collects optional screenshots or files, opens the selected AI chat, and then safely previews and applies the JSON operations returned by the model.

## Features

- **Create AI Request:** Write a task in VS Code and always refresh `repomix-output` before preparing a request.
- **Multi-Provider Handoff:** Open ChatGPT, Claude, Gemini, or Grok.
- **Any File Assets:** Paste screenshots with `Ctrl+V` or add any local files; they are copied into the handoff package.
- **Bundled Instructions:** Uses the extension's built-in JSON operations instruction template in any project.
- **Clean Handoff Folder:** Generates `ai-request.txt`, fresh Repomix output, and any added files in one folder for easy multi-file upload.
- **Temp Cleanup:** Removes old AI Code Workflow handoff and asset folders from the system temp directory.
- **Review & Apply Patch:** Paste the AI JSON response, format it, analyze operations, preview diffs, and apply safely.
- **Safety Checks:** Blocks absolute paths, path traversal, `.git`, and `node_modules` edits before writing changes.

## How to Use

1. Open a workspace folder that is a Git repository.
2. Run **AI Code Workflow: Open** from the command palette.
3. In **Create AI Request**, write the task you want the AI model to perform.
4. Paste any useful screenshots into the request area with `Ctrl+V`.
5. Pick an AI provider and click **Prepare AI Request**. Repomix is refreshed every time.
6. Paste the copied prompt into the AI chat and upload the files from the handoff folder together.
7. Paste the model's JSON response into **Review & Apply Patch**.
8. Use **Analyze**, **Preview**, and **Apply Patch** to inspect and write the patch.

## Settings

- `aiCodeWorkflow.instructionPath`: Optional custom instruction file. Relative paths resolve from the repository root.
- `aiCodeWorkflow.repomixCommand`: Command used to refresh project context. Defaults to `npx`.
- `aiCodeWorkflow.repomixArgs`: Arguments for the context command. Defaults to `["repomix"]`.
- `aiCodeWorkflow.defaultProvider`: Provider selected when the workflow panel opens. Defaults to `chatgpt`.

## License

This project is licensed under the MIT License.
