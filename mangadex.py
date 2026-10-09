"""Read public MangaDex chapters through its API, with a local image cache."""
import io
import json
import re
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from uuid import UUID

import httpx
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

CACHE = Path(__file__).resolve().parent / 'cache' / 'mangadex'
MAX_BYTES = 20 * 1024 * 1024
METADATA_TTL = 900
CATALOG_LIMIT = 100


def _uuid(value, message):
    try:
        normalized = str(UUID(value))
        if normalized != value.lower():
            raise ValueError()
        return normalized
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(400, message) from exc


def parse_source(value):
    """Resolve a MangaDex title or chapter link without fetching any images.

    A bare UUID denotes a manga for directory requests. Chapter UUIDs remain
    supported by chapter_id(), and chapter links are resolved via metadata.
    """
    if not isinstance(value, str):
        raise HTTPException(400, '请使用 MangaDex 作品目录或章节链接。')
    value = value.strip()
    if value.startswith('https://'):
        try:
            url = urlsplit(value)
            valid = (url.hostname in {'mangadex.org', 'www.mangadex.org'}
                     and url.username is None and url.password is None
                     and url.port in {None, 443})
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(400, '请使用 MangaDex 作品目录或章节链接。')
        match = re.fullmatch(r'/(title|chapter)/([0-9a-fA-F-]{36})(?:/([^/]+))?/?', url.path)
        if not match or (match[1] == 'chapter' and match[3] and not match[3].isdigit()):
            raise HTTPException(400, '链接无效，请复制 /title/ 或 /chapter/ 开头的完整网址。')
        return {'type': 'manga' if match[1] == 'title' else 'chapter',
                'id': _uuid(match[2], '漫画链接中的编号无效。')}
    return {'type': 'manga', 'id': _uuid(value, '漫画链接中的编号无效。')}


def chapter_id(value):
    if isinstance(value, str) and value.strip().startswith('https://'):
        source = parse_source(value)
        if source['type'] != 'chapter':
            raise HTTPException(400, '请使用 MangaDex 章节链接。')
        return source['id']
    return _uuid(value.strip() if isinstance(value, str) else value,
                 '章节链接无效，请复制 /chapter/ 开头的完整章节网址。')


def _read_cache(path):
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if isinstance(data, dict) and time.time() - data.get('fetched_at', 0) < METADATA_TTL:
            return data
    except (OSError, ValueError, TypeError):
        pass
    return None


def _manga_relationship(data):
    value = next((r.get('id') for r in data.get('relationships', []) if r.get('type') == 'manga'), None)
    return _uuid(value, '章节没有有效的作品目录。') if value else None


def _title(data):
    titles = data.get('attributes', {}).get('title', {})
    return titles.get('zh') or titles.get('zh-hk') or titles.get('en') or next(iter(titles.values()), 'MangaDex')


async def catalog(value, language='en', offset=0):
    """Return one raw API page of available chapters, without image requests.

    total/offset/limit describe the upstream feed before unavailable entries are
    filtered. Call again with offset + limit while has_more is true, even when
    this page contains fewer than limit readable chapters.
    """
    source = parse_source(value)
    if not isinstance(language, str) or not re.fullmatch(r'[a-z]{2}(?:-[a-z]{2})?', language):
        raise HTTPException(400, '章节语言无效。')
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise HTTPException(400, '目录页码无效。')
    async with httpx.AsyncClient(timeout=30, follow_redirects=False,
                                 headers={'User-Agent': 'ComicReader/0.1 (local reading tool)'}) as client:
        mid = source['id']
        if source['type'] == 'chapter':
            chapter = await get_json(client, f'https://api.mangadex.org/chapter/{mid}')
            mid = _manga_relationship(chapter.get('data', {}))
            if not mid:
                raise HTTPException(404, '这个章节没有可读取的作品目录。')
        folder = CACHE / f'manga-{mid}'
        cached = folder / f'catalog-{language}-{offset}.json'
        data = _read_cache(cached)
        if data:
            return {key: val for key, val in data.items() if key != 'fetched_at'}
        detail = await get_json(client, f'https://api.mangadex.org/manga/{mid}')
        query = urlencode({'limit': CATALOG_LIMIT, 'offset': offset, 'order[chapter]': 'asc',
                           'translatedLanguage[]': language, 'includes[]': 'scanlation_group'})
        feed = await get_json(client, f'https://api.mangadex.org/manga/{mid}/feed?{query}')
        entries, total = feed.get('data'), feed.get('total')
        if not isinstance(entries, list) or not isinstance(total, int) or total < 0:
            raise HTTPException(502, '作品的章节目录无效。')
        chapters = []
        for entry in entries:
            attributes = entry.get('attributes', {})
            pages = attributes.get('pages', 0)
            if (attributes.get('isUnavailable') or attributes.get('externalUrl')
                    or not isinstance(pages, int) or pages <= 0
                    or attributes.get('translatedLanguage') != language):
                continue
            item = {'id': _uuid(entry.get('id'), '作品的章节编号无效。'),
                    'chapter': attributes.get('chapter') or '',
                    'title': attributes.get('title') or '', 'pages': pages, 'language': language}
            groups = [r.get('attributes', {}).get('name') for r in entry.get('relationships', [])
                      if r.get('type') == 'scanlation_group' and r.get('attributes', {}).get('name')]
            if groups:
                item['scanlation_group'] = ' / '.join(groups)
            chapters.append(item)
        data = {'manga_id': mid, 'title': _title(detail.get('data', {})), 'language': language,
                'chapters': chapters, 'offset': offset, 'limit': CATALOG_LIMIT, 'total': total,
                'has_more': offset + CATALOG_LIMIT < total}
    folder.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(data | {'fetched_at': time.time()}, ensure_ascii=False), encoding='utf-8')
    return data


