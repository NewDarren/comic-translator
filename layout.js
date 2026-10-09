// Pure layout functions shared by the canvas editor and Node regression tests.
export const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const CLOSE = new Set(Array.from('，。！？；：、）》】」』…,.!?;:)]}'));
const OPEN = new Set(Array.from('（《【「『([{'));

export function wrapText(text, width, measure) {
  const lines = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const ch of Array.from(paragraph)) {
      if (line && measure(line + ch) > width) {
        // Avoid a leading Chinese punctuation mark or a stranded opening bracket.
        let carry = '';
        while (line && (OPEN.has(Array.from(line).at(-1)) || (CLOSE.has(ch) && !carry))) {
          const chars = Array.from(line);
          carry = chars.pop() + carry;
          line = chars.join('');
        }
        if (line) lines.push(line.trimEnd());
        line = carry + ch;
      } else line += ch;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function fitText(ctx, text, box, preferred = 0) {
  const padding = Math.max(2, Math.min(box.width, box.height) * .07);
  const width = box.width - padding * 2;
  const height = box.height - padding * 2;
  const minimum = 6;
  const maximum = Math.min(72, Math.floor(height / 1.25), Math.floor(width));
  function trySize(size) {
    ctx.font = `${size}px ${FONT}`;
    const lines = wrapText(text, width, value => ctx.measureText(value).width);
    const lineHeight = size * 1.3;
    // Never truncate the translation to fit a box.
    const fits = lines.every(line => ctx.measureText(line).width <= width + .01)
      && lines.length * lineHeight <= height + .01;
    return { size, lines, lineHeight, padding, fits };
  }
  if (preferred > 0) return trySize(preferred);
  for (let size = maximum; size >= minimum; size--) {
    const result = trySize(size);
    if (result.fits) return result;
  }
  return trySize(minimum);
}

export function clampRect(rect, width, height) {
  const rw = Math.max(1, Math.min(Number(rect.width) || 1, width));
  const rh = Math.max(1, Math.min(Number(rect.height) || 1, height));
  return { x: Math.max(0, Math.min(Number(rect.x) || 0, width - rw)),
    y: Math.max(0, Math.min(Number(rect.y) || 0, height - rh)), width: rw, height: rh };
}
