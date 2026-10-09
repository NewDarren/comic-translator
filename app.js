import { fitText, FONT, clampRect } from './layout.js';
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d');
let image = null, source = '', filename = 'comic', regions = [], selected = null;
let originalView = false, adding = false, drag = null, busy = false, hasKey = false;
let loadGeneration = 0, apiGeneration = 0;

function status(message, kind = '') { $('status').textContent = message; $('status').className = `status ${kind}`; }
function current() { return regions.find(region => region.id === selected); }
function nextId() { return Math.max(0, ...regions.map(r => r.id)) + 1; }
function fitPreview() {
  if (!image) return;
  const width = $('zoom').value === 'image'
    ? Math.min(image.naturalWidth, Math.max(200, $('stage').clientHeight - 48) * image.naturalWidth / image.naturalHeight)
    : image.naturalWidth;
  $('canvas-wrap').style.width = `${width}px`;
}
$('zoom').onchange = () => { fitPreview(); paint(); };
function buttons() {
  $('translate').disabled = !image || busy;
  for (const id of ['export', 'save-project', 'add-region']) $(id).disabled = !image || busy;
  for (const id of ['upload', 'demo', 'open-project', 'episode-sample']) $(id).disabled = busy;
  $('translate').textContent = busy ? '正在结合画面翻译…' : '识别韩文并翻译';
}
function drawRegion(region, context = ctx) {
  if (!region.enabled || !region.translation.trim()) return { fits: true, size: 0, lines: [] };
  const box = region.box, erase = region.erase;
  const layout = fitText(context, region.translation, box, Number(region.font_size) || 0);
  // A failed layout leaves the source untouched, never creates a truncated translation.
  if (!layout.fits) return layout;
  context.fillStyle = region.background;
  context.fillRect(erase.x, erase.y, erase.width, erase.height);
  context.save();
  context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
  context.font = `${layout.size}px ${FONT}`;
  context.fillStyle = region.foreground;
  context.textAlign = 'center'; context.textBaseline = 'middle';
  const first = box.y + (box.height - layout.lines.length * layout.lineHeight) / 2 + layout.lineHeight / 2;
  layout.lines.forEach((line, i) => context.fillText(line, box.x + box.width / 2, first + i * layout.lineHeight));
  context.restore(); return layout;
}
function paint(outlines = true) {
  if (!image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  for (const r of regions) {
    const layout = originalView ? fitText(ctx, r.translation, r.box, Number(r.font_size) || 0) : drawRegion(r);
    r.fit = layout.fits;
    r.actual_size = layout.size;
  }
  const region = current();
  if (outlines && region) {
    const mode = $('edit-mode').value, rect = region[mode];
    const screenScale = canvas.width / canvas.getBoundingClientRect().width;
    ctx.save(); ctx.strokeStyle = mode === 'erase' ? '#e19939' : '#167464'; ctx.lineWidth = 2 * screenScale;
    ctx.setLineDash([5 * screenScale, 3 * screenScale]); ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setLineDash([]); ctx.fillStyle = ctx.strokeStyle;
    const handle = 9 * screenScale; ctx.fillRect(rect.x + rect.width - handle, rect.y + rect.height - handle, handle, handle);
    ctx.restore();
  }
  if (drag?.kind === 'add') {
    ctx.save(); ctx.strokeStyle = '#167464'; ctx.lineWidth = 2;
    ctx.strokeRect(drag.start.x, drag.start.y, drag.end.x - drag.start.x, drag.end.y - drag.start.y); ctx.restore();
  }
  if (region) $('fit-status').textContent = !region.enabled ? '未启用：保留原图。' : !region.translation.trim() ? '请填写译文；空译文不会擦除原字。' : region.fit ? `实际字号 ${region.actual_size}px · 自动换行，完整保留译文` : '译文放不下，原图暂时保留。请扩大排字区域，或把字号设为 0。';
}
function tabs() {
  $('region-tabs').replaceChildren();
  regions.forEach((r, index) => {
    const button = document.createElement('button');
    button.className = `region-tab ${r.id === selected ? 'active' : ''} ${r.confidence !== 'high' || r.fit === false ? 'warn' : ''}`;
    button.textContent = String(index + 1);
    button.title = r.translation || r.original || '新区域';
    button.addEventListener('click', () => select(r.id)); $('region-tabs').append(button);
  });
}
function coordinates() {
  const r = current(); if (!r) return;
  const rect = r[$('edit-mode').value];
  for (const name of ['x','y','width','height']) $(`rect-${name}`).value = Math.round(rect[name]);
}
function select(id) {
  selected = id;
  const r = current();
  $('editor-fields').classList.toggle('hidden', !r);
  $('editor-empty').classList.toggle('hidden', !!r);
  if (r) {
    $('region-title').textContent = `对白 ${regions.indexOf(r) + 1}`;
    for (const field of ['original','translation','background','foreground','font-size']) $(field).value = r[field.replace('-','_')] ?? '';
    $('enabled').checked = r.enabled;
    const note = [r.confidence !== 'high' ? '需要核对韩文识别和上下文。' : '', r.note].filter(Boolean).join('\n');
    $('region-note').textContent = note; $('region-note').classList.toggle('hidden', !note);
    coordinates();
  }
  paint(); tabs();
}
async function loadImage(data, name, loadedRegions = []) {
  const generation = ++loadGeneration;
  const img = new Image(); img.src = data; await img.decode();
  if (img.naturalWidth * img.naturalHeight > 30_000_000 || img.naturalWidth < 20 || img.naturalHeight < 20) throw new Error('图片尺寸不支持；请使用 3000 万像素以内的清晰截图。');
  if (generation !== loadGeneration) return;
  // Normalize EXIF orientation and alpha through the browser into the same image sent to the server.
  const normalized = document.createElement('canvas'); normalized.width = img.naturalWidth; normalized.height = img.naturalHeight;
  const nctx = normalized.getContext('2d'); nctx.fillStyle = 'white'; nctx.fillRect(0,0,normalized.width,normalized.height); nctx.drawImage(img,0,0);
  const normalizedData = normalized.toDataURL('image/png');
  const normalizedImage = new Image(); normalizedImage.src = normalizedData; await normalizedImage.decode();
  if (generation !== loadGeneration) return;
  image = normalizedImage; source = normalizedData; filename = name.replace(/\.[^.]+$/, ''); regions = loadedRegions; selected = null; adding = false;
  originalView = false; $('view-original').classList.remove('active'); $('view-translated').classList.add('active');
  $('empty').classList.add('hidden'); $('canvas-wrap').classList.remove('hidden');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  $('canvas-wrap').style.width = `${image.naturalWidth}px`;
  fitPreview();
  $('image-meta').textContent = `${name} · ${canvas.width} × ${canvas.height}`;
  $('stage').scrollTop = 0; buttons(); select(regions[0]?.id ?? null);
  status('图片已准备好。可自动翻译，也可点“框选”手动排字。');
}
async function loadFile(file) {
  if (!file || busy) return;
  try {
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请上传 PNG、JPG 或 WebP 图片。');
    if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB，请分段截图。');
    const data = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    await loadImage(data, file.name); $('api-settings').open = !hasKey || !$('model').value;
  } catch (error) { status(error.message || '图片读取失败。', 'error'); }
}
$('upload').onclick = () => $('file').click();
$('file').onchange = async event => { await loadFile(event.target.files[0]); event.target.value = ''; };
document.addEventListener('paste', event => {
  if (busy) return;
  const file = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/'))?.getAsFile();
  if (file) { event.preventDefault(); loadFile(file); }
});
$('stage').addEventListener('dragover', event => { event.preventDefault(); $('stage').classList.add('dragover'); });
$('stage').addEventListener('dragleave', () => $('stage').classList.remove('dragover'));
$('stage').addEventListener('drop', event => { event.preventDefault(); $('stage').classList.remove('dragover'); loadFile(event.dataTransfer.files[0]); });

for (const field of ['original','translation','background','foreground','font-size']) $(field).addEventListener('input', () => {
  const r = current(); if (!r || busy) return;
  r[field.replace('-','_')] = field === 'font-size' ? Math.max(0, Math.min(200, Number($(field).value) || 0)) : $(field).value;
  paint(); tabs();
});
$('enabled').onchange = () => { if (current()) { current().enabled = $('enabled').checked; paint(); } };
$('edit-mode').onchange = () => { coordinates(); paint(); };
for (const name of ['x','y','width','height']) $(`rect-${name}`).addEventListener('change', () => {
  const r = current(); if (!r) return;
  const mode = $('edit-mode').value;
  r[mode] = clampRect({ ...r[mode], [name]: Number($(`rect-${name}`).value) }, canvas.width, canvas.height);
  coordinates(); paint();
});
$('delete-region').onclick = () => { regions = regions.filter(r => r.id !== selected); select(regions[0]?.id ?? null); };
$('view-original').onclick = () => { originalView = true; $('view-original').classList.add('active'); $('view-translated').classList.remove('active'); paint(); };
$('view-translated').onclick = () => { originalView = false; $('view-translated').classList.add('active'); $('view-original').classList.remove('active'); paint(); };
$('add-region').onclick = () => {
  adding = !adding; $('add-region').classList.toggle('active', adding); canvas.style.cursor = adding ? 'crosshair' : 'default';
  status(adding ? '在图上拖出原文字区域。随后可分别调整擦字区和中文排字区。' : '框选已取消。');
};
function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(canvas.width,(event.clientX-rect.left)*canvas.width/rect.width)),
    y: Math.max(0, Math.min(canvas.height,(event.clientY-rect.top)*canvas.height/rect.height)) };
}
function inside(p,r) { return p.x >= r.x && p.y >= r.y && p.x <= r.x+r.width && p.y <= r.y+r.height; }
canvas.addEventListener('pointerdown', event => {
  if (busy || !image) return;
  const p = point(event); canvas.setPointerCapture(event.pointerId);
  if (adding) { drag = {kind:'add',start:p,end:p}; return; }
  const mode = $('edit-mode').value;
  const handle = 14 * canvas.width / canvas.getBoundingClientRect().width;
  const selectedRect = current()?.[mode];
  if (selectedRect && Math.abs(p.x-selectedRect.x-selectedRect.width) < handle && Math.abs(p.y-selectedRect.y-selectedRect.height) < handle) {
    drag = {kind:'resize',start:p,rect:{...selectedRect},id:selected,mode}; return;
  }
  const hit = [...regions].reverse().find(r => inside(p, r[mode]));
  if (!hit) { select(null); return; }
  select(hit.id); drag = {kind:'move',start:p,rect:{...hit[mode]},id:hit.id,mode};
});
canvas.addEventListener('pointermove', event => {
  if (!drag) return;
  const p = point(event);
  if (drag.kind === 'add') drag.end = p;
  else {
    const r = regions.find(r => r.id === drag.id); if (!r) return;
    const dx = p.x-drag.start.x, dy = p.y-drag.start.y;
    const rect = drag.kind === 'resize' ? {...drag.rect,width:drag.rect.width+dx,height:drag.rect.height+dy} : {...drag.rect,x:drag.rect.x+dx,y:drag.rect.y+dy};
    r[drag.mode] = clampRect(rect,canvas.width,canvas.height); coordinates();
  }
  paint();
});
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.kind === 'add') {
    const box = {x:Math.min(drag.start.x,drag.end.x),y:Math.min(drag.start.y,drag.end.y),width:Math.abs(drag.start.x-drag.end.x),height:Math.abs(drag.start.y-drag.end.y)};
    if (box.width >= 8 && box.height >= 8) {
      const id = nextId(); regions.push({id,box:{...box},erase:{...box},original:'',translation:'',background:'#ffffff',foreground:'#202020',confidence:'medium',note:'手动框选，请填写或校对译文。',font_size:0,enabled:true});
      selected = id;
    }
    adding = false; $('add-region').classList.remove('active'); canvas.style.cursor = 'default';
  }
  drag = null; select(selected);
});
canvas.addEventListener('pointercancel', () => { drag = null; paint(); });
window.addEventListener('resize', () => { fitPreview(); paint(); });

