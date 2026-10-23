import {Logger} from 'winston';
import {DomainResult} from './DomainLatencyTester';

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

    public async write(results: DomainResult[], type: 'ipv4' | 'ipv6'): Promise<WriteResult[]> {
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
                const response = await this.router.exec('dns', 'show', {TYPE: 'dns_proxy_total,dns_proxy',
                    FILTER1: 'domain,=,' + result.domain, FILTER2: 'parse_type,=,' + type, limit: '0,1000'});
                if (response.Result !== 30000 || !Array.isArray(response.Data?.data)) throw new Error('读取规则失败');
                const existing = response.Data.data.filter((row: any) => row.domain === result.domain && row.parse_type === type);
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
}
