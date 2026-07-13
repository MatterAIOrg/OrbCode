const SGR_WHEEL_RE = /\x1b?\[<(\d+);\d+;\d+M/g;
const SGR_MOUSE_RE = /\x1b?\[<\d+;\d+;\d+[mM]/;
const URXVT_WHEEL_RE = /\x1b?\[(\d+);\d+;\d+M/g;
const URXVT_MOUSE_RE = /\x1b?\[\d+;\d+;\d+M/;

export function mouseScrollDelta(input: string): number {
  let delta = 0;
  let match: RegExpExecArray | null;

  SGR_WHEEL_RE.lastIndex = 0;
  while ((match = SGR_WHEEL_RE.exec(input))) {
    const button = Number(match[1]);
    if ((button & 64) === 64) delta += (button & 1) === 0 ? 1 : -1;
  }

  URXVT_WHEEL_RE.lastIndex = 0;
  while ((match = URXVT_WHEEL_RE.exec(input))) {
    const button = Number(match[1]);
    if (button === 64) delta += 1;
    if (button === 65) delta -= 1;
  }

  for (let i = 0; i <= input.length - 6; i++) {
    if (input.charCodeAt(i) !== 0x1b || input[i + 1] !== "[" || input[i + 2] !== "M") continue;
    const button = input.charCodeAt(i + 3) - 32;
    if ((button & 64) === 64) delta += (button & 1) === 0 ? 1 : -1;
    i += 5;
  }

  return delta;
}

export function isMouseInput(input: string): boolean {
  return mouseScrollDelta(input) !== 0 || SGR_MOUSE_RE.test(input) || URXVT_MOUSE_RE.test(input) || input.includes("\x1b[M");
}
