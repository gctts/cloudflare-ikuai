require('./helpers.cjs');
const test=require('node:test');const assert=require('node:assert/strict');
const {parseRuleIds,normalizeRuleDomain,selectRouterDomains}=require('../src/services/RouterDomainSource.ts');
const rule=(id,domain,extra={})=>({id,domain,parse_type:'ipv4',enabled:'yes',...extra});

test('兼容旧镜像单个、区间、混合 ID；留空表示不限制',()=>{
 assert.equal(parseRuleIds('  '),undefined);
 assert.deepEqual([...parseRuleIds('1, 2, 4-6, 5,10')],['1','2','4','5','6','10']);
 for(const value of ['0','3-1','1,,2','1,','abc','1-10001','9007199254740992']) assert.throws(()=>parseRuleIds(value),/IK_DNS_RULE_IDS/);
});
test('从爱快读取已启用的对应解析类型，域名去重但保留各条规则 ID',()=>{
 const rows=[rule(1,'A.Example.'),rule('2','a.example'),rule(3,'disabled.example',{enabled:'no'}),
  rule(4,'v6.example',{parse_type:'ipv6'}),rule(5,'*.wild.example'),rule(6,'192.0.2.1'),rule(7,'local'),rule(8,'url.example/path')];
 const selected=selectRouterDomains(rows,'ipv4');
 assert.deepEqual(selected.domains,['a.example']);assert.deepEqual([...selected.ruleIds],['1','2']);
 assert.deepEqual(selectRouterDomains(rows,'ipv6').domains,['v6.example']);
 assert.deepEqual([...selectRouterDomains(rows,'ipv4',parseRuleIds('2-4')).ruleIds],['2']);
});
test('爱快新增、改名、停用直接反映到下轮目标；不依赖文件列表',()=>{
 const rows=[rule(1,'old.example')];assert.deepEqual(selectRouterDomains(rows,'ipv4').domains,['old.example']);
 rows[0].domain='new.example';rows.push(rule(2,'added.example'));
 assert.deepEqual(selectRouterDomains(rows,'ipv4').domains,['new.example','added.example']);
 rows[0].enabled='no';assert.deepEqual(selectRouterDomains(rows,'ipv4').domains,['added.example']);
 rows.splice(0);assert.deepEqual(selectRouterDomains(rows,'ipv4').domains,[]);
});
test('仅接受可用作 SNI 的完整主机名，避免把通配符或 URL 当成域名',()=>{
 assert.equal(normalizeRuleDomain(' WWW.Example.COM. '),'www.example.com');
 assert.equal(normalizeRuleDomain('例子.中国'),'xn--fsqu00a.xn--fiqs8s');
 for(const value of ['*.example.com','https://example.com','a.example/path','a.example?x','a.example#x','a.example\\path','a.example:443','2001:db8::1','127.1','-bad.example','a..example','a'.repeat(64)+'.example']) assert.equal(normalizeRuleDomain(value),undefined,value);
});
