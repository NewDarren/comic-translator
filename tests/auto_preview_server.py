"""Local browser test fixture. Synthetic pages and replies; never calls a cloud API.

Run from comic_translator: python tests/auto_preview_server.py
"""
import io
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.responses import Response
from PIL import Image, ImageDraw
import server

CID = 'naver-999999-70'
MID = 'naver-999999'
requests = []
images = {}
for n in range(1, 4):
    image = Image.new('RGB', (600, 800), 'white')
    image.putpixel((0, 0), (n, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((40, 40, 560, 760), outline='black', width=3)
    draw.ellipse((120, 180, 480, 400), outline='black', width=3)
    draw.text((230, 270), f'HELLO PAGE {n}', fill='black')
    draw.text((100, 600), 'SYNTHETIC AUTOMATION TEST - NO CLOUD API', fill='black')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    images[n] = buffer.getvalue()

overridden = {'/api/config', '/api/chapter', '/api/catalog', '/api/translate',
              '/api/chapters/{cid}/pages/{page}'}
server.app.router.routes[:] = [route for route in server.app.router.routes
                              if getattr(route, 'path', None) not in overridden]


@server.app.get('/api/config')
async def config():
    return {'has_key': True, 'model': 'synthetic-test-only'}


@server.app.get('/api/chapter')
async def chapter(url: str):
    return {'id': CID, 'manga_id': MID, 'site': 'naver', 'title': '模拟自动翻译测试', 'chapter': '39', 'part': '1',
            'canonical_url': 'https://m.comic.naver.com/webtoon/detail?titleId=999999&no=70',
            'catalog_url': 'https://m.comic.naver.com/webtoon/list?titleId=999999&page=3', 'catalog_offset': 60,
            'chapter_title': '自制页面，未调用真实模型', 'language': 'ko', 'page_count': 3,
            'pages': [f'/api/chapters/{CID}/pages/{n}' for n in range(1, 4)]}


@server.app.get('/api/catalog')
async def catalog(url: str, language: str = 'en', offset: int = 0):
    return {'manga_id': MID, 'site': 'naver', 'title': '模拟自动翻译测试', 'language': 'ko',
            'canonical_url': 'https://m.comic.naver.com/webtoon/list?titleId=999999&page=3',
            'chapters': [{'id': CID, 'chapter': '39', 'part': '1', 'title': '模拟测试', 'pages': 3}],
            'offset': offset, 'limit': 30, 'total': 90, 'has_more': False}


@server.app.get('/api/chapters/{cid}/pages/{page}')
async def page(cid: str, page: int):
    return Response(images[page], media_type='image/png')


@server.app.post('/api/translate')
async def translate(payload: server.TranslationRequest):
    image = server.decode_image(payload.image)
    n = image.getpixel((0, 0))[0]
    requests.append({'page': n, 'source_language': payload.source_language})
    await asyncio.sleep(1.5)  # Keep a request in flight to exercise normal chapter navigation.
    return {'width': 600, 'height': 800, 'context': f'test page {n}', 'regions': [
        {'original': f'HELLO PAGE {n}', 'translation': f'你好，第{n}页（模拟）',
         'erase': {'x': 210, 'y': 255, 'width': 200, 'height': 45},
         'box': {'x': 160, 'y': 230, 'width': 280, 'height': 90},
         'background': '#ffffff', 'foreground': '#000000', 'enabled': True,
         'font_size': 0, 'confidence': 'high', 'note': 'Synthetic test only'}]}


@server.app.get('/api/test-metrics')
async def metrics():
    return {'requests': requests}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(server.app, host='127.0.0.1', port=8766, log_level='warning')
