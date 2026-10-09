"""Read public Naver Webtoon metadata and cache original images on demand.

Only fixed public mobile pages are requested. Login, payment, redirects and
non-viewer images are never followed. This module performs no translation.
"""
import hashlib
import io
import json
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

CACHE = Path(__file__).resolve().parent / 'cache' / 'naver'
MAX_BYTES = 20 * 1024 * 1024
MAX_HTML_BYTES = 2 * 1024 * 1024
METADATA_TTL = 900
CATALOG_LIMIT = 30
IMAGE_HOSTS = {'image-comic.pstatic.net', 'shared-comic.pstatic.net'}
HEADERS = {'User-Agent': 'ComicReader/0.1 (local reading tool)'}
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


def _number(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', value):
        raise HTTPException(400, 'Naver 漫画编号无效。')
    return value


def parse_source(value):
    if not isinstance(value, str):
        raise HTTPException(400, '请使用 Naver 作品目录或章节链接。')
    value = value.strip()
    ident = re.fullmatch(r'naver-([1-9][0-9]{0,9})(?:-([1-9][0-9]{0,9}))?', value)
    if ident:
        title_id, no = ident.groups()
    else:
        try:
            url = urlsplit(value)
            valid = (url.scheme == 'https' and url.hostname in {'m.comic.naver.com', 'comic.naver.com'}
                     and url.username is None and url.password is None and url.port in {None, 443}
                     and url.path in {'/webtoon/list', '/webtoon/detail'})
            query = parse_qs(url.query, keep_blank_values=True, max_num_fields=20)
        except ValueError:
            valid, query = False, {}
        if not valid or len(query.get('titleId', [])) != 1:
            raise HTTPException(400, '请使用 Naver 作品目录或章节链接。')
        title_id = _number(query['titleId'][0])
        no = None
        if url.path == '/webtoon/detail':
            if len(query.get('no', [])) != 1:
                raise HTTPException(400, 'Naver 章节链接缺少有效的 no 编号。')
            no = _number(query['no'][0])
        elif 'no' in query:
            raise HTTPException(400, 'Naver 目录链接不应包含章节编号。')
    return {'type': 'chapter' if no else 'manga',
            'id': f'naver-{title_id}' + (f'-{no}' if no else ''),
            'manga_id': f'naver-{title_id}', 'title_id': title_id, 'no': no}


def chapter_id(value):
    source = parse_source(value)
    if source['type'] != 'chapter':
        raise HTTPException(400, '请使用 Naver 章节链接。')
    return source['id']


def _catalog_url(title_id, page=1):
    return 'https://m.comic.naver.com/webtoon/list?' + urlencode(
        {'titleId': title_id, 'page': page, 'sortOrder': 'ASC'})


def _chapter_url(title_id, no):
    return 'https://m.comic.naver.com/webtoon/detail?' + urlencode(
        {'titleId': title_id, 'no': no, 'listSortOrder': 'ASC'})


class _Document(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': '', 'attrs': {}, 'children': []}
        self.stack = [self.root]
        self.count = 0
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.count += 1
        if self.count > 30_000:
            raise HTTPException(502, 'Naver 页面结构过大。')
        node = {'tag': tag, 'attrs': dict(attrs), 'children': []}
        self.stack[-1]['children'].append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]['tag'] == tag:
                del self.stack[i:]
                break

    def handle_data(self, value):
        self.stack[-1]['children'].append(value)


def _walk(root):
    pending = [root]
    while pending:
        node = pending.pop()
        if not isinstance(node, dict):
            continue
        yield node
        pending.extend(reversed(node['children']))


def _text(root):
    parts, pending = [], [root]
    while pending:
        node = pending.pop()
        if isinstance(node, str):
            parts.append(node)
        elif node['tag'] not in {'script', 'style'}:
            pending.extend(reversed(node['children']))
    return ' '.join(' '.join(parts).split())


def _classes(node):
    return set((node['attrs'].get('class') or '').split())


def _meta(root, name):
    return next((node['attrs'].get('content', '') for node in _walk(root)
                 if node['tag'] == 'meta' and node['attrs'].get('property') == name), '')


def round_fields(title, no):
    match = re.match(r'\s*ROUND\s+(\d+(?:\.\d+)?)(?:\s*[.:])?(?:\s|$)', title, re.I)
    part = re.search(r'\(([1-9][0-9]*)\)\s*$', title)
    return {'chapter': match[1] if match else str(no), 'part': part[1] if part else None}


def parse_catalog(html, title_id):
    root = _Document(html).root
    chapters, seen = [], set()
    for node in _walk(root):
        attrs = node['attrs']
        if node['tag'] != 'li' or attrs.get('data-title-id') != title_id:
            continue
        no = attrs.get('data-no', '')
        if not re.fullmatch(r'[1-9][0-9]{0,9}', no) or no in seen:
            continue
        links = [item for item in _walk(node) if item['tag'] == 'a']
        valid_link = False
        for item in links:
            href = item['attrs'].get('href', '')
            if href.startswith('/webtoon/detail?'):
                href = 'https://m.comic.naver.com' + href
            try:
                source = parse_source(href)
                valid_link = source['title_id'] == title_id and source['no'] == no
            except HTTPException:
                continue
            if valid_link:
                break
        if not valid_link:
            continue
        title_node = next((item for item in _walk(node) if 'name' in _classes(item)), None)
        title = _text(title_node) if title_node else next((item['attrs'].get('alt', '')
                  for item in _walk(node) if item['tag'] == 'img'), '')
        if not title:
            continue
        seen.add(no)
        chapters.append({'id': f'naver-{title_id}-{no}', 'title': title, 'language': 'ko',
                         'canonical_url': _chapter_url(title_id, no), **round_fields(title, no)})
    total_node = next((node for node in _walk(root) if 'total' in _classes(node)), None)
    total_text = _text(total_node) if total_node else '1'
    if not total_text.isdigit() or not 1 <= int(total_text) <= 10_000 or len(chapters) > CATALOG_LIMIT:
        raise HTTPException(502, 'Naver 目录页码无效。')
    if not chapters:
        raise HTTPException(404, '这个作品目录暂不可访问，可能需要登录或已下架。')
    return {'title': _meta(root, 'og:title') or 'Naver Webtoon',
            'chapters': chapters, 'total_pages': int(total_text)}


def validate_image_url(value, title_id, no):
    try:
        url = urlsplit(value)
        valid = (url.scheme == 'https' and url.hostname in IMAGE_HOSTS
                 and url.username is None and url.password is None and url.port in {None, 443}
                 and not url.query and not url.fragment
                 and re.fullmatch(rf'/(?:mobilewebimg|webtoon)/{re.escape(title_id)}/{re.escape(no)}/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)', url.path, re.I))
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise HTTPException(502, 'Naver 漫画图片地址不符合预期。')
    return value


def parse_manifest(html, title_id, no):
    root = _Document(html).root
    viewer = next((node for node in _walk(root)
                   if node['attrs'].get('id') in {'comic_viewer', 'toonLayer'}
                   or _classes(node) & {'toon_viewer', 'toon_view_lst'}), None)
    if viewer is None:
        raise HTTPException(404, '此章节没有可读取的公开图片，可能需要登录或付费。')
    images = []
    for node in _walk(viewer):
        if node['tag'] != 'img':
            continue
        attrs = node['attrs']
        value = attrs.get('data-src') or attrs.get('src') or ''
        # Ignore age notices, placeholders, thumbnails and advertising assets.
        try:
            path = urlsplit(value).path
        except ValueError as exc:
            raise HTTPException(502, 'Naver 漫画图片地址不符合预期。') from exc
        if not path.startswith((f'/mobilewebimg/{title_id}/{no}/', f'/webtoon/{title_id}/{no}/')):
            continue
        value = validate_image_url(value, title_id, no)
        if value not in images:
            images.append(value)
    if not images or len(images) > 500:
        raise HTTPException(404 if not images else 502, '此章节没有有效的公开漫画图片。')
    chapter_title = _meta(root, 'og:description') or next((_text(node) for node in _walk(root)
                          if node['tag'] == 'h1' and 'tit' in _classes(node)), '')
    full_title = _meta(root, 'og:title')
    title = full_title.removesuffix(' - ' + chapter_title) if chapter_title else full_title
    catalog_offset = (int(no) - 1) // CATALOG_LIMIT * CATALOG_LIMIT
    return {'id': f'naver-{title_id}-{no}', 'manga_id': f'naver-{title_id}',
            'site': 'naver', 'title': title or 'Naver Webtoon', 'chapter_title': chapter_title,
            **round_fields(chapter_title, no), 'language': 'ko', 'source_language': 'ko',
            'canonical_url': _chapter_url(title_id, no), 'catalog_offset': catalog_offset,
            'catalog_url': _catalog_url(title_id, catalog_offset // CATALOG_LIMIT + 1),
            'images': images, 'filenames': [urlsplit(value).path.rsplit('/', 1)[1] for value in images],
            'hash': hashlib.sha256('\n'.join(images).encode()).hexdigest()[:24]}


async def get_html(client, url):
    try:
        async with client.stream('GET', url) as response:
            if response.status_code in {301, 302, 303, 307, 308, 401, 403, 404, 410}:
                raise HTTPException(404, 'Naver 页面暂不可访问，可能需要登录或已下架。')
            if response.status_code == 429:
                raise HTTPException(429, 'Naver 请求过于频繁，请稍后再试。')
            response.raise_for_status()
            chunks, total = [], 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_HTML_BYTES:
                    raise HTTPException(502, 'Naver 页面超过读取大小限制。')
                chunks.append(chunk)
            return b''.join(chunks).decode('utf-8', errors='replace')
    except httpx.HTTPError as exc:
        raise HTTPException(502, '无法读取 Naver，请检查网络后重试。') from exc


def _read_cache(path):
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        age = time.time() - data.get('fetched_at', 0)
        if isinstance(data, dict) and 0 <= age < METADATA_TTL:
            return data
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return None


def _save_cache(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')


async def catalog(value, offset=0):
    source = parse_source(value)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset % CATALOG_LIMIT or offset >= 300_000:
        raise HTTPException(400, 'Naver 目录 offset 必须是非负的 30 倍数。')
    title_id, mid = source['title_id'], source['manga_id']
    cached = CACHE / mid / f'catalog-{offset}.json'
    data = _read_cache(cached)
    if data:
        return {key: val for key, val in data.items() if key != 'fetched_at'}
    page = offset // CATALOG_LIMIT + 1
    async with httpx.AsyncClient(timeout=30, follow_redirects=False, headers=HEADERS) as client:
        parsed = parse_catalog(await get_html(client, _catalog_url(title_id, page)), title_id)
        pages = parsed['total_pages']
        if page > pages:
            raise HTTPException(404, '目录页码超出范围。')
        last_cache = CACHE / mid / 'catalog-last.json'
        last = _read_cache(last_cache)
        if page == pages:
            last = parsed
        elif not last or last.get('total_pages') != pages:
            last = parse_catalog(await get_html(client, _catalog_url(title_id, pages)), title_id)
        _save_cache(last_cache, last | {'fetched_at': time.time()})
    total = (pages - 1) * CATALOG_LIMIT + len(last['chapters'])
    data = {'id': mid, 'manga_id': mid, 'site': 'naver', 'title': parsed['title'], 'language': 'ko',
            'canonical_url': _catalog_url(title_id, page), 'chapters': parsed['chapters'],
            'offset': offset, 'limit': CATALOG_LIMIT, 'total': total, 'has_more': page < pages}
    _save_cache(cached, data | {'fetched_at': time.time()})
    return data


async def manifest(value, refresh=False):
    source = parse_source(value)
    cid = chapter_id(value)
    cached = CACHE / cid / 'manifest.json'
    if not refresh:
        data = _read_cache(cached)
        if (data and data.get('id') == cid and isinstance(data.get('images'), list)
                and 1 <= len(data['images']) <= 500
                and isinstance(data.get('hash'), str) and re.fullmatch(r'[a-f0-9]{24}', data['hash'])):
            for image in data['images']:
                validate_image_url(image, source['title_id'], source['no'])
            return data
    async with httpx.AsyncClient(timeout=30, follow_redirects=False, headers=HEADERS) as client:
        html = await get_html(client, _chapter_url(source['title_id'], source['no']))
    data = parse_manifest(html, source['title_id'], source['no']) | {'fetched_at': time.time()}
    _save_cache(cached, data)
    return data


def public_manifest(data):
    return {key: data.get(key) for key in ('id', 'manga_id', 'site', 'title', 'chapter', 'chapter_title',
            'part', 'language', 'source_language', 'canonical_url', 'catalog_url', 'catalog_offset')} | {
        'page_count': len(data['images']),
        'pages': [f"/api/chapters/{data['id']}/pages/{i}" for i in range(1, len(data['images']) + 1)]}


async def page_image(cid, page):
    source = parse_source(cid)
    cid = chapter_id(cid)
    data = await manifest(cid)
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= len(data['images']):
        raise HTTPException(404, '页码超出章节范围。')
    folder = CACHE / cid
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{data['hash']}-{page}.png"
    if target.exists():
        return target
    url = validate_image_url(data['images'][page - 1], source['title_id'], source['no'])
    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=False, headers=HEADERS) as client:
            async with client.stream('GET', url) as response:
                if response.status_code in {301, 302, 303, 307, 308, 401, 403, 404, 410}:
                    raise HTTPException(404, '此页图片暂时不可访问。')
                if response.status_code == 429:
                    raise HTTPException(429, 'Naver 图片请求过于频繁，请稍后再试。')
                response.raise_for_status()
                chunks, total = [], 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise HTTPException(413, '单页图片超过 20MB。')
                    chunks.append(chunk)
        with Image.open(io.BytesIO(b''.join(chunks))) as original:
            if original.width * original.height > 30_000_000:
                raise HTTPException(413, '单页图片超过 3000 万像素。')
            image = ImageOps.exif_transpose(original).convert('RGBA')
            background = Image.new('RGBA', image.size, 'white')
            Image.alpha_composite(background, image).convert('RGB').save(target, format='PNG')
        return target
    except (httpx.HTTPError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise HTTPException(502, '该页图片读取失败，可稍后重试。') from exc