async def get_json(client, url):
    try:
        response = await client.get(url)
        if response.status_code in {403, 404, 410}:
            raise HTTPException(404, '这个章节暂不可访问，可能已下架或限制访问。')
        if response.status_code == 429:
            raise HTTPException(429, 'MangaDex 请求过于频繁，请稍后再试。')
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, '无法读取 MangaDex，请检查网络后重试。') from exc


def validate_host(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(502, '漫画图片服务器地址不符合预期。') from exc
    host = parsed.hostname or ''
    if parsed.scheme != 'https' or not host.endswith(('.mangadex.network', '.mangadex.org')) or parsed.username is not None or parsed.password is not None or port not in {None, 443} or parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
        raise HTTPException(502, '漫画图片服务器地址不符合预期。')
    return value.rstrip('/')


async def manifest(cid, refresh=False):
    cid = chapter_id(cid)
    folder = CACHE / cid
    cached = folder / 'manifest.json'
    if not refresh:
        data = _read_cache(cached)
        if data and 'manga_id' in data:
            return data
    async with httpx.AsyncClient(timeout=30, follow_redirects=False,
                                 headers={'User-Agent': 'ComicReader/0.1 (local reading tool)'}) as client:
        chapter = await get_json(client, f'https://api.mangadex.org/chapter/{cid}')
        attributes = chapter.get('data', {}).get('attributes', {})
        if attributes.get('isUnavailable') or attributes.get('externalUrl'):
            raise HTTPException(404, '此章节没有可直接读取的公开图片。')
        home = await get_json(client, f'https://api.mangadex.org/at-home/server/{cid}')
        filenames = home.get('chapter', {}).get('data', [])
        image_hash = home.get('chapter', {}).get('hash', '')
        if not filenames or len(filenames) > 500 or not re.fullmatch(r'[a-fA-F0-9]{32}', image_hash):
            raise HTTPException(502, '章节的图片索引无效。')
        if not all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', name) for name in filenames):
            raise HTTPException(502, '章节图片文件名无效。')
        title = 'MangaDex'
        manga = _manga_relationship(chapter['data'])
        if manga:
            try:
                detail = await get_json(client, f'https://api.mangadex.org/manga/{chapter_id(manga)}')
                title = _title(detail['data'])
            except (HTTPException, KeyError, StopIteration):
                pass
        data = {'id': cid, 'manga_id': manga, 'title': title, 'chapter': attributes.get('chapter') or '',
                'chapter_title': attributes.get('title') or '', 'language': attributes.get('translatedLanguage', 'unknown'),
                'base_url': validate_host(home.get('baseUrl', '')), 'hash': image_hash,
                'filenames': filenames, 'fetched_at': time.time()}
    folder.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return data


def public_manifest(data):
    return {key: data.get(key) for key in ('id', 'manga_id', 'title', 'chapter', 'chapter_title', 'language')} | {
        'page_count': len(data['filenames']),
        'pages': [f"/api/chapters/{data['id']}/pages/{i}" for i in range(1, len(data['filenames']) + 1)]}


async def page_image(cid, page):
    cid = chapter_id(cid)
    data = await manifest(cid)
    if not 1 <= page <= len(data['filenames']):
        raise HTTPException(404, '页码超出章节范围。')
    folder = CACHE / cid
    target = folder / f"{data['hash']}-{page}.png"
    if target.exists():
        return target
    filename = data['filenames'][page - 1]
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', filename):
        raise HTTPException(502, '图片索引无效。')
    url = f"{validate_host(data['base_url'])}/data/{data['hash']}/{filename}"
    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
            async with client.stream('GET', url) as response:
                if response.status_code in {403, 404, 410}:
                    raise HTTPException(404, '此页图片暂时不可访问。')
                response.raise_for_status()
                chunks, total = [], 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise HTTPException(413, '单页图片超过 20MB。')
                    chunks.append(chunk)
        image = Image.open(io.BytesIO(b''.join(chunks)))
        if image.width * image.height > 30_000_000:
            raise HTTPException(413, '单页图片超过 3000 万像素。')
        image = ImageOps.exif_transpose(image).convert('RGBA')
        background = Image.new('RGBA', image.size, 'white')
        Image.alpha_composite(background, image).convert('RGB').save(target, format='PNG')
        return target
    except (httpx.HTTPError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise HTTPException(502, '该页图片读取失败，可稍后重试。') from exc
