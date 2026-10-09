import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../ios/Overlay.js',import.meta.url),'utf8');

function comicImage(rect,{navigation=false}={}){
  return {
    getBoundingClientRect:()=>rect,complete:true,naturalWidth:900,naturalHeight:1400,
    currentSrc:'https://example.com/comic.jpg',alt:'',id:'',className:'',
    closest:()=>navigation?{}:null,
  };
}

function overlayState(images,{path='/chapter/1',offsetX=0,offsetY=0,width=400,height=800}={}){
  const root={style:{},isConnected:true,setAttribute(){},replaceChildren(){}};
  const context={
    document:{images,createElement:()=>root,documentElement:{appendChild(){}},addEventListener(){}},
    visualViewport:{width,height,offsetLeft:offsetX,offsetTop:offsetY,
      pageLeft:offsetX,pageTop:offsetY,scale:1,addEventListener(){}},
    innerWidth:width,innerHeight:height,scrollX:0,scrollY:0,
    location:{href:`https://example.com${path}`,pathname:path},
    addEventListener(){},MutationObserver:class{observe(){}},
  };
  vm.runInNewContext(source,context);
  return context.__comicTranslationOverlay.state();
}

test('OCR regions are limited to visible comic image coordinates',()=>{
  const state=overlayState([comicImage({left:20,top:120,right:380,bottom:760,x:20,y:120,width:360,height:640})]);
  assert.equal(state.comicCandidate,true);
  assert.equal(state.comicRects.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.comicRects[0])),{x:50,y:150,w:900,h:800});
});

test('navigation imagery and directory routes do not provide OCR regions',()=>{
  const image=comicImage({left:0,top:0,right:400,bottom:800,x:0,y:0,width:400,height:800},{navigation:true});
  const navigation=overlayState([image]);
  assert.equal(navigation.comicCandidate,false);
  assert.equal(navigation.comicRects.length,0);
  image.closest=()=>null;
  const directory=overlayState([image],{path:'/title/example'});
  assert.equal(directory.comicCandidate,false);
  assert.equal(directory.comicRects.length,0);
});

test('OCR region is clipped to the visual viewport after zoom offset',()=>{
  const state=overlayState([comicImage({left:100,top:100,right:500,bottom:900,x:100,y:100,width:400,height:800})],
    {offsetX:100,offsetY:100});
  assert.equal(state.comicCandidate,true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.comicRects[0])),{x:0,y:0,w:1000,h:1000});
});
