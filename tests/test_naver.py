import asyncio
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import HTTPException
from PIL import Image
import naver

MID, CID = 'naver-701535', 'naver-701535-70'
IMAGE_URL = 'https://image-comic.pstatic.net/mobilewebimg/701535/70/abc_001.jpg'


def detail(images=None, viewer='toon_view_lst'):
    images = images if images is not None else [IMAGE_URL]
    tags = ''.join(f'<img src="https://ssl.pstatic.net/placeholder.png" data-src="{url}">' for url in images)
    return ('<meta property="og:title" content="격기3반 - ROUND 39. 심하민 (1)">'
            '<meta property="og:description" content="ROUND 39. 심하민 (1)">'
            f'<div class="{viewer}">{tags}</div>'
            '<img src="https://image-comic.pstatic.net/webtoon/701535/70/thumb.jpg">')


def listing(first=1, count=30, pages=3):
    items = []
    for no in range(first, first + count):
        caption = ('ROUND 39. 심하민 (1)' if no == 70 else
                   'ROUND 39. 심하민 (2)' if no == 71 else f'ROUND {no}. 제목')
        items.append(f'<li data-title-id="701535" data-no="{no}"><a href="/webtoon/detail?titleId=701535&amp;no={no}">'
                     f'<span class="name"><strong>{caption}</strong></span></a></li>')
    return ('<meta property="og:title" content="격기3반"><ul>' + ''.join(items)
            + f'</ul><em class="current_pg">1<span class="total">{pages}</span></em>')


