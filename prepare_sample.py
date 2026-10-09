"""Prepare a short, manually translated typesetting sample from the user's episode.

This is NOT a model quality evaluation. Only two short speech bubbles are used.
"""
import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
samples = ROOT / 'samples'
original = Image.open(samples / 'episode1-opening-03.jpg').convert('RGB').crop((0, 580, 690, 1370))
original.save(samples / 'episode1-sample-original.png')
buffer = io.BytesIO()
original.save(buffer, format='PNG')
name_note = '주대각 采用用户提供的中文版译名「朱大觉」。此样张为人工试译与定位，尚未验证自动翻译质量。'
regions = [
    {'id': 1, 'original': '주대각…', 'translation': '朱大觉……',
     'erase': {'x': 42, 'y': 43, 'width': 136, 'height': 44},
     'box': {'x': 29, 'y': 32, 'width': 143, 'height': 61}},
    {'id': 2, 'original': '주대각이는 어딨어?', 'translation': '朱大觉在哪儿？',
     'erase': {'x': 174, 'y': 560, 'width': 154, 'height': 86},
     'box': {'x': 168, 'y': 552, 'width': 165, 'height': 101}},
]
for region in regions:
    region.update(background='#ffffff', foreground='#202020', confidence='high', note=name_note,
                  font_size=0, enabled=True)
project = {'version': 1, 'name': '第一集-开头两句试译',
           'image': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode(),
           'regions': regions, 'target': '简体中文',
           'context': '葬礼上的两名交谈者询问某人的下落。仅使用开头两句作排字样张。',
           'glossary': '주대각 = 朱大觉（沿用用户提供的中文版译名）', 'reference': 'fight-class-3'}
(samples / 'episode1-sample-project.json').write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding='utf-8')
# Also make a standalone manual sample artifact. The interactive editor uses
# layout.js; this export is explicitly a manually prepared comparison sample.
translated = original.copy()
draw = ImageDraw.Draw(translated)
font_path = Path('C:/Windows/Fonts/msyh.ttc')
if font_path.exists():
    for region in regions:
        box = region['box']
        pad = max(2, min(box['width'], box['height']) * .07)
        width, height = box['width'] - 2 * pad, box['height'] - 2 * pad
        for size in range(min(72, int(height / 1.25), int(width)), 5, -1):
            font = ImageFont.truetype(str(font_path), size)
            lines, line = [], ''
            for char in region['translation']:
                if line and font.getlength(line + char) > width:
                    if char in '，。！？；：、…':
                        lines.append(line[:-1])
                        line = line[-1] + char
                    else:
                        lines.append(line)
                        line = char
                else:
                    line += char
            lines.append(line)
            line_height = size * 1.3
            if len(lines) * line_height <= height and all(font.getlength(line) <= width for line in lines):
                break
        else:
            raise ValueError('Sample translation does not fit; adjust its text box.')
        erase = region['erase']
        draw.rectangle((erase['x'], erase['y'], erase['x'] + erase['width'] - 1,
                        erase['y'] + erase['height'] - 1), fill='white')
        first = box['y'] + (box['height'] - len(lines) * line_height) / 2 + line_height / 2
        for index, line in enumerate(lines):
            draw.text((box['x'] + box['width'] / 2, first + index * line_height), line,
                      font=font, fill=region['foreground'], anchor='mm')
    translated.save(samples / 'episode1-sample-translated.png')
print('Prepared two-bubble sample project. Translation and coordinates are manual.')
