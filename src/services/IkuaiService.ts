import path from 'path';
import fs from 'fs';
import {spawn} from 'child_process';
import {isIP} from 'net';
import {Logger} from 'winston';
import {ServiceConfigs} from '../configs/ServiceConfigs';
import {FileUtils} from '../utils/FileUtils';
import {DomainLatencyTester} from './DomainLatencyTester';
import {IkuaiDnsWriter, RouterClient} from './IkuaiDnsWriter';
import {CandidatePool} from './CandidatePool';
import {IkuaiClient} from './IkuaiClient';
import {normalizeRuleDomain, parseRuleIds, selectRouterDomains} from './RouterDomainSource';

export class IkuaiService {
    constructor(private configs: ServiceConfigs, private logger: Logger) {}

    private execSpeedTest(workdir: string, executable: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(path.join(workdir, executable), args, {cwd: workdir, stdio: 'ignore'});
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error(`CloudflareST 测速失败，退出码 ${code}`)));
        });
    }

    private speedTestOptions(): string[] {
        const c = this.configs;
        const args: string[] = [];
        const optional: Array<[string, number]> = [['-dn', c.DN], ['-tl', c.TL], ['-tll', c.TLL],
            ['-sl', c.SL], ['-dt', c.DT], ['-httping-code', c.HTTPING_CODE], ['-n', c.N], ['-t', c.T], ['-tp', c.TP]];
        for (const [flag, value] of optional) if (Number.isFinite(value) && value > 0) args.push(flag, String(value));
        // 0 也是有效阈值，代表不接受丢包。
        if (Number.isFinite(c.TLR) && c.TLR >= 0 && c.TLR <= 1) args.push('-tlr', String(c.TLR));
        if (c.DD) args.push('-dd');
        if (c.HTTPING) args.push('-httping');
        if (c.ALLIP) args.push('-allip');
        if (c.CF_COLO) args.push('-cfcolo', c.CF_COLO);
        if (c.URL) args.push('-url', c.URL);
        return args;
    }

    public async task(): Promise<void> {
        const started = Date.now();
        const c = this.configs;
        const executable = process.platform === 'linux' ? c.SCRIPT_LINUX : process.platform === 'win32' ? c.SCRIPT_WIN : '';
        if (!executable) throw new Error('测速工具只支持 Linux / Windows；macOS 可通过 Docker 运行');
        if (!c.ROUTER_IP || !c.ROUTER_USERNAME || !c.ROUTER_PASSWORD) throw new Error('请配置爱快地址、账号和密码');
        const fromRouter = c.DOMAIN_SOURCE !== 'file';
        const ids = parseRuleIds(c.IK_DNS_RULE_IDS || '');
        const fileDomains = fromRouter ? [] : FileUtils.loadDomainList(path.join(__dirname, 'configs', 'domain.txt'));
        if (!fromRouter && !fileDomains.length) throw new Error('domain.txt 没有有效域名');
        const runtime = path.join(__dirname, 'configs', 'runtime');
        const pool = new CandidatePool(runtime, c.POOL_SIZE, c.EXPLORE_NUM);
        const workdir = path.join(__dirname, 'assets');
        const tester = new DomainLatencyTester({attempts: c.DOMAIN_TESTS, timeoutMs: c.DOMAIN_TIMEOUT,
            concurrency: c.DOMAIN_CONCURRENCY, maxLossRate: c.TLR, maxLatencyMs: c.DOMAIN_TIME_LIMIT,
            selectNum: c.SELECT_NUM, port: c.TP || 443});
        const router: RouterClient = new IkuaiClient(c.ROUTER_IP, c.ROUTER_PORT);
        await router.login(c.ROUTER_USERNAME, c.ROUTER_PASSWORD);
        const writer = new IkuaiDnsWriter(router, this.logger);
        this.logger.info(`开始逐域名优选：域名来源=${fromRouter ? '爱快已启用 DNS 规则' : 'domain.txt'}，每域名选前 ${c.SELECT_NUM} 个；下载测速${c.DD ? '禁用' : '启用'}`);

        for (const family of (c.ENABLE_V6 ? [4, 6] : [4]) as Array<4 | 6>) {
            const type = family === 4 ? 'ipv4' : 'ipv6';
            // 每轮重新读取爱快；新增、改名、停用规则不需要更新容器内的文件。
            const rules = await writer.readRules();
            const selection = selectRouterDomains(rules, type, ids);
            const domains = fromRouter ? selection.domains : fileDomains;
            if (!domains.length) {
                this.logger.info(`IPv${family} 没有符合条件的已启用域名，跳过测速和写入`);
                continue;
            }
            this.logger.info(`IPv${family} 本轮目标：${domains.length} 个域名${fromRouter ? `，${selection.ruleIds.size} 条爱快规则` : ''}`);
            const source = path.join(__dirname, 'configs', family === 4 ? 'ip.txt' : 'ipv6.txt');
            const input = pool.prepare(source, family);
            const output = path.join(workdir, family === 4 ? c.FILE : c.FILE6);
            // 删除的只是本程序上一轮生成的 CSV；失败时不复用旧结果。
            if (fs.existsSync(output)) fs.unlinkSync(output);
            this.logger.info(`IPv${family} 候选初筛：${input.fullScan ? '扫描完整配置范围，首次可能超过一分钟' : '复测候选池并探索新地址'}`);
            await this.execSpeedTest(workdir, executable, ['-f', input.file, '-o', output, ...this.speedTestOptions()]);
            const candidates = await FileUtils.readCsv2IpArray(output, c.POOL_SIZE, family);
            if (!candidates.length) throw new Error(`IPv${family} 本轮没有有效候选，未更新 DNS`);
            pool.remember(candidates, family, source);
            const byDomain = new Map(domains.map(domain => {
                const previous: string[] = (fromRouter ? selection.rules : rules)
                    .filter(row => normalizeRuleDomain(row.domain) === domain && row.parse_type === type)
                    .flatMap(row => String(row.dns_addr || '').split(','));
                return [domain, Array.from(new Set([...candidates.slice(0, c.DOMAIN_CANDIDATES), ...previous]))
                    .filter(ip => isIP(ip) === family)];
            }));
            this.logger.info(`IPv${family} 初筛完成，开始对目标域名逐个验证 TLS 连接延迟（非 ping）`);
            const results = await tester.testDomains(byDomain, result => {
                const selected = result.selected.map(address => `${address.ip}=${address.averageMs!.toFixed(1)}ms`).join(', ');
                this.logger.info(`${result.domain} TLS 排序结果：${selected || '无候选通过稳定性/证书/延迟检查'}`);
            });
            const writes = await writer.write(results, type, fromRouter ? selection.ruleIds : undefined);
            const report = {started: new Date(started).toISOString(), finished: new Date().toISOString(), family,
                domainSource: fromRouter ? 'ikuai' : 'file', ruleIds: fromRouter ? Array.from(selection.ruleIds) : undefined,
                method: 'TCP connect + TLS handshake, fresh connections, SNI + certificate verification; not ICMP ping',
                domains: results.map(result => ({...result, write: writes.find(write => write.domain === result.domain)}))};
            FileUtils.writeJson(path.join(runtime, `last-run-v${family}.json`), report);
            const count = (status: string) => writes.filter(write => write.status === status).length;
            this.logger.info(`IPv${family} 写入完成：成功 ${count('updated')}，跳过 ${count('skipped')}，失败 ${count('failed')}`);
            if (count('failed')) throw new Error(`IPv${family} 部分 DNS 写入失败，详见本轮报告`);
        }
        this.logger.info(`本轮任务完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    }
}
