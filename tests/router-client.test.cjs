require('./helpers.cjs');const test=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const crypto=require('node:crypto');
const {IkuaiClient}=require('../src/services/IkuaiClient.ts');
async function listen(t,handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});return server.address().port;}
test('爱快客户端累积分段 JSON，登录后携带 cookie 写入请求',async t=>{
 const received=[];const port=await listen(t,(req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
  received.push({path:req.url,body:JSON.parse(body),cookie:req.headers.cookie});
  if(req.url==='/Action/login'){res.setHeader('Set-Cookie',['sess=test-session; Path=/; HttpOnly']);res.write('{"Result":');setImmediate(()=>res.end('10000}'));}
  else{res.end(JSON.stringify({Result:30000,Data:{data:[]}}));}
 });});
 const client=new IkuaiClient('127.0.0.1',port,1000);await client.login('test-user','test-password');await client.exec('dns','show',{TYPE:'dns_proxy'});
 assert.equal(received[0].body.passwd,crypto.createHash('md5').update('test-password').digest('hex'));assert.equal(received[1].cookie,'sess=test-session');assert.equal(received[1].body.action,'show');
});
test('爱快无响应会超时拒绝，未登录时不发编辑请求',async t=>{
 const port=await listen(t,()=>{});const client=new IkuaiClient('127.0.0.1',port,30);await assert.rejects(client.login('test','test'),/超时/);await assert.rejects(client.exec('dns','edit',{}),/未登录/);
});
test('爱快网络错误或非 JSON 响应必须拒绝',async t=>{
 const port=await listen(t,(_,res)=>res.end('not json'));await assert.rejects(new IkuaiClient('127.0.0.1',port,1000).login('test','test'),/响应异常/);
 const disconnected=new IkuaiClient('127.0.0.1',0,100);await assert.rejects(disconnected.login('test','test'));
});
