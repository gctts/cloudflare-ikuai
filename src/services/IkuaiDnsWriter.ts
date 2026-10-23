import {Logger} from 'winston';
import {DomainResult} from './DomainLatencyTester';
import {DnsType, normalizeRuleDomain} from './RouterDomainSource';

export interface RouterClient {
    login(username: string, password: string): Promise<unknown>;
    exec(module: string, action: string, params: Record<string, unknown>): Promise<any>;
}
export interface WriteResult {domain: string; status: 'updated' | 'skipped' | 'failed'; ips: string[]; error?: string}

export class IkuaiDnsWriter {
    constructor(private router: RouterClient, private logger: Logger) {}

    public async readRules(): Promise<any[]> {
        const response = await this.router.exec('dns', 'show', {TYPE: 'dns_proxy_total,dns_proxy', limit: '0,1000'});
        if (response.Result !== 30000 || !Array.isArray(response.Data?.data)) throw new Error('读取爱快 DNS 规则失败');
        return response.Data.data;
    }

    public async write(results: DomainResult[], type: DnsType, ruleIds?: ReadonlySet<string>): Promise<WriteResult[]> {
        const writes: WriteResult[] = [];
        let changed = false;
        for (const result of results) {
            const ips = result.selected.map(address => address.ip);
            if (!ips.length) {
                this.logger.warn(`${result.domain}：无有效候选，保留原规则`);
                writes.push({domain: result.domain, status: 'skipped', ips});
                continue;
            }
            try {
                // 测速结束后重新读取，保留用户在测速期间修改的备注、作用范围等字段。
                // 爱快来源只更新本轮读取过且仍启用的同一条规则；删除或改名后绝不重建旧规则。
                const rows = ruleIds ? await this.readRules() : await this.readDomainRules(result.domain, type);
                const existing = rows.filter((row: any) => row.parse_type === type
                    && (ruleIds ? normalizeRuleDomain(row.domain) === result.domain && row.enabled === 'yes'
                        && ruleIds.has(String(row.id)) : row.domain === result.domain));
                if (ruleIds && !existing.length) {
                    this.logger.info(`${result.domain}：规则已删除、改名或停用，跳过写入`);
                    writes.push({domain: result.domain, status: 'skipped', ips});
                    continue;
                }
                const entities = existing.length ? existing : [{domain: result.domain, parse_type: type}];
                for (const entity of entities) {
                    const updated = {...entity, dns_addr: ips.join(','), enabled: 'yes'};
                    // 同步爱快旧版本返回的地址派生字段，避免携带旧值覆盖 dns_addr。
                    for (const key of ['dns_addr_proxy', 'dns_addr_ipv4', 'dns_addr_ipv6']) {
                        if (Object.prototype.hasOwnProperty.call(updated, key)) updated[key] = ips.join('%20');
                    }
                    const edited = await this.router.exec('dns', existing.length ? 'edit' : 'add', updated);
                    if (edited.Result !== 30000) throw new Error(edited.ErrMsg || `错误码 ${edited.Result}`);
                    changed = true;
                }
                this.logger.info(`${result.domain} 已写入：${result.selected.map(a => `${a.ip} (${a.averageMs!.toFixed(1)}ms)`).join(', ')}`);
                writes.push({domain: result.domain, status: 'updated', ips});
            } catch (error) {
                this.logger.error(`${result.domain} 写入失败：${String(error)}`);
                writes.push({domain: result.domain, status: 'failed', ips, error: String(error)});
            }
        }
        if (changed) {
            try {
                const response = await this.router.exec('dns', 'clean_cache', {});
                if (response.Result !== 30000) throw new Error(response.ErrMsg);
            } catch (error) { this.logger.warn('规则已写入，但清理爱快 DNS 缓存失败：' + String(error)); }
        }
        return writes;
    }

    private async readDomainRules(domain: string, type: DnsType): Promise<any[]> {
        const response = await this.router.exec('dns', 'show', {TYPE: 'dns_proxy_total,dns_proxy',
            FILTER1: 'domain,=,' + domain, FILTER2: 'parse_type,=,' + type, limit: '0,1000'});
        if (response.Result !== 30000 || !Array.isArray(response.Data?.data)) throw new Error('读取规则失败');
        return response.Data.data;
    }
}
