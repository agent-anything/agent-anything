export const reportStyles = `
  :root {
    color-scheme: light dark;
  }

  body {
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.5;
    margin: 0;
    padding: 24px;
  }

  main {
    max-width: 920px;
  }

  h1,
  h2 {
    font-weight: 600;
    margin: 0;
  }

  h1 {
    font-size: 24px;
    margin-bottom: 8px;
  }

  h2 {
    font-size: 15px;
    margin-bottom: 8px;
  }

  section {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 18px 0;
  }

  dl {
    display: grid;
    grid-template-columns: minmax(120px, max-content) 1fr;
    gap: 8px 16px;
    margin: 0;
  }

  dt {
    color: var(--vscode-descriptionForeground);
  }

  dd {
    margin: 0;
    word-break: break-word;
  }

  ul {
    margin: 0;
    padding-left: 20px;
  }

  code {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family);
    padding: 1px 4px;
  }

  .status {
    display: inline-block;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 2px 8px;
    text-transform: uppercase;
  }

  .status-succeeded {
    color: var(--vscode-testing-iconPassed);
  }

  .status-failed {
    color: var(--vscode-testing-iconFailed);
  }

  .muted {
    color: var(--vscode-descriptionForeground);
  }

  .artifact-summary {
    margin: 0 0 8px;
  }
`;