$('translate').onclick = async () => {
  if (!image || busy) return;
  if ((!$('api-key').value.trim() && !hasKey) || !$('model').value.trim()) {
    $('api-settings').open = true; status('先配置 API Key 和模型名称。也可以手动框选，直接填写中文。','error'); return;
  }
  if (regions.length && !window.confirm('重新识别会替换现有区域和译文。可先保存项目。继续？')) return;
  busy = true; buttons();
  const generation = ++apiGeneration;
  status('正在识别和翻译。长图会分段处理，可能需要几分钟。请保持此页面打开。');
  const started = Date.now();
  const timer = setInterval(() => status(`正在结合画面翻译 · 已等待 ${Math.floor((Date.now()-started)/1000)} 秒\n长图会分段处理；不会自动重试，以免重复计费。`),1000);
  try {
    const response = await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:source,api_key:$('api-key').value.trim(),model:$('model').value.trim(),target:$('target').value,context:$('context').value,glossary:$('glossary').value,reference:$('reference').value})});
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '请求参数不符合要求，请检查图片和设置。');
    if (generation !== apiGeneration) return;
    if (result.width !== canvas.width || result.height !== canvas.height) throw new Error('原图和翻译坐标尺寸不一致，请重新加载图片。');
    regions = result.regions; selected = null; select(regions[0]?.id ?? null);
    status(regions.length ? `识别到 ${regions.length} 个对白区域 · ${result.segments} 个分段\n${result.warning}` : '没有识别到框内韩文。可手动框选；也请检查图片清晰度。','success');
  } catch (error) { status(error.message || '连接失败。确认本机服务正在运行。','error'); }
  finally { clearInterval(timer); busy = false; buttons(); }
};
function download(blob,name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),30000);
}
$('export').onclick = () => {
  if (!image) return;
  const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
  const context = output.getContext('2d'); context.drawImage(image,0,0);
  const overflow = regions.filter(r => r.enabled && r.translation.trim() && !drawRegion(r,context).fits);
  if (overflow.length) { status(`${overflow.length} 个区域放不下完整译文。请扩大排字区或设为自动字号后再导出。`,'error'); return; }
  output.toBlob(blob => { if (blob) { download(blob,`${filename}-中文.png`); status('已下载中文图片。导出不包含绿色或橙色编辑框。','success'); } else status('图片导出失败，请缩小图片后重试。','error'); },'image/png');
};
$('save-project').onclick = () => {
  if (!image) return;
  const project = {version:1,name:filename,image:source,regions:regions.map(({fit,actual_size,...r}) => r),context:$('context').value,glossary:$('glossary').value,target:$('target').value,reference:$('reference').value};
  download(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),`${filename}-翻译项目.json`); status('项目已保存，包含原图和译文，不含 API Key。','success');
};
function validateProject(project) {
  if (project.version !== 1 || typeof project.image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(project.image) || !Array.isArray(project.regions) || project.regions.length > 500) throw new Error('不是有效的框译项目。');
  const ids = new Set();
  for (const r of project.regions) {
    if (!Number.isSafeInteger(r.id) || ids.has(r.id)) throw new Error('项目区域编号无效。'); ids.add(r.id);
    for (const field of ['box','erase']) if (!r[field] || !['x','y','width','height'].every(k => Number.isFinite(r[field][k]) && r[field][k]>=0) || r[field].width<1 || r[field].height<1) throw new Error('项目区域坐标无效。');
    if (typeof r.translation !== 'string' || typeof r.original !== 'string' || r.translation.length>3000 || r.original.length>3000 || typeof r.note !== 'string' || typeof r.enabled !== 'boolean' || !['high','medium','low'].includes(r.confidence) || !Number.isFinite(r.font_size) || r.font_size<0 || r.font_size>200 || !/^#[a-f\d]{6}$/i.test(r.background) || !/^#[a-f\d]{6}$/i.test(r.foreground)) throw new Error('项目译文或样式无效。');
  }
}
$('open-project').onclick = () => $('project-file').click();
$('project-file').onchange = async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  try {
    if (file.size > 60 * 1024 * 1024) throw new Error('项目文件超过 60MB。');
    const project = JSON.parse(await file.text()); validateProject(project);
    await loadImage(project.image,typeof project.name === 'string' ? project.name : 'comic',project.regions);
    for (const r of regions) { r.box = clampRect(r.box,canvas.width,canvas.height); r.erase = clampRect(r.erase,canvas.width,canvas.height); }
    $('context').value = typeof project.context === 'string' ? project.context : '';
    $('glossary').value = typeof project.glossary === 'string' ? project.glossary : '';
    $('target').value = project.target === '繁體中文' ? '繁體中文' : '简体中文';
    $('reference').value = project.reference === 'fight-class-3' ? 'fight-class-3' : 'none';
    select(regions[0]?.id ?? null); status('项目已恢复，可继续校对和排字。','success');
  } catch (error) { status(error.message || '项目读取失败。','error'); }
  finally { event.target.value = ''; }
};
$('demo').onclick = async () => {
  const sample = document.createElement('canvas'); sample.width = 900; sample.height = 1120;
  const c = sample.getContext('2d'); c.fillStyle = '#f7f4e9'; c.fillRect(0,0,900,1120);
  c.fillStyle = '#335f55'; c.fillRect(40,40,820,440); c.fillStyle = '#c5d3be'; c.fillRect(40,520,820,560);
  c.fillStyle = '#92b3a0'; c.beginPath(); c.moveTo(40,480); c.lineTo(450,250); c.lineTo(860,480); c.fill();
  c.fillStyle = '#274e44'; c.fillRect(200,330,95,150); c.beginPath(); c.arc(247,303,43,0,Math.PI*2); c.fill();
  c.fillStyle = '#779c85'; c.fillRect(580,850,115,230); c.beginPath(); c.arc(638,810,50,0,Math.PI*2); c.fill();
  function bubble(x,y,w,h,words) {
    c.fillStyle = 'white'; c.strokeStyle = '#243d35'; c.lineWidth = 3; c.beginPath(); c.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2); c.fill(); c.stroke();
    c.fillStyle = '#233b38'; c.font = '32px "Malgun Gothic",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    words.forEach((line,i) => c.fillText(line,x+w/2,y+h/2+(i-(words.length-1)/2)*44));
  }
  bubble(430,90,350,160,['지금 어디야?']); bubble(100,600,490,220,['약속한 곳에서','기다리고 있어.']);
  const data = sample.toDataURL('image/png');
  await loadImage(data,'排字示例.png',[
    {id:1,original:'지금 어디야?',translation:'你现在在哪儿？',erase:{x:478,y:145,width:254,height:52},box:{x:479,y:125,width:252,height:90},background:'#ffffff',foreground:'#233b38',confidence:'high',note:'预设示例译文，用于演示排字，不是自动翻译结果。',font_size:0,enabled:true},
    {id:2,original:'약속한 곳에서 기다리고 있어.',translation:'我正在约好的地方等你。',erase:{x:217,y:663,width:256,height:95},box:{x:191,y:651,width:308,height:118},background:'#ffffff',foreground:'#233b38',confidence:'high',note:'预设示例译文，用于演示排字。',font_size:0,enabled:true},
  ]);
  status('这是预设排字示例，可切换原图、修改译文、拖动框和导出图片。未调用翻译服务。','success');
};
fetch('/api/config').then(response => response.json()).then(config => {
  hasKey = config.has_key; if (config.model) $('model').value = config.model;
  if (hasKey) $('api-key').placeholder = '已配置服务器环境变量，可留空';
  $('episode-sample').classList.toggle('hidden', !config.has_sample);
}).catch(() => { $('api-settings').open = true; status('未连接本机服务。先运行 server.py；手动排字示例仍可使用。','error'); });

$('episode-sample').onclick = async () => {
  try {
    const response = await fetch('/api/sample');
    if (!response.ok) throw new Error('第一集试译样张尚未准备。');
    const project = await response.json(); validateProject(project);
    await loadImage(project.image, project.name, project.regions);
    $('context').value = project.context; $('glossary').value = project.glossary;
    $('reference').value = project.reference === 'fight-class-3' ? 'fight-class-3' : 'none';
    $('zoom').value = 'image'; fitPreview(); paint();
    status('第一集开头两句的人工试译与排字样张。已按你提供的中文版统一为「朱大觉」；尚未调用自动翻译模型。','success');
  } catch (error) { status(error.message, 'error'); }
};
