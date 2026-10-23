const {logger}=require('./helpers.cjs');const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {CandidatePool}=require('../src/services/CandidatePool.ts');const {FileUtils}=require('../src/utils/FileUtils.ts');
const {exclusiveTask}=require('../src/App.ts');const {IkuaiService}=require('../src/services/IkuaiService.ts');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloudflare-ikuai-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('CSV 按延迟排序、排除无效和重复 IP，允许无下载测速的零速度',async t=>{
 const dir=temp(t);const p=path.join(dir,'result.csv');fs.writeFileSync(p,'IP 地址,平均延迟,丢包率,下载速度 (MB/s)\n192.0.2.1,50,0,0\n192.0.2.2,20,0,0\ninvalid,1,0,0\n192.0.2.2,30,0,0\n192.0.2.3,NaN,0,0\n2001:db8::1,10,0,0\n');
 assert.deepEqual(await FileUtils.readCsv2IpArray(p,10,4),['192.0.2.2','192.0.2.1']);await assert.rejects(FileUtils.readCsv2IpArray(path.join(dir,'missing.csv'),10),/ENOENT/);
});
test('首次扫描完整范围；后续保留候选并轮换新网段，原始范围文件不变',t=>{
 const dir=temp(t);const source=path.join(dir,'ip.txt');const original='192.0.2.0/24\n198.51.100.0/24\n203.0.113.0/24\n';fs.writeFileSync(source,original);
 const pool=new CandidatePool(path.join(dir,'runtime'),3,1);assert.deepEqual(pool.prepare(source,4),{file:source,fullScan:true});
 pool.remember(['192.0.2.100','192.0.2.101','192.0.2.102','192.0.2.103'],4,source);
 const first=FileUtils.loadDomainList(pool.prepare(source,4).file);const second=FileUtils.loadDomainList(pool.prepare(source,4).file);
 assert.ok(first.slice(0,3).every(ip=>ip.startsWith('192.0.2.')));assert.equal(first.length,4);assert.ok(second.at(-1).startsWith('198.51.100.'));assert.equal(fs.readFileSync(source,'utf8'),original);
 fs.writeFileSync(source,'203.0.113.0/24\n');assert.equal(pool.prepare(source,4).fullScan,true);
});
test('调度禁止重叠，任务结束或失败后仍可继续下一轮',async()=>{
 let calls=0,release;const warns=[],errors=[];
 const run=exclusiveTask(async()=>{calls++;await new Promise(resolve=>{release=resolve;});}, {...logger,warn:m=>warns.push(m)});
 const first=run();await run();assert.equal(calls,1);assert.equal(warns.length,1);release();await first;
 const second=run();assert.equal(calls,2);release();await second;
 const fail=exclusiveTask(async()=>{throw new Error('失败测试');},{...logger,error:m=>errors.push(m)});await fail();await fail();assert.equal(errors.length,2);
});
test('测速进程失败时拒绝结果，不把退出码 7 当作成功',{skip:process.platform==='win32'},async t=>{
 const dir=temp(t);const script=path.join(dir,'fail.sh');fs.writeFileSync(script,'#!/bin/sh\nexit 7\n',{mode:0o700});
 const s=new IkuaiService({},logger);await assert.rejects(s.execSpeedTest(dir,'fail.sh',[]),/退出码 7/);
});
test('默认无下载 HTTP 初筛支持零丢包阈值，参数以数组传递',()=>{
 const s=new IkuaiService({DD:true,HTTPING:true,HTTPING_CODE:204,URL:'https://cp.cloudflare.com/generate_204',TLR:0},logger);
 const args=s.speedTestOptions();assert.ok(args.includes('-dd'));assert.ok(args.includes('-httping'));assert.deepEqual(args.slice(args.indexOf('-tlr'),args.indexOf('-tlr')+2),['-tlr','0']);
});
