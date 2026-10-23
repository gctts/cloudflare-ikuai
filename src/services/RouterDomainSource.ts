import {isIP} from 'net';
import {domainToASCII} from 'url';

export type DnsType = 'ipv4' | 'ipv6';
export interface RouterDomainSelection {
    domains: string[];
    ruleIds: Set<string>;
    rules: any[];
}

// 空值表示读取所有已启用规则；兼容旧镜像的单个、区间和混合 ID 配置。
export function parseRuleIds(value: string): Set<string> | undefined {
    if (!value.trim()) return undefined;
    const ids = new Set<string>();
    for (const part of value.split(',')) {
        const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
        if (!match) throw new Error('IK_DNS_RULE_IDS 格式无效，请使用 1,2,4-9');
        const first = Number(match[1]);
        const last = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first
            || last - first >= 10000) throw new Error('IK_DNS_RULE_IDS 范围无效');
        for (let id = first; id <= last; id++) ids.add(String(id));
        if (ids.size > 10000) throw new Error('IK_DNS_RULE_IDS 最多支持 10000 个规则 ID');
    }
    return ids;
}

// 通配符、URL、IP 地址等不是可直接验证证书的 TLS 主机名，保留原规则。
export function normalizeRuleDomain(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const input = value.trim().toLowerCase().replace(/\.$/, '');
    if (/[\s/\\:?#@*%]/.test(input)) return undefined;
    const domain = domainToASCII(input);
    if (!domain || domain.length > 253 || isIP(domain) || !domain.includes('.')) return undefined;
    if (!domain.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return undefined;
    return domain;
}

export function selectRouterDomains(rules: any[], type: DnsType, ids?: ReadonlySet<string>): RouterDomainSelection {
    const eligible = rules.filter(row => row.enabled === 'yes' && row.parse_type === type
        && row.id !== undefined && row.id !== null && (!ids || ids.has(String(row.id)))
        && normalizeRuleDomain(row.domain));
    return {
        domains: Array.from(new Set(eligible.map(row => normalizeRuleDomain(row.domain)!))),
        ruleIds: new Set(eligible.map(row => String(row.id))),
        rules: eligible
    };
}
