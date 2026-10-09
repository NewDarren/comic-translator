import test from 'node:test';
import assert from 'node:assert/strict';
import { fitText, wrapText, clampRect } from '../layout.js';

const ctx = {
  font: '',
  measureText(text) {
    const size = Number.parseFloat(this.font);
    return {width:Array.from(text).reduce((n,c) => n + (/[^\x00-\x7f]/.test(c) ? size : size*.55),0)};
  }
};
test('Chinese wraps without dropping characters, including punctuation and emoji', () => {
  const text = '（你现在在哪儿？）我正在约好的地方等你。🙂';
  const lines = wrapText(text,50,word => Array.from(word).length * 10);
  assert.equal(lines.join(''),text);
  assert.ok(lines.every(line => Array.from(line).length<=5));
  assert.ok(lines.every(line => !/^[，。！？）]/.test(line)));
  assert.ok(lines.every(line => !/[（]$/.test(line)));
});
test('Fit preserves a long translation and keeps all lines inside the box', () => {
  const text = '我正在约好的地方等你。你别走错路了，我们一会儿见。';
  const box = {x:0,y:0,width:210,height:80};
  const result = fitText(ctx,text,box);
  assert.equal(result.fits,true);
  assert.equal(result.lines.join(''),text);
  assert.ok(result.lines.length*result.lineHeight <= box.height-result.padding*2);
  assert.ok(result.lines.every(line => ctx.measureText(line).width<=box.width-result.padding*2));
});
test('A tiny box fails visibly instead of shortening the translation', () => {
  const text = '这段译文绝对不能被截断或省略。'.repeat(5);
  const result = fitText(ctx,text,{x:0,y:0,width:15,height:10});
  assert.equal(result.fits,false);
  assert.equal(result.lines.join(''),text);
});
test('Explicit oversized font is rejected; line breaks are preserved', () => {
  assert.equal(fitText(ctx,'别走。\n等我。',{width:100,height:60},40).fits,false);
  assert.deepEqual(wrapText('甲\n乙',100,w => w.length*10),['甲','乙']);
});
test('Rectangles stay inside the original image at every edge', () => {
  assert.deepEqual(clampRect({x:-4,y:500,width:300,height:10},200,100),{x:0,y:90,width:200,height:10});
  assert.deepEqual(clampRect({x:195,y:95,width:-50,height:-20},200,100),{x:195,y:95,width:1,height:1});
});
