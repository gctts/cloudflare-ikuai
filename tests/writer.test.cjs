const {logger}=require('./helpers.cjs');const test=require('node:test');const assert=require('node:assert/strict');
const {IkuaiDnsWriter}=require('../src/services/IkuaiDnsWriter.ts');
const address=(ip,averageMs)=>({ip,averageMs,samplesMs:[averageMs,averageMs,averageMs],attempts:3,successes:3,lossRate:0,errors:[]});
const result=(domain,ips)=>({domain,addresses:ips.map((ip,i)=>address(ip,100+i)),selected:ips.map((ip,i)=>address(ip,100+i))});
function router(rows=[],fail=false){return {writes:[],async exec(module,action,params){
 if(action==='show')return {Result:30000,Data:{data:rows.filter(row=>!params.FILTER1||row.domain===params.FILTER1.split(',').at(-1))}};
 this.writes.push({action,params});return {Result:fail&&action==='edit'?30001:30000,ErrMsg:fail?'denied':'Success'};
}};}
test('各域名写入自己的前三个 IP；保留 ID、备注和作用范围，启用有效结果',async()=>{
 const rows=[{id:1,domain:'a.example',parse_type:'ipv4',comment:'备注',src_addr:'10.10.10.88',enabled:'no',dns_addr:'192.0.2.99',dns_addr_proxy:'old'}];
 const r=router(rows);const writer=new IkuaiDnsWriter(r,logger);
 const reports=await writer.write([result('a.example',['192.0.2.1','192.0.2.2','192.0.2.3']),result('b.example',['192.0.2.3','192.0.2.1','192.0.2.4'])],'ipv4');
 const edits=r.writes.filter(w=>w.action!=='clean_cache');assert.deepEqual(edits.map(e=>e.action),['edit','add']);
 assert.equal(edits[0].params.dns_addr,'192.0.2.1,192.0.2.2,192.0.2.3');assert.equal(edits[1].params.dns_addr,'192.0.2.3,192.0.2.1,192.0.2.4');
 assert.equal(edits[0].params.id,1);assert.equal(edits[0].params.comment,'备注');assert.equal(edits[0].params.src_addr,'10.10.10.88');assert.equal(edits[0].params.enabled,'yes');
 assert.equal(edits[0].params.dns_addr_proxy,'192.0.2.1%20192.0.2.2%20192.0.2.3');assert.ok(reports.every(r=>r.status==='updated'));
});
test('少于三个只写有效地址，全失败不修改现有规则',async()=>{
 const r=router();const reports=await new IkuaiDnsWriter(r,logger).write([result('few.example',['192.0.2.1']),result('failed.example',[])],'ipv4');
 assert.equal(r.writes.filter(w=>w.action==='add').length,1);assert.equal(r.writes.find(w=>w.action==='add').params.dns_addr,'192.0.2.1');assert.equal(reports[1].status,'skipped');
});
test('爱快拒绝编辑时必须报告失败，不能记录为写入成功',async()=>{
 const r=router([{id:1,domain:'a.example',parse_type:'ipv4'}],true);
 const [report]=await new IkuaiDnsWriter(r,logger).write([result('a.example',['192.0.2.1'])],'ipv4');assert.equal(report.status,'failed');assert.match(report.error,/denied/);assert.ok(!r.writes.some(w=>w.action==='clean_cache'));
});
test('只修改准确域名及解析类型匹配的规则',async()=>{
 const r=router([{id:1,domain:'a.example',parse_type:'ipv6',comment:'IPv6保持'}]);
 await new IkuaiDnsWriter(r,logger).write([result('a.example',['192.0.2.1'])],'ipv4');assert.equal(r.writes[0].action,'add');
});
