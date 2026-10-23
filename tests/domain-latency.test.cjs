require('./helpers.cjs');
const test=require('node:test');const assert=require('node:assert/strict');
const tls=require('node:tls');const {EventEmitter}=require('node:events');
const {DomainLatencyTester,probeTls}=require('../src/services/DomainLatencyTester.ts');
const options={attempts:3,timeoutMs:100,concurrency:4,maxLossRate:.2,maxLatencyMs:1000,selectNum:3,port:443};
const ips=['192.0.2.1','192.0.2.2','192.0.2.3','192.0.2.4'];
test('每个域名按自身平均延迟独立选前三，不共用一组排序',async()=>{
 const delays={'one.example':[100,20,30,10],'two.example':[10,40,20,90]};
 const tester=new DomainLatencyTester(options,async(domain,ip)=>({latencyMs:delays[domain][ips.indexOf(ip)]}));
 const results=await tester.testDomains(new Map(Object.keys(delays).map(domain=>[domain,ips])));
 assert.deepEqual(results[0].selected.map(r=>r.ip),[ips[3],ips[1],ips[2]]);
 assert.deepEqual(results[1].selected.map(r=>r.ip),[ips[0],ips[2],ips[1]]);
 assert.ok(results.every(r=>r.addresses.every(a=>a.attempts===3&&a.successes===3)));
});
test('排除失败和不稳定候选；不以一次偶然成功填满三个 IP',async()=>{
 const counts={};const tester=new DomainLatencyTester(options,async(_,ip)=>{
  counts[ip]=(counts[ip]||0)+1;
  return ip===ips[0]&&counts[ip]===1?{latencyMs:1}:ip===ips[1]?{latencyMs:100}:ip===ips[2]?{latencyMs:200}:{latencyMs:null,error:'证书失败'};
 });
 const [result]=await tester.testDomains(new Map([['tracker.example',[...ips,ips[1],'invalid']]]));
 assert.deepEqual(result.selected.map(r=>r.ip),[ips[1],ips[2]]);assert.equal(counts[ips[1]],3);assert.equal(counts.invalid,undefined);
});
test('允许的失败率内仍至少两次成功，超过延迟上限不写入',async()=>{
 let count=0;const tester=new DomainLatencyTester({...options,maxLossRate:.5},async(_,ip)=>{
  if(ip===ips[0])return {latencyMs:++count===1?null:100};
  return {latencyMs:1500};
 });
 const [result]=await tester.testDomains(new Map([['tracker.example',ips.slice(0,2)]]));
 assert.deepEqual(result.selected.map(r=>r.ip),[ips[0]]);assert.equal(result.selected[0].lossRate,1/3);
});
test('连接并发上限在全部域名之间共享',async()=>{
 let active=0,max=0;const tester=new DomainLatencyTester({...options,concurrency:3},async()=>{
  active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;return {latencyMs:50};
 });
 await tester.testDomains(new Map([['a.example',ips],['b.example',ips],['c.example',ips]]));
 assert.equal(max,3);assert.equal(active,0);
});
test('TLS 探测使用目标 SNI、保留证书校验，并清理超时/失败 socket',async()=>{
 const connect=tls.connect;let received;let destroyed=0;
 try {
  tls.connect=opts=>{received=opts;const socket=new EventEmitter();socket.authorized=true;socket.destroy=()=>{destroyed++;socket.emit('close');};setImmediate(()=>socket.emit('secureConnect'));return socket;};
  const good=await probeTls('tracker.example',ips[0],443,100);
  assert.ok(good.latencyMs>=0);assert.equal(received.host,ips[0]);assert.equal(received.servername,'tracker.example');assert.equal(received.rejectUnauthorized,true);assert.equal(destroyed,1);
  tls.connect=()=>{const socket=new EventEmitter();socket.destroy=()=>{destroyed++;};return socket;};
  const timeout=await probeTls('tracker.example',ips[0],443,10);assert.equal(timeout.latencyMs,null);assert.match(timeout.error,/超时/);assert.equal(destroyed,2);
  tls.connect=()=>{const socket=new EventEmitter();socket.authorized=false;socket.destroy=()=>{};setImmediate(()=>socket.emit('secureConnect'));return socket;};
  assert.equal((await probeTls('tracker.example',ips[0],443,100)).latencyMs,null);
 } finally {tls.connect=connect;}
});
