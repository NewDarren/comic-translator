import asyncio
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import HTTPException
from PIL import Image
import mangadex

CID = 'd423f62c-f81d-4c68-a72e-0a9b20f1f5d0'
MID = '49650a04-d0d7-4526-b460-8203ae223586'


class MangaDexTests(unittest.TestCase):
    def test_url_parser_rejects_other_hosts_paths_and_credentials(self):
        self.assertEqual(mangadex.chapter_id(f'https://mangadex.org/chapter/{CID}/1'), CID)
        for value in ['https://example.com/chapter/'+CID, 'https://mangadex.org.evil.test/chapter/'+CID,
                      'http://mangadex.org/chapter/'+CID, 'https://u:p@mangadex.org/chapter/'+CID,
                      'https://mangadex.org:bad/chapter/'+CID, 'https://mangadex.org/title/'+CID, '../secret']:
            with self.assertRaises(HTTPException): mangadex.chapter_id(value)

    def test_title_and_chapter_source_parser(self):
        self.assertEqual(mangadex.parse_source(f'https://mangadex.org/title/{MID}/fight-class-3'),
                         {'type': 'manga', 'id': MID})
        self.assertEqual(mangadex.parse_source(f'https://www.mangadex.org/title/{MID}/'),
                         {'type': 'manga', 'id': MID})
        self.assertEqual(mangadex.parse_source(f'https://mangadex.org/chapter/{CID}/2'),
                         {'type': 'chapter', 'id': CID})
        self.assertEqual(mangadex.parse_source(MID.upper()), {'type': 'manga', 'id': MID})
        for value in [f'https://mangadex.org.evil.test/title/{MID}', f'https://:pw@mangadex.org/title/{MID}',
                      f'https://mangadex.org:bad/title/{MID}', f'https://mangadex.org:8443/title/{MID}',
                      f'http://mangadex.org/title/{MID}', f'https://mangadex.org/chapter/{CID}/oops',
                      f'https://mangadex.org/title/{MID}/slug/extra', MID.replace('-', ''), '../secret', None]:
            with self.assertRaises(HTTPException): mangadex.parse_source(value)

    def test_image_host_validation(self):
        self.assertEqual(mangadex.validate_host('https://node.mangadex.network'), 'https://node.mangadex.network')
        for value in ['http://node.mangadex.network', 'https://localhost',
                      'https://node.mangadex.network.evil.test','https://u:p@node.mangadex.network',
                      'https://node.mangadex.network:8000','https://node.mangadex.network/redirect']:
            with self.assertRaises(HTTPException): mangadex.validate_host(value)

    def test_metadata_and_page_cache_with_mock_network(self):
        calls = []
        buffer=io.BytesIO();Image.new('RGB',(60,80),'white').save(buffer,format='PNG')
        def handler(request):
            calls.append(str(request.url))
            if request.url.path == f'/chapter/{CID}':
                return httpx.Response(200,json={'data':{'attributes':{'chapter':'44','title':'Carefully','translatedLanguage':'en'},'relationships':[]}})
            if request.url.path == f'/at-home/server/{CID}':
                return httpx.Response(200,json={'baseUrl':'https://node.mangadex.network','chapter':{'hash':'a'*32,'data':['page.png']}})
            if request.url.host=='node.mangadex.network':return httpx.Response(200,content=buffer.getvalue())
            return httpx.Response(404)
        real_client=httpx.AsyncClient
        def client(**kwargs):return real_client(transport=httpx.MockTransport(handler),**kwargs)
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(mangadex,'CACHE',Path(folder)), patch.object(httpx,'AsyncClient',client):
                metadata=await mangadex.manifest(CID)
                public=mangadex.public_manifest(metadata)
                self.assertEqual(public['language'],'en')
                self.assertIn('manga_id',public)
                self.assertEqual(public['pages'],[f'/api/chapters/{CID}/pages/1'])
                path=await mangadex.page_image(CID,1)
                with Image.open(path) as cached_image:
                    self.assertEqual(cached_image.size,(60,80))
                await mangadex.page_image(CID,1)
                self.assertEqual(len(calls),3) # two metadata calls, one image; cached reads don't refetch
                with self.assertRaises(HTTPException):await mangadex.page_image(CID,2)
        asyncio.run(work())

    def test_catalog_pagination_filters_and_metadata_only_cache(self):
        calls = []
        def entry(cid=CID, **overrides):
            return {'id': cid, 'attributes': {'chapter': '44', 'title': 'Carefully', 'pages': 26,
                                             'translatedLanguage': 'en', **overrides},
                    'relationships': [{'type': 'scanlation_group', 'attributes': {'name': 'Example Group'}}]}
        def handler(request):
            calls.append(str(request.url))
            if request.url.path == f'/manga/{MID}':
                return httpx.Response(200, json={'data': {'attributes': {'title': {'en': 'Fight Class 3'}}}})
            if request.url.path == f'/manga/{MID}/feed':
                self.assertEqual(request.url.params['limit'], '100')
                self.assertEqual(request.url.params['translatedLanguage[]'], 'en')
                self.assertEqual(request.url.params['order[chapter]'], 'asc')
                if request.url.params['offset'] == '0':
                    entries = [entry(), entry(isUnavailable=True), entry(externalUrl='https://example.com'),
                               entry(pages=0), entry(translatedLanguage='ko')]
                else:
                    self.assertEqual(request.url.params['offset'], '100')
                    entries = [entry(chapter='109')]
                return httpx.Response(200, json={'data': entries, 'total': 109, 'limit': 100})
            self.fail(f'Catalog must only request metadata: {request.url}')
        real_client = httpx.AsyncClient
        def client(**kwargs): return real_client(transport=httpx.MockTransport(handler), **kwargs)
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(mangadex, 'CACHE', Path(folder)), patch.object(httpx, 'AsyncClient', client):
                first = await mangadex.catalog(f'https://mangadex.org/title/{MID}/fight-class-3')
                self.assertEqual(first['manga_id'], MID)
                self.assertEqual(first['title'], 'Fight Class 3')
                self.assertEqual(first['total'], 109)
                self.assertEqual(first['limit'], 100)
                self.assertTrue(first['has_more'])
                self.assertEqual(len(first['chapters']), 1)
                self.assertEqual(first['chapters'][0]['scanlation_group'], 'Example Group')
                second = await mangadex.catalog(MID, offset=first['offset'] + first['limit'])
                self.assertEqual(second['chapters'][0]['chapter'], '109')
                self.assertFalse(second['has_more'])
                self.assertEqual(await mangadex.catalog(MID), first)
                self.assertEqual(len(calls), 4)
                self.assertFalse(any(Path(folder).rglob('*.png')))
        asyncio.run(work())

    def test_catalog_from_chapter_finds_parent_without_at_home(self):
        calls = []
        async def fake(client, url):
            calls.append(url)
            if url == f'https://api.mangadex.org/chapter/{CID}':
                return {'data': {'relationships': [{'type': 'manga', 'id': MID}]}}
            if url == f'https://api.mangadex.org/manga/{MID}':
                return {'data': {'attributes': {'title': {'en': 'Fight Class 3'}}}}
            if f'/manga/{MID}/feed?' in url:
                return {'data': [], 'total': 0}
            self.fail(f'Unexpected request: {url}')
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(mangadex, 'CACHE', Path(folder)), patch.object(mangadex, 'get_json', fake):
                result = await mangadex.catalog(f'https://mangadex.org/chapter/{CID}/1')
                self.assertEqual(result['manga_id'], MID)
                self.assertFalse(result['has_more'])
                self.assertEqual(len(calls), 3)
        asyncio.run(work())

    def test_catalog_rejects_unsafe_language_and_offset_before_network(self):
        async def work():
            for options in [{'language': '../en'}, {'language': 'en&offset=0'}, {'offset': -1},
                            {'offset': '100'}, {'offset': True}]:
                with self.assertRaises(HTTPException) as raised:
                    await mangadex.catalog(MID, **options)
                self.assertEqual(raised.exception.status_code, 400)
        asyncio.run(work())

    def test_legacy_manifest_cache_refetches_manga_id(self):
        calls = []
        async def fake(client, url):
            calls.append(url)
            if url.endswith(f'/chapter/{CID}'):
                return {'data': {'attributes': {'chapter': '44', 'translatedLanguage': 'en'},
                                 'relationships': [{'type': 'manga', 'id': MID}]}}
            if url.endswith(f'/at-home/server/{CID}'):
                return {'baseUrl': 'https://node.mangadex.network',
                        'chapter': {'hash': 'a' * 32, 'data': ['page.png']}}
            return {'data': {'attributes': {'title': {'en': 'Fight Class 3'}}}}
        async def work():
            with tempfile.TemporaryDirectory() as folder, patch.object(mangadex, 'CACHE', Path(folder)), patch.object(mangadex, 'get_json', fake):
                cached = Path(folder) / CID / 'manifest.json'
                cached.parent.mkdir()
                cached.write_text(json.dumps({'id': CID, 'fetched_at': time.time()}), encoding='utf-8')
                data = await mangadex.manifest(CID)
                self.assertEqual(mangadex.public_manifest(data)['manga_id'], MID)
                await mangadex.manifest(CID)
                self.assertEqual(len(calls), 3)
        asyncio.run(work())

    def test_unavailable_chapters_stop_before_image_lookup(self):
        async def fake(client,url):return {'data':{'attributes':{'isUnavailable':True}}}
        async def work():
            with tempfile.TemporaryDirectory() as folder,patch.object(mangadex,'CACHE',Path(folder)),patch.object(mangadex,'get_json',fake):
                with self.assertRaises(HTTPException) as raised:await mangadex.manifest(CID)
                self.assertEqual(raised.exception.status_code,404)
        asyncio.run(work())


if __name__=='__main__':unittest.main()
