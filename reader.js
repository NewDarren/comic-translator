import {fitText,FONT,clampRect} from '/layout.js';
import {createAutoQueue} from '/auto-translate.js';
import {createDraftStore} from '/draft-store.js';
const $ = id => document.getElementById(id);
const SAMPLE_ID = 'd423f62c-f81d-4c68-a72e-0a9b20f1f5d0';
const LANGUAGE = {en:'英语',ko:'韩语',ja:'日语',zh:'中文', 'zh-hk':'繁体中文',fr:'法语',es:'西班牙语',ru:'俄语'};
let chapter=null, page=1, chinese=true, generation=0, hasKey=false, translating=false, translationPage=0;
let catalog=null, currentView='welcome', sourceLoading=false;
const states=new Map(), visible=new Set();
const chapterDrafts=new Map();
let draftStore;
try{draftStore=createDraftStore(window.localStorage);}catch{draftStore=createDraftStore(null);}
function saveDrafts(id,entries){
  const result=draftStore.save(id,entries);
  const savedPages=new Set(result.savedPages||[]);
  for(const [n,s] of entries)if(s.translated)s.persisted=result.saved&&savedPages.has(n);
  const unsaved=[...entries.values()].filter(s=>s.translated&&!s.persisted).length;
  $('draft-status').textContent=result.saved?(unsaved?`部分译稿已保存，${unsaved} 页未保存，请核对白框与文字。`:'华文译稿已保存在此浏览器，刷新后会恢复。'):`本次译稿仍可阅读，但未保存：${result.error||'浏览器存储不可用'}`;
  return result.saved;
}
function persistCurrent(){if(chapter&&[...states.values()].some(s=>s.translated))saveDrafts(chapter.id,states);}
function chapterAddress(data,n=page){return data.site==='naver'?data.canonical_url:(data.canonical_url||`https://mangadex.org/chapter/${data.id}`).replace(/\/$/,'')+`/${n}`;}
function routeURL(url,mode='push'){if(mode==='none'||location.pathname+location.search===url)return;history[mode==='replace'?'replaceState':'pushState'](null,'',url);}
function rememberChapter(){if(!chapter)return;persistCurrent();chapterDrafts.set(chapter.id,new Map([...states].map(([n,s])=>[n,{...s,image:undefined}])));if(chapterDrafts.size>5)chapterDrafts.delete(chapterDrafts.keys().next().value);}
function showScreen(name){currentView=name;document.querySelector('header').classList.toggle('browsing',name!=='reader');$('welcome').classList.toggle('hidden',name!=='welcome');$('pages').classList.toggle('hidden',name!=='reader');$('catalog-panel').classList.toggle('hidden',name!=='catalog');controls();}
function tell(message,error=false){$('global-status').textContent=message;$('global-status').classList.toggle('error',error);}
function state(n){if(!states.has(n))states.set(n,{regions:[],translated:false,kind:'original',context:'',error:''});return states.get(n);}
function controls(){
  const exists=!!chapter&&currentView==='reader';
  $('return-catalog').disabled=currentView!=='reader'||!chapter?.manga_id;
  $('reading-mode').disabled=currentView!=='reader';
  for(const id of ['prev','bottom-prev','side-prev'])$(id).disabled=!exists||page<=1;
  for(const id of ['next','bottom-next','side-next'])$(id).disabled=!exists||page>=chapter.page_count;
  $('page-count').textContent=exists?`${page} / ${chapter.page_count}`:'— / —';
  $('bottom-count').textContent=$('page-count').textContent;
  $('translate-page').disabled=!exists||translating;
  $('translate-page').textContent=translating?`自动翻译第${translationPage}页…`:!credentials()?'配置自动翻译':!$('auto-translate').checked?'继续自动翻译':!chinese?'切回中文':state(page).error?'重试此页':state(page).translated?'此页已翻译':'自动翻译已开启';
  const status=!credentials()?'待配置':currentView!=='reader'?'等待阅读':!$('auto-translate').checked?'已暂停':!chinese?'原文模式':$('settings').open?'设置中':$('proof').open?'校对中':translating?'翻译中':'已开启';
  $('auto-state').textContent=`自动翻译 · ${status}`;
  $('auto-state').classList.toggle('ready',exists&&!!credentials()&&$('auto-translate').checked&&chinese&&!$('settings').open&&!$('proof').open);
  $('translation-setup').classList.toggle('hidden',!exists||!!credentials());
  const single=$('reading-mode').value==='single';
  for(const id of ['side-prev','side-next','bottom-nav'])$(id).classList.toggle('hidden',!exists||!single);
}
function pageLabel(n){
  const s=state(n);
  if(s.error)return `第 ${n} 页 · ${s.error}`;
  if(!chinese)return `第 ${n} 页 · 原文`;
  if(s.kind==='manual_sample')return `第 ${n} 页 · 试译两处，其余文字为原文`;
  if(s.translated)return `第 ${n} 页 · ${s.regions.length} 处对白 · ${s.overflow?'部分文字放不下，请校对':s.persisted?'华文译稿 · 已保存':'华文译稿'}`;
  if(chinese&&$('auto-translate').checked)return !credentials()?`第 ${n} 页 · 配置翻译模型后自动显示华文`:translating&&translationPage===n?`第 ${n} 页 · 正在自动翻译…`:`第 ${n} 页 · 等待自动翻译`;
  return `第 ${n} 页 · 原文，自动翻译已暂停`;
}
function paint(n){
  const figure=document.querySelector(`[data-page="${n}"]`); if(!figure)return;
  const img=figure.querySelector('img'), canvas=figure.querySelector('canvas'),s=state(n);
  const label=figure.querySelector('.page-label');label.textContent=pageLabel(n);
  figure.querySelector('.page-state').classList.toggle('translated',chinese&&s.translated);
  figure.querySelector('.page-state').classList.toggle('error',!!s.error);
  figure.querySelector('.proof-button').disabled=!s.regions.length;
  if(!img.complete||!img.naturalWidth)return;
  if(!chinese||!s.translated){canvas.classList.add('hidden');return;}
  canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);s.overflow=false;
  for(const r of s.regions){
    if(!r.enabled||!r.translation.trim())continue;
    const erase=clampRect(r.erase,canvas.width,canvas.height),box=clampRect(r.box,canvas.width,canvas.height);
    const fitted=fitText(context,r.translation,box,Number(r.font_size)||0);
    if(!fitted.fits){s.overflow=true;continue;}
    context.fillStyle=r.background;context.fillRect(erase.x,erase.y,erase.width,erase.height);
    context.save();context.beginPath();context.rect(box.x,box.y,box.width,box.height);context.clip();
    context.fillStyle=r.foreground;context.font=`${fitted.size}px ${FONT}`;context.textAlign='center';context.textBaseline='middle';
    const first=box.y+(box.height-fitted.lines.length*fitted.lineHeight)/2+fitted.lineHeight/2;
    fitted.lines.forEach((line,i)=>context.fillText(line,box.x+box.width/2,first+i*fitted.lineHeight));context.restore();
  }
  label.textContent=pageLabel(n);canvas.classList.remove('hidden');
}
function makeFigure(n){
  const sourceID=chapter.id;
  const figure=document.createElement('figure');figure.dataset.page=String(n);
  figure.style.scrollMarginTop=`${document.querySelector('header').offsetHeight+12}px`;
  const img=document.createElement('img');img.alt=`第 ${n} 页漫画`;
  img.loading=$('reading-mode').value==='single'?'eager':'lazy';img.decoding='async';
  img.style.aspectRatio='0.7';
  const canvas=document.createElement('canvas');canvas.className='hidden';canvas.setAttribute('aria-label',`第 ${n} 页中文漫画`);
  const bar=document.createElement('div');bar.className='page-state';
  const label=document.createElement('span');label.className='page-label';label.textContent=pageLabel(n);
  const proof=document.createElement('button');proof.textContent='校对';proof.className='proof-button';proof.disabled=!state(n).regions.length;proof.onclick=()=>proofread(n);
  const stack=document.createElement('div');stack.className='image-stack';stack.append(img,canvas);
  bar.append(label,proof);figure.append(stack,bar);
  img.onload=()=>{
    if(chapter?.id!==sourceID||!figure.isConnected)return;
    img.style.aspectRatio='auto';const s=state(n);s.image=img;s.error='';
    if(s.translated&&s.width&&s.height&&(s.width!==img.naturalWidth||s.height!==img.naturalHeight)){
      Object.assign(s,{regions:[],translated:false,kind:'original',context:'',persisted:false});
      draftStore.clear(chapter.id);persistCurrent();tell('原图尺寸已改变，旧坐标已清除，当前页会重新翻译。');
    }
    paint(n);queueAuto();
  };
  img.onerror=()=>{if(chapter?.id!==sourceID||!figure.isConnected)return;state(n).error='图片加载失败，请重新打开章节或稍后重试';paint(n);};
  img.src=chapter.pages[n-1];return figure;
}
function observation(entries){
  for(const entry of entries){const n=Number(entry.target.dataset.page);if(entry.isIntersecting)visible.add(n);else visible.delete(n);}
  if($('reading-mode').value==='scroll'&&visible.size){page=Math.min(...visible);controls();}
  queueAuto();
}
function createObserver(){return new IntersectionObserver(observation,{rootMargin:`-${document.querySelector('header').offsetHeight}px 0px 0px 0px`,threshold:.1});}
let observer=createObserver();
function render(){
  observer.disconnect();observer=createObserver();visible.clear();$('pages').replaceChildren();if(!chapter)return;
  if($('reading-mode').value==='single'){const figure=makeFigure(page);$('pages').append(figure);visible.add(page);}
  else for(let n=1;n<=chapter.page_count;n++){const figure=makeFigure(n);$('pages').append(figure);observer.observe(figure);}
  controls();queueAuto();
}
async function openChapter(url,start=1,sample=false,historyMode='push'){
  const token=++generation;sourceLoading=true;autoQueue.stop();tell('正在读取章节…');
  try{
    const response=await fetch(`/api/chapter?url=${encodeURIComponent(url)}`),result=await response.json();
    if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:'章节读取失败。');
    if(token!==generation)return;
    rememberChapter();chapter=result;states.clear();const memory=chapterDrafts.get(chapter.id),stored=draftStore.load(chapter.id);for(const [n,s] of memory||stored)states.set(n,{...s,persisted:memory?!!s.persisted&&stored.has(n):true});page=Math.max(1,Math.min(chapter.page_count,Number(start)||1));
    if(sample&&chapter.id===SAMPLE_ID){const r=await fetch('/api/reader-sample');if(!r.ok)throw Error('试译样张尚未准备。');const data=await r.json();Object.assign(state(data.page),{regions:data.regions,translated:true,kind:data.kind});}
    $('chapter-title').textContent=`${chapter.title} · 第 ${chapter.chapter||'?'} ${chapter.site==='naver'?'轮':'话'}${chapter.part?`（${chapter.part}）`:''}`;
    $('chapter-meta').textContent=`${chapter.chapter_title} · ${LANGUAGE[chapter.language]||chapter.language}版 · ${chapter.page_count} 页`;
    $('chapter-url').value=chapterAddress(chapter,page);
    $('address').value=$('chapter-url').value;
    $('notice').textContent='原图完整保留。中文显示层只覆盖原字位置，关闭翻译即可恢复原文；复杂背景仍需校对。';
    $('settings').close();showScreen('reader');render();
    $('draft-status').textContent=[...states.values()].some(s=>s.translated)?'已恢复此章节的华文译稿；未译页会按阅读进度处理。':'生成的华文译稿会保存在此浏览器；API Key 只用于本次会话。';
    tell(sample?'第2页的两处短对白是人工试译，仅展示框内排字效果。其余页面将按阅读进度自动翻译。':state(page).translated?'已恢复华文译稿，继续阅读时会自动处理未译页面。':!credentials()?'先配置一次 API Key 和模型，完成后当前页及接下来阅读的页面会自动翻译。':'章节已打开，正在等待当前图片加载并自动翻译。');
    routeURL(`/?chapter=${chapter.id}&page=${page}${state(2).kind==='manual_sample'?'&sample=1':''}`,historyMode);window.scrollTo({top:0,behavior:'instant'});
  }catch(error){if(token===generation)tell(error.message||'读取失败，请检查本机服务。',true);}
  finally{if(token===generation){sourceLoading=false;queueAuto();}}
}
async function openCatalog(url,offset=0,historyMode='push'){
  const token=++generation;sourceLoading=true;autoQueue.stop();tell('正在读取章节目录…');
  try{
    const response=await fetch(`/api/catalog?url=${encodeURIComponent(url)}&language=en&offset=${offset}`),result=await response.json();
    if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:'目录读取失败。');
    if(token!==generation)return;
    catalog=result;rememberChapter();observer.disconnect();visible.clear();
    autoQueue.stop();$('settings').close();showScreen('catalog');
    const language=LANGUAGE[result.language]||result.language;
    $('chapter-title').textContent=result.title;$('chapter-meta').textContent=`${language}版 · 章节目录`;
    $('address').value=result.canonical_url||`https://mangadex.org/title/${result.manga_id}`;$('chapter-url').value=$('address').value;
    $('notice').textContent='';$('catalog-title').textContent=`${result.title} · 章节目录`;
    $('catalog-summary').textContent=`${language}版索引共 ${result.total} 条。本批显示 ${result.chapters.length} 条目录项；受限或没有公开图片的章节会在打开时提示。`;
    $('chapter-links').replaceChildren();
    for(const item of result.chapters){
      const link=document.createElement('a');link.className='chapter-link';link.href=`/?chapter=${item.id}&page=1`;
      const name=document.createElement('strong');name.textContent=item.chapter?`第 ${item.chapter} ${result.site==='naver'?'轮':'话'}${item.part?`（${item.part}）`:''}`:'番外 / 未编号章节';
      const detail=document.createElement('span');detail.textContent=[item.title,item.pages?`${item.pages} 页`:'',item.scanlation_group].filter(Boolean).join(' · ');
      link.append(name,detail);link.onclick=event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();openChapter(item.id);};$('chapter-links').append(link);
    }
    if(!result.chapters.length){const empty=document.createElement('p');empty.className='catalog-empty';empty.textContent='本批没有可读取的章节。';$('chapter-links').append(empty);}
    $('catalog-prev').disabled=result.offset===0;$('catalog-next').disabled=!result.has_more;
    $('catalog-count').textContent=`第 ${Math.floor(result.offset/result.limit)+1} 批 / ${Math.max(1,Math.ceil(result.total/result.limit))} 批`;
    routeURL(`/?manga=${result.manga_id}&offset=${result.offset}`,historyMode);
    tell('选择章节即可阅读；返回目录后可继续选其他章节，无需再粘贴链接。');window.scrollTo({top:0,behavior:'instant'});
  }catch(error){if(token===generation)tell(error.message||'目录读取失败。',true);}
  finally{if(token===generation){sourceLoading=false;queueAuto();}}
}
function openAddress(value){
  try{
    const url=new URL(value.trim());
    if(['m.comic.naver.com','comic.naver.com'].includes(url.hostname)){
      if(url.pathname==='/webtoon/detail')return openChapter(value);
      if(url.pathname==='/webtoon/list')return openCatalog(value,Math.max(0,(Number(url.searchParams.get('page'))||1)-1)*30);
    }
    if(url.pathname.startsWith('/title/'))return openCatalog(value);
    if(url.pathname.startsWith('/chapter/')){const match=url.pathname.match(/\/chapter\/[a-f0-9-]+\/(\d+)/i);return openChapter(value,match?Number(match[1]):1);}
    return openCatalog(value);
  }catch{tell('请粘贴完整的 MangaDex 或 Naver 作品目录／章节网址。',true);}
}
$('browser-bar').onsubmit=event=>{event.preventDefault();openAddress($('address').value);};
$('return-catalog').onclick=()=>chapter?.manga_id&&openCatalog(chapter.manga_id,chapter.catalog_offset||0);
$('catalog-prev').onclick=()=>catalog&&openCatalog(catalog.manga_id,Math.max(0,catalog.offset-catalog.limit));
$('catalog-next').onclick=()=>catalog?.has_more&&openCatalog(catalog.manga_id,catalog.offset+catalog.limit);
function navigate(delta){if(!chapter||currentView!=='reader')return;const next=Math.max(1,Math.min(chapter.page_count,page+delta));if(next===page)return;page=next;
  if($('reading-mode').value==='single'){render();window.scrollTo({top:0,behavior:'instant'});}else document.querySelector(`[data-page="${page}"]`)?.scrollIntoView({behavior:'smooth'});
  history.replaceState(null,'',`/?chapter=${chapter.id}&page=${page}${state(2).kind==='manual_sample'?'&sample=1':''}`);controls();
  $('address').value=chapterAddress(chapter,page);
}
for(const id of ['prev','bottom-prev','side-prev'])$(id).onclick=()=>navigate(-1);
for(const id of ['next','bottom-next','side-next'])$(id).onclick=()=>navigate(1);
document.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||$('settings').open||$('proof').open)return;if(event.key==='ArrowRight')navigate(1);if(event.key==='ArrowLeft')navigate(-1);});
$('reading-mode').onchange=()=>{render();if($('reading-mode').value==='scroll')document.querySelector(`[data-page="${page}"]`)?.scrollIntoView({behavior:'instant',block:'start'});else window.scrollTo({top:0,behavior:'instant'});};
function view(value){chinese=value;$('chinese').classList.toggle('active',value);$('original').classList.toggle('active',!value);document.querySelectorAll('[data-page]').forEach(f=>paint(Number(f.dataset.page)));controls();if(value)queueAuto();else autoQueue.stop();}
$('chinese').onclick=()=>view(true);$('original').onclick=()=>view(false);
$('welcome-form').onsubmit=event=>{event.preventDefault();openAddress($('welcome-url').value);};
$('open-sample').onclick=()=>openChapter(SAMPLE_ID,2,true);
function openSettings(){autoQueue.stop();$('settings').showModal();controls();}
$('settings-open').onclick=openSettings;
$('configure-translation').onclick=openSettings;
for(const id of ['settings-close','settings-done'])$(id).onclick=()=>{$('settings').close();controls();document.querySelectorAll('[data-page]').forEach(f=>paint(Number(f.dataset.page)));queueAuto(0);};
$('settings').addEventListener('close',()=>{controls();queueAuto(0);});
for(const id of ['reader-key','reader-model'])$(id).addEventListener('input',()=>controls());
$('load-url').onclick=()=>openAddress($('chapter-url').value);
$('width').onchange=()=>document.documentElement.style.setProperty('--reader-width',`${$('width').value}px`);
function credentials(){return ($('reader-key').value.trim()||hasKey)&&$('reader-model').value.trim();}
async function translate(n){
  if(!chapter||currentView!=='reader'||translating)return;
  if(!credentials()){openSettings();tell('请在阅读设置中填写 API Key 和模型名称，完成后将自动开始。',true);return;}
  const s=state(n),img=s.image,sourceID=chapter.id,target=$('reader-target').value;
  if(!img?.complete||!img.naturalWidth){tell('请等待此页图片加载完成。',true);return;}
  translating=true;translationPage=n;controls();paint(n);const token=generation;
  const started=Date.now(),timer=setInterval(()=>{if(token===generation&&currentView==='reader')tell(`正在翻译第 ${n} 页，已等待 ${Math.floor((Date.now()-started)/1000)} 秒。完成后中文会显示在原对白框内。`);},1000);
  tell(`正在翻译第 ${n} 页…`);
  try{
    const sourceCanvas=document.createElement('canvas');sourceCanvas.width=img.naturalWidth;sourceCanvas.height=img.naturalHeight;sourceCanvas.getContext('2d').drawImage(img,0,0);
    const image=sourceCanvas.toDataURL('image/png');
    if(image.length>28_000_000)throw Error('此页展开后超过翻译大小限制，请用图片校对工具分段处理。');
    const response=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,api_key:$('reader-key').value.trim(),model:$('reader-model').value.trim(),target,source_language:LANGUAGE[chapter.language]||chapter.language,glossary:$('reader-glossary').value,context:$('reader-context').value,previous_context:(state(n-1).context||'').slice(-5000),reference:chapter.title==='Fight Class 3'||chapter.manga_id==='naver-701535'?'fight-class-3':'none'})});
    const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'翻译请求失败。');
    if(data.width!==img.naturalWidth||data.height!==img.naturalHeight)throw Error('翻译坐标与原图尺寸不一致，请重新载入此页。');
    const draft={regions:data.regions,translated:true,kind:'automatic',context:(data.context||'').slice(-5000),error:'',width:data.width,height:data.height,target};
    if(token!==generation){
      // Preserve a completed paid result for its source chapter without painting over another chapter.
      const entries=chapterDrafts.get(sourceID)||draftStore.load(sourceID);
      entries.set(n,{...s,...draft,image:undefined});saveDrafts(sourceID,entries);
      if(chapter?.id===sourceID){Object.assign(state(n),draft);persistCurrent();}
      return;
    }
    Object.assign(s,draft);persistCurrent();paint(n);tell(`第 ${n} 页已生成华文译稿。对白有疑问时，可切回原文或点击“校对”。`);
  }catch(error){if(token!==generation)return;s.error=error.message||'翻译失败';$('auto-translate').checked=false;paint(n);tell(`${s.error}\n原图仍可阅读。自动翻译已停止。`,true);}
  finally{clearInterval(timer);translating=false;controls();paint(n);}
}
const autoQueue=createAutoQueue({
  select(){
    if(translating||sourceLoading||!chapter||currentView!=='reader'||!$('auto-translate').checked||!chinese||!credentials()||$('settings').open||$('proof').open||document.hidden)return null;
    return [...visible].sort((a,b)=>a-b).find(n=>!state(n).translated&&!state(n).error&&state(n).image?.naturalWidth)??null;
  },
  run:translate,
  delay:650,
});
function queueAuto(wait){autoQueue.request(wait);}
function resumeAuto(){
  if(!credentials()){openSettings();return;}
  if(state(page).error)state(page).error='';
  $('auto-translate').checked=true;view(true);queueAuto(0);controls();
}
$('translate-page').onclick=()=>{if(!credentials())openSettings();else if(state(page).translated&&$('auto-translate').checked)openSettings();else resumeAuto();};
$('auto-translate').onchange=()=>{controls();if($('auto-translate').checked){for(const n of visible)if(state(n).image?.naturalWidth)state(n).error='';queueAuto(0);}else autoQueue.stop();document.querySelectorAll('[data-page]').forEach(f=>paint(Number(f.dataset.page)));};
document.addEventListener('visibilitychange',()=>{if(document.hidden)autoQueue.stop();else queueAuto();});
function proofread(n){
  if(translating){tell('请等当前翻译完成后再校对。',true);return;}
  const s=state(n);$('proof-fields').replaceChildren();
  s.regions.forEach((r,i)=>{
    const row=document.createElement('div');row.className='proof-row';const label=document.createElement('strong');label.textContent=`对白 ${i+1}`;
    const original=document.createElement('p');original.className='source-text';original.textContent=r.original;
    const input=document.createElement('textarea');input.maxLength=5000;input.value=r.translation;input.setAttribute('aria-label',`对白${i+1}中文译文`);input.oninput=()=>{r.translation=input.value;persistCurrent();paint(n);};
    const size=document.createElement('input');size.type='number';size.min='0';size.max='200';size.className='small';size.value=r.font_size||0;size.setAttribute('aria-label',`对白${i+1}字号`);size.oninput=()=>{r.font_size=Math.max(0,Math.min(200,Number(size.value)||0));persistCurrent();paint(n);};
    const note=document.createElement('p');note.className='hint';note.textContent=`字号 0 为自动适配。${r.confidence!=='high'?'需要核对原文。':''} ${r.note||''}`;
    row.append(label,original,input,size,note);$('proof-fields').append(row);
  });autoQueue.stop();$('proof').showModal();
}
for(const id of ['proof-close','proof-done'])$(id).onclick=()=>{$('proof').close();queueAuto();};
$('proof').addEventListener('close',()=>queueAuto());
async function init(){
  try{const result=await fetch('/api/config');const config=await result.json();hasKey=config.has_key;$('reader-model').value=config.model||'';$('open-sample').hidden=!config.has_reader_sample;if(hasKey)$('reader-key').placeholder='已配置服务器密钥，可留空';}
  catch{tell('本机服务未连接，请启动 server.py。',true);}
  await restoreRoute('replace');
  controls();
}
async function restoreRoute(mode='none'){
  const query=new URLSearchParams(location.search);
  if(query.get('manga'))return openCatalog(query.get('manga'),Number(query.get('offset'))||0,mode);
  if(query.get('chapter'))return openChapter(query.get('chapter'),query.get('page'),query.get('sample')==='1',mode);
  generation++;sourceLoading=false;autoQueue.stop();rememberChapter();
  observer.disconnect();visible.clear();showScreen('welcome');$('chapter-title').textContent='漫画阅读器';$('chapter-meta').textContent='英文译华文 · 独立翻译层';$('notice').textContent='';tell('');
}
window.addEventListener('popstate',()=>restoreRoute());
window.addEventListener('pagehide',persistCurrent);
init();
