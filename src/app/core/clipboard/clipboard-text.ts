import { Service } from '@angular/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

/**
 * Plain-text clipboard through the Tauri plugin: the webview's `readText` asks for permission in
 * WebView2 and shows a Paste callout in WKWebView. Clipboard content is user data: never logged.
 */
@Service()
export class ClipboardText {
  read(): Promise<string> {
    return readText();
  }

  write(text: string): Promise<void> {
    return writeText(text);
  }
}
