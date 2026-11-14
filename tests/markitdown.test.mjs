import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkItDownResult,resolveMarkItDownPython} from '../lib/markitdown.mjs';

const result=pages=>JSON.stringify({version:1,engine:'markitdown',packageVersion:'0.1.9',pages});
test('MarkItDown bridge accepts only bounded page-preserving JSON',()=>{
 assert.deepEqual(parseMarkItDownResult(result(['Page one\n\n| Course | Deadline |','Page two']),2),{pages:['Page one\n\n| Course | Deadline |','Page two'],packageVersion:'0.1.9'});
 for(const raw of ['not JSON','null','[]',result(['only one']),result(['one','two','three']),result(['one\fpage','two']),result(['one\u0000','two']),result([null,'two']),result(['x'.repeat(200001),'two']),JSON.stringify({version:1,engine:'remote',packageVersion:'0.1.9',pages:['one','two']})])assert.throws(()=>parseMarkItDownResult(raw,2),/Invalid local document/);
 assert.throws(()=>parseMarkItDownResult(result(['one']),0));assert.throws(()=>parseMarkItDownResult(result(Array(7).fill('')),7));
});
test('converter program comes only from an absolute operator-controlled executable',async()=>{
 assert.equal(await resolveMarkItDownPython({env:{MARKITDOWN_PYTHON:process.execPath}}),process.execPath);
 for(const env of [{MARKITDOWN_ENABLED:'false',MARKITDOWN_PYTHON:process.execPath},{MARKITDOWN_PYTHON:'python3'},{MARKITDOWN_PYTHON:'https://untrusted.example/python'},{MARKITDOWN_PYTHON:'/missing/brb-python'},{MARKITDOWN_PYTHON:'/tmp/python\ncommand'}])assert.equal(await resolveMarkItDownPython({env}),null);
});
