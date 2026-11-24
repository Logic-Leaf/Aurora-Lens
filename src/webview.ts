import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/**
 * Shell HTML for every AuroraLens webview: strict CSP (no inline styles or scripts, no remote
 * content), nonce-tagged scripts and theme-aware stylesheets served from media/.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, scripts: string[], styles: string[]): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&"]/g, '')}</title>
${['ui.css', ...styles].map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
</head>
<body>
<div id="app" class="app"></div>
${scripts.map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n')}
</body>
</html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  };
}
