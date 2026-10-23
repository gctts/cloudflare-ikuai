require('./helpers.cjs');
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const tls=require('node:tls');const net=require('node:net');const {execFileSync}=require('node:child_process');
const {probeTls}=require('../src/services/DomainLatencyTester.ts');

test('真实本地 TLS：带 SNI 成功，错误域名及不受信任证书失败',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloudflare-ikuai-tls-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const key=path.join(dir,'test.key'),cert=path.join(dir,'test.crt');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=tracker.example','-addext','subjectAltName=DNS:tracker.example'],{stdio:'ignore'});
 let sni;const credentials={key:fs.readFileSync(key),cert:fs.readFileSync(cert)};
 const server=tls.createServer({...credentials,SNICallback:(hostname,callback)=>{sni=hostname;callback(null,tls.createSecureContext(credentials));}},socket=>socket.end());
 server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const original=tls.connect;const port=server.address().port;
 try {
  tls.connect=options=>original({...options,ca:fs.readFileSync(cert)});
  const good=await probeTls('tracker.example','127.0.0.1',port,1500);assert.ok(good.latencyMs!==null);await new Promise(r=>setTimeout(r,10));assert.equal(sni,'tracker.example');
  const wrong=await probeTls('wrong.example','127.0.0.1',port,1500);assert.equal(wrong.latencyMs,null);assert.match(wrong.error,/certificate|cert|Hostname|altnames/i);
  tls.connect=original;
  const untrusted=await probeTls('tracker.example','127.0.0.1',port,1500);assert.equal(untrusted.latencyMs,null);assert.match(untrusted.error,/self.signed|certificate/i);
 } finally {tls.connect=original;}
});

test('真实本地 TCP 无 TLS 响应时按总超时关闭连接',async t=>{
 const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{for(const s of sockets)s.destroy();return new Promise(resolve=>server.close(resolve));});
 const result=await probeTls('tracker.example','127.0.0.1',server.address().port,50);assert.equal(result.latencyMs,null);assert.match(result.error,/超时/);
});
