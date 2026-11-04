/** Splits a path after each `/` or `\`, so a `<wbr>` between parts breaks it only at separators. */
export function pathParts(path: string): string[] {
  return path.match(/[^\\/]*[\\/]+|[^\\/]+$/g) ?? [path];
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escaped HTML for content Taiga renders with `innerHTML` (`TUI_CONFIRM`). */
export function pathHtml(path: string): string {
  return pathParts(path).map(escapeHtml).join('<wbr>');
}