class NaverTests(unittest.TestCase):
    def test_corrupt_cached_hash_is_refetched_before_any_image_path_is_used(self):
        async def run():
            calls = []
            async def fake_html(client, url):
                calls.append(url)
                return detail()
            with tempfile.TemporaryDirectory() as folder, patch.object(naver, 'CACHE', Path(folder)), patch.object(naver, 'get_html', fake_html):
                cached = Path(folder) / CID / 'manifest.json'
                cached.parent.mkdir()
                data = naver.parse_manifest(detail(), '701535', '70')
                cached.write_text(json.dumps(data | {'hash':'../../escape', 'fetched_at':time.time()}), encoding='utf-8')
                refreshed = await naver.manifest(CID)
                self.assertEqual(len(calls), 1)
                self.assertRegex(refreshed['hash'], r'^[a-f0-9]{24}$')
                self.assertEqual(list(Path(folder).rglob('*.png')), [])
        asyncio.run(run())

    def test_source_parser_and_canonical_ids(self):
        source = naver.parse_source('https://m.comic.naver.com/webtoon/detail?titleId=701535&no=70&week=wed&listPage=3')
        self.assertEqual(source, {'type': 'chapter', 'id': CID, 'manga_id': MID, 'title_id': '701535', 'no': '70'})
        self.assertEqual(naver.parse_source('https://comic.naver.com/webtoon/list?titleId=701535')['id'], MID)
        self.assertEqual(naver.chapter_id(CID), CID)
        self.assertEqual(naver.parse_source(MID)['type'], 'manga')

    def test_source_rejects_hosts_schemes_credentials_duplicate_and_traversal(self):
        for value in ['http://m.comic.naver.com/webtoon/detail?titleId=701535&no=70',
                      'https://m.comic.naver.com.evil.test/webtoon/detail?titleId=701535&no=70',
                      'https://u:p@m.comic.naver.com/webtoon/detail?titleId=701535&no=70',
                      'https://m.comic.naver.com:8000/webtoon/detail?titleId=701535&no=70',
                      'https://m.comic.naver.com:bad/webtoon/detail?titleId=701535&no=70',
                      'https://m.comic.naver.com/webtoon/detail?titleId=1&titleId=701535&no=70',
                      'https://m.comic.naver.com/webtoon/detail?titleId=701535&no=70&no=71',
                      'https://m.comic.naver.com/webtoon/detail?titleId=701535&no=0',
                      'https://m.comic.naver.com/webtoon/list?titleId=701535&no=70',
                      'https://m.comic.naver.com/other?titleId=701535&no=70',
                      'naver-701535-../secret', 'naver-01-70', None]:
            with self.subTest(value=value), self.assertRaises(HTTPException):
                naver.parse_source(value)
        with self.assertRaises(HTTPException):
            naver.chapter_id(MID)

    def test_viewer_images_only_and_round_part_not_episode_number(self):
        for viewer in ['toon_viewer', 'toon_view_lst']:
            data = naver.parse_manifest(detail(viewer=viewer), '701535', '70')
            self.assertEqual(data['images'], [IMAGE_URL])
            self.assertEqual(data['chapter'], '39')
            self.assertEqual(data['part'], '1')
            self.assertEqual(data['title'], '격기3반')
            self.assertEqual(data['catalog_offset'], 60)
            self.assertIn('page=3', data['catalog_url'])
            public = naver.public_manifest(data)
            self.assertEqual(public['page_count'], 1)
            self.assertEqual(public['language'], 'ko')
            self.assertEqual(public['pages'], [f'/api/chapters/{CID}/pages/1'])
            self.assertNotIn('images', public)
        data = naver.parse_manifest(detail().replace('class="toon_view_lst"', 'id="comic_viewer"'), '701535', '70')
        self.assertEqual(data['images'], [IMAGE_URL])

    def test_existing_mobile_fixture_excludes_recommendations_and_age_notice(self):
        html = (Path(__file__).resolve().parents[1] / 'naver_page.html').read_text(encoding='utf-8')
        data = naver.parse_manifest(html, '701535', '1')
        self.assertEqual(len(data['images']), 39)
        self.assertEqual(data['chapter'], '1')
        self.assertTrue(all('/mobilewebimg/701535/1/' in value for value in data['images']))

    def test_image_url_rejects_ssrf_paths_and_cross_chapter(self):
        self.assertEqual(naver.validate_image_url(IMAGE_URL, '701535', '70'), IMAGE_URL)
        for value in [IMAGE_URL.replace('https:', 'http:'), IMAGE_URL.replace('image-comic.pstatic.net', 'localhost'),
                      IMAGE_URL.replace('image-comic.pstatic.net', 'image-comic.pstatic.net.evil.test'),
                      IMAGE_URL.replace('https://', 'https://u:p@'),
                      IMAGE_URL.replace('pstatic.net/', 'pstatic.net:8000/'),
                      IMAGE_URL.replace('/70/', '/71/'), IMAGE_URL.replace('abc_001.jpg', '../other.jpg'),
                      IMAGE_URL.replace('abc_001.jpg', '%2e%2e%2fother.jpg'), IMAGE_URL + '?redirect=x', IMAGE_URL + '#x']:
            with self.subTest(value=value), self.assertRaises(HTTPException):
                naver.validate_image_url(value, '701535', '70')

    def test_manifest_stops_on_missing_public_viewer(self):
        for html in ['<h1>로그인</h1>', '<div class="toon_viewer"><img src="https://ssl.pstatic.net/age.jpg"></div>']:
            with self.assertRaises(HTTPException) as raised:
                naver.parse_manifest(html, '701535', '70')
            self.assertEqual(raised.exception.status_code, 404)

    def test_catalog_round39_and_safe_anchor_filter(self):
        html = listing(61, 12) + '<li data-title-id="701535" data-no="73"><a href="https://evil.test"><span class="name">bad</span></a></li>'
        data = naver.parse_catalog(html, '701535')
        self.assertEqual(len(data['chapters']), 12)
        round39 = [item for item in data['chapters'] if item['chapter'] == '39']
        self.assertEqual([item['id'] for item in round39], [CID, 'naver-701535-71'])
        self.assertEqual([item['part'] for item in round39], ['1', '2'])

    def test_catalog_metadata_only_pagination_total_and_cache(self):
        calls = []
        def handler(request):
            calls.append(str(request.url))
            self.assertEqual(request.url.host, 'm.comic.naver.com')
            self.assertEqual(request.url.path, '/webtoon/list')
            self.assertEqual(request.url.params['sortOrder'], 'ASC')
            page = int(request.url.params['page'])
            return httpx.Response(200, text=listing((page - 1) * 30 + 1, 12 if page == 3 else 30))
        real_client = httpx.AsyncClient
        def client(**kwargs): return real_client(transport=httpx.MockTransport(handler), **kwargs)
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(naver, 'CACHE', Path(folder)), patch.object(httpx, 'AsyncClient', client):
                first = await naver.catalog(CID)
                self.assertEqual(first['total'], 72)
                self.assertEqual(first['limit'], 30)
                self.assertTrue(first['has_more'])
                self.assertEqual(await naver.catalog(MID), first)
                self.assertEqual(len(calls), 2)
                last = await naver.catalog(MID, offset=60)
                self.assertFalse(last['has_more'])
                self.assertEqual(last['offset'], 60)
                self.assertIn('page=3', last['canonical_url'])
                self.assertEqual(len(calls), 3)
                self.assertFalse(any(Path(folder).rglob('*.png')))
        asyncio.run(work())

    def test_invalid_offsets_fail_before_network(self):
        async def work():
            for offset in [-1, True, '30', 1, 300_000]:
                with self.assertRaises(HTTPException) as raised:
                    await naver.catalog(MID, offset=offset)
                self.assertEqual(raised.exception.status_code, 400)
        asyncio.run(work())

    def test_manifest_and_image_cache_are_on_demand(self):
        calls = []
        buffer = io.BytesIO()
        Image.new('RGB', (60, 80), 'white').save(buffer, format='PNG')
        def handler(request):
            calls.append(str(request.url))
            if request.url.host == 'm.comic.naver.com':
                return httpx.Response(200, text=detail())
            self.assertEqual(str(request.url), IMAGE_URL)
            return httpx.Response(200, content=buffer.getvalue())
        real_client = httpx.AsyncClient
        def client(**kwargs): return real_client(transport=httpx.MockTransport(handler), **kwargs)
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(naver, 'CACHE', Path(folder)), patch.object(httpx, 'AsyncClient', client):
                await naver.manifest(CID)
                self.assertEqual(len(calls), 1)
                self.assertFalse(any(Path(folder).rglob('*.png')))
                target = await naver.page_image(CID, 1)
                with Image.open(target) as image:
                    self.assertEqual(image.size, (60, 80))
                await naver.page_image(CID, 1)
                self.assertEqual(len(calls), 2)
                for page in [0, 2, True]:
                    with self.assertRaises(HTTPException):
                        await naver.page_image(CID, page)
        asyncio.run(work())

    def test_http_redirect_is_not_followed_and_metadata_size_is_bounded(self):
        async def work():
            for response in [httpx.Response(302, headers={'location': 'http://localhost/secret'}),
                             httpx.Response(200, content=b'x' * 21)]:
                calls = []
                def handler(request):
                    calls.append(str(request.url))
                    return response
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
                    with patch.object(naver, 'MAX_HTML_BYTES', 20), self.assertRaises(HTTPException):
                        await naver.get_html(client, naver._catalog_url('701535'))
                self.assertEqual(len(calls), 1)
        asyncio.run(work())

    def test_expired_manifest_refetches_and_image_byte_limit_stops_download(self):
        real_client = httpx.AsyncClient
        def handler(request):
            return httpx.Response(200, text=detail()) if request.url.host == 'm.comic.naver.com' else httpx.Response(200, content=b'x' * 21)
        def client(**kwargs): return real_client(transport=httpx.MockTransport(handler), **kwargs)
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(naver, 'CACHE', Path(folder)), patch.object(httpx, 'AsyncClient', client):
                cached = Path(folder) / CID / 'manifest.json'
                cached.parent.mkdir()
                cached.write_text(json.dumps({'id': CID, 'fetched_at': time.time() - 901, 'images': []}), encoding='utf-8')
                data = await naver.manifest(CID)
                self.assertEqual(data['images'], [IMAGE_URL])
                with patch.object(naver, 'MAX_BYTES', 20), self.assertRaises(HTTPException) as raised:
                    await naver.page_image(CID, 1)
                self.assertEqual(raised.exception.status_code, 413)
                self.assertFalse(any(Path(folder).rglob('*.png')))
        asyncio.run(work())

    def test_image_pixel_limit_stops_before_conversion(self):
        data = naver.parse_manifest(detail(), '701535', '70')
        real_client = httpx.AsyncClient
        def client(**kwargs):
            return real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'image')), **kwargs)
        image = MagicMock()
        image.__enter__.return_value = image
        image.width, image.height = 6000, 6000
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(naver, 'CACHE', Path(folder)), \
                 patch.object(naver, 'manifest', AsyncMock(return_value=data)), patch.object(httpx, 'AsyncClient', client), \
                 patch.object(naver.Image, 'open', return_value=image), patch.object(naver.ImageOps, 'exif_transpose') as conversion:
                with self.assertRaises(HTTPException) as raised:
                    await naver.page_image(CID, 1)
                self.assertEqual(raised.exception.status_code, 413)
                conversion.assert_not_called()
                self.assertFalse(any(Path(folder).rglob('*.png')))
        asyncio.run(work())


if __name__ == '__main__':
    unittest.main()
