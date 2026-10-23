import fs from 'fs';
import path from 'path';
import {isIP} from 'net';
import {createHash} from 'crypto';
import {FileUtils} from '../utils/FileUtils';

interface IPv4Block {start: number; size: number}

export class CandidatePool {
    constructor(private runtimeDir: string, private keep: number, private explore: number) {
        fs.mkdirSync(runtimeDir, {recursive: true});
    }
    private sourceHash(source: string): string { return createHash('sha256').update(fs.readFileSync(source)).digest('hex'); }
    private cache(family: 4 | 6): string { return path.join(this.runtimeDir, `candidates-v${family}.json`); }

    public prepare(source: string, family: 4 | 6): {file: string; fullScan: boolean} {
        let retained: string[] = [];
        try {
            const stored = JSON.parse(fs.readFileSync(this.cache(family), 'utf8'));
            if (stored.sourceHash === this.sourceHash(source) && Array.isArray(stored.ips)) {
                retained = Array.from(new Set<string>(stored.ips.filter((ip: unknown) => typeof ip === 'string' && isIP(ip) === family))).slice(0, this.keep);
            }
        } catch { /* 首次运行从完整网段扫描，不使用固定 IP。 */ }
        // IPv6 范围无法按 /24 展开，继续交给 CloudflareST 采样。
        if (!retained.length || family === 6) return {file: source, fullScan: true};
        const blocks = this.ipv4Blocks(FileUtils.loadDomainList(source));
        const cursorFile = path.join(this.runtimeDir, 'candidate-cursor.json');
        let cursor = 0;
        try {
            const value = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).cursor;
            if (Number.isSafeInteger(value) && value >= 0) cursor = value;
        } catch {}
        const fresh: string[] = [];
        for (let i = 0; i < Math.min(this.explore, blocks.length); i++) {
            const block = blocks[(cursor + i) % blocks.length];
            const offset = block.size > 2 ? 1 + Math.floor(Math.random() * (block.size - 2)) : Math.floor(Math.random() * block.size);
            const value = (block.start + offset) >>> 0;
            fresh.push([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'));
        }
        FileUtils.writeJson(cursorFile, {cursor: blocks.length ? (cursor + fresh.length) % blocks.length : 0});
        const file = path.join(this.runtimeDir, 'scan-v4.txt');
        fs.writeFileSync(file, Array.from(new Set([...retained, ...fresh])).join('\n') + '\n');
        return {file, fullScan: false};
    }

    public remember(ips: string[], family: 4 | 6, source: string): void {
        const valid = Array.from(new Set(ips.filter(ip => isIP(ip) === family))).slice(0, this.keep);
        if (valid.length) FileUtils.writeJson(this.cache(family), {sourceHash: this.sourceHash(source), ips: valid});
    }

    private ipv4Blocks(ranges: string[]): IPv4Block[] {
        const blocks: IPv4Block[] = [];
        for (const range of ranges) {
            const [address, prefixText] = range.split('/');
            const prefix = prefixText === undefined ? 32 : Number(prefixText);
            if (isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) throw new Error('无效或过大的 IPv4 范围：' + range);
            const size = 2 ** (32 - prefix);
            const value = address.split('.').reduce((sum, byte) => sum * 256 + Number(byte), 0);
            const start = Math.floor(value / size) * size;
            for (let offset = 0; offset < size; offset += 256) {
                blocks.push({start: start + offset, size: Math.min(256, size)});
                if (blocks.length > 65536) throw new Error('IPv4 候选范围过大，请缩小 ip.txt');
            }
        }
        return blocks;
    }
}
