/**
 * Clipboard text made safe to paste into a shell: control characters other than tab and line
 * breaks are dropped. An ESC inside the text could end bracketed paste early (`ESC[201~`) and run
 * the rest as typed input, or send any other escape sequence to the remote program.
 */
export function pasteSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}
