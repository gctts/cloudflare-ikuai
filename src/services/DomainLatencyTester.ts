import tls from 'tls';
import {isIP} from 'net';
import {performance} from 'perf_hooks';

export interface ProbeResult { latencyMs: number | null; error?: string }
export interface AddressLatency {
    ip: string;
    samplesMs: number[];
    attempts: number;
    successes: number;
    lossRate: number;
    averageMs: number | null;
    errors: string[];
}
export interface DomainResult {
    domain: string;
    addresses: AddressLatency[];
    selected: AddressLatency[];
}
export interface DomainTestOptions {
    attempts: number;
    timeoutMs: number;
    concurrency: number;
    maxLossRate: number;
    maxLatencyMs: number;
    selectNum: number;
    port: number;
}
export type Probe = (domain: string, ip: string, port: number, timeoutMs: number) => Promise<ProbeResult>;

// 每次新建连接，以目标域名发送 SNI 并校验证书；总超时包含 TCP 建连和 TLS 握手。
// 此数值是 TLS 连接耗时，不是 ICMP ping，也不发送下载请求。
export const probeTls: Probe = (domain, ip, port, timeoutMs) => new Promise(resolve => {
    const started = performance.now();
    let finished = false;
    let socket: tls.TLSSocket | undefined;
    const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket?.destroy();
        resolve(error ? {latencyMs: null, error} : {latencyMs: performance.now() - started});
    };
    const timer = setTimeout(() => finish('连接超时'), timeoutMs);
    try {
        socket = tls.connect({host: ip, port, servername: domain, rejectUnauthorized: true});
        socket.once('secureConnect', () => finish(socket!.authorized ? undefined : '证书验证失败'));
        socket.once('error', error => finish(error.message));
        socket.once('close', () => finish('握手完成前连接关闭'));
    } catch (error) {
        finish(String(error));
    }
});

export class DomainLatencyTester {
    constructor(private options: DomainTestOptions, private probe: Probe = probeTls) {
        if (!Number.isInteger(options.attempts) || options.attempts < 2 || options.attempts > 10
            || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 128
            || !Number.isInteger(options.selectNum) || options.selectNum < 1
            || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0
            || !Number.isFinite(options.maxLossRate) || options.maxLossRate < 0 || options.maxLossRate > 1) {
            throw new Error('逐域名测速参数无效');
        }
    }

    public async testDomains(candidates: Map<string, string[]>, progress?: (result: DomainResult) => void): Promise<DomainResult[]> {
        const results = Array.from(candidates, ([domain]) => ({domain, addresses: [], selected: []} as DomainResult));
        const jobs = results.flatMap(result => Array.from(new Set(candidates.get(result.domain)!))
            .filter(ip => isIP(ip) !== 0).map(ip => ({result, ip})));
        let cursor = 0;
        const worker = async () => {
            while (cursor < jobs.length) {
                const {result, ip} = jobs[cursor++];
                const samples: number[] = [];
                const errors: string[] = [];
                for (let i = 0; i < this.options.attempts; i++) {
                    try {
                        const probe = await this.probe(result.domain, ip, this.options.port, this.options.timeoutMs);
                        if (probe.latencyMs !== null && Number.isFinite(probe.latencyMs) && probe.latencyMs >= 0) samples.push(probe.latencyMs);
                        else errors.push(probe.error || '没有有效延迟');
                    } catch (error) { errors.push(String(error)); }
                }
                result.addresses.push({ip, samplesMs: samples, attempts: this.options.attempts,
                    successes: samples.length, lossRate: (this.options.attempts - samples.length) / this.options.attempts,
                    averageMs: samples.length ? samples.reduce((sum, time) => sum + time, 0) / samples.length : null, errors});
            }
        };
        await Promise.all(Array.from({length: Math.min(this.options.concurrency, jobs.length)}, worker));
        for (const result of results) {
            result.addresses.sort((a, b) => (a.averageMs ?? Infinity) - (b.averageMs ?? Infinity) || a.ip.localeCompare(b.ip));
            result.selected = result.addresses.filter(address => address.successes >= 2
                && address.lossRate <= this.options.maxLossRate
                && address.averageMs !== null && address.averageMs <= this.options.maxLatencyMs)
                .slice(0, this.options.selectNum);
            progress?.(result);
        }
        return results;
    }
}
