import base64
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import server


def image_data(width=600, height=800):
    buffer = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


class PipelineTests(unittest.TestCase):
    def test_strips_cover_long_page_once_including_last_pixel(self):
        image = Image.new('RGB', (800, 6500), 'white')
        tiles = list(server.image_tiles(image))
        self.assertEqual(tiles[0][2], 0)
        self.assertEqual(tiles[-1][3], 6500)
        for left, right in zip(tiles, tiles[1:]):
            self.assertEqual(left[3], right[2])
            self.assertLess(right[1], left[1] + left[0].height)

    def test_coordinate_mapping_returns_original_resolution(self):
        rect = server.Rectangle(x=100, y=100, width=200, height=100)
        result = server.to_pixels(rect, Image.new('RGB',(1280,1800)),1400,(1280,6000),(2560,12000))
        self.assertEqual(result,{'x':256,'y':3160,'width':512,'height':360})
        with self.assertRaises(HTTPException):
            server.to_pixels(server.Rectangle(x=900,y=0,width=200,height=100),Image.new('RGB',(100,100)),0,(100,100),(100,100))

    def test_invalid_images_and_unsupported_formats(self):
        for image in ['broken','data:image/png;base64,!!!!!','data:image/svg+xml;base64,AAAA',image_data(10,10)]:
            with self.assertRaises(HTTPException): server.decode_image(image)
        self.assertEqual(server.decode_image(image_data()).size,(600,800))

    def test_all_objects_in_schema_are_strict(self):
        def check(node):
            if isinstance(node,dict):
                if node.get('type')=='object':
                    self.assertFalse(node['additionalProperties'])
                    self.assertEqual(set(node['required']),set(node.get('properties',{})))
                for value in node.values(): check(value)
            elif isinstance(node,list):
                for value in node: check(value)
        check(server.strict_schema())

    def test_local_routes_and_cross_site_protection(self):
        client = TestClient(server.app)
        self.assertEqual(client.get('/').status_code,200)
        self.assertEqual(client.get('/layout.js').status_code,200)
        self.assertEqual(client.get('/auto-translate.js').status_code,200)
        self.assertEqual(client.get('/draft-store.js').status_code,200)
        self.assertEqual(client.get('/server.py').status_code,404)
        self.assertEqual(client.get('/api/config',headers={'Origin':'https://example.com'}).status_code,403)
        self.assertEqual(client.get('/',headers={'Host':'untrusted.example'}).status_code,403)
        with patch.dict('os.environ',{'OPENAI_API_KEY':'','COMIC_MODEL':''}):
            result = client.post('/api/translate',json={'image':image_data()})
            self.assertEqual(result.status_code,400)
        self.assertNotIn('api_key', client.get('/api/config').json())

    def test_catalog_route_preserves_pagination_and_validates_offset(self):
        calls = []
        async def fake_catalog(url, language='en', offset=0):
            calls.append((url, language, offset))
            return {'manga_id':'49650a04-d0d7-4526-b460-8203ae223586',
                    'title':'Fight Class 3','language':language,'chapters':[],
                    'offset':offset,'limit':100,'total':109,'has_more':False}
        client = TestClient(server.app)
        address = 'https://mangadex.org/title/49650a04-d0d7-4526-b460-8203ae223586'
        with patch.object(server.mangadex, 'catalog', fake_catalog):
            response = client.get('/api/catalog',params={'url':address,'offset':100})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['total'],109)
            self.assertEqual(response.json()['offset'],100)
            self.assertEqual(calls,[(address,'en',100)])
            self.assertEqual(client.get('/api/catalog',params={'url':address,'offset':-1}).status_code,422)
            self.assertEqual(len(calls),1)

    def test_naver_routes_preserve_korean_language_round_parts_and_directory_offset(self):
        calls = []
        async def fake_manifest(value):
            calls.append(('chapter', value))
            html = ('<meta property="og:title" content="Test - ROUND 39. Name (1)">'
                    '<meta property="og:description" content="ROUND 39. Name (1)">'
                    '<div id="toonLayer"><img src="https://image-comic.pstatic.net/mobilewebimg/701535/70/test.jpg"></div>')
            return server.naver.parse_manifest(html, '701535', '70')
        async def fake_catalog(value, offset=0):
            calls.append(('catalog', value, offset))
            return {'manga_id': 'naver-701535', 'site': 'naver', 'language': 'ko',
                    'offset': offset, 'limit': 30, 'total': 259, 'chapters': [], 'has_more': True}
        client = TestClient(server.app)
        with patch.object(server.naver, 'manifest', fake_manifest), patch.object(server.naver, 'catalog', fake_catalog):
            result = client.get('/api/chapter', params={'url':'https://m.comic.naver.com/webtoon/detail?titleId=701535&no=70'})
            self.assertEqual(result.status_code, 200, result.text)
            data = result.json()
            self.assertEqual((data['id'], data['chapter'], data['part'], data['language']), ('naver-701535-70', '39', '1', 'ko'))
            self.assertEqual(data['catalog_offset'], 60)
            self.assertEqual(data['pages'], ['/api/chapters/naver-701535-70/pages/1'])
            directory = client.get('/api/catalog', params={'url':'naver-701535', 'offset':60}).json()
            self.assertEqual((directory['language'], directory['offset'], directory['limit']), ('ko', 60, 30))
            self.assertEqual(calls[-1], ('catalog', 'naver-701535', 60))
        self.assertEqual(client.get('/api/chapter', params={'url':'https://m.comic.naver.com.evil.test/webtoon/detail?titleId=701535&no=70'}).status_code, 400)

    def test_mocked_vision_pipeline_schema_and_pixel_mapping(self):
        # Mock response verifies wiring, not the real model's translation accuracy.
        result = {'regions':[{'original':'지금 어디야?','translation':'你现在在哪儿？',
            'erase':{'x':200,'y':200,'width':200,'height':100},
            'box':{'x':150,'y':150,'width':300,'height':200},
            'background':'#ffffff','foreground':'#202020','confidence':'high','note':''}], 'context':'朋友之间的问话'}
        async def fake_post(self,url,**kwargs):
            self_test.assertEqual(url,'https://api.openai.com/v1/responses')
            self_test.assertFalse(kwargs['json']['store'])
            self_test.assertEqual(kwargs['json']['input'][0]['content'][1]['type'],'input_image')
            return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps(result)}]}]})
        self_test = self
        with patch.object(httpx.AsyncClient,'post',fake_post):
            response = TestClient(server.app).post('/api/translate',json={'image':image_data(),'api_key':'test-key','model':'test-model'})
        self.assertEqual(response.status_code,200,response.text)
        region = response.json()['regions'][0]
        self.assertEqual(region['erase'],{'x':120,'y':160,'width':120,'height':80})
        self.assertEqual(region['translation'],'你现在在哪儿？')


if __name__ == '__main__': unittest.main()
